/**
 * Conversational assistant. Falls back to a local response when no LLM key.
 */
import { config } from "../config.mjs";
import { httpError } from "../http/responses.mjs";
import { moduleLogger } from "../logger.mjs";
import { save, state } from "../storage/index.mjs";
import { dayKey } from "../utils/dates.mjs";
import { geminiGenerate } from "./analysis.mjs";
import { generateBriefing } from "./generate.mjs";
import { sanitizePlainText } from "./scoring.mjs";

const log = moduleLogger("briefing.assistant");

/**
 * @param {string} userID
 * @param {{ prompt?: string }} input
 */
export async function askAssistant(userID, input) {
  const prompt = sanitizePlainText(input.prompt, 1200);
  if (!prompt) throw httpError(400, "prompt is required");

  const today = dayKey(new Date());
  if (!state.briefings[userID]?.[today]) {
    await generateBriefing(userID, new Date());
    await save();
  }

  const context = assistantContext(userID, today);
  const generatedAt = new Date().toISOString();
  if (config.gemini) {
    try {
      const answer = await geminiGenerate(
        [
          "You are EVE, a practical personal operations assistant.",
          "Answer the user's request using only the provided workspace context.",
          "If the data is missing, say what is missing and suggest the next concrete action.",
          "Be concise, specific, and never invent emails, meetings, people, or notifications.",
          "",
          `Workspace context JSON:\n${JSON.stringify(context, null, 2)}`,
          "",
          `User request: ${prompt}`,
        ].join("\n"),
        { temperature: 0.2, maxOutputTokens: 700 },
      );
      return { answer, source: "gemini", generatedAt };
    } catch (error) {
      log.warn({ err: error }, "Gemini assistant failed");
    }
  }

  return {
    answer: localAssistantAnswer(prompt, context),
    source: "local",
    generatedAt,
  };
}

/**
 * Build the workspace context the LLM (or local fallback) reasons over.
 *
 * @param {string} userID
 * @param {string} [briefingKey]
 */
export function assistantContext(userID, briefingKey = dayKey(new Date())) {
  const briefing = state.briefings[userID]?.[briefingKey] || null;
  return {
    now: new Date().toISOString(),
    user: {
      id: userID,
      email: state.users[userID]?.email || null,
      googleConnected: Boolean(state.users[userID]?.googleConnected),
    },
    briefing: briefing
      ? {
          generatedAt: briefing.generatedAt,
          stats: briefing.stats,
          emails: (briefing.emails || []).slice(0, 12).map((/** @type {any} */ email) => ({
            id: email.id,
            from: `${email.senderName} <${email.senderEmail}>`,
            subject: email.subject,
            receivedAt: email.receivedAt,
            urgencyScore: email.urgencyScore,
            urgencyReason: email.urgencyReason,
            summary: email.summary,
            draftReply: email.draftReply,
            status: email.status,
          })),
          calendar: (briefing.calendar || []).slice(0, 12),
        }
      : null,
    recentNotifications: (state.deviceNotifications?.[userID] || []).slice(0, 15).map((entry) => ({
      appName: entry.appName,
      packageName: entry.packageName,
      title: entry.title,
      body: entry.body,
      receivedAt: entry.receivedAt,
    })),
    recentAudit: (state.audit[userID] || []).slice(-15),
  };
}

/**
 * Deterministic fallback used when no LLM key is configured (or the LLM
 * fails). Pulled out of the legacy server.mjs verbatim.
 *
 * @param {string} prompt
 * @param {ReturnType<typeof assistantContext>} context
 */
export function localAssistantAnswer(prompt, context) {
  const emails = context.briefing?.emails || [];
  const pending = emails.filter((/** @type {any} */ email) => email.status === "pending");
  if (emails.length === 0) {
    return "I do not have Gmail briefing data yet. Connect Gmail, then refresh the briefing so I can answer from real mailbox data.";
  }

  const top = emails[0];
  const lowerPrompt = prompt.toLowerCase();
  if (lowerPrompt.includes("urgent") || lowerPrompt.includes("priority")) {
    return `Top priority: ${top.subject} from ${top.from}. ${top.summary} Reason: ${top.urgencyReason}`;
  }
  if (lowerPrompt.includes("reply") || lowerPrompt.includes("draft")) {
    return pending.length
      ? `There are ${pending.length} pending replies. The next draft is for "${pending[0].subject}": ${pending[0].draftReply}`
      : "There are no pending replies in the current briefing.";
  }
  return `I found ${emails.length} emails and ${context.briefing?.calendar?.length || 0} calendar items in the latest briefing. Ask about priorities, drafts, meetings, or notifications.`;
}
