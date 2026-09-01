/**
 * Google OAuth flow: build the consent URL, manage state tokens, exchange
 * authorization codes, fetch profile info.
 *
 * Token storage and refresh logic lives in ./api.mjs.
 */
import crypto from "node:crypto";
import { config } from "../config.mjs";
import { httpError } from "../http/responses.mjs";
import { consumePersistedOAuthState, saveOAuthState, state } from "../storage/index.mjs";

export const GOOGLE_SCOPES = Object.freeze([
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
]);

// OAuth state is deliberately short-lived and bounded. The endpoint that
// creates it is public, so without a cap an attacker could fill the process
// heap (and the persistence backend) with abandoned browser sessions.
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const OAUTH_HANDOFF_TTL_MS = 2 * 60 * 1000;
export const MAX_OAUTH_STATES = 10_000;
export const MAX_OAUTH_CODE_CHARS = 256;
export const MAX_OAUTH_CALLBACK_PARAM_CHARS = 4_096;
export const MAX_RETURN_TO_CHARS = 2_048;

// Google responses are buffered before JSON parsing. Keep the default small
// enough that a provider-side error or an unexpectedly large message cannot
// consume the API process heap. The value is configurable for deployments
// with a different provider payload budget.
export const DEFAULT_GOOGLE_RESPONSE_MAX_BYTES = 2_000_000;
export const GOOGLE_RESPONSE_MAX_BYTES =
  Number.isSafeInteger(config.googleResponseMaxBytes) && config.googleResponseMaxBytes > 0
    ? config.googleResponseMaxBytes
    : DEFAULT_GOOGLE_RESPONSE_MAX_BYTES;

/** A provider response exceeded the byte budget before JSON parsing. */
export class GoogleResponseTooLargeError extends Error {
  constructor() {
    super("google response exceeded the configured size limit");
    this.name = "GoogleResponseTooLargeError";
    this.code = "GOOGLE_RESPONSE_TOO_LARGE";
  }
}

export function integrationMode() {
  const hasGoogle = Boolean(config.google);
  const hasLLM = Boolean(config.gemini || config.anthropic);
  return {
    google: hasGoogle ? "configured" : "not-configured",
    llm: hasLLM ? "configured" : "local",
    emailSending: hasGoogle ? "gmail-api" : "audit-only",
  };
}

/**
 * @param {string | null} userID
 * @param {"login" | "connect"} mode
 * @param {string} [returnTo]
 */
export async function googleAuthURL(userID, mode = "connect", returnTo = "") {
  if (!config.google) {
    return {
      configured: false,
      url: null,
      reason: "GOOGLE_CLIENT_ID and GOOGLE_REDIRECT_URI are not configured.",
    };
  }

  const oauthState = createGoogleOAuthState(userID, mode, returnTo);
  try {
    await saveOAuthState(oauthState, state.oauthStates[oauthState]);
  } catch (error) {
    delete state.oauthStates[oauthState];
    throw error;
  }
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: config.google.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES.join(" "),
    state: oauthState,
  });

  return {
    configured: true,
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  };
}

/**
 * @param {string | null} userID
 * @param {"login" | "connect"} mode
 * @param {string} returnTo
 */
export function createGoogleOAuthState(userID, mode = "connect", returnTo = "") {
  ensureOAuthStateCapacity();
  const oauthState = crypto.randomBytes(24).toString("base64url");
  state.oauthStates ||= {};
  state.oauthStates[oauthState] = {
    userID,
    mode: mode === "login" ? "login" : "connect",
    returnTo: safeReturnTo(returnTo),
    expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString(),
  };
  return oauthState;
}

/**
 * @param {string | null} oauthState
 * @returns {{ userID: string, mode: "login" | "connect", returnTo: string } | ""}
 */
export function consumeGoogleOAuthState(oauthState) {
  if (!oauthState || !state.oauthStates?.[oauthState]) return "";
  const entry = state.oauthStates[oauthState];
  delete state.oauthStates[oauthState];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";
  if (entry.mode !== "login" && entry.mode !== "connect") return "";
  const expiresAt = Date.parse(String(entry.expiresAt || ""));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return "";
  return {
    userID: entry.userID || "",
    mode: entry.mode,
    returnTo: safeReturnTo(entry.returnTo),
  };
}

