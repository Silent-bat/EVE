/**
 * Auth domain: signup, login, native Google login, session lifecycle.
 *
 * Storage is hidden behind `getPool()` + the shared `state` container. We use
 * Postgres when configured (sessions table, users table) and fall back to
 * keeping sessions in the JSON state otherwise.
 */
import crypto from "node:crypto";
import { config } from "../config.mjs";
import { httpError } from "../http/responses.mjs";
import { ensureUserIn, getPool, LOCAL_USER_ID, save, state } from "../storage/index.mjs";
import { hashPassword, hashToken, normalizeEmail, verifyPassword } from "./password.mjs";

/**
 * @typedef {{ id: string, email: string, passwordHash: string }} AuthUser
 * @typedef {{ id: string, email: string }} BasicUser
 * @typedef {{ userID: string, tokenHash: string }} SessionInfo
 */

const SESSION_TTL_MS = config.authTokenTTLMs;

/**
 * Create a new email/password user, persist them, and return a session token.
 *
 * @param {{ email?: string, password?: string }} input
 */
export async function signup(input) {
  const email = normalizeEmail(input.email);
  const password = String(input.password || "");
  if (!email) throw httpError(400, "email is required");
  if (password.length < 8) throw httpError(400, "password must be at least 8 characters");

  const passwordHash = await hashPassword(password);
  const userID = crypto.randomUUID();
  const pool = getPool();

  if (pool) {
    try {
      await pool.query("insert into users (id, email, password_hash) values ($1, $2, $3)", [
        userID,
        email,
        passwordHash,
      ]);
    } catch (error) {
      // Postgres unique_violation
      if (/** @type {{ code?: string }} */ (error).code === "23505") {
        throw httpError(409, "email is already registered");
      }
      throw error;
    }
  } else if (Object.values(state.users).some((user) => user.email === email)) {
    throw httpError(409, "email is already registered");
  }

  ensureUserIn(state, userID);
  state.users[userID].email = email;
  state.users[userID].passwordHash = passwordHash;
  await save();

  const token = await createSession(userID);
  return { token, userID };
}

/**
 * Verify credentials, ensure the local user record, return a session token.
 *
 * @param {{ email?: string, password?: string }} input
 */
export async function login(input) {
  const email = normalizeEmail(input.email);
  const password = String(input.password || "");
  if (!email || !password) throw httpError(400, "email and password are required");

  const user = await findAuthUserByEmail(email);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw httpError(401, "invalid email or password");
  }

  ensureUserIn(state, user.id);
  state.users[user.id].email = email;
  await save();

  const token = await createSession(user.id);
  return { token, userID: user.id };
}

/**
 * Find an authenticator (email + scrypt hash). Postgres-only path queries
 * `users`; in-memory path filters the state's user dict.
 *
 * @param {string} email
 * @returns {Promise<AuthUser | null>}
 */
export async function findAuthUserByEmail(email) {
  const pool = getPool();
  if (pool) {
    const result = await pool.query("select id, email, password_hash from users where email = $1", [email]);
    const row = result.rows[0];
    return row ? { id: row.id, email: row.email, passwordHash: row.password_hash } : null;
  }
  const entry = Object.values(state.users).find((u) => u.email === email && u.passwordHash);
  return entry ? { id: entry.id, email: entry.email, passwordHash: entry.passwordHash } : null;
}

/**
 * Find any user record by email — for Google login lookups (where there may
 * be no password set yet).
 *
 * @param {string} email
 * @returns {Promise<BasicUser | null>}
 */
export async function findUserByEmail(email) {
  const pool = getPool();
  if (pool) {
    const result = await pool.query("select id, email from users where email = $1", [email]);
    const row = result.rows[0];
    return row ? { id: row.id, email: row.email } : null;
  }
  const entry = Object.values(state.users).find((u) => u.email === email);
  return entry ? { id: entry.id, email: entry.email } : null;
}

/**
 * Find or create a user from a verified Google profile and attach the token
 * payload. Returns the resolved user id.
 *
 * @param {string} email
 * @param {Record<string, unknown>} tokenPayload
 * @param {{ name?: string | null, picture?: string | null } | null} [profile]
 *   The rest of the Google profile. Optional so the password paths and older
 *   callers keep working — without it the account simply has no photo.
 * @returns {Promise<string>}
 */
