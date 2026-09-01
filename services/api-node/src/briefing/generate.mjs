/**
 * Briefing generation: diff-first Gmail polling + persistent priority inbox
 * + Calendar fetches. The briefing is assembled from the priority inbox
 * store so it reflects the latest known state without re-fetching every
 * email on every call.
 */
import { moduleLogger } from "../logger.mjs";
import { BACKGROUND_SWEEP_LOCK, save, state, tryWithAdvisoryLock } from "../storage/index.mjs";
import { addMinutes, atTimeInZone, dayKeyInZone, timeKeyInZone } from "../utils/dates.mjs";
import { fetchCalendarEvents, fetchGmailMessagesByIds, listGmailMessageIds } from "../google/api.mjs";
import { analyzeMessages } from "./analysis.mjs";
import { localMessageAnalysis, urgencyScore } from "./scoring.mjs";
import { getProfile, hasProfile, profileBlock } from "../profile/index.mjs";
import { listMemory } from "./tools.mjs";
import {
  getKnownMessageIds,
  HIGH_URGENCY,
  readPriorityInbox,
  rememberMessageIds,
  upsertPriorityInbox,
} from "./priorityInbox.mjs";

const log = moduleLogger("briefing");
const MAX_BRIEFING_ENTRIES = 120;
const BRIEFING_RETENTION_DAYS = 45;

/**
 * Generate (or refresh) the user's briefing.
 *
 * Gmail uses a diff-first flow:
 *   1. List INBOX message IDs only (~1KB response).
 *   2. Diff against the known-IDs set — skip everything already analyzed.
 *   3. Fetch full bodies + analyze only the new messages.
 *   4. Upsert results above the urgency threshold into the persistent
 *      priority inbox (existing items keep their status).
 *   5. Remember all IDs for the next diff.
 *
 * Calendar is fetched fresh every call (one cheap API request).
 *
 * The briefing's `emails` array is read from the priority inbox store,
 * so it reflects approvals/rejections made since the last generation.
 *
 * @param {string} userID
 * @param {Date} now
 * @param {{ range?: "day" | "week" | "month" }} [opts]
 */
export async function generateBriefing(userID, now, opts = {}) {
  const range = opts.range === "week" || opts.range === "month" ? opts.range : "day";
  const user = state.users[userID];
  const timezone = user?.preferences?.timezone || "UTC";
  const generatedAt = atTimeInZone(now, 7, 45, timezone);

  // --- Gmail: diff-first poll -------------------------------------------
  if (user?.connectionMode === "google" && user.googleTokens?.access_token) {
    try {
      await refreshPriorityInbox(user, userID, range);
    } catch (err) {
      log.warn({ err, userID }, "gmail diff-first poll failed");
    }
  }

  // --- Calendar: fresh every time ---------------------------------------
  /** @type {any[]} */
  let calendar = [];
  if (user?.connectionMode === "google" && user.googleTokens?.access_token) {
    try {
      calendar = await fetchCalendarEvents(user, now);
    } catch (err) {
      log.warn({ err, userID }, "Google Calendar fetch failed");
    }
  }

  // --- Assemble briefing from priority inbox + calendar -----------------
  const emails = readPriorityInbox(userID, { range });

  /** @type {Record<string, any>} */
  const briefing = {
    id: `briefing-${dayKeyInZone(now, timezone)}-${range}`,
    userId: userID,
    range,
    generatedAt: generatedAt.toISOString(),
    stats: {
      // HIGH_URGENCY, not a literal: this is the number the app puts on a tile
      // labelled "urgent mail", directly above cards it chips "High" using the
      // same cutoff. Any other value here makes the two disagree on screen.
      priorityEmails: emails.filter((email) => email.urgencyScore >= HIGH_URGENCY).length,
      meetingsToday: calendar.length,
      approvedReplies: emails.filter((email) => email.status === "approved").length,
    },
    emails,
    calendar: calendar.map((event) => ({
      id: event.id,
      title: event.title,
      startsAt: atTimeInZone(now, event.startHour, event.startMinute, timezone).toISOString(),
      endsAt: addMinutes(
        atTimeInZone(now, event.startHour, event.startMinute, timezone),
        event.durationMinutes,
      ).toISOString(),
      location: event.location,
    })),
  };

  state.briefings[userID] ||= {};
  const cacheDay = dayKeyInZone(now, timezone);
  const cacheKey = range === "day" ? cacheDay : `${cacheDay}:${range}`;
  state.briefings[userID][cacheKey] = briefing;
  pruneBriefingHistory(userID, now);
  return briefing;
}

