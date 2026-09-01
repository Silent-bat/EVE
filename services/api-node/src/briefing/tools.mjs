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
import { dayKeyInZone } from "../utils/dates.mjs";
import { httpError } from "../http/responses.mjs";
import { normalizePreferences } from "../storage/state.mjs";
import { fetchGmailMessages, searchGmailMessages } from "../google/api.mjs";
import { persistDeviceNotification } from "../notifications/index.mjs";
import { getProactivePrefs, normalizeProactivePrefs } from "../notifications/proactive.mjs";

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
    description:
      "Reply conversationally without taking an action. Use when no other tool fits or when the user just asked a question.",
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
    args: {
      draftId: "string — the draft id (e.g. draft-12345)",
      draftReply: "optional string — overrides the suggested reply",
    },
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
  {
    name: "search_emails",
    description:
      "Search the user's Gmail using Gmail's q syntax. Use for anything the briefing doesn't already show: older emails, specific senders, specific topics. Returns up to 25 results with sender, subject, snippet, and receivedAt. Examples: 'from:sarah@acme.com', 'subject:contract newer_than:14d', 'is:unread label:investors'.",
    args: {
      query: "string — Gmail q= search expression",
      limit: "optional number — 1..25, default 10",
    },
  },
  {
    name: "remember",
    description:
      "Save a durable fact about the user that should persist across conversations (their role, recurring contacts, projects, preferences, schedule, anything they ask you to remember). Use one short factual sentence.",
    args: {
      fact: "string — one concise sentence",
      kind: "optional string — one of 'profile', 'contact', 'project', 'preference', 'general'",
    },
  },
  {
    name: "forget",
    description: "Remove a saved memory by its id.",
    args: { id: "string — the memory id" },
  },
];

/** Categories accepted in durable memory records. */
export const MEMORY_KINDS = Object.freeze(["profile", "contact", "project", "preference", "general"]);

/**
 * Keep memory categories bounded and predictable before they are persisted or
 * inserted into a model context. Unknown values are intentionally generic.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeMemoryKind(value) {
  const kind = typeof value === "string" ? value.trim().toLowerCase() : "";
  return MEMORY_KINDS.includes(kind) ? kind : "general";
}

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
 * Destructive or durable tools must be corroborated by the authenticated
 * user's current utterance. Model output alone is not authorization: an email
 * or notification can contain text that persuades a model to call a tool.
 *
 * @param {string} action
 * @param {unknown} userPrompt
 */
