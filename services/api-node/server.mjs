import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import pg from "pg";

const host = process.env.API_HOST || "127.0.0.1";
const port = Number(process.env.API_PORT || 8080);
const dataDir = process.env.EVE_DATA_DIR || path.join(process.cwd(), ".eve-data");
const statePath = path.join(dataDir, "state.json");
const localUserID = "local-user";
const sessionTTL = Number(process.env.AUTH_TOKEN_TTL_DAYS || 30) * 24 * 60 * 60 * 1000;
const dbPool = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

const jsonHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-EVE-User-ID",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

await initDatabase();
let state = await loadState();

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, jsonHeaders);
      response.end();
      return;
    }

    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    if (request.method === "GET" && url.pathname === "/health") {
      writeJSON(response, 200, { status: "ok", mode: integrationMode(), storage: dbPool ? "postgres" : "json" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/auth/signup") {
      const input = await readJSON(request);
      const result = await signup(input);
      writeJSON(response, 201, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/auth/login") {
      const input = await readJSON(request);
      const result = await login(input);
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
    writeJSON(response, error.status || 500, { error: error.message || "internal server error" });
  }
});

server.listen(port, host, () => {
  console.log(`EVE API listening at http://${host}:${port}`);
  console.log(`Mode: ${JSON.stringify(integrationMode())}`);
});

setInterval(() => {
  void runDueBriefings().catch((error) => {
    console.error(`Scheduled briefing failed: ${error.message}`);
  });
}, 60_000);

async function initDatabase() {
  if (!dbPool) return;

  await dbPool.query(`
    create table if not exists users (
      id text primary key,
      email text unique not null,
      password_hash text not null,
      created_at timestamptz not null default now()
    );

    create table if not exists auth_sessions (
      token_hash text primary key,
      user_id text not null references users(id) on delete cascade,
      expires_at timestamptz not null,
      created_at timestamptz not null default now()
    );

    create table if not exists app_state (
      user_id text primary key references users(id) on delete cascade,
      payload jsonb not null,
      updated_at timestamptz not null default now()
    );

    create table if not exists device_notifications (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      package_name text not null,
      app_name text,
      title text,
      body text,
      posted_at timestamptz not null,
      received_at timestamptz not null default now(),
      raw jsonb not null default '{}'::jsonb
    );

    create index if not exists device_notifications_user_received_idx
      on device_notifications (user_id, received_at desc);
  `);
}

async function loadState() {
  if (dbPool) {
    const seeded = { users: {}, briefings: {}, audit: {}, deviceNotifications: {} };
    const appStateRows = await dbPool.query("select user_id, payload from app_state");
    for (const row of appStateRows.rows) {
      mergePersistedUser(seeded, row.user_id, row.payload || {});
    }
    const userRows = await dbPool.query("select id, email from users");
    for (const row of userRows.rows) {
      ensureUserIn(seeded, row.id);
      seeded.users[row.id].email = row.email;
    }
    const notificationRows = await dbPool.query(
      `select id, user_id, package_name, app_name, title, body, posted_at, received_at, raw
       from device_notifications
       order by received_at desc
       limit 500`,
    );
    for (const row of notificationRows.rows) {
      seeded.deviceNotifications[row.user_id] ||= [];
      seeded.deviceNotifications[row.user_id].push({
        id: row.id,
        userId: row.user_id,
        packageName: row.package_name,
        appName: row.app_name || "",
        title: row.title || "",
        body: row.body || "",
        postedAt: row.posted_at.toISOString(),
        receivedAt: row.received_at.toISOString(),
        raw: row.raw || {},
      });
    }
    return seeded;
  }

  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      users: parsed.users || {},
      briefings: parsed.briefings || {},
      audit: parsed.audit || {},
      deviceNotifications: parsed.deviceNotifications || {},
      sessions: parsed.sessions || {},
      oauthStates: parsed.oauthStates || {},
    };
  } catch {
    const seeded = { users: {}, briefings: {}, audit: {}, deviceNotifications: {}, sessions: {}, oauthStates: {} };
    ensureUserIn(seeded, localUserID);
    return seeded;
  }
}

