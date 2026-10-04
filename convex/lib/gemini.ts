/**
 * Gemini API wrapper for Convex
 *
 * Ports the analysis logic from services/api-node/src/briefing/analysis.mjs
 */
import { geminiFetch } from "./geminiFetch";
import { openRouterChat, openRouterConfigured } from "./openrouter";

export const DEFAULT_GEMINI_PROMPT_MAX_CHARS = 120_000;

interface GeminiOptions {
  temperature?: number;
  maxOutputTokens?: number;
}

/**
 * Send a prompt to Gemini and return the textual content.
 * Throws on missing API key or non-2xx responses.
 */
export async function geminiGenerate(
  prompt: string,
  apiKey: string,
  options: GeminiOptions = {},
): Promise<string> {
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

  if (typeof prompt !== "string" || prompt.length > DEFAULT_GEMINI_PROMPT_MAX_CHARS) {
    throw new Error("gemini prompt exceeds the configured size limit");
  }

  // gemini-3.6-flash is Google's named replacement for the retired
  // gemini-2.5-flash / -pro (which now 404). Pinned explicitly. Flash is
  // plenty for email ranking.
  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
  const modelName = model.startsWith("models/") ? model : `models/${model}`;

  const response = await geminiFetch(
    `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: options.temperature ?? 0.2,
          maxOutputTokens: options.maxOutputTokens ?? 700,
        },
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${text}`);
  }

  const payload = await response.json();
  const candidate = payload.candidates?.[0];
  if (!candidate) {
    throw new Error("No candidate in Gemini response");
  }

  const parts = candidate.content?.parts || [];
  return parts.map((p: any) => p.text || "").join("");
}

/**
 * Parse JSON from Gemini response text.
 * Handles markdown code fences and other wrapping.
 */
export function parseJSONFromText(text: string): any {
  // Strip markdown code fences
  let cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "");
  cleaned = cleaned.trim();

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    // Try to extract JSON object from the text
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error(`Failed to parse JSON from Gemini response: ${error}`);
  }
}

/**
 * Analyze messages using Gemini.
 * Returns structured analysis for each message.
 */
export async function analyzeMessages(
  scoredMessages: Array<{ message: any; score: number }>,
  context: { profileBlock?: string; memoryFacts?: string[] },
  apiKey: string,
): Promise<any[]> {
  if (scoredMessages.length === 0) return [];

  const prompt = buildAnalysisPrompt(scoredMessages, context);

  // 1. Preferred: OpenRouter — TypeSafe's "Jev" router — sorts the mail, per the
  //    user's request. The same JSON prompt works across providers.
  if (openRouterConfigured()) {
    try {
      const text = await openRouterChat(
        [
          {
            role: "system",
            content:
              "You are an email prioritization assistant. Return ONLY the JSON object the instructions describe — no prose, no code fences.",
          },
          { role: "user", content: prompt },
        ],
        { temperature: 0.15, maxTokens: 2400 },
      );
      const parsed = parseJSONFromText(text);
      const rows = Array.isArray(parsed?.emails) ? parsed.emails : [];
      if (rows.length > 0) return mapAnalyzedRows(rows, scoredMessages);
    } catch (error) {
      console.error("OpenRouter (jev) mail sort failed, falling back to Gemini:", error);
    }
  }

  // 2. Fallback: Gemini (the project's existing key).
  try {
    const text = await geminiGenerate(prompt, apiKey, {
      temperature: 0.15,
      maxOutputTokens: 2400,
    });

    const parsed = parseJSONFromText(text);
    const rows = Array.isArray(parsed.emails) ? parsed.emails : [];
    return mapAnalyzedRows(rows, scoredMessages);
  } catch (error) {
    console.error("Gemini batch email analysis failed:", error);
    // Final fallback: return local scores.
    return scoredMessages.map(({ message, score }) => ({
      id: message?.id,
      urgencyScore: score,
      reasoning: "Local scoring (AI unavailable)",
      category: "other",
      actionable: false,
    }));
  }
}

