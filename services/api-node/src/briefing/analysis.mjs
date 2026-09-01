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
import { GoogleResponseTooLargeError, readBoundedResponseJSON } from "../google/oauth.mjs";

export const DEFAULT_GEMINI_PROMPT_MAX_CHARS = 120_000;
const MAX_EMAIL_CONTEXT_CHARS = 8_000;
const MAX_PROFILE_CONTEXT_CHARS = 8_000;
const MAX_MEMORY_CONTEXT_CHARS = 500;

const log = moduleLogger("briefing.analysis");

/**
 * @param {Array<{ message: any, score: number }>} scoredMessages
 * @param {{ profileBlock?: string, memoryFacts?: string[] }} [context]
 */
export async function analyzeMessages(scoredMessages, context = {}) {
  const fallback = scoredMessages.map(({ message, score }) => localMessageAnalysis(message, score));
  if (!config.gemini || scoredMessages.length === 0) return fallback;

  try {
    const text = await geminiGenerate(buildAnalysisPrompt(scoredMessages, context), {
      temperature: 0.15,
      maxOutputTokens: 2400,
    });
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
  const maxPromptChars =
    Number.isSafeInteger(config.geminiPromptMaxChars) && config.geminiPromptMaxChars > 0
      ? config.geminiPromptMaxChars
      : DEFAULT_GEMINI_PROMPT_MAX_CHARS;
  if (typeof prompt !== "string" || prompt.length > maxPromptChars) {
    // Refuse oversized prompts instead of truncating them. Truncation can cut
    // away the authenticated user's instruction while leaving attacker-
    // controlled context at the front, and it still spends an unpredictable
    // amount of memory assembling the request body.
    throw new Error("gemini prompt exceeds the configured size limit");
  }
  const apiKey = config.gemini.apiKey;
  // Default to Pro for analysis + assistant tool calling — Flash was
  // producing weak urgency rankings. Override via env to trade quality
  // for speed/cost (e.g. GEMINI_MODEL=gemini-2.5-flash).
  const model = process.env.GEMINI_MODEL || "gemini-2.5-pro";
  const modelName = model.startsWith("models/") ? model : `models/${model}`;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent`,
    {
      method: "POST",
      // LLM generation is the slowest call in a briefing; without a bound a
      // stalled connection holds the request open indefinitely. Given more
      // room than other calls because generation legitimately takes longer.
      signal: AbortSignal.timeout(config.outboundTimeoutMs * 4),
      // Keep billable credentials out of URLs: reverse proxies and upstream
      // access logs routinely retain query strings for much longer than bodies.
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: options.temperature ?? 0.2,
          maxOutputTokens: options.maxOutputTokens ?? 700,
        },
      }),
    },
  );

  let payload;
  try {
    payload = await readBoundedResponseJSON(response, config.googleResponseMaxBytes);
  } catch (error) {
    if (error instanceof GoogleResponseTooLargeError) {
      throw new Error("gemini response too large");
    }
    throw new Error("gemini returned invalid JSON");
  }
  if (!response.ok) {
    const providerMessage = typeof payload?.error?.message === "string" ? payload.error.message : "";
    throw new Error(providerMessage.slice(0, 500) || "gemini request failed");
  }

  const text = (payload.candidates || [])
    .flatMap((/** @type {any} */ candidate) => candidate.content?.parts || [])
    .map((/** @type {any} */ part) => part.text || "")
    .join("\n")
    .trim();
  if (!text) throw new Error("gemini returned an empty answer");
  return text;
}

/**
 * Build a bounded prompt while retaining the input order required to map model
 * results back to messages. Bodies are the high-volume field, so they are
 * progressively shortened first; if a hostile profile or message list still
 * exceeds the cap, rows are omitted from the tail and receive local fallback
 * analysis rather than sending an invalid/truncated JSON document.
 *
 * @param {Array<{ message: any, score: number }>} scoredMessages
 * @param {{ profileBlock?: string, memoryFacts?: string[] }} context
 */
export function buildAnalysisPrompt(scoredMessages, context = {}) {
  const configured = Number(config.geminiPromptMaxChars);
  const maxChars =
    Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_GEMINI_PROMPT_MAX_CHARS;
  const instructions = [
    "You rank emails by importance for a personal-operations assistant.",
    'Output ONLY JSON of shape: {"emails":[...]}. The array order must match the input.',
    "",
    "Each item must contain:",
    "  - urgencyScore: integer 1..99",
    "  - urgencyReason: one short sentence justifying the score",
    "  - summary: one sentence summary of the email",
    '  - draftReply: a concise actionable reply, or exactly "No reply needed."',
    '  - category: one of ["client_reply","investor","team","customer","recruiter","application_confirm","transactional","newsletter","automated","other"]',
    "",
    "Scoring rubric (calibrate against the user's profile, not generic):",
    "  85-99: direct reply from a key relationship (client / investor / manager / customer who is already in a thread), or a time-bounded ask that affects revenue / hiring / partnerships TODAY.",
    "  65-84: a question from a known person, a meeting confirmation needed today, a follow-up the user owes.",
    "  40-64: useful but not time-critical (team coordination, generic FYI from a known sender).",
    "  20-39: automated notifications that the user should glance at (calendar invites already-accepted, GitHub mentions, billing).",
    '  1-19: newsletters, marketing, social, application-received confirmations, and any pure "thank you for submitting" / "we will get back to you" messages.',
    "",
    'Strong negative signals: bulk sender domains, unsubscribe footers, "no-reply" From addresses, any "your application has been received" pattern — those should never score above 20 even if the subject sounds important.',
  ];

  const profile =
    typeof context.profileBlock === "string" && context.profileBlock.trim()
      ? `About the user:\n${truncate(context.profileBlock, MAX_PROFILE_CONTEXT_CHARS)}`
      : "";
  const facts = Array.isArray(context.memoryFacts)
    ? context.memoryFacts
        .map((fact, index) => `  ${index + 1}. ${truncate(String(fact || ""), MAX_MEMORY_CONTEXT_CHARS)}`)
        .filter((line) => line.trim().length > 4)
        .join("\n")
    : "";
  const contextText = [profile, facts ? `Durable facts about the user:\n${facts}` : ""]
    .filter(Boolean)
    .join("\n\n");

  /**
   * @param {number} bodyChars
   * @param {Array<{ message: any, score: number }>} [rows]
   */
  /** @param {number} bodyChars @param {Array<{ message: any, score: number }>} [rows] */
  const makeRows = (bodyChars, rows = scoredMessages) =>
    rows.map(({ message, score }) => ({
      fallbackUrgencyScore: score,
      from: truncate(`${message.senderName || ""} <${message.senderEmail || ""}>`, 400),
      subject: truncate(message.subject, 600),
      body: truncate(message.body, bodyChars),
      receivedAtHour: message.receivedAtHour,
      receivedAtMinute: message.receivedAtMinute,
    }));
  /**
   * @param {Array<Record<string, unknown>>} rows
   * @param {boolean} [includeContext]
   */
  /** @param {any[]} rows @param {boolean} [includeContext] */
  const compose = (rows, includeContext = true) =>
    [
      ...instructions,
      includeContext && contextText ? contextText : "",
      `Emails JSON:\n${JSON.stringify(rows, null, 2)}`,
    ]
      .filter(Boolean)
      .join("\n");

  let bodyChars = MAX_EMAIL_CONTEXT_CHARS;
  let rows = makeRows(bodyChars);
  let prompt = compose(rows);
  while (prompt.length > maxChars && bodyChars > 0) {
    bodyChars = bodyChars > 1_000 ? Math.floor(bodyChars * 0.6) : Math.max(0, bodyChars - 200);
    rows = makeRows(bodyChars);
    prompt = compose(rows);
  }
  if (prompt.length <= maxChars) return prompt;

  // Profile/memory text is useful but less important than the mail metadata.
  prompt = compose(makeRows(0), false);
  if (prompt.length <= maxChars) return prompt;

  // Keep the prefix and a valid JSON array. Any omitted rows use the local
  // scorer in analyzeMessages, preserving a useful result under pressure.
  rows = makeRows(0);
  while (rows.length > 0 && compose(rows, false).length > maxChars) rows.pop();
  prompt = compose(rows, false);
  return prompt.length <= maxChars ? prompt : instructions.join("\n").slice(0, maxChars);
}

/** @param {unknown} value @param {number} maxChars */
function truncate(value, maxChars) {
  const text = String(value ?? "");
  if (text.length <= maxChars) return text;
  if (maxChars <= 16) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 14)} [truncated]`;
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