export async function ensureGoogleAuthUser(email, tokenPayload, profile = null) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw httpError(400, "google account did not return a verified email");

  const existing = await findUserByEmail(normalized);
  const userID = existing?.id || crypto.randomUUID();
  const passwordHash = await hashPassword(crypto.randomBytes(32).toString("base64url"));
  const pool = getPool();

  if (pool && !existing) {
    await pool.query("insert into users (id, email, password_hash) values ($1, $2, $3)", [
      userID,
      normalized,
      passwordHash,
    ]);
  }

  ensureUserIn(state, userID);
  state.users[userID].email = normalized;
  state.users[userID].googleConnected = true;
  state.users[userID].connectionMode = "google";
  // Only overwrite when Google actually sent one. A re-login that omits the
  // photo shouldn't blank the avatar the user already had.
  if (profile?.name) state.users[userID].displayName = profile.name;
  if (profile?.picture) state.users[userID].photoURL = profile.picture;
  // Merge, don't replace. Google does NOT always re-issue a refresh
  // token on re-login (especially when the user already has an active
  // OAuth grant for this app). The previous logic wiped any existing
  // refresh_token whenever the new payload didn't carry one, which
  // forced the user to log out + back in every time the access token
  // expired. Preserve the prior refresh_token when the new payload
  // omits it.
  const previous = state.users[userID].googleTokens || {};
  state.users[userID].googleTokens = {
    ...previous,
    ...tokenPayload,
    refresh_token: tokenPayload.refresh_token || previous.refresh_token,
    // A prior connection may have been flagged as needing re-auth. This IS
    // that re-auth, so clear the flag — spreading `previous` would otherwise
    // carry it forward and leave a working connection marked broken.
    needsReconnect: false,
  };
  return userID;
}

/**
 * Issue a new session token. Stored as a SHA-256 hash; the raw token is
 * returned once to the caller.
 *
 * @param {string} userID
 */
export async function createSession(userID) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const pool = getPool();

  if (pool) {
    await pool.query("insert into auth_sessions (token_hash, user_id, expires_at) values ($1, $2, $3)", [
      tokenHash,
      userID,
      expiresAt,
    ]);
  } else {
    state.sessions ||= {};
    state.sessions[tokenHash] = { userID, expiresAt: expiresAt.toISOString() };
    await save();
  }
  return token;
}

/**
 * Resolve the user ID for a request. Throws 401 unless a valid session token is
 * present — except in local development on JSON storage, where the
 * X-EVE-User-ID header is accepted as a convenience.
 *
 * That exception is gated on `isProduction` and not only on storage mode. The
 * header is caller-supplied, so wherever it is honoured the API has no
 * authentication at all and any user's data is one header away; a deployment
 * that forgets to set DATABASE_URL should fail closed rather than silently open.
 *
 * @param {import("node:http").IncomingMessage} request
 */
export async function requireUserID(request) {
  const session = await optionalSession(request);
  if (session) return session.userID;
  const pool = getPool();
  if (!pool && !config.isProduction) {
    const header = request.headers["x-eve-user-id"];
    if (typeof header === "string") return header;
    if (Array.isArray(header) && header[0]) return header[0];
    return LOCAL_USER_ID;
  }
  throw httpError(401, "authentication required");
}

/**
 * Look up the current session if any, without enforcing it.
 *
 * @param {import("node:http").IncomingMessage} request
 * @returns {Promise<SessionInfo | null>}
 */
export async function optionalSession(request) {
  const token = bearerToken(request);
  if (!token) return null;
  const tokenHash = hashToken(token);
  const pool = getPool();

  if (pool) {
    const result = await pool.query(
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

/**
 * Revoke a session by its token hash.
 *
 * @param {string} tokenHash
 */
export async function revokeSession(tokenHash) {
  const pool = getPool();
  if (pool) {
    await pool.query("delete from auth_sessions where token_hash = $1", [tokenHash]);
    return;
  }
  if (state.sessions) {
    delete state.sessions[tokenHash];
    await save();
  }
}

/**
 * Extract the bearer token from a request, or "" if not present.
 *
 * @param {import("node:http").IncomingMessage} request
 */
export function bearerToken(request) {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") return "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}
