/**
 * LLM-backed email analysis. Falls back to local scoring when no API key is
 * configured or the LLM returns an unusable response.
 */
import { config } from "../config.mjs";
import { moduleLogger } from "../logger.mjs";
import { localMessageAnalysis, normalizeMessageAnalysis } from "./scoring.mjs";

const log = moduleLogger("briefing.analysis");

/**
 * @param {Array<{ message: any, score: number }>} scoredMessages
 */
export async function analyzeMessages(scoredMessages) {
  const fallback = scoredMessages.map(({ message, score }) => localMessageAnalysis(message, score));
  if (!config.gemini || scoredMessages.length === 0) return fallback;

  try {
    const text = await geminiGenerate(
      [
        "Analyze these emails for a personal assistant briefing.",
        'Return only JSON with this shape: {"emails":[...]}',
        "The emails array must use the same order as the input.",
        'Each item must contain urgencyScore as a number from 1 to 99, urgencyReason as a short sentence, summary as one sentence, and draftReply as a concise reply or exactly "No reply needed."',
        "",
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
      { temperature: 0.15, maxOutputTokens: 1800 },
    );
    const parsed = parseJSONFromText(text);
    const rows = Array.isArray(parsed.emails) ? parsed.emails : [];
    return scoredMessages.map(({ message, score }, index) =>
      normalizeMessageAnalysis(rows[index] || {}, localMessageAnalysis(message, score)),
    );
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
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const modelName = model.startsWith("models/") ? model : `models/${model}`;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${apiKey}`,
    {
      method: "POST",
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
