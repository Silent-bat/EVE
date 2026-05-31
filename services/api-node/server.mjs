import crypto from "node:crypto";
import http from "node:http";

import { config } from "./src/config.mjs";
import { logger, moduleLogger } from "./src/logger.mjs";
import {
  applySecurityHeaders,
  handlePreflight,
  logRequest,
  writeErrorResponse,
} from "./src/http/middleware.mjs";
import {
  HttpError,
  httpError,
  readJSON,
  writeAuthRedirect,
  writeHTML,
  writeJSON,
} from "./src/http/responses.mjs";
import {
  addMinutes,
  atTime,
  dayKey,
  timeKey,
} from "./src/utils/dates.mjs";
import {
  close as closeStorage,
  ensureUserIn,
  getPool,
  initialize as initializeStorage,
  isDatabaseConnected,
  LOCAL_USER_ID,
  save as saveStateToStorage,
  state,
  storageInfo,
} from "./src/storage/index.mjs";
import {
  normalizePreferences,
  sessionPayload as buildSessionPayload,
  statePayload,
  validTime,
} from "./src/storage/state.mjs";
import {
  bearerToken,
  createSession,
  ensureGoogleAuthUser,
  findAuthUserByEmail,
  findUserByEmail,
  login as authLogin,
  optionalSession,
  requireUserID,
  revokeSession,
  signup as authSignup,
} from "./src/auth/index.mjs";
import { hashPassword, hashToken, normalizeEmail } from "./src/auth/password.mjs";
import { enforceAuthRateLimit } from "./src/auth/rate-limit.mjs";

const log = moduleLogger("server");
const host = config.host;
const port = config.port;
const localUserID = LOCAL_USER_ID;
const sessionTTL = config.authTokenTTLMs;

const startedAt = Date.now();

await initializeStorage();
const dbPool = getPool();

function ensureUser(userID) {
  ensureUserIn(state, userID);
}

async function saveState() {
  await saveStateToStorage();
}

function sessionPayload(userID) {
  return buildSessionPayload(state, userID, integrationMode());
}

function clientIP(request) {
  const forwarded = request.headers["x-forwarded-for"];
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof header === "string" && header.length) return header.split(",")[0].trim();
  return request.socket?.remoteAddress || "";
}

/**
 * Wrap authLogin/authSignup to add rate limiting and include the session
 * payload in the response body (matching the original API shape).
 */
async function signup(input, ip) {
  enforceAuthRateLimit(ip, normalizeEmail(input?.email));
  const { token, userID } = await authSignup(input);
  return { token, session: sessionPayload(userID) };
}