export function hasExplicitActionIntent(action, userPrompt) {
  const prompt = typeof userPrompt === "string" ? userPrompt.trim() : "";
  if (!prompt) return false;
  const lower = prompt.toLowerCase();
  // Look for a negation before the command, not only in the exact phrase
  // "don't approve". This also covers "I don't want you to send it" and
  // "there is no need to remember this".
  const negated =
    /\b(?:don't|do not|never|no longer|shouldn't|should not|cannot|can't|without)\b[^.!?]{0,80}\b(?:approve|send|deliver|reply|respond|reject|discard|remember|save|forget|change|update|set|enable|disable)\b/.test(
      lower,
    ) ||
    /\bno\s+need\s+to\b[^.!?]{0,40}\b(?:approve|send|deliver|reply|respond|reject|discard|remember|save|forget|change|update|set|enable|disable)\b/.test(
      lower,
    );
  if (negated) return false;
  switch (action) {
    case "approve_draft":
      return (
        /^(?:(?:please|kindly)\s+)?(?:approve|send|deliver|reply|respond)\b/.test(lower) ||
        /^(?:yes\s*,?\s*)?(?:approve|send|deliver|reply|respond)\b/.test(lower) ||
        /^(?:go ahead(?: and)?|you can|i approve|i want you to|i(?:'d| would) like you to|can you|could you|would you)\s+(?:approve|send|deliver|reply|respond)\b/.test(
          lower,
        )
      );
    case "reject_draft":
      return (
        /^(?:(?:please|kindly)\s+)?(?:reject|discard|decline)\b/.test(lower) ||
        /^(?:yes\s*,?\s*)?(?:reject|discard|decline)\b/.test(lower) ||
        /^(?:go ahead(?: and)?|you can|i (?:reject|decline)|i want you to|i(?:'d| would) like you to|can you|could you|would you)\s+(?:reject|discard|decline)\b/.test(
          lower,
        )
      );
    case "remember":
      return (
        /^(?:(?:please|kindly)\s+)?(?:remember|save|keep)\b/.test(lower) ||
        /^(?:i want you to|i(?:'d| would) like you to|can you|could you|would you)\s+(?:remember|save|keep)\b/.test(
          lower,
        )
      );
    case "forget":
      return (
        /^(?:(?:please|kindly)\s+)?(?:forget|remove|delete)\b/.test(lower) ||
        /^(?:i want you to|i(?:'d| would) like you to|can you|could you|would you)\s+(?:forget|remove|delete)\b/.test(
          lower,
        )
      );
    case "update_preferences":
      return (
        /^(?:(?:please|kindly)\s+)?(?:change|update|set|adjust|enable|disable|turn)\b/.test(lower) &&
        /\b(?:preferences?|settings?|timezone|briefing|notifications?|push|reminders?|quiet|schedule|proactive)\b/.test(
          lower,
        )
      );
    default:
      return true;
  }
}

/**
 * Execute a tool the model picked. Returns whatever the tool produced;
 * `null` for tools that mutate state without a useful response body.
 *
 * @param {string} userID
 * @param {{ name: string, args: Record<string, any> }} action
 * @param {{ userPrompt?: string }} [options]
 * @returns {Promise<unknown>}
 */
export async function runTool(userID, action, options = {}) {
  const name = String(action.name || "answer");
  const args = action.args && typeof action.args === "object" ? action.args : {};

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
      if (!hasExplicitActionIntent(name, options.userPrompt)) {
        throw httpError(400, "explicit user confirmation is required for draft actions");
      }
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
      if (!hasExplicitActionIntent(name, options.userPrompt)) {
        throw httpError(400, "explicit user instruction is required to change preferences");
      }
      const merged = normalizePreferences({ ...user.preferences, ...args });
      if (args.proactive !== undefined) {
        /** @type {any} */ (merged).proactive = normalizeProactivePrefs(
          args.proactive,
          getProactivePrefs(userID),
        );
      } else if (user.preferences?.proactive !== undefined) {
        /** @type {any} */ (merged).proactive = user.preferences.proactive;
      }
      user.preferences = merged;
      await save();
      return { preferences: user.preferences };
    }

    case "search_emails": {
      const user = state.users[userID];
      if (!user || user.connectionMode !== "google" || !user.googleTokens?.access_token) {
        throw httpError(400, "Gmail is not connected for this user");
      }
      const query = String(args.query || "").trim();
      if (!query) throw httpError(400, "query is required");
      if (query.length > 500) throw httpError(400, "query is too long");
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const results = await searchGmailMessages(user, { query, limit });
      return { query, count: results.length, results };
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

    case "remember": {
      if (!hasExplicitActionIntent(name, options.userPrompt)) {
        throw httpError(400, "explicit user instruction is required to save a memory");
      }
      const fact = String(args.fact || "").trim();
      if (!fact || fact.length > 500)
        throw httpError(400, "fact is required and must be at most 500 characters");
      const entry = rememberFact(userID, fact, args.kind);
      await save();
      return entry;
    }

    case "forget": {
      if (!hasExplicitActionIntent(name, options.userPrompt)) {
        throw httpError(400, "explicit user instruction is required to remove a memory");
      }
      const id = String(args.id || "");
      if (!id) throw httpError(400, "memory id is required");
      const removed = forgetFact(userID, id);
      await save();
      return { removed };
    }

    default:
      throw httpError(400, `unknown tool: ${name}`);
  }
}

const MAX_MEMORIES = 200;

/**
 * Append a fact to the user's memory list. Deduplicated by lowercase text.
 *
 * @param {string} userID
 * @param {string} fact
 * @param {string} kind
 */
export function rememberFact(userID, fact, kind) {
  const user = state.users[userID];
  if (!user) throw httpError(404, "user not found");
  user.memory ||= [];
  const lowered = fact.toLowerCase();
  const existing = user.memory.find((/** @type {any} */ m) => String(m.fact || "").toLowerCase() === lowered);
  if (existing) {
    // Migrate a legacy/custom category when a duplicate is encountered so an
    // old value cannot leak into a later model context.
    existing.kind = normalizeMemoryKind(existing.kind);
    return existing;
  }
  const entry = {
    id: `mem-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    fact,
    kind: normalizeMemoryKind(kind),
    createdAt: new Date().toISOString(),
  };
  user.memory.unshift(entry);
  user.memory = user.memory.slice(0, MAX_MEMORIES);
  return entry;
}

/**
 * Remove a memory by id. Returns true if anything was removed.
 *
 * @param {string} userID
 * @param {string} id
 */
export function forgetFact(userID, id) {
  const user = state.users[userID];
  if (!user?.memory) return false;
  const before = user.memory.length;
  user.memory = user.memory.filter((/** @type {any} */ m) => m.id !== id);
  return user.memory.length < before;
}

/**
 * Read the current memory list (newest first). Safe to call when memory is
 * uninitialized.
 *
 * @param {string} userID
 */
export function listMemory(userID) {
  return state.users[userID]?.memory || [];
}

/**
 * Append a short "system" notification visible in the device-notifications
 * tab. Used by the Gmail poller and the AI to surface async events.
 *
 * @param {string} userID
 * @param {{ title: string, body: string, data?: Record<string, unknown> }} input
 */
export async function appendSystemNotification(userID, input) {
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
  await persistDeviceNotification(event);
  return event;
}

/**
 * Helper for the dayKey of "today" — handy in tools that need to look at the
 * current briefing.
 */
export function todayKey(userID = "") {
  return dayKeyInZone(new Date(), state.users[userID]?.preferences?.timezone || "UTC");
}
