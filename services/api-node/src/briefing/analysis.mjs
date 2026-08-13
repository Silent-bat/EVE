/**
 * LLM-backed email analysis. Falls back to local scoring when no API key is
 * configured or the LLM returns an unusable response.
 *
 * The context object is what makes the ranking feel correct: the user's
 * profile + durable memory facts let Pro distinguish "client reply to my
 * outreach" (high) from "your application has been received" (low) even
 * when both contain similar keywords.
 */
import { config } from "../config.mjs";
import { moduleLogger } from "../logger.mjs";
import { localMessageAnalysis, normalizeMessageAnalysis } from "./scoring.mjs";

const log = moduleLogger("briefing.analysis");

/**
 * @param {Array<{ message: any, score: number }>} scoredMessages
 * @param {{ profileBlock?: string, memoryFacts?: string[] }} [context]
 */
export async function analyzeMessages(scoredMessages, context = {}) {
  const fallback = scoredMessages.map(({ message, score }) => localMessageAnalysis(message, score));
  if (!config.gemini || scoredMessages.length === 0) return fallback;

  const contextBlocks = [];
  if (context.profileBlock) {
    contextBlocks.push(`About the user:\n${context.profileBlock}`);
  }
  if (context.memoryFacts && context.memoryFacts.length > 0) {
    contextBlocks.push(
      `Durable facts about the user:\n${context.memoryFacts.map((f, i) => `  ${i + 1}. ${f}`).join("\n")}`,
    );
  }

  try {
    const text = await geminiGenerate(
      [
        "You rank emails by importance for a personal-operations assistant.",
        "Output ONLY JSON of shape: {\"emails\":[...]}. The array order must match the input.",
        "",
        "Each item must contain:",
        "  - urgencyScore: integer 1..99",
        "  - urgencyReason: one short sentence justifying the score",
        "  - summary: one sentence summary of the email",
        "  - draftReply: a concise actionable reply, or exactly \"No reply needed.\"",
        "  - category: one of [\"client_reply\",\"investor\",\"team\",\"customer\",\"recruiter\",\"application_confirm\",\"transactional\",\"newsletter\",\"automated\",\"other\"]",
        "",
        "Scoring rubric (calibrate against the user's profile, not generic):",
        "  85-99: direct reply from a key relationship (client / investor / manager / customer who is already in a thread), or a time-bounded ask that affects revenue / hiring / partnerships TODAY.",
        "  65-84: a question from a known person, a meeting confirmation needed today, a follow-up the user owes.",
        "  40-64: useful but not time-critical (team coordination, generic FYI from a known sender).",
        "  20-39: automated notifications that the user should glance at (calendar invites already-accepted, GitHub mentions, billing).",
        "  1-19: newsletters, marketing, social, application-received confirmations, and any pure \"thank you for submitting\" / \"we will get back to you\" messages.",
        "",
        "Strong negative signals: bulk sender domains, unsubscribe footers, \"no-reply\" From addresses, any \"your application has been received\" pattern — those should never score above 20 even if the subject sounds important.",
        "",
        contextBlocks.length > 0 ? contextBlocks.join("\n\n") + "\n" : "",
        `Emails JSON:\n${JSON.stringify(
          scoredMessages.map(({ message, score }) => ({
            fallbackUrgencyScore: score,
            from: `${message.senderName} <${message.senderEmail}>`,
            subject: message.subject,
            body: message.body,
            receivedAtHour: message.receivedAtHour,
            receivedAtMinute: message.receivedAtMinute,
          })),
          null,
          2,
        )}`,
      ].join("\n"),
      { temperature: 0.15, maxOutputTokens: 2400 },
    );
    const parsed = parseJSONFromText(text);
    const rows = Array.isArray(parsed.emails) ? parsed.emails : [];
    return scoredMessages.map(({ message, score }, index) => {
      const fallbackOne = localMessageAnalysis(message, score);
      const normalized = normalizeMessageAnalysis(rows[index] || {}, fallbackOne);
      // Preserve the new category tag (normalizeMessageAnalysis only
      // knows about the legacy fields). Clamp to known values.
      const category = typeof rows[index]?.category === "string" ? rows[index].category : "other";
      return { ...normalized, category };
    });
  } catch (error) {
    log.warn({ err: error }, "Gemini batch email analysis failed");
    return fallback;
  }
}

/**
 * Send a prompt to Gemini and return the textual content. Throws on missing
 * API key or non-2xx responses.
 *
 * @param {string} prompt
 * @param {{ temperature?: number, maxOutputTokens?: number }} [options]
 * @returns {Promise<string>}
 */
export async function geminiGenerate(prompt, options = {}) {
  if (!config.gemini) throw new Error("GEMINI_API_KEY is not configured");
  const apiKey = config.gemini.apiKey;
  // Default to Pro for analysis + assistant tool calling — Flash was
  // producing weak urgency rankings. Override via env to trade quality
  // for speed/cost (e.g. GEMINI_MODEL=gemini-2.5-flash).
  const model = process.env.GEMINI_MODEL || "gemini-2.5-pro";
  const modelName = model.startsWith("models/") ? model : `models/${model}`;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      // LLM generation is the slowest call in a briefing; without a bound a
      // stalled connection holds the request open indefinitely. Given more
      // room than other calls because generation legitimately takes longer.
      signal: AbortSignal.timeout(config.outboundTimeoutMs * 4),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: options.temperature ?? 0.2,
          maxOutputTokens: options.maxOutputTokens ?? 700,
        },
      }),
    },
  );

  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "gemini request failed");

  const text = (payload.candidates || [])
    .flatMap((/** @type {any} */ candidate) => candidate.content?.parts || [])
    .map((/** @type {any} */ part) => part.text || "")
    .join("\n")
    .trim();
  if (!text) throw new Error("gemini returned an empty answer");
  return text;
}

/**
 * Extract the first JSON object from a fenced-or-raw model response.
 *
 * @param {unknown} text
 */
export function parseJSONFromText(text) {
  const clean = String(text || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("gemini did not return JSON");
  return JSON.parse(clean.slice(start, end + 1));
}
