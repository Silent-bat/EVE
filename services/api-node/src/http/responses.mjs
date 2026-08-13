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
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
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
 * Hand the session token back to the app after Google sign-in.
 *
 * This used to render an HTML page that carried the token and bounced via an
 * inline `window.location.replace(...)`. Two things were wrong with that. The
 * redirect URL was interpolated with `JSON.stringify`, which escapes for
 * JavaScript and not for HTML, so a `returnTo` containing `</script>` closed the
 * script element and the rest was parsed as markup — and `safeReturnTo` lets any
 * `eve://` value through, so that was reachable. And the app's own CSP sets
 * `script-src 'self'` with no inline allowance, so the redirect the page existed
 * to perform never ran anyway; users fell through to the manual link.
 *
 * A 302 fixes both. There is no document, so there is nothing to inject into,
 * and the browser performs the redirect without needing script at all.
 *
 * @param {ServerResponse} response
 * @param {string} token
 * @param {string} returnTo
 */
export function writeAuthRedirect(response, token, returnTo) {
  if (!returnTo) {
    writeHTML(response, 200, "Google login complete. Return to EVE.");
    return;
  }
  const separator = returnTo.includes("?") ? "&" : "?";
  const redirectURL = `${returnTo}${separator}eve_token=${encodeURIComponent(token)}`;
  response.writeHead(302, {
    Location: redirectURL,
    // The token is in the URL. Keep it out of shared caches and out of the
    // Referer header on whatever the app navigates to next.
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  response.end();
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