async function saveState() {
  if (dbPool) {
    await Promise.all(
      Object.keys(state.users).map((userID) =>
        dbPool.query(
          `insert into app_state (user_id, payload, updated_at)
           values ($1, $2, now())
           on conflict (user_id) do update set payload = excluded.payload, updated_at = now()`,
          [userID, statePayload(userID)],
        ),
      ),
    );
    return;
  }

  await mkdir(dataDir, { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

function ensureUser(userID) {
  ensureUserIn(state, userID);
}

function ensureUserIn(target, userID) {
  target.users[userID] ||= {
    id: userID,
    email: undefined,
    googleConnected: false,
    connectionMode: "none",
    preferences: normalizePreferences({ userId: userID }),
  };
  target.briefings[userID] ||= {};
  target.audit[userID] ||= [];
  target.deviceNotifications ||= {};
  target.deviceNotifications[userID] ||= [];
}

function mergePersistedUser(target, userID, payload) {
  ensureUserIn(target, userID);
  const user = payload.user || {};
  target.users[userID] = {
    ...target.users[userID],
    ...user,
    id: userID,
  };
  target.briefings[userID] = payload.briefings || {};
  target.audit[userID] = payload.audit || [];
  target.deviceNotifications[userID] = payload.deviceNotifications || [];
}

function statePayload(userID) {
  const { passwordHash, ...safeUser } = state.users[userID] || {};
  return {
    user: safeUser,
    briefings: state.briefings[userID] || {},
    audit: state.audit[userID] || [],
    deviceNotifications: state.deviceNotifications?.[userID] || [],
  };
}

function normalizePreferences(input) {
  return {
    userId: input.userId || localUserID,
    briefingTime: validTime(input.briefingTime) ? input.briefingTime : "08:00",
    pushEnabled: typeof input.pushEnabled === "boolean" ? input.pushEnabled : true,
    timezone: input.timezone || "Africa/Douala",
  };
}

function validTime(value) {
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value);
}

function sessionPayload(userID) {
  ensureUser(userID);
  const user = state.users[userID];
  return {
    userId: userID,
    email: user.email || null,
    googleConnected: user.googleConnected,
    connectionMode: user.connectionMode,
    integrationMode: integrationMode(),
    preferences: user.preferences,
  };
}

async function signup(input) {
  const email = normalizeEmail(input.email);
  const password = String(input.password || "");
  if (!email) throw httpError(400, "email is required");
  if (password.length < 8) throw httpError(400, "password must be at least 8 characters");

  const passwordHash = await hashPassword(password);
  const userID = crypto.randomUUID();

  if (dbPool) {
    try {
      await dbPool.query("insert into users (id, email, password_hash) values ($1, $2, $3)", [
        userID,
        email,
        passwordHash,
      ]);
    } catch (error) {
      if (error.code === "23505") throw httpError(409, "email is already registered");
      throw error;
    }
  } else if (Object.values(state.users).some((user) => user.email === email)) {
    throw httpError(409, "email is already registered");
  }

  ensureUser(userID);
  state.users[userID].email = email;
  state.users[userID].passwordHash = passwordHash;
  await saveState();

  const token = await createSession(userID);
  return { token, session: sessionPayload(userID) };
}

async function login(input) {
  const email = normalizeEmail(input.email);
  const password = String(input.password || "");
  if (!email || !password) throw httpError(400, "email and password are required");

  const user = await findAuthUserByEmail(email);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw httpError(401, "invalid email or password");
  }

  ensureUser(user.id);
  state.users[user.id].email = email;
  await saveState();

  const token = await createSession(user.id);
  return { token, session: sessionPayload(user.id) };
}

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

async function findAuthUserByEmail(email) {
  if (dbPool) {
    const result = await dbPool.query("select id, email, password_hash from users where email = $1", [email]);
    const row = result.rows[0];
    return row ? { id: row.id, email: row.email, passwordHash: row.password_hash } : null;
  }

  const entry = Object.values(state.users).find((user) => user.email === email && user.passwordHash);
  return entry ? { id: entry.id, email: entry.email, passwordHash: entry.passwordHash } : null;
}

async function findUserByEmail(email) {
  if (dbPool) {
    const result = await dbPool.query("select id, email from users where email = $1", [email]);
    const row = result.rows[0];
    return row ? { id: row.id, email: row.email } : null;
  }

  const entry = Object.values(state.users).find((user) => user.email === email);
  return entry ? { id: entry.id, email: entry.email } : null;
}

async function ensureGoogleAuthUser(email, tokenPayload) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw httpError(400, "google account did not return a verified email");

  const existing = await findUserByEmail(normalizedEmail);
  const userID = existing?.id || crypto.randomUUID();
  const passwordHash = await hashPassword(crypto.randomBytes(32).toString("base64url"));

  if (dbPool && !existing) {
    await dbPool.query("insert into users (id, email, password_hash) values ($1, $2, $3)", [
      userID,
      normalizedEmail,
      passwordHash,
    ]);
  }

  ensureUser(userID);
  state.users[userID].email = normalizedEmail;
  state.users[userID].googleConnected = true;
  state.users[userID].connectionMode = "google";
  state.users[userID].googleTokens = tokenPayload;
  return userID;
}

