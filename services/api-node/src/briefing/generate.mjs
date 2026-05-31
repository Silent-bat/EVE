/**
 * Briefing generation: combine Gmail + Calendar fetches with analysis, store
 * the result on the user's state.
 */
import { moduleLogger } from "../logger.mjs";
import { save, state } from "../storage/index.mjs";
import { addMinutes, atTime, dayKey, timeKey } from "../utils/dates.mjs";
import { fetchCalendarEvents, fetchGmailMessages } from "../google/api.mjs";
import { analyzeMessages } from "./analysis.mjs";
import { localMessageAnalysis, urgencyScore } from "./scoring.mjs";

const log = moduleLogger("briefing");

/**
 * @param {string} userID
 * @param {Date} now
 */
export async function generateBriefing(userID, now) {
  const generatedAt = atTime(now, 7, 45);
  const source = await briefingSource(userID, now);
  const scoredMessages = source.mailbox.map((/** @type {any} */ message) => ({
    message,
    score: urgencyScore(message),
  }));
  const analyses = await analyzeMessages(scoredMessages);
  const emails = scoredMessages.map(({ message, score }, index) => {
    const analysis = analyses[index] || localMessageAnalysis(message, score);
    return {
      id: `draft-${message.id}`,
      threadId: message.threadId,
      senderName: message.senderName,
      senderEmail: message.senderEmail,
      subject: message.subject,
      receivedAt: atTime(now, message.receivedAtHour, message.receivedAtMinute).toISOString(),
      urgencyScore: analysis.urgencyScore,
      urgencyReason: analysis.urgencyReason,
      summary: analysis.summary,
      draftReply: analysis.draftReply,
      status: "pending",
    };
  });

  /** @type {Record<string, any>} */
  const briefing = {
    id: `briefing-${dayKey(now)}`,
    userId: userID,
    generatedAt: generatedAt.toISOString(),
    stats: {
      priorityEmails: emails.filter((email) => email.urgencyScore >= 75).length,
      meetingsToday: source.calendar.length,
      approvedReplies: 0,
    },
    emails: emails.sort((a, b) => b.urgencyScore - a.urgencyScore),
    calendar: source.calendar.map((/** @type {any} */ event) => ({
      id: event.id,
      title: event.title,
      startsAt: atTime(now, event.startHour, event.startMinute).toISOString(),
      endsAt: addMinutes(atTime(now, event.startHour, event.startMinute), event.durationMinutes).toISOString(),
      location: event.location,
    })),
  };

  state.briefings[userID] ||= {};
  state.briefings[userID][dayKey(now)] = briefing;
  return briefing;
}

/**
 * Fetch Gmail + Calendar in parallel, tolerating one side failing.
 *
 * @param {string} userID
 * @param {Date} now
 */
export async function briefingSource(userID, now) {
  const user = state.users[userID];
  if (user?.connectionMode !== "google" || !user.googleTokens?.access_token) {
    return { mailbox: [], calendar: [] };
  }

  const [mailboxResult, calendarResult] = await Promise.allSettled([
    fetchGmailMessages(user, now),
    fetchCalendarEvents(user, now),
  ]);

  if (mailboxResult.status === "rejected") {
    log.warn({ err: mailboxResult.reason }, "Gmail fetch failed");
  }
  if (calendarResult.status === "rejected") {
    log.warn({ err: calendarResult.reason }, "Google Calendar fetch failed");
  }

  return {
    mailbox: mailboxResult.status === "fulfilled" ? mailboxResult.value : [],
    calendar: calendarResult.status === "fulfilled" ? calendarResult.value : [],
  };
}

/**
 * Fire off briefings for any user whose preferred time matches the current
 * wall-clock minute. Idempotent for the same minute.
 */
export async function runDueBriefings() {
  const now = new Date();
  let changed = false;
  for (const userID of Object.keys(state.users)) {
    const prefs = state.users[userID].preferences;
    if (!prefs?.briefingTime) continue;
    if (prefs.briefingTime !== timeKey(now)) continue;

    const today = dayKey(now);
    const existing = state.briefings[userID]?.[today];
    if (existing?.scheduledAt === today) continue;

    const briefing = await generateBriefing(userID, now);
    briefing.scheduledAt = today;
    changed = true;
  }
  if (changed) await save();
}
