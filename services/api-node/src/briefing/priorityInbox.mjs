/**
 * Persistent priority inbox.
 *
 * Replaces the old "regenerate the briefing every poll" approach. The
 * store now holds a curated list of emails the user actually needs to
 * see — anything that crossed an urgency threshold when first analyzed.
 *
 * Each entry holds only the briefing-ready summary (no full body) so
 * the store stays small. For the full body the agent calls the
 * get_email_body tool.
 *
 * Lifecycle:
 *   - Poller upserts items above PRIORITY_THRESHOLD when they're first
 *     analyzed. Existing items get their status preserved.
 *   - Actions (approve/reject) update status in place.
 *   - Items older than MAX_AGE_DAYS get pruned on each upsert pass.
 *   - Items the user already saw N days ago that haven't been acted on
 *     are still kept (so the agent can search them via tools).
 */
import { state } from "../storage/index.mjs";

/**
 * Score at or above which a mail is admitted to the priority inbox at all.
 * Below this it is never stored, so it can never reach any screen.
 */
export const PRIORITY_THRESHOLD = Number(process.env.EVE_PRIORITY_THRESHOLD || 60);

/**
 * Score at or above which the UI calls a mail "High". Must stay in step with
 * `HIGH_SCORE` in apps/mobile/src/ui/components/cards/EmailCard.tsx: the app
 * chips each card from its own copy of this number and counts them from this
 * one, and when the two drifted apart nine cards marked HIGH sat under a tile
 * reading "0 urgent mail".
 */
export const HIGH_URGENCY = 55;

export const MAX_AGE_DAYS = Number(process.env.EVE_PRIORITY_INBOX_MAX_AGE_DAYS || 30);
export const MAX_ENTRIES = 200;

/**
 * @typedef {Object} PriorityEmail
 * @property {string} id                 draft-${gmailId}
 * @property {string} threadId
 * @property {string} senderName
 * @property {string} senderEmail
 * @property {string} subject
 * @property {string} summary
 * @property {number} urgencyScore
 * @property {string} urgencyReason
 * @property {string} category
 * @property {string} draftReply
 * @property {string} receivedAt
 * @property {string} addedAt
 * @property {"pending" | "approved" | "rejected" | "dismissed"} status
 */

/**
 * Read the user's priority inbox. Returns an empty array if the store
 * has never been written.
 *
 * @param {string} userID
 * @returns {PriorityEmail[]}
 */
export function listPriorityInbox(userID) {
  const user = state.users[userID];
  return Array.isArray(user?.priorityInbox) ? user.priorityInbox : [];
}

/**
 * Filter the inbox to a recency window. day = 36h, week = 7d, month =
 * 30d. Sorted by urgencyScore descending. Status filter optional.
 *
 * @param {string} userID
 * @param {{ range?: "day" | "week" | "month", status?: PriorityEmail["status"] }} opts
 */
export function readPriorityInbox(userID, opts = {}) {
  const range = opts.range || "day";
  const ms = range === "month" ? 30 * 86_400_000 : range === "week" ? 7 * 86_400_000 : 36 * 3_600_000;
  const cutoff = Date.now() - ms;
  const all = listPriorityInbox(userID);
  const filtered = all.filter((e) => {
    const t = Date.parse(e.receivedAt);
    if (Number.isFinite(t) && t < cutoff) return false;
    if (opts.status && e.status !== opts.status) return false;
    return true;
  });
  filtered.sort((a, b) => b.urgencyScore - a.urgencyScore);
  return filtered;
}

/**
 * Upsert a batch of newly-analyzed emails. Items below the threshold
 * are skipped entirely (we don't want a noisy store). Existing items
 * keep their status; everything else gets overwritten with the fresh
 * analysis (so re-analyzing a thread updates summary + score).
 *
 * @param {string} userID
 * @param {Array<Omit<PriorityEmail, "addedAt" | "status">>} freshEmails
 */
export function upsertPriorityInbox(userID, freshEmails) {
  const user = state.users[userID];
  if (!user) return [];
  /** @type {PriorityEmail[]} */
  const current = Array.isArray(user.priorityInbox) ? user.priorityInbox : [];
  const byId = new Map(current.map((e) => [e.id, e]));
  const nowISO = new Date().toISOString();

  for (const fresh of freshEmails) {
    if (typeof fresh.urgencyScore !== "number" || fresh.urgencyScore < PRIORITY_THRESHOLD) continue;
    const existing = byId.get(fresh.id);
    byId.set(fresh.id, {
      ...fresh,
      status: existing?.status || "pending",
      addedAt: existing?.addedAt || nowISO,
    });
  }

  // Prune by age + entry count.
  const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
  const merged = Array.from(byId.values())
    .filter((e) => {
      const t = Date.parse(e.receivedAt);
      return !Number.isFinite(t) || t >= cutoff;
    })
    .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
    .slice(0, MAX_ENTRIES);

  user.priorityInbox = merged;
  return merged;
}

/**
 * Mutate a single email's status (approve / reject / dismiss) in place.
 *
 * @param {string} userID
 * @param {string} id
 * @param {PriorityEmail["status"]} status
 */
export function setInboxStatus(userID, id, status) {
  const all = listPriorityInbox(userID);
  const target = all.find((e) => e.id === id);
  if (target) target.status = status;
  return target || null;
}

/**
 * Track which Gmail message IDs we've already analyzed so the poller
 * can skip them on subsequent passes. Stored as a flat array, capped.
 *
 * @param {string} userID
 * @returns {Set<string>}
 */
export function getKnownMessageIds(userID) {
  const user = state.users[userID];
  if (!Array.isArray(user?.knownMessageIds)) return new Set();
  return new Set(user.knownMessageIds);
}

/**
 * @param {string} userID
 * @param {Iterable<string>} ids
 */
export function rememberMessageIds(userID, ids) {
  const user = state.users[userID];
  if (!user) return;
  const set = new Set(user.knownMessageIds || []);
  for (const id of ids) set.add(id);
  // Cap so this doesn't grow unbounded. 2000 IDs ≈ a few months of inbox.
  user.knownMessageIds = Array.from(set).slice(-2000);
}