async function login(input, ip) {
  enforceAuthRateLimit(ip, normalizeEmail(input?.email));
  const { token, userID } = await authLogin(input);
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
        version: "0.2.0",
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        mode: integrationMode(),
        storage: storageInfo(),
        databaseConnected: await isDatabaseConnected(),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/auth/signup") {
      const input = await readJSON(request);
      const result = await signup(input, clientIP(request));
      writeJSON(response, 201, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/auth/login") {
      const input = await readJSON(request);
      const result = await login(input, clientIP(request));
      writeJSON(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/auth/logout") {
      const session = await optionalSession(request);
      if (session) await revokeSession(session.tokenHash);
      writeJSON(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/auth/google-url") {
      writeJSON(response, 200, await googleAuthURL(null, "login", url.searchParams.get("returnTo")));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/auth/google-native") {
      const input = await readJSON(request);
      const result = await googleNativeLogin(input);
      writeJSON(response, 200, result);
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/google/callback") {
      const code = url.searchParams.get("code");
      const oauthState = url.searchParams.get("state");
      if (!code) throw httpError(400, "missing google authorization code");
      const stateEntry = consumeGoogleOAuthState(oauthState);
      if (!stateEntry) throw httpError(400, "google oauth state is invalid or expired");

      const tokenPayload = await exchangeGoogleCode(code);
      tokenPayload.client_id = process.env.GOOGLE_CLIENT_ID;
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
      const input = await readJSON(request);
      state.users[userID].preferences = normalizePreferences({
        ...state.users[userID].preferences,
        ...input,
      });
      await saveState();
      writeJSON(response, 200, state.users[userID].preferences);
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/device-notifications") {
      const input = await readJSON(request);
      const event = await recordDeviceNotification(userID, input);
      writeJSON(response, 201, event);
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/device-notifications") {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 30)));
      writeJSON(response, 200, { entries: await getDeviceNotifications(userID, limit) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/assistant/ask") {
      ensureUser(userID);
      const input = await readJSON(request);
      const result = await askAssistant(userID, input);
      writeJSON(response, 200, result);
      return;
    }

    const draftActionMatch = url.pathname.match(/^\/v1\/drafts\/([^/]+)\/action$/);
    if (request.method === "POST" && draftActionMatch) {
      ensureUser(userID);
      const input = await readJSON(request);
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

server.listen(port, host, () => {
  log.info(
    {
      address: `http://${host}:${port}`,
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

function shutdown(signal) {
  log.info({ signal }, "shutting down");
  clearInterval(briefingInterval);
  server.close((err) => {
    if (err) log.error({ err }, "server close error");
    closeStorage().catch((err) => log.error({ err }, "storage close error")).finally(() => {
      process.exit(err ? 1 : 0);
    });
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

async function googleNativeLogin(input) {
  const clientID = String(input.clientId || process.env.GOOGLE_ANDROID_CLIENT_ID || "");
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

function integrationMode() {
  const hasGoogle = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const hasLLM = Boolean(process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY);
  return {
    google: hasGoogle ? "configured" : "not-configured",
    llm: hasLLM ? "configured" : "local",
    emailSending: hasGoogle ? "gmail-api" : "audit-only",
  };
}

async function googleAuthURL(userID, mode = "connect", returnTo = "") {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REDIRECT_URI) {
    return {
      configured: false,
      url: null,
      reason: "GOOGLE_CLIENT_ID and GOOGLE_REDIRECT_URI are not configured.",
    };
  }

  const oauthState = createGoogleOAuthState(userID, mode, returnTo);
  await saveState();
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/calendar.readonly",
    ].join(" "),
    state: oauthState,
  });

  return {
    configured: true,
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  };
}

function createGoogleOAuthState(userID, mode = "connect", returnTo = "") {
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

function consumeGoogleOAuthState(oauthState) {
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

function safeReturnTo(value) {
  const returnTo = String(value || "").trim();
  if (!returnTo) return "";
  if (returnTo.startsWith("eve://")) return returnTo;
  if (returnTo.startsWith("http://localhost:") || returnTo.startsWith("http://127.0.0.1:")) return returnTo;
  return "";
}

async function runDueBriefings() {
  const now = new Date();
  let changed = false;
  for (const userID of Object.keys(state.users)) {
    const prefs = state.users[userID].preferences;
    if (!prefs?.briefingTime) continue;
    if (prefs.briefingTime !== timeKey(now)) continue;

    const today = dayKey(now);
    const existing = state.briefings[userID]?.[today];
    if (existing?.scheduledAt === today) continue;

    const briefing = await generateBriefing(userID, now);
    briefing.scheduledAt = today;
    changed = true;
  }
  if (changed) await saveState();
}

async function exchangeGoogleCode(code) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) {
    throw httpError(400, "google oauth is not configured");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
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

async function fetchGoogleProfile(accessToken) {
  const payload = await googleJSON("https://openidconnect.googleapis.com/v1/userinfo", accessToken);
  if (!payload.email || payload.email_verified === false) {
    throw httpError(400, "google account did not return a verified email");
  }
  return { email: payload.email };
}

async function refreshGoogleToken(user) {
  if (!user.googleTokens?.refresh_token) {
    return user.googleTokens?.access_token;
  }
  if (user.googleTokens.expires_at && user.googleTokens.expires_at > Date.now() + 60_000) {
    return user.googleTokens.access_token;
  }

  const clientID = user.googleTokens.client_id || process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_ANDROID_CLIENT_ID;
  if (!clientID) return user.googleTokens.access_token;

  const body = new URLSearchParams({
    refresh_token: user.googleTokens.refresh_token,
    client_id: clientID,
    grant_type: "refresh_token",
  });
  if (process.env.GOOGLE_CLIENT_SECRET && clientID === process.env.GOOGLE_CLIENT_ID) {
    body.set("client_secret", process.env.GOOGLE_CLIENT_SECRET);
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error_description || payload.error || "google refresh failed");

  user.googleTokens = {
    ...user.googleTokens,
    ...payload,
    expires_at: Date.now() + Number(payload.expires_in || 3600) * 1000,
  };
  await saveState();
  return user.googleTokens.access_token;
}

async function fetchGmailMessages(user, now) {
  const accessToken = await refreshGoogleToken(user);
  if (!accessToken) return [];

  const after = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime() / 1000);
  const listURL = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listURL.searchParams.set("maxResults", "20");
  listURL.searchParams.set("q", `newer:${after}`);

  const list = await googleJSON(listURL, accessToken);
  const messages = await Promise.all(
    (list.messages || []).slice(0, 10).map((item) =>
      googleJSON(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=full`, accessToken),
    ),
  );

  return messages.map((message) => {
    const headers = message.payload?.headers || [];
    const from = headerValue(headers, "From");
    const parsedFrom = parseSender(from);
    const date = new Date(Number(message.internalDate || Date.now()));
    return {
      id: message.id,
      threadId: message.threadId,
      senderName: parsedFrom.name,
      senderEmail: parsedFrom.email,
      subject: headerValue(headers, "Subject") || "(no subject)",
      receivedAtHour: date.getHours(),
      receivedAtMinute: date.getMinutes(),
      body: decodeGmailBody(message.payload) || message.snippet || "",
    };
  });
}

async function fetchCalendarEvents(user, now) {
  const accessToken = await refreshGoogleToken(user);
  if (!accessToken) return [];

  const timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).toISOString();
  const timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0).toISOString();
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);

  const payload = await googleJSON(url, accessToken);
  return (payload.items || []).slice(0, 10).map((event) => {
    const startsAt = new Date(event.start?.dateTime || event.start?.date || now);
    const endsAt = new Date(event.end?.dateTime || event.end?.date || startsAt.getTime() + 30 * 60 * 1000);
    return {
      id: event.id,
      title: event.summary || "(busy)",
      startHour: startsAt.getHours(),
      startMinute: startsAt.getMinutes(),
      durationMinutes: Math.max(15, Math.round((endsAt.getTime() - startsAt.getTime()) / 60000)),
      location: event.location || event.hangoutLink || "Calendar",
    };
  });
}

async function googleJSON(url, accessToken, init = {}) {
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

async function generateBriefing(userID, now) {
  const generatedAt = atTime(now, 7, 45);
  const source = await briefingSource(userID, now);
  const scoredMessages = source.mailbox.map((message) => ({ message, score: urgencyScore(message) }));
  const analyses = await analyzeMessages(scoredMessages);
  const emails = scoredMessages.map(({ message, score }, index) => {
      const analysis = analyses[index] || localMessageAnalysis(message, score);
      return {
        id: `draft-${message.id}`,
        threadId: message.threadId,
        senderName: message.senderName,
        senderEmail: message.senderEmail,
        subject: message.subject,
        receivedAt: atTime(now, message.receivedAtHour, message.receivedAtMinute).toISOString(),
        urgencyScore: analysis.urgencyScore,
        urgencyReason: analysis.urgencyReason,
        summary: analysis.summary,
        draftReply: analysis.draftReply,
        status: "pending",
      };
    });

  const briefing = {
    id: `briefing-${dayKey(now)}`,
    userId: userID,
    generatedAt: generatedAt.toISOString(),
    stats: {
      priorityEmails: emails.filter((email) => email.urgencyScore >= 75).length,
      meetingsToday: source.calendar.length,
      approvedReplies: 0,
    },
    emails: emails.sort((a, b) => b.urgencyScore - a.urgencyScore),
    calendar: source.calendar.map((event) => ({
      id: event.id,
      title: event.title,
      startsAt: atTime(now, event.startHour, event.startMinute).toISOString(),
      endsAt: addMinutes(atTime(now, event.startHour, event.startMinute), event.durationMinutes).toISOString(),
      location: event.location,
    })),
  };

  state.briefings[userID][dayKey(now)] = briefing;
  return briefing;
}

async function briefingSource(userID, now) {
  const user = state.users[userID];
  if (user?.connectionMode !== "google" || !user.googleTokens?.access_token) {
    return { mailbox: [], calendar: [] };
  }

  const [mailboxResult, calendarResult] = await Promise.allSettled([
    fetchGmailMessages(user, now),
    fetchCalendarEvents(user, now),
  ]);

  if (mailboxResult.status === "rejected") {
    log.warn({ err: mailboxResult.reason }, "Gmail fetch failed");
  }
  if (calendarResult.status === "rejected") {
    log.warn({ err: calendarResult.reason }, "Google Calendar fetch failed");
  }

  return {
    mailbox: mailboxResult.status === "fulfilled" ? mailboxResult.value : [],
    calendar: calendarResult.status === "fulfilled" ? calendarResult.value : [],
  };
}

async function askAssistant(userID, input) {
  const prompt = sanitizePlainText(input.prompt, 1200);
  if (!prompt) throw httpError(400, "prompt is required");

  const today = dayKey(new Date());
  if (!state.briefings[userID]?.[today]) {
    await generateBriefing(userID, new Date());
    await saveState();
  }

  const context = assistantContext(userID, today);
  const generatedAt = new Date().toISOString();
  if (process.env.GEMINI_API_KEY) {
    try {
      const answer = await geminiGenerate(
        [
          "You are EVE, a practical personal operations assistant.",
          "Answer the user's request using only the provided workspace context.",
          "If the data is missing, say what is missing and suggest the next concrete action.",
          "Be concise, specific, and never invent emails, meetings, people, or notifications.",
          "",
          `Workspace context JSON:\n${JSON.stringify(context, null, 2)}`,
          "",
          `User request: ${prompt}`,
        ].join("\n"),
        { temperature: 0.2, maxOutputTokens: 700 },
      );
      return { answer, source: "gemini", generatedAt };
    } catch (error) {
      log.warn({ err: error }, "Gemini assistant failed");
    }
  }

  return {
    answer: localAssistantAnswer(prompt, context),
    source: "local",
    generatedAt,
  };
}

async function actOnDraft(userID, draftID, input) {
  const action = input.action;
  if (action !== "approve" && action !== "reject") {
    throw httpError(400, "action must be approve or reject");
  }

  const briefing = state.briefings[userID]?.[dayKey(new Date())];
  if (!briefing) throw httpError(404, "briefing not found");

  const draft = briefing.emails.find((email) => email.id === draftID);
  if (!draft) throw httpError(404, "draft not found");
  if (draft.status !== "pending") throw httpError(409, "draft already approved or rejected");

  const before = draft.draftReply;
  if (typeof input.draftReply === "string" && input.draftReply.trim()) {
    draft.draftReply = input.draftReply.trim();
  }
  draft.status = action === "approve" ? "approved" : "rejected";
  briefing.stats.approvedReplies = briefing.emails.filter((email) => email.status === "approved").length;
  const delivery = action === "approve" ? await deliverApprovedReply(userID, draft) : { status: "not-sent" };

  const entry = {
    id: `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    userId: userID,
    draftId: draft.id,
    action,
    subject: draft.subject,
    createdAt: new Date().toISOString(),
    before,
    after: draft.draftReply,
    deliveryStatus: delivery.status,
    ...(delivery.error ? { deliveryError: delivery.error } : {}),
  };

  state.audit[userID].push(entry);
  return { draft, audit: entry, briefing };
}

async function recordDeviceNotification(userID, input) {
  const packageName = sanitizePlainText(input.packageName, 120);
  if (!packageName) throw httpError(400, "packageName is required");

  const event = {
    id: input.id ? sanitizePlainText(input.id, 160) : `notif-${Date.now()}-${crypto.randomUUID()}`,
    userId: userID,
    packageName,
    appName: sanitizePlainText(input.appName, 120),
    title: sanitizePlainText(input.title, 240),
    body: sanitizePlainText(input.body || input.text, 2000),
    postedAt: validDateISOString(input.postedAt) || new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    raw: safeRawNotification(input),
  };

  if (dbPool) {
    await dbPool.query(
      `insert into device_notifications
        (id, user_id, package_name, app_name, title, body, posted_at, received_at, raw)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (id) do nothing`,
      [
        event.id,
        userID,
        event.packageName,
        event.appName,
        event.title,
        event.body,
        event.postedAt,
        event.receivedAt,
        event.raw,
      ],
    );
  }

  state.deviceNotifications ||= {};
  state.deviceNotifications[userID] ||= [];
  if (!state.deviceNotifications[userID].some((item) => item.id === event.id)) {
    state.deviceNotifications[userID].unshift(event);
    state.deviceNotifications[userID] = state.deviceNotifications[userID].slice(0, 100);
  }
  await saveState();
  return event;
}

async function getDeviceNotifications(userID, limit) {
  if (dbPool) {
    const result = await dbPool.query(
      `select id, user_id, package_name, app_name, title, body, posted_at, received_at, raw
       from device_notifications
       where user_id = $1
       order by received_at desc
       limit $2`,
      [userID, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      packageName: row.package_name,
      appName: row.app_name || "",
      title: row.title || "",
      body: row.body || "",
      postedAt: row.posted_at.toISOString(),
      receivedAt: row.received_at.toISOString(),
      raw: row.raw || {},
    }));
  }

  const entries = state.deviceNotifications?.[userID] || [];
  return entries.slice(0, limit);
}

function sanitizePlainText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function validDateISOString(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function safeRawNotification(input) {
  return {
    packageName: sanitizePlainText(input.packageName, 120),
    appName: sanitizePlainText(input.appName, 120),
    title: sanitizePlainText(input.title, 240),
    body: sanitizePlainText(input.body || input.text, 2000),
    postedAt: validDateISOString(input.postedAt) || null,
  };
}

async function deliverApprovedReply(userID, draft) {
  const user = state.users[userID];
  if (user?.connectionMode !== "google" || !user.googleTokens?.access_token) {
    return { status: "audit-only" };
  }

  try {
    const accessToken = await refreshGoogleToken(user);
    if (!accessToken) return { status: "audit-only" };

    await googleJSON("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", accessToken, {
      method: "POST",
      body: JSON.stringify({
        raw: encodeBase64URL(replyRFC822(draft)),
        threadId: draft.threadId,
      }),
    });
    return { status: "sent" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "gmail send failed";
    log.warn({ draftId: draft.id, message }, "Gmail send failed");
    return { status: "send-failed", error: message };
  }
}

function replyRFC822(draft) {
  const subject = draft.subject.toLowerCase().startsWith("re:") ? draft.subject : `Re: ${draft.subject}`;
  return [
    `To: ${formatAddress(draft.senderName, draft.senderEmail)}`,
    `Subject: ${sanitizeHeader(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    draft.draftReply,
  ].join("\r\n");
}

function formatAddress(name, email) {
  const cleanEmail = sanitizeHeader(email || "unknown@example.com");
  const cleanName = sanitizeHeader(name || "").replaceAll('"', "");
  return cleanName ? `"${cleanName}" <${cleanEmail}>` : cleanEmail;
}

function sanitizeHeader(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function encodeBase64URL(value) {
  return Buffer.from(value, "utf8").toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

async function draftReply(message, score) {
  return localDraft(message, score);
}

async function analyzeMessage(message, score) {
  const fallback = localMessageAnalysis(message, score);
  if (!process.env.GEMINI_API_KEY) return fallback;

  try {
    const text = await geminiGenerate(
      [
        "Analyze this email for a personal assistant briefing.",
        "Return only JSON with these keys:",
        "urgencyScore: number from 1 to 99, urgencyReason: short sentence, summary: one sentence, draftReply: concise reply or exactly \"No reply needed.\"",
        "",
        `Email JSON:\n${JSON.stringify(
          {
            from: `${message.senderName} <${message.senderEmail}>`,
            subject: message.subject,
            body: message.body,
            receivedAtHour: message.receivedAtHour,
            receivedAtMinute: message.receivedAtMinute,
          },
          null,
          2,
        )}`,
      ].join("\n"),
      { temperature: 0.15, maxOutputTokens: 450 },
    );
    return normalizeMessageAnalysis(parseJSONFromText(text), fallback);
  } catch (error) {
    log.warn({ err: error }, "Gemini email analysis failed");
    return fallback;
  }
}

async function analyzeMessages(scoredMessages) {
  const fallback = scoredMessages.map(({ message, score }) => localMessageAnalysis(message, score));
  if (!process.env.GEMINI_API_KEY || scoredMessages.length === 0) return fallback;

  try {
    const text = await geminiGenerate(
      [
        "Analyze these emails for a personal assistant briefing.",
        "Return only JSON with this shape: {\"emails\":[...]}",
        "The emails array must use the same order as the input.",
        "Each item must contain urgencyScore as a number from 1 to 99, urgencyReason as a short sentence, summary as one sentence, and draftReply as a concise reply or exactly \"No reply needed.\"",
        "",
        `Emails JSON:\n${JSON.stringify(
          scoredMessages.map(({ message, score }) => ({
            fallbackUrgencyScore: score,
            from: `${message.senderName} <${message.senderEmail}>`,
            subject: message.subject,
            body: message.body,
            receivedAtHour: message.receivedAtHour,
            receivedAtMinute: message.receivedAtMinute,
          })),
          null,
          2,
        )}`,
      ].join("\n"),
      { temperature: 0.15, maxOutputTokens: 1800 },
    );
    const parsed = parseJSONFromText(text);
    const rows = Array.isArray(parsed.emails) ? parsed.emails : [];
    return scoredMessages.map(({ message, score }, index) =>
      normalizeMessageAnalysis(rows[index] || {}, localMessageAnalysis(message, score)),
    );
  } catch (error) {
    log.warn({ err: error }, "Gemini batch email analysis failed");
    return fallback;
  }
}

function localMessageAnalysis(message, score) {
  return {
    urgencyScore: score,
    urgencyReason: urgencyReason(message, score),
    summary: summarizeMessage(message),
    draftReply: localDraft(message, score),
  };
}

function normalizeMessageAnalysis(input, fallback) {
  return {
    urgencyScore: clampNumber(input.urgencyScore, 1, 99, fallback.urgencyScore),
    urgencyReason: sanitizePlainText(input.urgencyReason, 220) || fallback.urgencyReason,
    summary: sanitizePlainText(input.summary, 420) || fallback.summary,
    draftReply: sanitizePlainText(input.draftReply, 1200) || fallback.draftReply,
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

async function geminiGenerate(prompt, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const modelName = model.startsWith("models/") ? model : `models/${model}`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: options.temperature ?? 0.2,
        maxOutputTokens: options.maxOutputTokens ?? 700,
      },
    }),
  });

  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "gemini request failed");

  const text = (payload.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => part.text || "")
    .join("\n")
    .trim();
  if (!text) throw new Error("gemini returned an empty answer");
  return text;
}

function parseJSONFromText(text) {
  const clean = String(text || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("gemini did not return JSON");
  return JSON.parse(clean.slice(start, end + 1));
}

function assistantContext(userID, briefingKey = dayKey(new Date())) {
  const briefing = state.briefings[userID]?.[briefingKey] || null;
  return {
    now: new Date().toISOString(),
    user: {
      id: userID,
      email: state.users[userID]?.email || null,
      googleConnected: Boolean(state.users[userID]?.googleConnected),
    },
    briefing: briefing
      ? {
          generatedAt: briefing.generatedAt,
          stats: briefing.stats,
          emails: (briefing.emails || []).slice(0, 12).map((email) => ({
            id: email.id,
            from: `${email.senderName} <${email.senderEmail}>`,
            subject: email.subject,
            receivedAt: email.receivedAt,
            urgencyScore: email.urgencyScore,
            urgencyReason: email.urgencyReason,
            summary: email.summary,
            draftReply: email.draftReply,
            status: email.status,
          })),
          calendar: (briefing.calendar || []).slice(0, 12),
        }
      : null,
    recentNotifications: (state.deviceNotifications?.[userID] || []).slice(0, 15).map((entry) => ({
      appName: entry.appName,
      packageName: entry.packageName,
      title: entry.title,
      body: entry.body,
      receivedAt: entry.receivedAt,
    })),
    recentAudit: (state.audit[userID] || []).slice(-15),
  };
}

function localAssistantAnswer(prompt, context) {
  const emails = context.briefing?.emails || [];
  const pending = emails.filter((email) => email.status === "pending");
  if (emails.length === 0) {
    return "I do not have Gmail briefing data yet. Connect Gmail, then refresh the briefing so I can answer from real mailbox data.";
  }

  const top = emails[0];
  const lowerPrompt = prompt.toLowerCase();
  if (lowerPrompt.includes("urgent") || lowerPrompt.includes("priority")) {
    return `Top priority: ${top.subject} from ${top.from}. ${top.summary} Reason: ${top.urgencyReason}`;
  }
  if (lowerPrompt.includes("reply") || lowerPrompt.includes("draft")) {
    return pending.length
      ? `There are ${pending.length} pending replies. The next draft is for "${pending[0].subject}": ${pending[0].draftReply}`
      : "There are no pending replies in the current briefing.";
  }
  return `I found ${emails.length} emails and ${context.briefing?.calendar?.length || 0} calendar items in the latest briefing. Ask about priorities, drafts, meetings, or notifications.`;
}

function localDraft(message, score) {
  const greeting = `Hi ${message.senderName.split(" ")[0]},`;
  if (message.subject.toLowerCase().includes("invoice")) return "No reply needed.";
  if (message.subject.toLowerCase().includes("contract")) {
    return `${greeting} I saw this. I am reviewing the final agreement now and will send the signed version before noon.`;
  }
  if (message.subject.toLowerCase().includes("design review")) {
    return `${greeting} yes, we can move it. I can do 16:30 today if that still works for the team.`;
  }
  if (message.subject.toLowerCase().includes("investor")) {
    return `${greeting} thanks for the heads up. 11:30 works for me, and I will bring the revised deck with the updated retention slide.`;
  }
  if (score < 50) return "No reply needed.";
  return `${greeting} thanks for sending this. I saw it and will follow up today.`;
}

function urgencyScore(message) {
  const text = `${message.subject} ${message.body}`.toLowerCase();
  let score = 30;
  if (text.includes("today")) score += 28;
  if (text.includes("noon") || text.includes("before")) score += 24;
  if (text.includes("confirm") || text.includes("needed")) score += 18;
  if (text.includes("investor") || text.includes("contract")) score += 16;
  if (text.includes("invoice")) score -= 10;
  if (text.includes("newsletter")) score -= 25;
  return Math.max(1, Math.min(99, score));
}

function urgencyReason(message, score) {
  const text = `${message.subject} ${message.body}`.toLowerCase();
  if (text.includes("noon")) return "Deadline inside the next five hours.";
  if (text.includes("investor")) return "Meeting moved into today's calendar window.";
  if (text.includes("design review")) return "Impacts a meeting already on today's calendar.";
  if (score < 50) return "Informational item, not urgent for today.";
  return "Relevant to today's work and likely needs a response.";
}

function summarizeMessage(message) {
  const body = message.body.replace(/\s+/g, " ").trim();
  return body.length > 150 ? `${body.slice(0, 147)}...` : body;
}

function headerValue(headers, name) {
  return headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function parseSender(value) {
  const match = value.match(/^(.*)<([^>]+)>$/);
  if (!match) {
    return {
      name: value.split("@")[0] || "Unknown",
      email: value || "unknown@example.com",
    };
  }

  return {
    name: match[1].replaceAll('"', "").trim() || match[2],
    email: match[2].trim(),
  };
}

function decodeGmailBody(payload) {
  if (!payload) return "";
  if (payload.body?.data) return decodeBase64URL(payload.body.data);
  for (const part of payload.parts || []) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      return decodeBase64URL(part.body.data);
    }
  }
  for (const part of payload.parts || []) {
    const nested = decodeGmailBody(part);
    if (nested) return nested;
  }
  return "";
}

function decodeBase64URL(value) {
  return Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64")
    .toString("utf8")
    .replace(/\s+/g, " ")
    .trim();
}


