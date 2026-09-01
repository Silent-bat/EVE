import http from "node:http";

import { config } from "./src/config.mjs";
import { logger, moduleLogger } from "./src/logger.mjs";
import {
  applySecurityHeaders,
  handlePreflight,
  logRequest,
  writeErrorResponse,
} from "./src/http/middleware.mjs";
import { httpError, readJSON, writeAuthRedirect, writeHTML, writeJSON } from "./src/http/responses.mjs";
import { dayKeyInZone } from "./src/utils/dates.mjs";
import {
  close as closeStorage,
  ensureUserIn,
  initialize as initializeStorage,
  isUserDeleted,
  isDatabaseConnected,
  purgeUser,
  save as saveState,
  saveOAuthState,
  state,
  storageInfo,
} from "./src/storage/index.mjs";
import {
  isValidUserID,
  normalizePreferences,
  sessionPayload as buildSessionPayload,
} from "./src/storage/state.mjs";
import {
  createSession,
  ensureGoogleAuthUser,
  login as authLogin,
  optionalSession,
  requireUserID,
  revokeSession,
  signup as authSignup,
} from "./src/auth/index.mjs";
import { normalizeNativeGoogleInput } from "./src/auth/google-native.mjs";
import { normalizeEmail } from "./src/auth/password.mjs";
import { changePassword, disconnectGoogle, revokeAllSessions, setDisplayName } from "./src/auth/account.mjs";
import { enforceAuthRateLimit, enforceUserRateLimit } from "./src/auth/rate-limit.mjs";
import {
  consumeGoogleOAuthStateDurable,
  createOAuthHandoff,
  consumeOAuthHandoffDurable,
  exchangeGoogleCode,
  fetchGoogleProfile,
  googleAuthURL,
  integrationMode,
  MAX_OAUTH_CALLBACK_PARAM_CHARS,
  MAX_RETURN_TO_CHARS,
} from "./src/google/oauth.mjs";
import { askAssistant } from "./src/briefing/assistant.mjs";
import { actOnDraft } from "./src/briefing/drafts.mjs";
import { generateBriefing, runDueBriefings } from "./src/briefing/generate.mjs";
import { startGmailPollerLoop, sweepGmailPollers } from "./src/briefing/gmail-poller.mjs";
import { getEmailBody } from "./src/briefing/messages.mjs";
import {
  clearDeviceNotifications,
  getDeviceNotifications,
  recordDeviceNotification,
} from "./src/notifications/index.mjs";
import { registerPushToken, unregisterPushToken } from "./src/notifications/push.mjs";
import {
  clearAvailableNow,
  dispatchProactive,
  getProactivePrefs,
  isCategory,
  listThoughts,
  markThought,
  normalizeProactivePrefs,
  setAvailableNow,
} from "./src/notifications/proactive.mjs";
import { transcribeAudio } from "./src/voice/index.mjs";
import { attachVoiceWS } from "./src/voice/wsServer.mjs";
import { getProfile, updateProfile } from "./src/profile/index.mjs";

const log = moduleLogger("server");
const VERSION = "0.2.0";
const startedAt = Date.now();
const REQUEST_URL_BASE = "http://eve.invalid";

await initializeStorage();

function ensureUser(/** @type {string} */ userID) {
  if (!isValidUserID(userID)) throw httpError(401, "invalid authentication");
  if (isUserDeleted(userID)) throw httpError(401, "account has been deleted");
  ensureUserIn(state, userID);
}

function sessionPayload(/** @type {string} */ userID) {
  ensureUser(userID);
  return buildSessionPayload(state, userID, integrationMode());
}

/**
 * Extract a best-effort client IP for rate-limit bucketing.
 *
 * X-Forwarded-For is only believed when TRUST_PROXY says something in front of
 * us is setting it. Otherwise the header is just caller-supplied text, and
 * honouring it means an attacker rotates one string per request and the login
 * limiter stops existing.
 *
 * @param {import("node:http").IncomingMessage} request
 */