/** Shape LLM output rows into analyzed-email objects, aligned to inputs by index. */
function mapAnalyzedRows(
  rows: any[],
  scoredMessages: Array<{ message: any; score: number }>,
): any[] {
  return scoredMessages.map((scored, index) => {
    const row = rows[index] ?? {};
    return {
      id: scored.message.id,
      urgencyScore: typeof row.urgencyScore === "number" ? row.urgencyScore : scored.score,
      reasoning: row.reasoning || "",
      category: row.category || "other",
      actionable: row.actionable ?? false,
    };
  });
}

function buildAnalysisPrompt(
  scoredMessages: Array<{ message: any; score: number }>,
  context: { profileBlock?: string; memoryFacts?: string[] },
): string {
  const MAX_EMAIL_SNIPPET_CHARS = 1_500;
  const MAX_HEADER_CHARS = 300;
  const MAX_PROFILE_CONTEXT_CHARS = 8_000;
  const MAX_MEMORY_CONTEXT_CHARS = 500;

  let prompt = `You triage a busy professional's inbox. For each email, decide how much it needs the person and sort it. Be decisive: most inbox mail is automated noise (job digests, newsletters, promos, social pings) — only a real message from a person asking THIS user for something is urgent.\n\n`;

  if (context.profileBlock) {
    const profile = context.profileBlock.slice(0, MAX_PROFILE_CONTEXT_CHARS);
    prompt += `User Profile:\n${profile}\n\n`;
  }

  if (context.memoryFacts && context.memoryFacts.length > 0) {
    const memory = context.memoryFacts.join(", ").slice(0, MAX_MEMORY_CONTEXT_CHARS);
    prompt += `Memory: ${memory}\n\n`;
  }

  prompt += `Emails to analyze (order matters — return results in the same order):\n`;
  for (let i = 0; i < scoredMessages.length; i++) {
    const entry = scoredMessages[i];
    const message = entry?.message;
    const score = entry?.score ?? 0;
    // Build a COMPACT per-email context from the useful fields, not the whole
    // stringified message. Full Gmail payloads embed base64 bodies that blow
    // the prompt past its size limit (and add no signal for prioritization).
    const headers = message?.payload?.headers ?? [];
    const header = (name: string) =>
      String(
        headers.find((x: any) => String(x?.name || "").toLowerCase() === name)?.value ?? "",
      ).slice(0, MAX_HEADER_CHARS);
    const snippet = String(message?.snippet ?? "").slice(0, MAX_EMAIL_SNIPPET_CHARS);
    prompt +=
      `\n[${i}] initialScore:${score}\n` +
      `From: ${header("from")}\nSubject: ${header("subject")}\nDate: ${header("date")}\n` +
      `Preview: ${snippet}\n`;
  }

  prompt += `\n\nReturn ONLY a JSON object {"emails":[...]} with one entry per email, IN THE SAME ORDER as above. Each entry:\n`;
  prompt += `- urgencyScore: integer 0-100, calibrated:\n`;
  prompt += `    85-100 = a real person directly asks THIS user for something, OR a hard deadline / security / payment matter\n`;
  prompt += `    60-84  = a real person's message worth reading soon, no hard action yet\n`;
  prompt += `    35-59  = relevant but automated (a job match they'd actually care about, a receipt, a calendar invite)\n`;
  prompt += `    1-34   = noise: newsletters, promotions, social "viewed/reacted", bulk job digests, duplicates\n`;
  prompt += `- actionable: true ONLY if the user personally must reply or act. Automated/bulk mail is false.\n`;
  prompt += `- category: exactly one of "action", "personal", "work", "finance", "recruiting", "newsletter", "promotion", "social", "notification", "other". Bulk job alerts/recruiter mail are "recruiting", NOT "work".\n`;
  prompt += `- reasoning: one short clause.\n`;

  return prompt;
}
