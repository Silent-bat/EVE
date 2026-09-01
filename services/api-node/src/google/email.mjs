/**
 * Gmail send for approved drafts.
 */
import { moduleLogger } from "../logger.mjs";
import { state } from "../storage/index.mjs";
import { googleJSON } from "./oauth.mjs";
import { refreshGoogleToken } from "./api.mjs";
import { encodeMimeBody, encodeMimeHeader, isValidEmailAddress, sanitizeHeaderValue } from "./address.mjs";

const log = moduleLogger("google.email");

/**
 * Send the user's draft via Gmail's send API. Returns the outcome — never
 * throws, the caller records the status as an audit entry.
 *
 * @param {string} userID
 * @param {{ id: string, senderName: string, senderEmail: string, subject: string, draftReply: string, threadId?: string }} draft
 */
export async function deliverApprovedReply(userID, draft) {
  const user = state.users[userID];
  if (user?.connectionMode !== "google" || !user.googleTokens?.access_token) {
    return { status: "audit-only" };
  }
  if (!isValidEmailAddress(draft?.senderEmail)) {
    return { status: "send-failed", error: "draft recipient email is invalid" };
  }
  if (typeof draft?.draftReply !== "string" || !draft.draftReply.trim()) {
    return { status: "send-failed", error: "draft reply is empty" };
  }

  try {
    const accessToken = await refreshGoogleToken(user);
    if (!accessToken) return { status: "audit-only" };

    await googleJSON("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", accessToken, {
      method: "POST",
      body: JSON.stringify({
        raw: encodeBase64URL(replyRFC822(draft)),
        threadId: draft.threadId,
      }),
    });
    return { status: "sent" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "gmail send failed";
    log.warn({ draftId: draft.id, message }, "Gmail send failed");
    return { status: "send-failed", error: message };
  }
}

/**
 * Build the raw RFC-2822 reply we hand to Gmail.
 *
 * @param {{ senderName: string, senderEmail: string, subject: string, draftReply: string }} draft
 */
export function replyRFC822(draft) {
  const rawSubject = sanitizeHeaderValue(draft?.subject, 998) || "(no subject)";
  const subject = rawSubject.toLowerCase().startsWith("re:") ? rawSubject : `Re: ${rawSubject}`;
  return [
    `To: ${formatAddress(draft.senderName, draft.senderEmail)}`,
    `Subject: ${encodeMimeHeader(subject, 998)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeMimeBody(draft.draftReply),
  ].join("\r\n");
}

/**
 * @param {string} name
 * @param {string} email
 */
function formatAddress(name, email) {
  const cleanEmail = sanitizeHeaderValue(email, 254);
  if (!isValidEmailAddress(cleanEmail)) throw new Error("draft recipient email is invalid");
  const cleanName = encodeMimeHeader(name || "", 256);
  if (!cleanName) return cleanEmail;
  const quotedName = cleanName.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `"${quotedName}" <${cleanEmail}>`;
}

/**
 * @param {string} value
 */
export function encodeBase64URL(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}
