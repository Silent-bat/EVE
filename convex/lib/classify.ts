/**
 * Clean AI classification harness.
 *
 * One entry point — classifyJSON() — that returns a validated JSON object from
 * an LLM. It prefers the Vercel AI Gateway (per the user's request) and falls
 * back to the project's Gemini key when the gateway is unavailable (e.g. the
 * 403 "add a credit card" gate, or a transient error). Callers get a working
 * classifier today; it silently upgrades to the gateway once the card is added.
 *
 * Used by notification triage (useless vs needs-attention) and the
 * save-worthy memory classifier.
 */
import { gatewayChat, parseJsonObject, type ChatMessage } from "./aiGateway";
import { geminiGenerate } from "./gemini";

export interface ClassifyResult<T> {
  data: T | null;
  engine: "gateway" | "gemini" | "none";
  error?: string;
}

/**
 * Run a classification prompt and parse a JSON object out of the reply.
 * `system` frames the task and MUST specify the exact JSON shape expected.
 */
export async function classifyJSON<T = any>(
  system: string,
  user: string,
  opts: { maxTokens?: number } = {},
): Promise<ClassifyResult<T>> {
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  // 1. Preferred: Vercel AI Gateway.
  try {
    const text = await gatewayChat(messages, {
      jsonObject: true,
      maxTokens: opts.maxTokens ?? 512,
      temperature: 0,
    });
    const data = parseJsonObject<T>(text);
    if (data) return { data, engine: "gateway" };
  } catch (err) {
    // fall through to Gemini — the gateway may be card-gated (403) or overloaded
  }

  // 2. Fallback: Gemini (the project's existing key).
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return { data: null, engine: "none", error: "no GEMINI_API_KEY for fallback" };
    const prompt = `${system}\n\nInput:\n${user}\n\nReturn ONLY the JSON object, no prose.`;
    const text = await geminiGenerate(prompt, apiKey, { temperature: 0, maxOutputTokens: opts.maxTokens ?? 512 });
    const data = parseJsonObject<T>(text);
    return data ? { data, engine: "gemini" } : { data: null, engine: "none", error: "unparseable Gemini reply" };
  } catch (err) {
    return { data: null, engine: "none", error: err instanceof Error ? err.message : "classify failed" };
  }
}
