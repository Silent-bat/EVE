/**
 * Reading one whole email.
 *
 * The priority inbox deliberately stores only a summary — a few hundred
 * bytes per mail instead of a few kilobytes — which is right for a list but
 * wrong the moment someone taps a row and expects the message. Bodies are
 * therefore pulled from Gmail on demand and never persisted.
 *
 * IDs arriving here are the ones the app already holds: `draft-<gmailId>`,
 * minted in generate.mjs. The Gmail id is the part after the prefix.
 */
import { fetchGmailMessageBody } from "../google/api.mjs";
import { httpError } from "../http/responses.mjs";
import { moduleLogger } from "../logger.mjs";
import { state } from "../storage/index.mjs";
import { listPriorityInbox } from "./priorityInbox.mjs";

const log = moduleLogger("briefing.messages");

/**
 * Strip the `draft-` prefix the app knows an email by. Raw Gmail ids are
 * accepted too, so a caller holding either kind works.
 *
 * @param {string} emailID
 */
export function gmailIDFor(emailID) {
  const id = String(emailID || "").trim();
  return id.startsWith("draft-") ? id.slice("draft-".length) : id;
}

/**
 * One email as the detail view needs it: the stored summary fields, plus the
 * body when Gmail gave us one.
 *
 * Declared as a single shape rather than left to inference. The three return
 * paths below build slightly different objects, and without this the caller
 * sees a union it has to narrow before touching `subject` — which is every
 * field the header renders.
 *
 * @typedef {Object} EmailDetail
 * @property {string} id
 * @property {string} threadId
 * @property {string} senderName
 * @property {string} senderEmail
 * @property {string} subject
 * @property {string} receivedAt
 * @property {string} summary
 * @property {string} draftReply
 * @property {number} urgencyScore
 * @property {string} urgencyReason
 * @property {string} status
 * @property {string} body
 * @property {boolean} bodyAvailable
 * @property {string} [reason] Why the body is missing, when it is.
 */

/**
 * Fetch the full text of one email.
 *
 * Returns the stored summary fields alongside the body so the detail view
 * can render its header without a second lookup, and so it still has
 * something to show when Gmail refuses the fetch. `bodyAvailable` is what
 * the UI keys off: false means "this is the summary, not the message", which
 * is a different thing from an error.
 *
 * @param {string} userID
 * @param {string} emailID
 * @returns {Promise<EmailDetail>}
 */
export async function getEmailBody(userID, emailID) {
  const gmailID = gmailIDFor(emailID);
  if (!gmailID) throw httpError(400, "An email id is required");

  const stored = listPriorityInbox(userID).find(
    (/** @type {any} */ entry) => entry.id === emailID || gmailIDFor(entry.id) === gmailID,
  );

  /** @type {Omit<EmailDetail, "body" | "bodyAvailable" | "reason">} */
  const base = {
    id: stored?.id || `draft-${gmailID}`,
    threadId: stored?.threadId || "",
    senderName: stored?.senderName || "",
    senderEmail: stored?.senderEmail || "",
    subject: stored?.subject || "(no subject)",
    receivedAt: stored?.receivedAt || "",
    summary: stored?.summary || "",
    draftReply: stored?.draftReply || "",
    urgencyScore: typeof stored?.urgencyScore === "number" ? stored.urgencyScore : 0,
    urgencyReason: stored?.urgencyReason || "",
    status: stored?.status || "pending",
  };

  const user = state.users[userID];
  const connected = user?.connectionMode === "google" && Boolean(user.googleTokens?.access_token);
  if (!connected) {
    return { ...base, body: "", bodyAvailable: false, reason: "Gmail is not connected" };
  }

  try {
    const message = await fetchGmailMessageBody(user, gmailID);
    return {
      ...base,
      // Gmail is the authority on the header fields; the stored copy is a
      // snapshot from whenever the poller last saw the thread.
      threadId: message.threadId || base.threadId,
      senderName: message.senderName || base.senderName,
      senderEmail: message.senderEmail || base.senderEmail,
      subject: message.subject || base.subject,
      receivedAt: message.receivedAt || base.receivedAt,
      body: message.body || "",
      bodyAvailable: Boolean(message.body),
    };
  } catch (error) {
    // A failed body fetch is not a failed screen: the header and summary are
    // still worth showing, so this degrades rather than throws.
    log.warn({ err: error, userID, gmailID }, "gmail body fetch failed");
    return {
      ...base,
      body: "",
      bodyAvailable: false,
      reason: "EVE couldn't reach Gmail for this message",
    };
  }
}