/**
 * Durable variant used by HTTP callbacks. JSON mode follows the synchronous
 * in-memory path; Postgres performs an atomic DELETE ... RETURNING so a second
 * API worker cannot replay the same nonce.
 *
 * @param {unknown} oauthState
 * @returns {Promise<{ userID: string, mode: "login" | "connect", returnTo: string } | "">}
 */
export async function consumeGoogleOAuthStateDurable(oauthState) {
  if (!isOpaqueOAuthCode(oauthState)) return "";
  const entry = await consumePersistedOAuthState(String(oauthState));
  if (!entry || (entry.mode !== "login" && entry.mode !== "connect")) return "";
  const expiresAt = Date.parse(String(entry.expiresAt || ""));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return "";
  return {
    userID: typeof entry.userID === "string" ? entry.userID : "",
    mode: entry.mode,
    returnTo: safeReturnTo(entry.returnTo),
  };
}

/**
 * Create an opaque, one-use handoff for a newly-created EVE session. The raw
 * bearer token never enters a redirect URL; the app exchanges this code over
 * HTTPS and receives a normal session response. Handoffs share the persisted
 * OAuth-state store so JSON and Postgres deployments retain the same restart
 * and cleanup semantics.
 *
 * @param {string} userID
 */
export function createOAuthHandoff(userID) {
  if (!userID) throw httpError(400, "oauth handoff has no user");
  ensureOAuthStateCapacity();
  const code = crypto.randomBytes(24).toString("base64url");
  state.oauthStates ||= {};
  state.oauthStates[code] = {
    userID,
    mode: "handoff",
    returnTo: "",
    expiresAt: new Date(Date.now() + OAUTH_HANDOFF_TTL_MS).toISOString(),
  };
  return code;
}

/**
 * Durable variant used by the exchange endpoint. The database operation is
 * one-shot across all API workers; JSON mode persists the local deletion.
 *
 * @param {unknown} code
 * @returns {Promise<string>}
 */
export async function consumeOAuthHandoffDurable(code) {
  if (!isOpaqueOAuthCode(code)) return "";
  const entry = await consumePersistedOAuthState(String(code));
  if (!entry || entry.mode !== "handoff") return "";
  const expiresAt = Date.parse(String(entry.expiresAt || ""));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return "";
  return typeof entry.userID === "string" ? entry.userID : "";
}

/**
 * Consume an OAuth handoff exactly once. Deletion happens before the caller's
 * async work, so two simultaneous exchange requests cannot both mint a session
 * in this process.
 *
 * @param {unknown} code
 * @returns {string}
 */
export function consumeOAuthHandoff(code) {
  if (!isOpaqueOAuthCode(code)) return "";
  const key = String(code);
  const entry = state.oauthStates?.[key];
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.mode !== "handoff") return "";
  delete state.oauthStates[key];
  const expiresAt = Date.parse(String(entry.expiresAt || ""));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return "";
  return typeof entry.userID === "string" ? entry.userID : "";
}

/**
 * Allow only known-safe return URLs to avoid open-redirects.
 *
 * @param {unknown} value
 */
export function safeReturnTo(value) {
  const returnTo = String(value || "").trim();
  if (!returnTo || returnTo.length > MAX_RETURN_TO_CHARS) return "";
  let parsed;
  try {
    parsed = new URL(returnTo);
  } catch {
    return "";
  }
  // The native app has one registered callback. Do not reflect arbitrary
  // `eve://` paths or hosts into a Location header: another installed app could
  // claim that URI and receive the one-use handoff code.
  if (
    parsed.protocol === "eve:" &&
    parsed.hostname === "auth" &&
    parsed.pathname === "/google" &&
    !parsed.username &&
    !parsed.password
  ) {
    return "eve://auth/google";
  }
  if (
    parsed.protocol === "http:" &&
    !config.isProduction &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
    parsed.port &&
    !parsed.username &&
    !parsed.password
  ) {
    return parsed.toString().replace(/\/$/, "");
  }
  return "";
}

/** Remove expired entries and keep the public state store bounded. */
function ensureOAuthStateCapacity() {
  state.oauthStates ||= {};
  const now = Date.now();
  for (const [key, entry] of Object.entries(state.oauthStates)) {
    if (
      !entry ||
      !Number.isFinite(Date.parse(String(entry.expiresAt || ""))) ||
      Date.parse(String(entry.expiresAt)) <= now
    ) {
      delete state.oauthStates[key];
    }
  }

  const entries = Object.entries(state.oauthStates);
  if (entries.length < MAX_OAUTH_STATES) return;
  // Evict the entries nearest to expiry until there is room for this request.
  // This keeps the map bounded even when a process starts with a legacy file
  // containing more states than the current limit.
  entries
    .sort(
      ([, left], [, right]) =>
        Date.parse(String(left?.expiresAt || "")) - Date.parse(String(right?.expiresAt || "")),
    )
    .slice(0, entries.length - MAX_OAUTH_STATES + 1)
    .forEach(([key]) => delete state.oauthStates[key]);
}

