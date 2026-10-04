/**
 * OpenRouter client (OpenAI-compatible) for Convex.
 *
 * Used for MAIL SORT classification via TypeSafe's "Jev" router, per the user's
 * request. The key lives in the Convex env (OPENROUTER_API_KEY) — never in the
 * repo. The model defaults to `typesafe/jev-router`, a router that picks the
 * best underlying model per request; override with OPENROUTER_MODEL.
 *
 * Jev Router advertises no fixed parameter set, so we do NOT send
 * `response_format`; callers prompt for JSON and parse the reply themselves
 * (the reply is clean JSON in practice).
 *
 * Docs: https://openrouter.ai/docs (OpenAI-compatible /api/v1 surface)
 */
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_OPENROUTER_MODEL = "typesafe/jev-router";

const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const DELAYS_MS = [400, 1200, 2500];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** True when the deployment has an OpenRouter key configured. */
export function openRouterConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

function apiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not configured in the Convex deployment");
  return key;
}

/**
 * Chat completion via OpenRouter, retrying transient overloads. Returns the
 * assistant message text.
 */
export async function openRouterChat(
  messages: ChatMessage[],
  opts: { model?: string; temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model ?? process.env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL,
    messages,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 1024,
  };

  let last: Response | null = null;
  for (let attempt = 0; attempt <= DELAYS_MS.length; attempt++) {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey()}`,
        // Optional attribution headers OpenRouter recommends.
        "HTTP-Referer": "https://eve.app",
        "X-Title": "EVE mail sort",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const json: any = await res.json();
      return String(json?.choices?.[0]?.message?.content ?? "");
    }
    last = res;
    if (!TRANSIENT.has(res.status)) break;
    if (attempt < DELAYS_MS.length) await new Promise((r) => setTimeout(r, DELAYS_MS[attempt]));
  }
  const detail = last ? `${last.status} ${(await last.text()).slice(0, 300)}` : "no response";
  throw new Error(`OpenRouter error: ${detail}`);
}
