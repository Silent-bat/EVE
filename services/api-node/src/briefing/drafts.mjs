/**
 * Draft action handler: approve or reject a draft reply, optionally sending
 * it via Gmail when approved.
 *
 * Mutates both the cached briefing AND the persistent priority inbox so
 * the status survives a briefing regeneration.
 */
import { httpError } from "../http/responses.mjs";
import { state } from "../storage/index.mjs";
import { dayKeyInZone } from "../utils/dates.mjs";
import { deliverApprovedReply } from "../google/email.mjs";
import { setInboxStatus } from "./priorityInbox.mjs";

/** One in-flight action per user/draft prevents duplicate real-world sends. */
const inFlight = new Map();
const MAX_AUDIT_ENTRIES = 500;

/**
 * @param {string} userID
 * @param {string} draftID
 * @param {{ action?: string, draftReply?: string, idempotencyKey?: string }} input
 */
export async function actOnDraft(userID, draftID, input) {
  const lockKey = `${userID}:${draftID}`;
  if (inFlight.has(lockKey)) throw httpError(409, "draft action is already in progress");
  const operation = actOnDraftUnsafe(userID, draftID, input);
  inFlight.set(lockKey, operation);
  try {
    return await operation;
  } finally {
    inFlight.delete(lockKey);
  }
}

/** @param {string} userID @param {string} draftID @param {{ action?: string, draftReply?: string, idempotencyKey?: string }} input */
async function actOnDraftUnsafe(userID, draftID, input) {
  const action = input.action;
  if (action !== "approve" && action !== "reject") {
    throw httpError(400, "action must be approve or reject");
  }

  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);

  const briefing =
    state.briefings[userID]?.[dayKeyInZone(new Date(), state.users[userID]?.preferences?.timezone || "UTC")];
  if (!briefing) throw httpError(404, "briefing not found");

  const draft = briefing.emails.find((/** @type {any} */ email) => email.id === draftID);
  if (!draft) throw httpError(404, "draft not found");

  // A gateway retry after a successful send must return the original result,
  // not enter the delivery path a second time. Reusing the same key for a
  // different operation is rejected so a client cannot accidentally turn a
  // stale key into an unrelated approval.
  if (idempotencyKey) {
    const prior = (state.audit[userID] || []).find(
      (/** @type {any} */ entry) => entry?.idempotencyKey === idempotencyKey,
    );
    if (prior) {
      if (prior.draftId !== draftID || prior.action !== action) {
        throw httpError(409, "idempotency key was already used for another draft action");
      }
      return { draft, audit: prior, briefing };
    }
  }
  if (draft.status !== "pending") throw httpError(409, "draft already approved or rejected");

  const before = draft.draftReply;
  if (typeof input.draftReply === "string" && input.draftReply.trim()) {
    draft.draftReply = input.draftReply.trim();
  }
  const newStatus = action === "approve" ? "approved" : "rejected";
  draft.status = newStatus;
  // Persist the caller's operation id in the audit record. It gives a gateway
  // or a future durable worker a stable idempotency key if delivery is retried.
  if (idempotencyKey) draft.actionId = idempotencyKey;
  setInboxStatus(userID, draftID, newStatus);
  briefing.stats.approvedReplies = briefing.emails.filter(
    (/** @type {any} */ email) => email.status === "approved",
  ).length;
  const delivery = action === "approve" ? await deliverApprovedReply(userID, draft) : { status: "not-sent" };

  /** @type {Record<string, unknown>} */
  const entry = {
    id: `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    userId: userID,
    draftId: draft.id,
    action,
    subject: draft.subject,
    createdAt: new Date().toISOString(),
    before,
    after: draft.draftReply,
    deliveryStatus: delivery.status,
  };
  if (idempotencyKey) entry.idempotencyKey = idempotencyKey;
  if ("error" in delivery && delivery.error) entry.deliveryError = delivery.error;

  state.audit[userID] ||= [];
  state.audit[userID].push(entry);
  if (state.audit[userID].length > MAX_AUDIT_ENTRIES) {
    state.audit[userID] = state.audit[userID].slice(-MAX_AUDIT_ENTRIES);
  }
  return { draft, audit: entry, briefing };
}

/** @param {unknown} value */
function normalizeIdempotencyKey(value) {
  if (typeof value !== "string") return "";
  const key = value.trim();
  return key ? key.slice(0, 160) : "";
}
