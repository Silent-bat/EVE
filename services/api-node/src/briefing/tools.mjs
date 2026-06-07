/**
 * AI tool catalog and executor.
 *
 * The assistant picks a tool, the server executes it, the result + a final
 * sentence is returned. Every tool runs server-side scoped to the calling
 * user — the LLM never touches the database directly. When no tool fits the
 * user's intent, the model answers conversationally (action = "answer").
 */
import { actOnDraft } from "./drafts.mjs";
import { generateBriefing } from "./generate.mjs";
import { save, state } from "../storage/index.mjs";
import { dayKey } from "../utils/dates.mjs";
import { httpError } from "../http/responses.mjs";
import { normalizePreferences } from "../storage/state.mjs";
import { fetchGmailMessages } from "../google/api.mjs";

/**
 * Tool catalog handed to the model. Keep arg shapes simple so the LLM can
 * fill them without hallucinating types.
 *
 * @typedef {{ name: string, description: string, args: Record<string, string> }} ToolSpec
 */

/** @type {ToolSpec[]} */
export const TOOL_CATALOG = [
  {
    name: "answer",
    description: "Reply conversationally without taking an action. Use when no other tool fits or when the user just asked a question.",
    args: { text: "string — the answer to show the user" },
  },
  {
    name: "generate_briefing",
    description: "Refresh today's briefing from Gmail + Calendar and re-rank emails.",
    args: {},
  },
  {
    name: "approve_draft",
    description: "Approve a pending draft reply by id. Sends via Gmail if connected.",
    args: { draftId: "string — the draft id (e.g. draft-12345)", draftReply: "optional string — overrides the suggested reply" },
  },
  {
    name: "reject_draft",
    description: "Reject a pending draft reply by id.",
    args: { draftId: "string — the draft id" },
  },
  {
    name: "update_preferences",
    description: "Update the user's preferences. Use HH:MM for briefingTime, IANA strings for timezone.",
    args: {
      briefingTime: "optional string — HH:MM 24h",
      timezone: "optional string — IANA tz, e.g. Africa/Douala",
      pushEnabled: "optional boolean",
    },
  },
  {
    name: "refresh_gmail",
    description: "Pull recent Gmail messages now (does not re-rank — that's generate_briefing).",
    args: {},
  },
];

/**
 * Plain-English summary of the catalog used in the planner prompt.
 */
export function toolCatalogPrompt() {
  return TOOL_CATALOG.map((t) => {
    const argList = Object.entries(t.args)
      .map(([k, v]) => `    "${k}": (${v})`)
      .join(",\n");
    return `- ${t.name}: ${t.description}\n  args:\n${argList || "    (none)"}`;
  }).join("\n");
}

/**
 * Execute a tool the model picked. Returns whatever the tool produced;
 * `null` for tools that mutate state without a useful response body.
 *
 * @param {string} userID
 * @param {{ name: string, args: Record<string, any> }} action
 * @returns {Promise<unknown>}
 */
export async function runTool(userID, action) {
  const name = String(action.name || "answer");
  const args = action.args || {};

  switch (name) {
    case "answer":
      return null;

    case "generate_briefing": {
      const briefing = await generateBriefing(userID, new Date());
      await save();
      return {
        generatedAt: briefing.generatedAt,
        priorityEmails: briefing.stats.priorityEmails,
        meetingsToday: briefing.stats.meetingsToday,
        emails: briefing.emails.length,
      };
    }

    case "approve_draft":
    case "reject_draft": {
      const draftId = String(args.draftId || "");
      if (!draftId) throw httpError(400, "draftId is required");
      const result = await actOnDraft(userID, draftId, {
        action: name === "approve_draft" ? "approve" : "reject",
        draftReply: typeof args.draftReply === "string" ? args.draftReply : undefined,
      });
      await save();
      return {
        action: name === "approve_draft" ? "approve" : "reject",
        subject: result.draft.subject,
        deliveryStatus: result.audit.deliveryStatus,
      };
    }

    case "update_preferences": {
      const user = state.users[userID];
      if (!user) throw httpError(404, "user not found");
      user.preferences = normalizePreferences({ ...user.preferences, ...args });
      await save();
      return { preferences: user.preferences };
    }

    case "refresh_gmail": {
      const user = state.users[userID];
      if (!user || user.connectionMode !== "google" || !user.googleTokens?.access_token) {
        throw httpError(400, "Gmail is not connected for this user");
      }
      const now = new Date();
      const messages = await fetchGmailMessages(user, now);
      user.gmailPoll ||= {};
      user.gmailPoll.lastFetchedAt = now.toISOString();
      user.gmailPoll.lastFetchedCount = messages.length;
      await save();
      return { fetched: messages.length, at: now.toISOString() };
    }

    default:
      throw httpError(400, `unknown tool: ${name}`);
  }
}

/**
 * Append a short "system" notification visible in the device-notifications
 * tab. Used by the Gmail poller and the AI to surface async events.
 *
 * @param {string} userID
 * @param {{ title: string, body: string }} input
 */
export function appendSystemNotification(userID, input) {
  state.deviceNotifications ||= {};
  state.deviceNotifications[userID] ||= [];
  const event = {
    id: `eve-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    userId: userID,
    packageName: "com.eve.agent",
    appName: "EVE",
    title: input.title,
    body: input.body,
    postedAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    raw: { source: "eve.system" },
  };
  state.deviceNotifications[userID].unshift(event);
  state.deviceNotifications[userID] = state.deviceNotifications[userID].slice(0, 100);
  return event;
}

/**
 * Helper for the dayKey of "today" — handy in tools that need to look at the
 * current briefing.
 */
export function todayKey() {
  return dayKey(new Date());
}