/** @param {unknown} value */
function isOpaqueOAuthCode(value) {
  return typeof value === "string" && value.length <= MAX_OAUTH_CODE_CHARS && /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Exchange a one-time auth code for access + refresh tokens.
 *
 * @param {string} code
 */
export async function exchangeGoogleCode(code) {
  if (!config.google) throw httpError(400, "google oauth is not configured");
  if (
    typeof code !== "string" ||
    !code.trim() ||
    code.length > MAX_OAUTH_CALLBACK_PARAM_CHARS ||
    hasControlCharacters(code)
  ) {
    throw httpError(400, "google authorization code is invalid");
  }
  code = code.trim();

  let response;
  try {
    response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      signal: AbortSignal.timeout(config.outboundTimeoutMs),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: config.google.redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "google token exchange failed";
    throw httpError(502, `google token service unavailable: ${message}`);
  }

  let payload;
  try {
    payload = await readBoundedResponseJSON(response);
  } catch (error) {
    if (error instanceof GoogleResponseTooLargeError) {
      throw httpError(502, "google token service response too large");
    }
    throw httpError(502, "google token service returned invalid JSON");
  }
  if (!response.ok) {
    const providerError = payload && typeof payload === "object" ? payload : {};
    throw httpError(
      400,
      providerError.error_description || providerError.error || "google token exchange failed",
    );
  }
  return normalizeGoogleTokenPayload(payload);
}

/**
 * Reduce a successful token response to the credentials EVE actually needs.
 * Provider responses are external input too: accepting a missing access token
 * here would defer a TypeError until a later Gmail call, while spreading every
 * provider field into persistent state stores unnecessary identity material.
 *
 * @param {unknown} payload
 * @returns {{ access_token: string, refresh_token?: string, token_type: string, scope?: string, expires_in: number, expires_at: number }}
 */
export function normalizeGoogleTokenPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw httpError(502, "google token service returned an invalid payload");
  }
  const source = /** @type {Record<string, unknown>} */ (payload);
  const accessToken = providerCredential(source.access_token, "access token");
  if (!accessToken) throw httpError(502, "google token service returned no access token");
  const refreshToken = providerCredential(source.refresh_token, "refresh token");
  const rawType = typeof source.token_type === "string" ? source.token_type.trim() : "";
  const tokenType = rawType && !hasControlCharacters(rawType) ? rawType.slice(0, 32) : "Bearer";
  const scope =
    typeof source.scope === "string" && !hasControlCharacters(source.scope)
      ? source.scope.trim().slice(0, 2_048)
      : "";
  const expiresIn = boundedProviderExpiry(source.expires_in);
  return {
    access_token: accessToken,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    token_type: tokenType,
    ...(scope ? { scope } : {}),
    expires_in: expiresIn,
    expires_at: Date.now() + expiresIn * 1000,
  };
}

/** @param {unknown} value @param {string} label @returns {string} */
function providerCredential(value, label) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw httpError(502, `google token ${label} is invalid`);
  const clean = value.trim();
  if (!clean || clean.length > MAX_OAUTH_CALLBACK_PARAM_CHARS || hasControlCharacters(clean)) {
    throw httpError(502, `google token ${label} is invalid`);
  }
  return clean;
}

