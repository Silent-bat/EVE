/**
 * Gmail polling loop.
 *
 * Every 60s we sweep users; for each Google-connected user whose
 * lastGmailPollAt is older than POLL_INTERVAL_MS (default 3h), we:
 *
 *   1. Re-run generateBriefing(now) — this fetches Gmail + Calendar and
 *      re-ranks via Gemini analysis (or local fallback).
 *   2. Compare the new high-priority set to the previously-known one.
 *   3. If there are new priority items, append a system notification so the
 *      mobile app surfaces it through the existing /v1/device-notifications
 *      tab.
 *   4. Update the user's gmailPoll bookkeeping and save.
 *
 * Idempotent: if the poller runs again within POLL_INTERVAL_MS it no-ops.
 */
import { moduleLogger } from "../logger.mjs";
import { save, state } from "../storage/index.mjs";
import { dayKey } from "../utils/dates.mjs";
import { generateBriefing } from "./generate.mjs";
import { appendSystemNotification } from "./tools.mjs";

const log = moduleLogger("briefing.gmail-poller");

export const POLL_INTERVAL_MS = Number(process.env.GMAIL_POLL_INTERVAL_MS || 3 * 60 * 60 * 1000);
export const SWEEP_INTERVAL_MS = Number(process.env.GMAIL_POLL_SWEEP_INTERVAL_MS || 60_000);
const PRIORITY_THRESHOLD = 75;

/**
 * Run one full sweep over users. Exported so tests + admin endpoints can
 * trigger it without waiting for the interval.
 *
 * @param {{ force?: boolean }} [opts]
 */
export async function sweepGmailPollers(opts = {}) {
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
}

/**
 * @param {string} userID
 * @param {Date} now
 */
async function pollOne(userID, now) {
  const today = dayKey(now);
  const before = state.briefings[userID]?.[today];
  const knownIds = new Set((before?.emails || []).map((/** @type {any} */ e) => e.id));
  const knownPriorityIds = new Set(
    (before?.emails || [])
      .filter((/** @type {any} */ e) => e.urgencyScore >= PRIORITY_THRESHOLD)
      .map((/** @type {any} */ e) => e.id),
  );

  const briefing = await generateBriefing(userID, now);
  const newEmails = (briefing.emails || []).filter(
    (/** @type {any} */ e) => !knownIds.has(e.id),
  );
  const newPriority = (briefing.emails || []).filter(
    (/** @type {any} */ e) => e.urgencyScore >= PRIORITY_THRESHOLD && !knownPriorityIds.has(e.id),
  );

  const user = state.users[userID];
  user.gmailPoll.lastPollAt = now.toISOString();
  user.gmailPoll.lastPollCount = briefing.emails?.length || 0;
  user.gmailPoll.lastNewCount = newEmails.length;
  user.gmailPoll.lastNewPriorityCount = newPriority.length;

  if (newPriority.length > 0) {
    const top = newPriority[0];
    appendSystemNotification(userID, {
      title:
        newPriority.length === 1
          ? "1 new priority email"
          : `${newPriority.length} new priority emails`,
      body: `Top: "${top.subject}" from ${top.senderName || top.senderEmail}.`,
    });
  } else if (newEmails.length > 0) {
    appendSystemNotification(userID, {
      title:
        newEmails.length === 1 ? "1 new email" : `${newEmails.length} new emails`,
      body: "Gmail refreshed. Open EVE to review.",
    });
  }

  log.info(
    {
      userID,
      newEmails: newEmails.length,
      newPriority: newPriority.length,
      total: briefing.emails?.length || 0,
    },
    "gmail poll done",
  );
}

/**
 * Start the periodic sweeper. Returns a clearable handle so the shutdown
 * handler can stop it.
 */
export function startGmailPollerLoop() {
  const handle = setInterval(() => {
    void sweepGmailPollers().catch((err) => log.error({ err }, "sweep crashed"));
  }, SWEEP_INTERVAL_MS);
  log.info(
    { pollIntervalMs: POLL_INTERVAL_MS, sweepIntervalMs: SWEEP_INTERVAL_MS },
    "gmail poller started",
  );
  return handle;
}
