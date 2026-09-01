/**
 * Validation for the native Google Sign-In handoff.
 *
 * The mobile SDK is a useful source of a short-lived access token, but every
 * other field in its response is still client-controlled once it crosses the
 * API boundary. Keep the accepted shape small and validate the OAuth client
 * id against the server configuration before any provider call or persistence.
 */
import { httpError } from "../http/responses.mjs";

export const MAX_NATIVE_GOOGLE_TOKEN_CHARS = 4_096;
export const MAX_NATIVE_GOOGLE_CODE_CHARS = 2_048;
export const MAX_NATIVE_GOOGLE_CLIENT_ID_CHARS = 256;

/**
 * @typedef {{ accessToken: string, clientID: string, serverAuthCode: string, expiresIn: number }} NativeGoogleInput
 */

/**
 * Validate and reduce a native Google login payload. The returned object does
 * not include id tokens, refresh tokens, scopes, or token types supplied by the
 * client: userinfo verification and a server-side auth-code exchange are the
 * only trusted sources for those values.
 *
 * @param {unknown} input
 * @param {{ clientId?: string, androidClientId?: string } | null | undefined} googleConfig
 * @returns {NativeGoogleInput}
 */
export function normalizeNativeGoogleInput(input, googleConfig) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw httpError(400, "google login body must be an object");
  }
  const source = /** @type {Record<string, unknown>} */ (input);
  const accessToken = credential(source.accessToken, MAX_NATIVE_GOOGLE_TOKEN_CHARS, "google access token");
  const serverAuthCode = optionalCredential(
    source.serverAuthCode,
    MAX_NATIVE_GOOGLE_CODE_CHARS,
    "google server auth code",
  );
  const suppliedClientID = optionalCredential(
    source.clientId,
    MAX_NATIVE_GOOGLE_CLIENT_ID_CHARS,
    "google client id",
  );
  const configuredClientIDs = [googleConfig?.clientId, googleConfig?.androidClientId].filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  if (suppliedClientID && configuredClientIDs.length > 0 && !configuredClientIDs.includes(suppliedClientID)) {
    throw httpError(400, "google client id is not configured for this app");
  }

  // Google access tokens normally live for one hour. A client-supplied value
  // is only a fallback hint when no auth-code exchange succeeds; cap it so an
  // attacker cannot make a stale token look valid for days.
  const rawExpiresIn = Number(source.expiresIn);
  const expiresIn = Number.isFinite(rawExpiresIn)
    ? Math.max(60, Math.min(Math.floor(rawExpiresIn), 3_600))
    : 3_600;

  return {
    accessToken,
    clientID: suppliedClientID || googleConfig?.clientId || googleConfig?.androidClientId || "",
    serverAuthCode,
    expiresIn,
  };
}

/** @param {unknown} value @param {number} max @param {string} label */
function credential(value, max, label) {
  const result = optionalCredential(value, max, label);
  if (!result) throw httpError(400, `${label} is required`);
  return result;
}

/** @param {unknown} value @param {number} max @param {string} label */
function optionalCredential(value, max, label) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw httpError(400, `${label} must be a string`);
  const result = value.trim();
  if (!result) return "";
  if (result.length > max || hasControlCharacters(result)) {
    throw httpError(400, `${label} is invalid`);
  }
  return result;
}

/** @param {string} value */
function hasControlCharacters(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
