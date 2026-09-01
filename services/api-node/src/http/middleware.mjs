import { config } from "../config.mjs";
import { moduleLogger } from "../logger.mjs";
import { HttpError, writeJSON } from "./responses.mjs";

const log = moduleLogger("http");

const corsHeaders = Object.freeze({
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-EVE-User-ID",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Max-Age": "86400",
});

const baseSecurityHeaders = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  // No route serves script, and none needs to: the Google OAuth callback used to
  // carry an inline redirect, which this CSP was silently blocking anyway, and it
  // is now a 302 with no document at all. So this stays strict everywhere.
  "Content-Security-Policy":
    "default-src 'none'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
});

const productionOnlyHeaders = Object.freeze({
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
});

/**
 * @param {import("node:http").ServerResponse} response
 * @param {import("node:http").IncomingMessage} [request]
 */
export function applySecurityHeaders(response, request) {
  const origin = request?.headers?.origin;
  const allowedOrigins = config.corsOrigins || [];
  if (allowedOrigins.length > 0) {
    if (typeof origin === "string" && allowedOrigins.includes(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
  } else if (!config.isProduction) {
    response.setHeader("Access-Control-Allow-Origin", "*");
  }
  for (const [k, v] of Object.entries(corsHeaders)) response.setHeader(k, v);
  for (const [k, v] of Object.entries(baseSecurityHeaders)) response.setHeader(k, v);
  if (config.isProduction) {
    for (const [k, v] of Object.entries(productionOnlyHeaders)) response.setHeader(k, v);
  }
}

/**
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 */
export function handlePreflight(request, response) {
  if (request.method !== "OPTIONS") return false;
  const allowedOrigins = config.corsOrigins || [];
  if (
    allowedOrigins.length > 0 &&
    (typeof request.headers.origin !== "string" || !allowedOrigins.includes(request.headers.origin))
  ) {
    response.writeHead(403);
    response.end();
    return true;
  }
  response.writeHead(204);
  response.end();
  return true;
}

/**
 * Catches and serializes errors into a JSON response.
 *
 * @param {unknown} error
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 */
export function writeErrorResponse(error, request, response) {
  const url = redactURL(request.url);
  if (response.headersSent) {
    log.error({ err: error, url }, "error after headers sent");
    response.destroy();
    return;
  }
  const status = Number(/** @type {{ status?: unknown }} */ (error)?.status);
  if (error instanceof HttpError || (Number.isInteger(status) && status >= 400 && status <= 599)) {
    const code = error instanceof HttpError ? error.status : status;
    if (code >= 500) log.error({ err: error, url }, "http 5xx");
    else
      log.warn(
        { status: code, msg: error instanceof Error ? error.message : String(error), url },
        "http error",
      );
    writeJSON(response, code, {
      error:
        config.isProduction && code >= 500
          ? "internal error"
          : error instanceof Error
            ? error.message
            : String(error),
    });
    return;
  }
  log.error({ err: error, url }, "unhandled error");
  writeJSON(response, 500, { error: config.isProduction ? "internal error" : String(error) });
}

/**
 * Logs an incoming request when it completes, with duration and status.
 *
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 */
export function logRequest(request, response) {
  const start = process.hrtime.bigint();
  const method = request.method;
  const url = redactURL(request.url);
  response.once("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    log.info(
      {
        method,
        url,
        status: response.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      },
      "request",
    );
  });
}

/**
 * Query strings routinely contain OAuth codes, state nonces, and installation
 * tokens. Keep the route visible for diagnostics, but never put caller-
 * supplied query values into logs.
 *
 * @param {string | undefined} value
 */
export function redactURL(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    const parsed = new URL(value, "http://localhost");
    for (const key of parsed.searchParams.keys()) parsed.searchParams.set(key, "[redacted]");
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return value.split("?", 1)[0] || "/";
  }
}
