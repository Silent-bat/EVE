/**
 * Google OAuth flow: build the consent URL, manage state tokens, exchange
 * authorization codes, fetch profile info.
 *
 * Token storage and refresh logic lives in ./api.mjs.
 */
import crypto from "node:crypto";
import { config } from "../config.mjs";
import { httpError } from "../http/responses.mjs";
import { save, state } from "../storage/index.mjs";

export const GOOGLE_SCOPES = Object.freeze([
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
]);

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
  await save();
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
  const oauthState = crypto.randomBytes(24).toString("base64url");
  state.oauthStates ||= {};
  state.oauthStates[oauthState] = {
    userID,
    mode,
    returnTo: safeReturnTo(returnTo),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
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
  if (new Date(entry.expiresAt).getTime() <= Date.now()) return "";
  return {
    userID: entry.userID || "",
    mode: entry.mode === "login" ? "login" : "connect",
    returnTo: safeReturnTo(entry.returnTo),
  };
}

/**
 * Allow only known-safe return URLs to avoid open-redirects.
 *
 * @param {unknown} value
 */
export function safeReturnTo(value) {
  const returnTo = String(value || "").trim();
  if (!returnTo) return "";
  if (returnTo.startsWith("eve://")) return returnTo;
  if (returnTo.startsWith("http://localhost:") || returnTo.startsWith("http://127.0.0.1:")) return returnTo;
  return "";
}

/**
 * Exchange a one-time auth code for access + refresh tokens.
 *
 * @param {string} code
 */
export async function exchangeGoogleCode(code) {
  if (!config.google) throw httpError(400, "google oauth is not configured");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: config.google.redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw httpError(400, payload.error_description || payload.error || "google token exchange failed");
  }
  payload.expires_at = Date.now() + Number(payload.expires_in || 3600) * 1000;
  return payload;
}

/**
 * Fetch the verified email + profile from a Google access token.
 *
 * @param {string} accessToken
 */
export async function fetchGoogleProfile(accessToken) {
  const payload = await googleJSON("https://openidconnect.googleapis.com/v1/userinfo", accessToken);
  if (!payload.email || payload.email_verified === false) {
    throw httpError(400, "google account did not return a verified email");
  }
  return { email: payload.email };
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
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "google api request failed");
  return payload;
}
