/**
 * Conversational + tool-using assistant.
 *
 * Flow:
 *   1. Sanitize the prompt and assemble workspace context.
 *   2. Ask Gemini to either answer or pick exactly one tool with args.
 *   3. Execute the tool (server-side, scoped to userID).
 *   4. Ask Gemini for a short user-facing summary of the result.
 *   5. Return { answer, action, result, source }.
 *
 * Falls back to a deterministic local response when no LLM key is configured
 * or the model returns garbage.
 */
import { config } from "../config.mjs";
import { httpError } from "../http/responses.mjs";
import { moduleLogger } from "../logger.mjs";
import { save, state } from "../storage/index.mjs";
import { dayKey } from "../utils/dates.mjs";
import { geminiGenerate, parseJSONFromText } from "./analysis.mjs";
import { generateBriefing } from "./generate.mjs";
import { sanitizePlainText } from "./scoring.mjs";
import { runTool, TOOL_CATALOG, toolCatalogPrompt } from "./tools.mjs";

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

  if (!config.gemini) {
    return {
      answer: localAssistantAnswer(prompt, context),
      action: { name: "answer", args: {} },
      result: null,
      source: "local",
      generatedAt,
    };
  }

  let action = /** @type {{ name: string, args: Record<string, any> }} */ ({ name: "answer", args: {} });
  try {
    action = await planAction(prompt, context);
  } catch (error) {
    log.warn({ err: error }, "Gemini planner failed");
    return {
      answer: localAssistantAnswer(prompt, context),
      action: { name: "answer", args: {} },
      result: null,
      source: "local",
      generatedAt,
    };
  }

  let result = null;
  try {
    result = await runTool(userID, action);
  } catch (error) {
    log.warn({ err: error, tool: action.name }, "tool failed");
    const message = error instanceof Error ? error.message : "tool failed";
    return {
      answer: `I tried to run "${action.name}" but it failed: ${message}.`,
      action,
      result: null,
      source: "gemini",
      generatedAt,
    };
  }

  let answer = "";
  if (action.name === "answer" && typeof action.args.text === "string" && action.args.text.trim()) {
    answer = action.args.text.trim();
  } else {
    try {
      answer = await summarizeResult(prompt, action, result);
    } catch (error) {
      log.warn({ err: error }, "Gemini summary failed");
      answer = describeResultLocally(action, result);
    }
  }

  return { answer, action, result, source: "gemini", generatedAt };
}

/**
 * @param {string} prompt
 * @param {ReturnType<typeof assistantContext>} context
 */
async function planAction(prompt, context) {
  const text = await geminiGenerate(
    [
      "You are EVE, a personal operations assistant. Decide whether to take an action or answer.",
      "Return ONLY valid JSON of shape: {\"name\":\"<tool>\",\"args\":{...}}.",
      "Pick exactly one tool from this catalog:",
      "",
      toolCatalogPrompt(),
      "",
      "Guidance:",
      '- Use "answer" with {"text": "..."} when the user just wants information.',
      "- Never invent ids; if you need a draftId, use one from the briefing emails in context.",
      "- For approve_draft / reject_draft, only pick drafts whose status is \"pending\".",
      "",
      `Workspace context JSON:\n${JSON.stringify(context, null, 2)}`,
      "",
      `User request: ${prompt}`,
    ].join("\n"),
    { temperature: 0.15, maxOutputTokens: 400 },
  );
  const parsed = /** @type {any} */ (parseJSONFromText(text));
  const name = String(parsed?.name || "answer");
  if (!TOOL_CATALOG.some((t) => t.name === name)) {
    return { name: "answer", args: { text: typeof parsed?.text === "string" ? parsed.text : "" } };
  }
  return { name, args: parsed?.args && typeof parsed.args === "object" ? parsed.args : {} };
}

/**
 * @param {string} prompt
 * @param {{ name: string, args: Record<string, any> }} action
 * @param {unknown} result
 */
async function summarizeResult(prompt, action, result) {
  const text = await geminiGenerate(
    [
      "You are EVE. The user asked for something, you took an action on their behalf, and now you must briefly confirm what happened.",
      "Be concise (one or two short sentences). Refer to the result data when relevant.",
      "Do NOT invent details — only reference what is in the result.",
      "",
      `User request: ${prompt}`,
      `Action taken: ${action.name}`,
      `Result JSON: ${JSON.stringify(result)}`,
    ].join("\n"),
    { temperature: 0.2, maxOutputTokens: 200 },
  );
  return text.trim();
}

/**
 * Local fallback when Gemini can't summarize the tool result.
 *
 * @param {{ name: string, args: Record<string, any> }} action
 * @param {any} result
 */
function describeResultLocally(action, result) {
  switch (action.name) {
    case "generate_briefing":
      return `Refreshed today's briefing — ${result?.priorityEmails ?? 0} priority emails and ${result?.meetingsToday ?? 0} meetings.`;
    case "approve_draft":
      return `Approved the draft for "${result?.subject ?? "the email"}" (${result?.deliveryStatus ?? "recorded"}).`;
    case "reject_draft":
      return `Rejected the draft for "${result?.subject ?? "the email"}".`;
    case "update_preferences":
      return "Preferences updated.";
    case "refresh_gmail":
      return `Pulled ${result?.fetched ?? 0} Gmail messages.`;
    default:
      return "Done.";
  }
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
 * fails).
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
