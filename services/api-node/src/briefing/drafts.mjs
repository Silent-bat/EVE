/**
 * Draft action handler: approve or reject a draft reply, optionally sending
 * it via Gmail when approved.
 */
import { httpError } from "../http/responses.mjs";
import { state } from "../storage/index.mjs";
import { dayKey } from "../utils/dates.mjs";
import { deliverApprovedReply } from "../google/email.mjs";

/**
 * @param {string} userID
 * @param {string} draftID
 * @param {{ action?: string, draftReply?: string }} input
 */
export async function actOnDraft(userID, draftID, input) {
  const action = input.action;
  if (action !== "approve" && action !== "reject") {
    throw httpError(400, "action must be approve or reject");
  }

  const briefing = state.briefings[userID]?.[dayKey(new Date())];
  if (!briefing) throw httpError(404, "briefing not found");

  const draft = briefing.emails.find((/** @type {any} */ email) => email.id === draftID);
  if (!draft) throw httpError(404, "draft not found");
  if (draft.status !== "pending") throw httpError(409, "draft already approved or rejected");

  const before = draft.draftReply;
  if (typeof input.draftReply === "string" && input.draftReply.trim()) {
    draft.draftReply = input.draftReply.trim();
  }
  draft.status = action === "approve" ? "approved" : "rejected";
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
  if ("error" in delivery && delivery.error) entry.deliveryError = delivery.error;

  state.audit[userID] ||= [];
  state.audit[userID].push(entry);
  return { draft, audit: entry, briefing };
}
