/**
 * @typedef {import("node:http").IncomingMessage} IncomingMessage
 * @typedef {import("node:http").ServerResponse} ServerResponse
 */

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
export async function readJSON(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
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
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EVE</title>
<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:32px;background:#fffdf8;color:#20242a">
  <h1>EVE</h1>
  <p>Google login complete. Returning to EVE.</p>
  <script>
    window.location.replace(${JSON.stringify(redirectURL)});
  </script>
  <p><a href="${escapeHTML(redirectURL)}">Return to EVE</a></p>
</body>`);
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
