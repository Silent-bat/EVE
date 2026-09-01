/**
 * Gmail polling loop.
 *
 * Every 60s we sweep users; for each Google-connected user whose
 * lastGmailPollAt is older than POLL_INTERVAL_MS (default 15min), we:
 *
 *   1. Capture the priority inbox state + known-IDs count.
 *   2. Call generateBriefing(now) — this diff-first polls Gmail, fetches
 *      only new messages, analyzes them, upserts to the priority inbox,
 *      then assembles the briefing from the store.
 *   3. Diff the post-refresh priority inbox against the pre-refresh
 *      snapshot to detect genuinely new priority items.
 *   4. If there are new priority items, append a system notification so the
 *      mobile app surfaces it through the existing /v1/device-notifications
 *      tab.
 *   5. Update the user's gmailPoll bookkeeping and save.
 *
 * Idempotent: if the poller runs again within POLL_INTERVAL_MS it no-ops.
 */
import { moduleLogger } from "../logger.mjs";
import { dispatchProactive } from "../notifications/proactive.mjs";
import { BACKGROUND_SWEEP_LOCK, save, state, tryWithAdvisoryLock } from "../storage/index.mjs";
import { generateBriefing } from "./generate.mjs";
import { appendSystemNotification } from "./tools.mjs";
import { getKnownMessageIds, listPriorityInbox } from "./priorityInbox.mjs";

const log = moduleLogger("briefing.gmail-poller");

// 15 minutes by default. The previous 3h default felt broken on app open
// because new Gmail messages took up to 3h to surface; 15min is short
// enough that users perceive the inbox as "fresh", long enough to stay
// under the Gmail + Gemini cost budget.
export const POLL_INTERVAL_MS = Number(process.env.GMAIL_POLL_INTERVAL_MS || 15 * 60 * 1000);
export const SWEEP_INTERVAL_MS = Number(process.env.GMAIL_POLL_SWEEP_INTERVAL_MS || 60_000);
/**
 * Score at or above which a newly-arrived mail is worth a push notification.
 * Deliberately stricter than both the inbox admission floor and the score the
 * UI calls "High" — appearing in the list is cheap, buzzing a phone is not.
 * Was named PRIORITY_THRESHOLD, which shadowed the export of that name in
 * priorityInbox.mjs holding a different number.
 */
const NOTIFY_THRESHOLD = 75;

/**
 * Run one full sweep over users. Exported so tests + admin endpoints can
 * trigger it without waiting for the interval.
 *
 * @param {{ force?: boolean }} [opts]
 */
export async function sweepGmailPollers(opts = {}) {
  const locked = await tryWithAdvisoryLock(BACKGROUND_SWEEP_LOCK, async () => {
    const now = new Date();
    let changed = false;
    for (const userID of Object.keys(state.users)) {
      const user = state.users[userID];
      if (!user || user.connectionMode !== "google" || !user.googleTokens?.access_token) continue;

      const poll = (user.gmailPoll ||= {});
      const last = poll.lastPollAt ? Date.parse(poll.lastPollAt) : 0;
      const due = opts.force || !last || now.getTime() - last >= POLL_INTERVAL_MS;
      if (!due) continue;
      if (poll.inFlight) continue;

      poll.inFlight = true;
      try {
        await pollOne(userID, now);
        changed = true;
      } catch (error) {
        log.warn({ err: error, userID }, "gmail poll failed");
      } finally {
        poll.inFlight = false;
      }
    }
    if (changed) await save();
  });
  return locked.acquired;
}

/**
 * @param {string} userID
 * @param {Date} now
 */
async function pollOne(userID, now) {
  // Snapshot priority inbox and known-IDs count so we can detect what
  // arrived during this poll cycle.
  const beforePriorityIds = new Set(listPriorityInbox(userID).map((/** @type {any} */ e) => e.id));
  const beforeKnownCount = getKnownMessageIds(userID).size;

  const briefing = await generateBriefing(userID, now);

  const afterPriority = listPriorityInbox(userID);
  const newPriority = afterPriority.filter(
    (/** @type {any} */ e) => !beforePriorityIds.has(e.id) && e.urgencyScore >= NOTIFY_THRESHOLD,
  );
  const afterKnownCount = getKnownMessageIds(userID).size;
  const newEmailCount = Math.max(0, afterKnownCount - beforeKnownCount);

  const user = state.users[userID];
  user.gmailPoll.lastPollAt = now.toISOString();
  user.gmailPoll.lastPollCount = briefing.emails?.length || 0;
  user.gmailPoll.lastNewCount = newEmailCount;
  user.gmailPoll.lastNewPriorityCount = newPriority.length;

  let pushPayload = null;
  if (newPriority.length > 0) {
    const top = newPriority[0];
    pushPayload = {
      title: newPriority.length === 1 ? "1 new priority email" : `${newPriority.length} new priority emails`,
      body: `Top: "${top.subject}" from ${top.senderName || top.senderEmail}.`,
      data: { kind: "gmail.priority", count: newPriority.length },
    };
    await appendSystemNotification(userID, pushPayload);
  } else if (newEmailCount > 0) {
    pushPayload = {
      title: newEmailCount === 1 ? "1 new email" : `${newEmailCount} new emails`,
      body: "Gmail refreshed. Open EVE to review.",
      data: { kind: "gmail.new", count: newEmailCount },
    };
    await appendSystemNotification(userID, pushPayload);
  }

  if (pushPayload) {
    try {
      // Route background mail notifications through the same proactive gate as
      // every other interruption. This enforces the user's category choice,
      // quiet hours, and hourly/daily caps while still keeping the in-app
      // system notification above as the source of truth.
      await dispatchProactive(userID, {
        category: newPriority.length > 0 ? "urgent_email" : "briefing_ready",
        urgency: newPriority.length > 0 ? urgencyForScore(newPriority[0].urgencyScore) : "low",
        title: pushPayload.title,
        body: pushPayload.body,
        data: pushPayload.data,
      });
    } catch (error) {
      log.warn({ err: error, userID }, "proactive mail notification failed");
    }
  }

  log.info(
    {
      userID,
      newEmails: newEmailCount,
      newPriority: newPriority.length,
      total: briefing.emails?.length || 0,
    },
    "gmail poll done",
  );
}

/** @param {unknown} score */
function urgencyForScore(score) {
  const value = Number(score);
  if (value >= 90) return "critical";
  if (value >= 75) return "high";
  if (value >= 60) return "medium";
  return "low";
}

/**
 * Start the periodic sweeper. Returns a clearable handle so the shutdown
 * handler can stop it.
 */
export function startGmailPollerLoop() {
  const handle = setInterval(() => {
    void sweepGmailPollers().catch((err) => log.error({ err }, "sweep crashed"));
  }, SWEEP_INTERVAL_MS);
  log.info({ pollIntervalMs: POLL_INTERVAL_MS, sweepIntervalMs: SWEEP_INTERVAL_MS }, "gmail poller started");
  return handle;
}
