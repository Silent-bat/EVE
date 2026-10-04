/**
 * Vercel AI Gateway client (OpenAI-compatible) for Convex.
 *
 * Used for classification/triage: deciding what a notification means, what is
 * worth saving to memory vs useless noise. The gateway key lives in the Convex
 * env (AI_GATEWAY_API_KEY) — never in the repo. One endpoint fronts many
 * providers; we default to a fast, cheap model and always ask for JSON.
 *
 * Docs: https://vercel.com/docs/ai-gateway (OpenAI-compatible /v1 surface)
 */
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
/** Fast + cheap, strong instruction-following — good for classification. */
export const DEFAULT_CLASSIFIER_MODEL = "google/gemini-3.6-flash";

const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const DELAYS_MS = [400, 1200, 2500];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function apiKey(): string {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) throw new Error("AI_GATEWAY_API_KEY is not configured in the Convex deployment");
  return key;
}

/**
 * Chat completion via the gateway, with retry on transient overloads. Returns
 * the assistant message text.
 */
export async function gatewayChat(
  messages: ChatMessage[],
  opts: { model?: string; temperature?: number; maxTokens?: number; jsonObject?: boolean } = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model ?? DEFAULT_CLASSIFIER_MODEL,
    messages,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 1024,
  };
  if (opts.jsonObject) body.response_format = { type: "json_object" };

  let last: Response | null = null;
  for (let attempt = 0; attempt <= DELAYS_MS.length; attempt++) {
    const res = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey()}`,
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
  throw new Error(`AI Gateway error: ${detail}`);
}

/**
 * Parse a JSON object from a model response, tolerating ```json fences and
 * leading/trailing prose. Returns null if nothing parseable is found.
 */
export function parseJsonObject<T = any>(text: string): T | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}