async function createSession(userID) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + sessionTTL);

  if (dbPool) {
    await dbPool.query("insert into auth_sessions (token_hash, user_id, expires_at) values ($1, $2, $3)", [
      tokenHash,
      userID,
      expiresAt,
    ]);
  } else {
    state.sessions ||= {};
    state.sessions[tokenHash] = { userID, expiresAt: expiresAt.toISOString() };
    await saveState();
  }

  return token;
}

async function requireUserID(request) {
  const session = await optionalSession(request);
  if (session) return session.userID;
  if (!dbPool) return request.headers["x-eve-user-id"]?.toString() || localUserID;
  throw httpError(401, "authentication required");
}

async function optionalSession(request) {
  const token = bearerToken(request);
  if (!token) return null;
  const tokenHash = hashToken(token);

  if (dbPool) {
    const result = await dbPool.query(
      "select user_id, expires_at from auth_sessions where token_hash = $1 and expires_at > now()",
      [tokenHash],
    );
    const row = result.rows[0];
    return row ? { userID: row.user_id, tokenHash } : null;
  }

  const session = state.sessions?.[tokenHash];
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) return null;
  return { userID: session.userID, tokenHash };
}

async function revokeSession(tokenHash) {
  if (dbPool) {
    await dbPool.query("delete from auth_sessions where token_hash = $1", [tokenHash]);
    return;
  }
  if (state.sessions) {
    delete state.sessions[tokenHash];
    await saveState();
  }
}

function bearerToken(request) {
  const header = request.headers.authorization?.toString() || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = await scrypt(password, salt);
  return `scrypt:${salt}:${hash}`;
}

async function verifyPassword(password, stored) {
  const [scheme, salt, expected] = String(stored || "").split(":");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const actual = await scrypt(password, salt);
  return timingSafeEqual(actual, expected);
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, key) => {
      if (error) reject(error);
      else resolve(key.toString("base64url"));
    });
  });
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("base64url");
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
    console.warn(`Gmail fetch failed: ${mailboxResult.reason?.message || mailboxResult.reason}`);
  }
  if (calendarResult.status === "rejected") {
    console.warn(`Google Calendar fetch failed: ${calendarResult.reason?.message || calendarResult.reason}`);
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
      console.warn(`Gemini assistant failed: ${error.message}`);
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
    console.warn(`Gmail send failed for ${draft.id}: ${message}`);
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
    console.warn(`Gemini email analysis failed: ${error.message}`);
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
    console.warn(`Gemini batch email analysis failed: ${error.message}`);
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

function atTime(date, hour, minute) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function dayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function timeKey(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

async function readJSON(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJSON(response, status, payload) {
  response.writeHead(status, jsonHeaders);
  response.end(JSON.stringify(payload));
}

function writeHTML(response, status, message) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(`<!doctype html><html><body><p>${escapeHTML(message)}</p></body></html>`);
}

function writeAuthRedirect(response, token, returnTo) {
  if (!returnTo) {
    writeHTML(response, 200, "Google login complete. Return to EVE.");
    return;
  }

  const separator = returnTo.includes("?") ? "&" : "?";
  const redirectURL = `${returnTo}${separator}eve_token=${encodeURIComponent(token)}`;
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
  });
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

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
