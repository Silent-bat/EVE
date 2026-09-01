/**
 * Small RFC-5322 helpers shared by Gmail reads and sends. This is deliberately
 * conservative: provider headers are untrusted input, and an address we cannot
 * validate must never be turned into a guessed recipient.
 */

export const MAX_EMAIL_ADDRESS_CHARS = 254;
export const MAX_HEADER_VALUE_CHARS = 4_096;
export const MAX_DISPLAY_NAME_CHARS = 256;

// This covers ordinary mailbox addresses accepted by Gmail while rejecting
// whitespace, controls, comments, and route syntax that is unsafe to reflect
// into a To/Subject header. Internationalized domains arrive from Gmail in
// punycode, so an ASCII label matcher is sufficient here.
const EMAIL_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/** @param {unknown} value @returns {value is string} */
export function isValidEmailAddress(value) {
  if (typeof value !== "string") return false;
  const email = value.trim();
  return email.length <= MAX_EMAIL_ADDRESS_CHARS && EMAIL_PATTERN.test(email);
}

/**
 * Parse a Gmail From header into a display name and a validated address.
 * Invalid addresses are returned with an empty `email`; callers must treat
 * that as non-sendable rather than guessing a destination.
 *
 * @param {unknown} value
 * @returns {{ name: string, email: string }}
 */
export function parseEmailAddress(value) {
  const raw = sanitizeHeaderValue(value, MAX_HEADER_VALUE_CHARS);
  if (!raw) return { name: "Unknown sender", email: "" };

  const angle = raw.match(/^(.*)<([^<>]*)>\s*$/);
  if (angle) {
    const email = angle[2].trim();
    if (!isValidEmailAddress(email)) return { name: cleanDisplayName(angle[1]), email: "" };
    const name = cleanDisplayName(angle[1]) || email.slice(0, email.indexOf("@"));
    return { name, email };
  }

  if (isValidEmailAddress(raw)) {
    return { name: raw.slice(0, raw.indexOf("@")), email: raw };
  }
  return { name: cleanDisplayName(raw) || "Unknown sender", email: "" };
}

/**
 * Remove folding/control characters from a provider header before it reaches a
 * prompt or an RFC header. CRLF is treated as whitespace, never preserved.
 *
 * @param {unknown} value
 * @param {number} [max]
 */
export function sanitizeHeaderValue(value, max = MAX_HEADER_VALUE_CHARS) {
  if (typeof value !== "string") return "";
  let clean = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    clean += code <= 0x1f || code === 0x7f ? " " : character;
  }
  return clean.replace(/\s+/g, " ").trim().slice(0, max);
}

/** @param {unknown} value @returns {string} */
function cleanDisplayName(value) {
  return sanitizeHeaderValue(value, MAX_DISPLAY_NAME_CHARS)
    .replace(/^"+|"+$/g, "")
    .replace(/\\"/g, '"')
    .trim();
}

/**
 * Encode a header value as an RFC-2047 UTF-8 encoded word when it contains
 * non-ASCII bytes. ASCII values are returned unchanged after sanitization.
 *
 * @param {unknown} value
 * @param {number} [max]
 */
export function encodeMimeHeader(value, max = MAX_HEADER_VALUE_CHARS) {
  const clean = sanitizeHeaderValue(value, max);
  if (!clean || /^[\x20-\x7e]*$/.test(clean)) return clean;
  const encoded = Buffer.from(clean, "utf8").toString("base64");
  return `=?UTF-8?B?${encoded}?=`;
}

/** @param {unknown} value @returns {string} */
export function encodeMimeBody(value) {
  const bytes = Buffer.from(typeof value === "string" ? value : String(value || ""), "utf8");
  const encoded = bytes.toString("base64");
  return encoded.match(/.{1,76}/g)?.join("\r\n") || "";
}