function clientIP(request) {
  if (config.trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (typeof header === "string" && header.length) {
      const [first] = header.split(",");
      if (first) return first.trim();
    }
  }
  return request.socket?.remoteAddress || "";
}

/**
 * Parse the request target against a fixed, non-user-controlled origin. The
 * Host header is routing metadata and must not become the parser's authority.
 *
 * @param {import("node:http").IncomingMessage} request
 * @returns {URL}
 */
function requestURL(request) {
  try {
    return new URL(request.url || "/", REQUEST_URL_BASE);
  } catch {
    throw httpError(400, "invalid request URL");
  }
}

/**
 * Decode one path component while translating malformed percent escapes into a
 * client error instead of an unhandled URIError/500.
 *
 * @param {string} value
 * @returns {string}
 */
function decodePathComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw httpError(400, "invalid URL encoding");
  }
}

/**
 * Read a bounded positive integer query parameter. Empty values retain the
 * route default; non-decimal, fractional, non-finite, and non-positive values
 * are rejected rather than silently converted to another limit.
 *
 * @param {URL} url
 * @param {string} name
 * @param {number} fallback
 * @param {number} maximum
 */
function positiveIntegerQuery(url, name, fallback, maximum) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) throw httpError(400, `${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw httpError(400, `${name} must be a positive integer`);
  }
  return Math.min(maximum, parsed);
}

/**
 * @param {any} input
 * @param {string} ip
 */
async function signup(input, ip) {
  enforceAuthRateLimit(ip, normalizeEmail(input?.email));
  const { token, userID } = await authSignup(input);
  return { token, session: sessionPayload(userID) };
}

/**
 * @param {any} input
 * @param {string} ip
 */
async function login(input, ip) {
  enforceAuthRateLimit(ip, normalizeEmail(input?.email));
  const { token, userID } = await authLogin(input);
  return { token, session: sessionPayload(userID) };
}

/**
 * The Google native login endpoint takes tokens issued to the mobile dev
 * client and re-binds them to an EVE session. The native client receives a
 * Google access token + optional refresh token through the device SDK; we
 * verify the email server-side and create/update the user record.
 *
 * @param {Record<string, any>} input
 */
async function googleNativeLogin(input) {
  if (!config.google) {
    // Native sign-in still needs the server's configured OAuth client so the
    // returned Google identity can be associated with a durable Gmail grant.
    // Do not turn an unconfigured deployment into an arbitrary userinfo proxy.
    throw httpError(503, "google oauth is not configured");
  }
  const nativeInput = normalizeNativeGoogleInput(input, config.google);
  const { accessToken, serverAuthCode, expiresIn } = nativeInput;

  // If the mobile client provided a serverAuthCode (offlineAccess: true
  // GoogleSignIn flow), exchange it for a real refresh token. Without
  // this, the access token expires after 1h and refreshGoogleToken has
  // nothing to refresh with, so Gmail / Calendar silently 401s forever.
  let exchanged = null;
  if (serverAuthCode && config.google?.clientSecret) {
    try {
      exchanged = await exchangeGoogleCode(serverAuthCode);
    } catch (error) {
      log.warn({ err: error }, "google serverAuthCode exchange failed");
    }
  }

  const verifiedAccessToken = exchanged?.access_token || accessToken;
  const profile = await fetchGoogleProfile(verifiedAccessToken);
  const tokenPayload = {
    access_token: verifiedAccessToken,
    // Refresh tokens are only accepted from the server-side auth-code
    // exchange. Client-supplied refreshToken/idToken/scope fields are ignored.
    ...(exchanged?.refresh_token ? { refresh_token: exchanged.refresh_token } : {}),
    ...(config.google?.clientId ? { client_id: config.google.clientId } : {}),
    token_type: "Bearer",
    expires_at: exchanged
      ? Date.now() + boundedProviderExpiry(exchanged.expires_in) * 1000
      : Date.now() + expiresIn * 1000,
  };
  const userID = await ensureGoogleAuthUser(profile.email, tokenPayload, profile);
  invalidateBriefingCache(userID);
  await saveState();
  const token = await createSession(userID);
  return { token, session: sessionPayload(userID) };
}

/**
 * Drop today's stored briefing and reset the gmail poll bookkeeping so the
 * next briefings/today request regenerates and the next poller sweep treats
 * the user as due. Called when fresh Google tokens replace stale ones.
 *
 * @param {string} userID
 */
function invalidateBriefingCache(userID) {
  const todayKey = dayKeyInZone(new Date(), state.users[userID]?.preferences?.timezone || "UTC");
  if (state.briefings[userID]?.[todayKey]) delete state.briefings[userID][todayKey];
  const user = state.users[userID];
  if (user) {
    user.gmailPoll ||= {};
    user.gmailPoll.lastPollAt = null;
  }
}

/** @param {unknown} value */
function boundedProviderExpiry(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(60, Math.min(Math.floor(seconds), 3_600)) : 3_600;
}

const server = http.createServer(async (request, response) => {
  applySecurityHeaders(response, request);
  logRequest(request, response);

  try {
    if (handlePreflight(request, response)) return;

    const url = requestURL(request);

    if (request.method === "GET" && (url.pathname === "/v1/health" || url.pathname === "/health")) {
      const databaseConnected = await isDatabaseConnected();
      writeJSON(response, 200, {
        status: "ok",
        version: VERSION,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        mode: integrationMode(),
        storage: storageInfo(),
        databaseConnected,
      });
      return;
    }

    if (request.method === "GET" && (url.pathname === "/v1/ready" || url.pathname === "/ready")) {
      // Liveness stays 200 while an upstream database is recovering; readiness
      // must fail so an orchestrator stops routing authenticated traffic to a
      // process that cannot read or persist account state.
      const databaseConnected = await isDatabaseConnected();
      const ready = !config.databaseUrl || databaseConnected;
      writeJSON(response, ready ? 200 : 503, {
        status: ready ? "ready" : "not-ready",
        version: VERSION,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        mode: integrationMode(),
        storage: storageInfo(),
        databaseConnected,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/auth/signup") {
      const input = /** @type {any} */ (await readJSON(request));
      writeJSON(response, 201, await signup(input, clientIP(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/auth/login") {
      const input = /** @type {any} */ (await readJSON(request));
      writeJSON(response, 200, await login(input, clientIP(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/auth/logout") {
      const session = await optionalSession(request);
      if (session) await revokeSession(session.tokenHash);
      writeJSON(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/auth/google-url") {
      // OAuth URL creation is public and cheap per request but expensive in
      // aggregate (each state is persisted). Apply the same per-IP auth budget
      // used by password login before allocating a state entry.
      enforceAuthRateLimit(clientIP(request), "");
      const returnTo = url.searchParams.get("returnTo") ?? "";
      if (returnTo.length > MAX_RETURN_TO_CHARS) throw httpError(400, "returnTo is too long");
      writeJSON(response, 200, await googleAuthURL(null, "login", returnTo));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/auth/google-native") {
      // This route is public and reaches Google's userinfo endpoint. Apply the
      // same source-IP auth budget as password login before doing any upstream
      // work, even when the supplied Google token is invalid.
      enforceAuthRateLimit(clientIP(request), "");
      const input = /** @type {any} */ (await readJSON(request));
      writeJSON(response, 200, await googleNativeLogin(input));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/auth/google-exchange") {
      // The callback sends only a short-lived, one-use code through the app
      // deep link. Exchange it over the authenticated transport before issuing
      // the bearer session token, and rate-limit guesses from one source.
      enforceAuthRateLimit(clientIP(request), "");
      const input = /** @type {{ code?: unknown }} */ (await readJSON(request));
      const code = typeof input.code === "string" ? input.code : "";
      const userID = await consumeOAuthHandoffDurable(code);
      if (!userID) throw httpError(400, "oauth handoff is invalid or expired");
      if (!state.users[userID]) throw httpError(400, "oauth account no longer exists");
      const token = await createSession(userID);
      writeJSON(response, 200, { token, session: sessionPayload(userID) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/google/callback") {
      const code = url.searchParams.get("code");
      const oauthState = url.searchParams.get("state");
      if (!code) throw httpError(400, "missing google authorization code");
      if (
        code.length > MAX_OAUTH_CALLBACK_PARAM_CHARS ||
        (oauthState && oauthState.length > MAX_OAUTH_CALLBACK_PARAM_CHARS)
      ) {
        throw httpError(400, "google oauth parameters are too long");
      }
      const stateEntry = await consumeGoogleOAuthStateDurable(oauthState);
      if (!stateEntry) throw httpError(400, "google oauth state is invalid or expired");

      const tokenPayload = {
        ...(await exchangeGoogleCode(code)),
        client_id: config.google?.clientId,
      };
      if (stateEntry.mode === "login") {
        const profile = await fetchGoogleProfile(tokenPayload.access_token);
        const userID = await ensureGoogleAuthUser(profile.email, tokenPayload, profile);
        invalidateBriefingCache(userID);
        // Persist the account before creating a handoff. In Postgres the two
        // operations use separate tables; a crash can leave an account without
        // a handoff, but never a handoff for an account that was not saved.
        await saveState();
        if (stateEntry.returnTo) {
          const handoffCode = createOAuthHandoff(userID);
          await saveOAuthState(handoffCode, state.oauthStates[handoffCode]);
          writeAuthRedirect(response, handoffCode, stateEntry.returnTo);
        } else {
          // There is no safe destination to deliver a handoff to. Do not mint
          // an orphaned session or place a bearer credential in an HTML page.
          writeHTML(response, 200, "Google login complete. Return to EVE.");
        }
        return;
      }

      const userID = stateEntry.userID;
      if (!userID) throw httpError(400, "google connection state has no user");
      ensureUser(userID);
      const previousTokens = state.users[userID].googleTokens || {};
      state.users[userID].googleConnected = true;
      state.users[userID].connectionMode = "google";
      // Google often omits refresh_token when an existing grant is reused.
      // Preserve the prior one so a reconnect does not silently make the
      // mailbox expire after the new access token does.
      state.users[userID].googleTokens = {
        ...previousTokens,
        ...tokenPayload,
        refresh_token: tokenPayload.refresh_token || previousTokens.refresh_token,
        needsReconnect: false,
      };
      invalidateBriefingCache(userID);
      await saveState();
      writeHTML(response, 200, "Google connected. You can return to EVE.");
      return;
    }

    // Authenticated routes start here.
    const userID = await requireUserID(request);

    // AI, Gmail, and transcription calls are externally billable and can be
    // retried by a client. Keep a separate per-user bucket for each capability
    // before any upstream work starts.
    const routeBucket =
      request.method === "POST" && url.pathname === "/v1/voice/transcribe"
        ? "voice"
        : request.method === "POST" && url.pathname === "/v1/assistant/ask"
          ? "assistant"
          : request.method === "POST" &&
              (url.pathname === "/v1/briefings/generate" || url.pathname === "/v1/gmail/poll")
            ? "gmail"
            : "";
    if (routeBucket) enforceUserRateLimit(userID, routeBucket);

    if (request.method === "GET" && url.pathname === "/v1/session") {
      writeJSON(response, 200, sessionPayload(userID));
      return;
    }

    // Irreversible: drops the user record, their briefings, audit trail,
    // captured notifications, stored Google tokens, and every session. The
    // client confirms twice before calling this.
    if (request.method === "DELETE" && url.pathname === "/v1/account") {
      await purgeUser(userID);
      writeJSON(response, 200, { ok: true, deleted: true });
      return;
    }

    // Everything short of deletion that the account page can change. Each
    // returns the fresh session payload where the change is visible in it, so
    // the client re-renders from the server's view rather than guessing.
    if (request.method === "PUT" && url.pathname === "/v1/account/name") {
      ensureUser(userID);
      const input = /** @type {{ displayName?: unknown }} */ (await readJSON(request));
      await setDisplayName(userID, input.displayName ?? null);
      await saveState();
      writeJSON(response, 200, sessionPayload(userID));
      return;
    }

    if (request.method === "PUT" && url.pathname === "/v1/account/password") {
      ensureUser(userID);
      const input = /** @type {{ currentPassword?: unknown, newPassword?: unknown }} */ (
        await readJSON(request)
      );
      writeJSON(response, 200, await changePassword(userID, input));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/account/disconnect-google") {
      ensureUser(userID);
      await disconnectGoogle(userID);
      await saveState();
      writeJSON(response, 200, sessionPayload(userID));
      return;
    }

    // Ends this session too, so the client treats a 200 here as a sign-out.
    if (request.method === "POST" && url.pathname === "/v1/account/sessions/revoke-all") {
      ensureUser(userID);
      writeJSON(response, 200, await revokeAllSessions(userID));
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/google/auth-url") {
      writeJSON(response, 200, await googleAuthURL(userID, "connect"));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/briefings/generate") {
      ensureUser(userID);
      const briefing = await generateBriefing(userID, new Date());
      await saveState();
      writeJSON(response, 201, briefing);
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/briefings/today") {
      ensureUser(userID);
      const rangeParam = url.searchParams.get("range");
      const range = rangeParam === "week" || rangeParam === "month" ? rangeParam : "day";
      const todayKey = dayKeyInZone(new Date(), state.users[userID]?.preferences?.timezone || "UTC");
      const cacheKey = range === "day" ? todayKey : `${todayKey}:${range}`;
      if (!state.briefings[userID]?.[cacheKey]) {
        await generateBriefing(userID, new Date(), { range });
        await saveState();
      } else if (range === "day") {
        // Same opportunistic Gmail sweep as before (only for day view —
        // week/month rebuilds are heavier so we don't fire them in the
        // background on every open).
        void sweepGmailPollers().catch((err) =>
          log.warn({ err, userID }, "opportunistic gmail sweep failed"),
        );
      }
      writeJSON(response, 200, state.briefings[userID][cacheKey]);
      return;
    }

    // Bodies are fetched one at a time rather than stored: the inbox keeps
    // summaries so it stays small, and this is what a tap on a row needs.
    const emailBodyMatch = url.pathname.match(/^\/v1\/emails\/([^/]+)\/body$/);
    if (request.method === "GET" && emailBodyMatch && emailBodyMatch[1]) {
      ensureUser(userID);
      const email = await getEmailBody(userID, decodePathComponent(emailBodyMatch[1]));
      writeJSON(response, 200, email);
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/audit") {
      ensureUser(userID);
      writeJSON(response, 200, { entries: state.audit[userID] || [] });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/profile") {
      ensureUser(userID);
      writeJSON(response, 200, getProfile(userID));
      return;
    }

    if (request.method === "PUT" && url.pathname === "/v1/profile") {
      ensureUser(userID);
      const input = /** @type {Record<string, unknown>} */ (await readJSON(request));
      const saved = updateProfile(userID, input);
      await saveState();
      writeJSON(response, 200, saved);
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/preferences") {
      ensureUser(userID);
      writeJSON(response, 200, state.users[userID].preferences);
      return;
    }

    if (request.method === "PUT" && url.pathname === "/v1/preferences") {
      ensureUser(userID);
      const input = /** @type {Record<string, unknown>} */ (await readJSON(request));
      const current = state.users[userID].preferences || {};
      const merged = normalizePreferences({ ...current, ...input });
      // Validate proactive sub-object at the HTTP boundary so junk doesn't
      // reach storage. The proactive module owns its own schema.
      if (input.proactive !== undefined) {
        /** @type {any} */ (merged).proactive = normalizeProactivePrefs(
          /** @type {any} */ (input.proactive),
          getProactivePrefs(userID),
        );
      } else if (current.proactive !== undefined) {
        /** @type {any} */ (merged).proactive = current.proactive;
      }
      state.users[userID].preferences = merged;
      await saveState();
      writeJSON(response, 200, state.users[userID].preferences);
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/proactive/preferences") {
      ensureUser(userID);
      writeJSON(response, 200, getProactivePrefs(userID));
      return;
    }

    if (request.method === "PUT" && url.pathname === "/v1/proactive/preferences") {
      ensureUser(userID);
      const input = /** @type {Record<string, unknown>} */ (await readJSON(request));
      const next = normalizeProactivePrefs(/** @type {any} */ (input), getProactivePrefs(userID));
      state.users[userID].preferences ||= normalizePreferences({ userId: userID });
      state.users[userID].preferences.proactive = next;
      await saveState();
      writeJSON(response, 200, next);
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/proactive/inbox") {
      ensureUser(userID);
      const status = url.searchParams.get("status") || undefined;
      const since = url.searchParams.get("since") || undefined;
      const limit = positiveIntegerQuery(url, "limit", 50, 200);
      const thoughts = listThoughts(userID, {
        status: /** @type {any} */ (status),
        since,
        limit,
      });
      writeJSON(response, 200, { thoughts });
      return;
    }

    const markMatch = url.pathname.match(/^\/v1\/proactive\/inbox\/([^/]+)\/mark$/);
    if (request.method === "POST" && markMatch && markMatch[1]) {
      ensureUser(userID);
      const input = /** @type {Record<string, unknown>} */ (await readJSON(request));
      const thought = markThought(userID, decodePathComponent(markMatch[1]), {
        status: /** @type {any} */ (input.status),
        feedback: /** @type {any} */ (input.feedback),
      });
      await saveState();
      writeJSON(response, 200, thought);
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/proactive/available-now") {
      ensureUser(userID);
      const input = /** @type {Record<string, any>} */ (await readJSON(request));
      const categories = Array.isArray(input.categories) ? input.categories.filter(isCategory) : undefined;
      const window = setAvailableNow(userID, {
        minutes: typeof input.minutes === "number" ? input.minutes : undefined,
        categories,
        reason: typeof input.reason === "string" ? input.reason : undefined,
      });
      await saveState();
      writeJSON(response, 200, window);
      return;
    }

    if (request.method === "DELETE" && url.pathname === "/v1/proactive/available-now") {
      ensureUser(userID);
      clearAvailableNow(userID);
      await saveState();
      writeJSON(response, 200, { cleared: true });
      return;
    }

    // Test-only dispatcher: lets the mobile app (or a dev) inject a proactive
    // thought to exercise the full gate-and-push pipeline without waiting for
    // the triage loop to fire. Gated by EVE_ALLOW_TEST_DISPATCH so it can't
    // be hit in prod by accident.
    if (
      request.method === "POST" &&
      url.pathname === "/v1/proactive/dispatch" &&
      !config.isProduction &&
      process.env.EVE_ALLOW_TEST_DISPATCH === "1"
    ) {
      ensureUser(userID);
      const input = /** @type {Record<string, any>} */ (await readJSON(request));
      if (!isCategory(input.category)) throw httpError(400, "invalid category");
      const result = await dispatchProactive(userID, {
        category: input.category,
        urgency: input.urgency,
        title: String(input.title || ""),
        body: String(input.body || ""),
        data: input.data && typeof input.data === "object" ? input.data : {},
      });
      writeJSON(response, 201, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/device-notifications") {
      ensureUser(userID);
      const input = /** @type {Record<string, any>} */ (await readJSON(request));
      const idempotencyKey = request.headers["idempotency-key"];
      writeJSON(
        response,
        201,
        await recordDeviceNotification(userID, input, {
          idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : undefined,
        }),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/device-notifications") {
      ensureUser(userID);
      const limit = positiveIntegerQuery(url, "limit", 30, 100);
      writeJSON(response, 200, { entries: await getDeviceNotifications(userID, limit) });
      return;
    }

    if (request.method === "DELETE" && url.pathname === "/v1/device-notifications") {
      ensureUser(userID);
      writeJSON(response, 200, await clearDeviceNotifications(userID));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/assistant/ask") {
      ensureUser(userID);
      const input = /** @type {{ prompt?: string }} */ (await readJSON(request));
      writeJSON(response, 200, await askAssistant(userID, input));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/voice/transcribe") {
      ensureUser(userID);
      const input = /** @type {{ audio?: unknown, mimeType?: unknown }} */ (await readJSON(request));
      const result = await transcribeAudio({
        audioBase64: String(input.audio || ""),
        mimeType: String(input.mimeType || ""),
      });
      writeJSON(response, 200, result);
      return;
    }

    const draftActionMatch = url.pathname.match(/^\/v1\/drafts\/([^/]+)\/action$/);
    if (request.method === "POST" && draftActionMatch && draftActionMatch[1]) {
      ensureUser(userID);
      const input = /** @type {{ action?: string, draftReply?: string, idempotencyKey?: string }} */ (
        await readJSON(request)
      );
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey === "string" && !input.idempotencyKey) input.idempotencyKey = idempotencyKey;
      const result = await actOnDraft(userID, decodePathComponent(draftActionMatch[1]), input);
      await saveState();
      writeJSON(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/notifications/push-token") {
      ensureUser(userID);
      const input = /** @type {{ token?: unknown, platform?: unknown }} */ (await readJSON(request));
      const result = registerPushToken(userID, input);
      await saveState();
      writeJSON(response, 200, result);
      return;
    }

    if (request.method === "DELETE" && url.pathname === "/v1/notifications/push-token") {
      ensureUser(userID);
      const token = url.searchParams.get("token") || "";
      const result = unregisterPushToken(userID, token);
      await saveState();
      writeJSON(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/gmail/poll") {
      ensureUser(userID);
      const user = state.users[userID];
      user.gmailPoll ||= {};
      user.gmailPoll.lastPollAt = null; // force this user due
      await sweepGmailPollers({ force: true });
      writeJSON(response, 200, {
        gmailPoll: user.gmailPoll,
        lastNotification: state.deviceNotifications?.[userID]?.[0] ?? null,
      });
      return;
    }

    writeJSON(response, 404, { error: "not found" });
  } catch (error) {
    writeErrorResponse(error, request, response);
  }
});

// Mount the /v1/voice/live WebSocket bridge. Authentication stays in the
// upgrade headers so bearer credentials never become URL/query-string data.
attachVoiceWS(server, async (req) => {
  try {
    return await requireUserID(req);
  } catch {
    return null;
  }
});

server.listen(config.port, config.host, () => {
  log.info(
    {
      address: `http://${config.host}:${config.port}`,
      mode: integrationMode(),
      databaseUrl: config.databaseUrl ? "set" : "unset",
    },
    "EVE API listening",
  );
});

const briefingInterval = setInterval(() => {
  void runDueBriefings().catch((error) => {
    log.error({ err: error }, "scheduled briefing failed");
  });
}, 60_000);

const gmailPollerInterval = startGmailPollerLoop();

/** @param {string} signal */
function shutdown(signal) {
  log.info({ signal }, "shutting down");
  clearInterval(briefingInterval);
  clearInterval(gmailPollerInterval);
  server.close((err) => {
    if (err) log.error({ err }, "server close error");
    closeStorage()
      .catch((err) => log.error({ err }, "storage close error"))
      .finally(() => process.exit(err ? 1 : 0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaughtException");
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  logger.fatal({ err }, "unhandledRejection");
  process.exit(1);
});
