/**
 * Gmail send for approved drafts.
 */
import { moduleLogger } from "../logger.mjs";
import { state } from "../storage/index.mjs";
import { googleJSON } from "./oauth.mjs";
import { refreshGoogleToken } from "./api.mjs";

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
function replyRFC822(draft) {
  const subject = draft.subject.toLowerCase().startsWith("re:") ? draft.subject : `Re: ${draft.subject}`;
  return [
    `To: ${formatAddress(draft.senderName, draft.senderEmail)}`,
    `Subject: ${sanitizeHeader(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    draft.draftReply,
  ].join("\r\n");
}

/**
 * @param {string} name
 * @param {string} email
 */
function formatAddress(name, email) {
  const cleanEmail = sanitizeHeader(email || "unknown@example.com");
  const cleanName = sanitizeHeader(name || "").replaceAll('"', "");
  return cleanName ? `"${cleanName}" <${cleanEmail}>` : cleanEmail;
}

/**
 * @param {string} value
 */
function sanitizeHeader(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

/**
 * @param {string} value
 */
export function encodeBase64URL(value) {
  return Buffer.from(value, "utf8").toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
