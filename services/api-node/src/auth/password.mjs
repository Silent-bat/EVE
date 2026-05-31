import crypto from "node:crypto";

/**
 * @param {unknown} value
 * @returns {string} normalized lowercase email or "" if not a syntactically valid address
 */
export function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

/**
 * Hash a password with scrypt. Format: `scrypt:<base64url-salt>:<base64url-hash>`.
 *
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = await scrypt(password, salt);
  return `scrypt:${salt}:${hash}`;
}

/**
 * Verify a password against a stored scrypt hash. Returns false for any
 * malformed input rather than throwing — login should not leak parse errors.
 *
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  const [scheme, salt, expected] = String(stored || "").split(":");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const actual = await scrypt(password, salt);
  return timingSafeEqual(actual, expected);
}

/**
 * @param {string} password
 * @param {string} salt
 * @returns {Promise<string>}
 */
function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, key) => {
      if (error) reject(error);
      else resolve(key.toString("base64url"));
    });
  });
}

/**
 * @param {string} left
 * @param {string} right
 */
export function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * SHA-256 of a session token, used to avoid storing the token itself.
 *
 * @param {string} token
 */
export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("base64url");
}