/** @param {string} value */
function hasControlCharacters(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** @param {unknown} value @returns {number} */
export function boundedProviderExpiry(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(60, Math.min(Math.floor(numeric), 3_600)) : 3_600;
}

/**
 * Fetch the verified email + profile from a Google access token.
 *
 * @param {string} accessToken
 */
export async function fetchGoogleProfile(accessToken) {
  const payload = await googleJSON("https://openidconnect.googleapis.com/v1/userinfo", accessToken);
  if (typeof payload?.email !== "string" || !payload.email.trim() || payload.email_verified !== true) {
    throw httpError(400, "google account did not return a verified email");
  }
  // `name` and `picture` are optional on the userinfo response — a Workspace
  // account with no photo returns neither — so both normalize to null rather
  // than undefined, and the client falls back to initials.
  return {
    email: payload.email,
    name: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : null,
    picture: typeof payload.picture === "string" && payload.picture ? payload.picture : null,
  };
}

/**
 * Authenticated GET (or POST when init.body is provided) returning JSON.
 * Throws when Google returns a non-2xx.
 *
 * @param {string | URL} url
 * @param {string} accessToken
 * @param {RequestInit} [init]
 */
export async function googleJSON(url, accessToken, init = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...init,
      // Node's fetch waits indefinitely by default, so a stalled connection to
      // Google would hang the request past any client timeout.
      signal: init.signal ?? AbortSignal.timeout(config.outboundTimeoutMs),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "google api request failed";
    throw httpError(502, `google api unavailable: ${message}`);
  }
  let payload;
  try {
    payload = await readBoundedResponseJSON(response);
  } catch (error) {
    if (error instanceof GoogleResponseTooLargeError) {
      throw httpError(502, "google api response too large");
    }
    throw httpError(502, "google api returned invalid JSON");
  }
  if (!response.ok) {
    const providerError = payload && typeof payload === "object" ? payload : {};
    const message = providerError.error?.message || "google api request failed";
    // An expired or revoked token is the client's cue to sign in again, so
    // keep it a 401 rather than letting it surface as a server error the
    // app can only report as "something went wrong". Anything else really
    // is upstream failing, which is a gateway error and not our fault.
    throw httpError(response.status === 401 || response.status === 403 ? 401 : 502, message);
  }
  return payload;
}

/**
 * Read and parse a provider JSON response without calling `response.json()`
 * blindly. Native fetch responses expose a streaming body; consuming it in
 * chunks lets us stop as soon as the byte budget is exceeded. A small
 * compatibility fallback remains for the response doubles used by tests and
 * older fetch implementations that only expose `text()` or `json()`.
 *
 * @param {Response | { body?: any, headers?: any, text?: () => Promise<string>, json?: () => Promise<any> }} response
 * @param {number} [maxBytes]
 * @returns {Promise<any>}
 */
export async function readBoundedResponseJSON(response, maxBytes = GOOGLE_RESPONSE_MAX_BYTES) {
  const limit = normalizeResponseLimit(maxBytes);
  const declaredLength = responseContentLength(response);
  if (declaredLength > limit) {
    await cancelResponseBody(response);
    throw new GoogleResponseTooLargeError();
  }

  let text;
  const body = response?.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (!item || item.done) break;
        if (item.value == null) continue;
        const chunk = Buffer.from(item.value);
        total += chunk.byteLength;
        if (total > limit) {
          try {
            await reader.cancel();
          } catch {
            // The response is already being rejected; cancellation is best
            // effort and should not mask the useful size-limit error.
          }
          throw new GoogleResponseTooLargeError();
        }
        chunks.push(chunk);
      }
    } finally {
      // A released lock lets undici reclaim the response even when parsing
      // fails after the body was consumed.
      try {
        reader.releaseLock?.();
      } catch {
        /* best effort */
      }
    }
    text = Buffer.concat(chunks, total).toString("utf8");
  } else if (typeof response?.text === "function") {
    text = await response.text();
    if (Buffer.byteLength(text, "utf8") > limit) throw new GoogleResponseTooLargeError();
  } else if (typeof response?.json === "function") {
    // Test doubles sometimes expose only json(). This fallback cannot stop
    // allocation before parsing, but it still rejects an oversized parsed
    // value and keeps the production fetch path bounded by the stream above.
    const payload = await response.json();
    let serialized;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      throw new Error("response is not serializable JSON");
    }
    if (Buffer.byteLength(serialized || "", "utf8") > limit) {
      throw new GoogleResponseTooLargeError();
    }
    return payload;
  } else {
    throw new Error("google response body is unavailable");
  }

  return JSON.parse(text);
}

/** @param {unknown} value */
function normalizeResponseLimit(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : GOOGLE_RESPONSE_MAX_BYTES;
}

/** @param {any} response */
function responseContentLength(response) {
  try {
    const raw = response?.headers?.get?.("content-length");
    const numeric = Number(raw);
    return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
  } catch {
    return 0;
  }
}

/** @param {any} response */
async function cancelResponseBody(response) {
  try {
    if (typeof response?.body?.cancel === "function") await response.body.cancel();
  } catch {
    /* best effort */
  }
}