/**
 * Keep the durable cache bounded even when the user never opens the app. A
 * briefing is a rendered snapshot, not the source of truth (priorityInbox and
 * the calendar provider are), so old snapshots can be discarded safely.
 *
 * @param {string} userID
 * @param {Date} now
 */
function pruneBriefingHistory(userID, now) {
  const history = state.briefings[userID];
  if (!history || typeof history !== "object" || Array.isArray(history)) return;
  const cutoff = now.getTime() - BRIEFING_RETENTION_DAYS * 86_400_000;
  const entries = Object.entries(history)
    .filter(([, briefing]) => {
      const generatedAt = Date.parse(String(briefing?.generatedAt || ""));
      if (Number.isFinite(generatedAt)) return generatedAt >= cutoff;
      const keyDate = Date.parse(String(briefing?.id || "").match(/briefing-(\d{4}-\d{2}-\d{2})/)?.[1] || "");
      return !Number.isFinite(keyDate) || keyDate >= cutoff;
    })
    .sort(([, left], [, right]) => {
      const a = Date.parse(String(left?.generatedAt || ""));
      const b = Date.parse(String(right?.generatedAt || ""));
      return (Number.isFinite(b) ? b : 0) - (Number.isFinite(a) ? a : 0);
    });
  state.briefings[userID] = Object.fromEntries(entries.slice(0, MAX_BRIEFING_ENTRIES));
}

/**
 * Diff-first Gmail poll. Lists message IDs, fetches + analyzes only the
 * ones we haven't seen before, and upserts the results into the
 * persistent priority inbox.
 *
 * @param {any} user
 * @param {string} userID
 * @param {"day" | "week" | "month"} range
 */
async function refreshPriorityInbox(user, userID, range) {
  const knownIds = getKnownMessageIds(userID);
  const allMessages = await listGmailMessageIds(user, { range });
  const newIds = allMessages.filter((m) => !knownIds.has(m.id)).map((m) => m.id);

  if (newIds.length === 0) {
    // There is nothing to fetch, so the listing itself confirms these IDs are
    // still valid and can refresh the bounded retention window.
    rememberMessageIds(
      userID,
      allMessages.map((m) => m.id),
    );
    return;
  }

  const messages = await fetchGmailMessagesByIds(user, newIds);
  if (messages.length === 0) return;

  const scoredMessages = messages.map((message) => ({
    message,
    score: urgencyScore(message),
  }));

  const profile = getProfile(userID);
  const memory = listMemory(userID);
  const analyses = await analyzeMessages(scoredMessages, {
    profileBlock: hasProfile(profile) ? profileBlock(profile) : "",
    memoryFacts: memory.map((/** @type {any} */ m) => String(m.fact || "")).filter(Boolean),
  });

  const freshEmails = scoredMessages.map(({ message, score }, index) => {
    const analysis = analyses[index] || localMessageAnalysis(message, score);
    return {
      id: `draft-${message.id}`,
      threadId: message.threadId,
      senderName: message.senderName,
      senderEmail: message.senderEmail,
      subject: message.subject,
      receivedAt: message.receivedAt || new Date().toISOString(),
      urgencyScore: analysis.urgencyScore,
      urgencyReason: analysis.urgencyReason,
      summary: analysis.summary,
      draftReply: analysis.draftReply,
      category:
        typeof (/** @type {any} */ (analysis).category) === "string"
          ? /** @type {any} */ (analysis).category
          : "other",
    };
  });

  upsertPriorityInbox(userID, freshEmails);
  // Only acknowledge IDs whose full message was actually fetched. A transient
  // Gmail outage must leave failed IDs eligible for the next poll.
  rememberMessageIds(
    userID,
    messages.map((message) => message.id),
  );
}

/**
 * Fire off briefings for any user whose preferred time matches the current
 * wall-clock minute. Idempotent for the same minute.
 */
export async function runDueBriefings() {
  const locked = await tryWithAdvisoryLock(BACKGROUND_SWEEP_LOCK, async () => {
    const now = new Date();
    let changed = false;
    for (const userID of Object.keys(state.users)) {
      const prefs = state.users[userID].preferences;
      if (!prefs?.briefingTime) continue;
      const timezone = prefs.timezone || "UTC";
      if (prefs.briefingTime !== timeKeyInZone(now, timezone)) continue;

      const today = dayKeyInZone(now, timezone);
      const existing = state.briefings[userID]?.[today];
      if (existing?.scheduledAt === today) continue;

      const briefing = await generateBriefing(userID, now);
      briefing.scheduledAt = today;
      changed = true;
    }
    if (changed) await save();
  });
  return locked.acquired;
}
