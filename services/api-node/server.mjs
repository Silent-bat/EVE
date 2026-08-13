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
import { dayKey } from "./src/utils/dates.mjs";
import {
  close as closeStorage,
  ensureUserIn,
  initialize as initializeStorage,
  isDatabaseConnected,
  purgeUser,
  save as saveState,
  state,
  storageInfo,
} from "./src/storage/index.mjs";
import { normalizePreferences, sessionPayload as buildSessionPayload } from "./src/storage/state.mjs";
import {
  createSession,
  ensureGoogleAuthUser,
  login as authLogin,
  optionalSession,
  requireUserID,
  revokeSession,
  signup as authSignup,
} from "./src/auth/index.mjs";
import { normalizeEmail } from "./src/auth/password.mjs";
import {
  changePassword,
  disconnectGoogle,
  revokeAllSessions,
  setDisplayName,
} from "./src/auth/account.mjs";
import { enforceAuthRateLimit } from "./src/auth/rate-limit.mjs";
import {
  consumeGoogleOAuthState,
  exchangeGoogleCode,
  fetchGoogleProfile,
  googleAuthURL,
  integrationMode,
} from "./src/google/oauth.mjs";
import { askAssistant } from "./src/briefing/assistant.mjs";
import { actOnDraft } from "./src/briefing/drafts.mjs";
import { generateBriefing, runDueBriefings } from "./src/briefing/generate.mjs";
import { startGmailPollerLoop, sweepGmailPollers } from "./src/briefing/gmail-poller.mjs";
import { getEmailBody } from "./src/briefing/messages.mjs";
import { getDeviceNotifications, recordDeviceNotification } from "./src/notifications/index.mjs";
import { registerPushToken } from "./src/notifications/push.mjs";
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

await initializeStorage();

function ensureUser(/** @type {string} */ userID) {
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
  const clientID = String(input.clientId || config.google?.androidClientId || "");
  const accessToken = String(input.accessToken || "");
  const serverAuthCode = String(input.serverAuthCode || "");
  let refreshToken = String(input.refreshToken || "");
  const idToken = String(input.idToken || "");
  if (!accessToken) throw httpError(400, "google access token is required");

  // If the mobile client provided a serverAuthCode (offlineAccess: true
  // GoogleSignIn flow), exchange it for a real refresh token. Without
  // this, the access token expires after 1h and refreshGoogleToken has
  // nothing to refresh with, so Gmail / Calendar silently 401s forever.
  let exchanged = null;
  if (serverAuthCode && config.google?.clientSecret) {
    try {
      exchanged = await exchangeGoogleCode(serverAuthCode);
      if (exchanged.refresh_token) refreshToken = exchanged.refresh_token;
    } catch (error) {
      log.warn({ err: error }, "google serverAuthCode exchange failed");
    }
  }

  const profile = await fetchGoogleProfile(accessToken);
  const tokenPayload = {
    access_token: exchanged?.access_token || accessToken,
    ...(clientID ? { client_id: clientID } : {}),
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    ...(idToken ? { id_token: idToken } : {}),
    token_type: input.tokenType || "Bearer",
    scope: input.scope || "",
    expires_at: exchanged
      ? Date.now() + Number(exchanged.expires_in || 3600) * 1000
      : Date.now() + Number(input.expiresIn || 3600) * 1000,
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
  const todayKey = dayKey(new Date());
  if (state.briefings[userID]?.[todayKey]) delete state.briefings[userID][todayKey];
  const user = state.users[userID];
  if (user) {
    user.gmailPoll ||= {};
    user.gmailPoll.lastPollAt = null;
  }
}

const server = http.createServer(async (request, response) => {
  applySecurityHeaders(response);
  logRequest(request, response);

  try {
    if (handlePreflight(request, response)) return;

    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    if (request.method === "GET" && (url.pathname === "/v1/health" || url.pathname === "/health")) {
      writeJSON(response, 200, {
        status: "ok",
        version: VERSION,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        mode: integrationMode(),
        storage: storageInfo(),
        databaseConnected: await isDatabaseConnected(),
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
      writeJSON(response, 200, await googleAuthURL(null, "login", url.searchParams.get("returnTo") ?? ""));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/auth/google-native") {
      const input = /** @type {any} */ (await readJSON(request));
      writeJSON(response, 200, await googleNativeLogin(input));
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/google/callback") {
      const code = url.searchParams.get("code");
      const oauthState = url.searchParams.get("state");
      if (!code) throw httpError(400, "missing google authorization code");
      const stateEntry = consumeGoogleOAuthState(oauthState);
      if (!stateEntry) throw httpError(400, "google oauth state is invalid or expired");

      const tokenPayload = await exchangeGoogleCode(code);
      tokenPayload.client_id = config.google?.clientId;
      if (stateEntry.mode === "login") {
        const profile = await fetchGoogleProfile(tokenPayload.access_token);
        const userID = await ensureGoogleAuthUser(profile.email, tokenPayload, profile);
        invalidateBriefingCache(userID);
        const token = await createSession(userID);
        await saveState();
        writeAuthRedirect(response, token, stateEntry.returnTo);
        return;
      }

      const userID = stateEntry.userID;
      ensureUser(userID);
      state.users[userID].googleConnected = true;
      state.users[userID].connectionMode = "google";
      state.users[userID].googleTokens = tokenPayload;
      invalidateBriefingCache(userID);
      await saveState();
      writeHTML(response, 200, "Google connected. You can return to EVE.");
      return;
    }

    // Authenticated routes start here.
    const userID = await requireUserID(request);

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
      const range =
        rangeParam === "week" || rangeParam === "month" ? rangeParam : "day";
      const todayKey = dayKey(new Date());
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
      const email = await getEmailBody(userID, decodeURIComponent(emailBodyMatch[1]));
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
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Math.max(1, Math.min(200, Number(limitParam) || 50)) : 50;
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
      const thought = markThought(userID, decodeURIComponent(markMatch[1]), {
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
      const categories = Array.isArray(input.categories)
        ? input.categories.filter(isCategory)
        : undefined;
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
      const input = /** @type {Record<string, any>} */ (await readJSON(request));
      writeJSON(response, 201, await recordDeviceNotification(userID, input));
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/device-notifications") {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 30)));
      writeJSON(response, 200, { entries: await getDeviceNotifications(userID, limit) });
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
      const input = /** @type {{ action?: string, draftReply?: string }} */ (await readJSON(request));
      const result = await actOnDraft(userID, decodeURIComponent(draftActionMatch[1]), input);
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

// Mount the /v1/voice/live WebSocket bridge. Auth: try the standard
// Bearer header first, then fall back to ?token=... query param since
// some WS clients don't send Authorization on upgrade.
attachVoiceWS(server, async (req) => {
  try {
    const userID = await requireUserID(req);
    if (userID) return userID;
  } catch {
    // fall through to query-string token
  }
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const queryToken = url.searchParams.get("token");
    if (!queryToken) return null;
    // Synthesize a request with the token in the Authorization header so
    // we can reuse the existing requireUserID code path.
    const synthetic = /** @type {any} */ ({
      headers: { authorization: `Bearer ${queryToken}` },
    });
    return await requireUserID(synthetic);
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
