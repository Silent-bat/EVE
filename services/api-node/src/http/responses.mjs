/**
 * @typedef {import("node:http").IncomingMessage} IncomingMessage
 * @typedef {import("node:http").ServerResponse} ServerResponse
 */
import { config } from "../config.mjs";

/**
 * HTTP error carrying a status code. Thrown from handlers and converted to a
 * JSON response by the error middleware.
 */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * Shortcut for `throw new HttpError(...)`. Returns an Error so it can be used
 * either as `throw httpError(400, "...")` or in places that expect an Error.
 *
 * @param {number} status
 * @param {string} message
 * @returns {HttpError}
 */
export function httpError(status, message) {
  return new HttpError(status, message);
}

const jsonHeaders = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
});

/**
 * @param {IncomingMessage} request
 * @returns {Promise<unknown>}
 */
/**
 * Largest body any JSON route will buffer, from MAX_BODY_BYTES. Every route
 * here takes small structured payloads, so the 1 MiB default is generous;
 * without a ceiling an unauthenticated POST can grow the heap until the
 * process dies.
 */
function maxBodyBytes() {
  return config.maxBodyBytes;
}

/**
 * @param {IncomingMessage} request
 * @returns {Promise<unknown>}
 */
export async function readJSON(request) {
  const limit = maxBodyBytes();
  // Keep draining past the cap instead of cutting the socket off at it. A
  // socket closed with data still unread makes the kernel send RST rather than
  // FIN, and an RST lets the peer discard whatever it had already buffered —
  // including our 413. Draining costs bandwidth we have already decided not to
  // use, so it is bounded: past the ceiling we give up and reset, on the view
  // that a caller still sending after 8 MiB of refusal is not one worth being
  // polite to.
  const hardCeiling = limit * 8;
  let chunks = [];
  let size = 0;
  let overLimit = false;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      if (!overLimit) {
        overLimit = true;
        // Release what we buffered: the body is refused, so holding it is the
        // exact heap growth this cap exists to prevent.
        chunks = [];
      }
      if (size > hardCeiling) {
        request.destroy();
        break;
      }
      continue;
    }
    chunks.push(chunk);
  }

  if (overLimit) throw httpError(413, "request body too large");
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw httpError(400, "JSON body must be an object");
    }
    return parsed;
  } catch (error) {
    // Preserve an explicit HttpError from the shape check rather than
    // re-labelling it as malformed JSON.
    if (/** @type {any} */ (error)?.status) throw error;
    throw httpError(400, "invalid JSON body");
  }
}

/**
 * @param {ServerResponse} response
 * @param {number} status
 * @param {unknown} payload
 */
export function writeJSON(response, status, payload) {
  response.writeHead(status, jsonHeaders);
  response.end(JSON.stringify(payload));
}

/**
 * @param {ServerResponse} response
 * @param {number} status
 * @param {string} message
 */
export function writeHTML(response, status, message) {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><body><p>${escapeHTML(message)}</p></body></html>`);
}

/**
 * Hand a one-use OAuth handoff code back to the app after Google sign-in.
 *
 * This used to render an HTML page that carried a bearer token and bounced via
 * an inline `window.location.replace(...)`. The destination was interpolated
 * into a script context, and the app's strict CSP blocked that inline script in
 * the first place. A fragment-only handoff plus a 302 avoids both hazards.
 *
 * A 302 fixes both. There is no document, so there is nothing to inject into,
 * and the browser performs the redirect without needing script at all.
 *
 * @param {ServerResponse} response
 * @param {string} code
 * @param {string} returnTo
 */
export function writeAuthRedirect(response, code, returnTo) {
  if (!returnTo) {
    writeHTML(response, 200, "Google login complete. Return to EVE.");
    return;
  }
  let redirectURL;
  try {
    // A URL fragment is delivered to the native app/browser but is never sent
    // in HTTP requests, proxy logs, or Referer headers. The value is a
    // short-lived handoff code, not a bearer session token; the app exchanges
    // it over HTTPS exactly once.
    const parsed = new URL(returnTo);
    if (!isAllowedAuthRedirect(parsed)) throw new Error("redirect destination is not allowlisted");
    parsed.hash = new URLSearchParams({ eve_code: code }).toString();
    redirectURL = parsed.toString();
  } catch {
    // `returnTo` normally comes from safeReturnTo(). Keep this helper fail
    // closed if a caller accidentally passes an invalid destination.
    writeHTML(response, 200, "Google login complete. Return to EVE.");
    return;
  }
  response.writeHead(302, {
    Location: redirectURL,
    // Keep the one-use code out of shared caches and any subsequent referrer.
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  response.end();
}

/**
 * Keep this response-level guard in addition to `safeReturnTo` at the OAuth
 * state boundary. It protects the helper if another callback ever passes an
 * unsanitized destination directly.
 *
 * @param {URL} parsed
 */
function isAllowedAuthRedirect(parsed) {
  if (
    parsed.protocol === "eve:" &&
    parsed.hostname === "auth" &&
    parsed.pathname === "/google" &&
    !parsed.username &&
    !parsed.password
  ) {
    return true;
  }
  return (
    parsed.protocol === "http:" &&
    !config.isProduction &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
    Boolean(parsed.port) &&
    !parsed.username &&
    !parsed.password
  );
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
