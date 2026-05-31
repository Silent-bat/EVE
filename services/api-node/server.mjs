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
import { getDeviceNotifications, recordDeviceNotification } from "./src/notifications/index.mjs";

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
 * @param {import("node:http").IncomingMessage} request
 */
function clientIP(request) {
  const forwarded = request.headers["x-forwarded-for"];
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof header === "string" && header.length) {
    const [first] = header.split(",");
    if (first) return first.trim();
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
  const refreshToken = String(input.refreshToken || "");
  const idToken = String(input.idToken || "");
  if (!accessToken) throw httpError(400, "google access token is required");

  const profile = await fetchGoogleProfile(accessToken);
  const tokenPayload = {
    access_token: accessToken,
    ...(clientID ? { client_id: clientID } : {}),
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    ...(idToken ? { id_token: idToken } : {}),
    token_type: input.tokenType || "Bearer",
    scope: input.scope || "",
    expires_at: Date.now() + Number(input.expiresIn || 3600) * 1000,
  };
  const userID = await ensureGoogleAuthUser(profile.email, tokenPayload);
  await saveState();
  const token = await createSession(userID);
  return { token, session: sessionPayload(userID) };
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
        const userID = await ensureGoogleAuthUser(profile.email, tokenPayload);
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
      const todayKey = dayKey(new Date());
      if (!state.briefings[userID]?.[todayKey]) {
        await generateBriefing(userID, new Date());
        await saveState();
      }
      writeJSON(response, 200, state.briefings[userID][todayKey]);
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/audit") {
      ensureUser(userID);
      writeJSON(response, 200, { entries: state.audit[userID] || [] });
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
      state.users[userID].preferences = normalizePreferences({
        ...state.users[userID].preferences,
        ...input,
      });
      await saveState();
      writeJSON(response, 200, state.users[userID].preferences);
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

    const draftActionMatch = url.pathname.match(/^\/v1\/drafts\/([^/]+)\/action$/);
    if (request.method === "POST" && draftActionMatch && draftActionMatch[1]) {
      ensureUser(userID);
      const input = /** @type {{ action?: string, draftReply?: string }} */ (await readJSON(request));
      const result = await actOnDraft(userID, decodeURIComponent(draftActionMatch[1]), input);
      await saveState();
      writeJSON(response, 200, result);
      return;
    }

    writeJSON(response, 404, { error: "not found" });
  } catch (error) {
    writeErrorResponse(error, request, response);
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

/** @param {string} signal */
function shutdown(signal) {
  log.info({ signal }, "shutting down");
  clearInterval(briefingInterval);
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
