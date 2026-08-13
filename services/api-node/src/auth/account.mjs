/**
 * Account management: the things a signed-in user can change about their own
 * account without deleting it.
 *
 * Deletion already lived in `purgeUser`, but everything short of that — the
 * name on the account, the password, the Google grant, the sessions on other
 * devices — had no server-side route, so the app's Account page could only
 * report state it was unable to alter. These are those routes.
 *
 * Each one works in both storage modes. Postgres owns `users` and
 * `auth_sessions`; the JSON fallback keeps the same records in `state`, so
 * every function writes through both paths rather than assuming one.
 */
import { httpError } from "../http/responses.mjs";
import { getPool, save, state } from "../storage/index.mjs";
import { hashPassword, verifyPassword } from "./password.mjs";

/** Longest display name we'll store. Long enough for any real name. */
const MAX_NAME = 80;

/**
 * Rename the account. This is the name the app's header and avatar read, and
 * for a password account it is the only name that exists — Google accounts get
 * one from the provider, which this then overrides.
 *
 * An empty string clears it, which is a legitimate choice: the UI falls back to
 * the email address, and someone who never wanted a name shouldn't be stuck
 * with whatever Google supplied.
 *
 * @param {string} userID
 * @param {unknown} value
 */
export async function setDisplayName(userID, value) {
  if (value !== null && typeof value !== "string") {
    throw httpError(400, "displayName must be a string or null");
  }
  const name = typeof value === "string" ? value.trim().slice(0, MAX_NAME) : "";
  const user = state.users[userID];
  if (!user) throw httpError(404, "account not found");

  user.displayName = name || null;
  await save();
  return { displayName: user.displayName };
}

/**
 * Change the password on an email/password account.
 *
 * The current password is required even though the caller already holds a valid
 * session: a session token proves the phone is unlocked, not that the person
 * holding it knows the password, and password change is exactly the step an
 * attacker with a borrowed phone would take to lock the owner out.
 *
 * Google-only accounts have no password to change and get a 400 saying so
 * rather than a silent success.
 *
 * @param {string} userID
 * @param {{ currentPassword?: unknown, newPassword?: unknown }} input
 */
export async function changePassword(userID, input) {
  const current = String(input.currentPassword || "");
  const next = String(input.newPassword || "");
  if (!current || !next) throw httpError(400, "currentPassword and newPassword are required");
  if (next.length < 8) throw httpError(400, "newPassword must be at least 8 characters");
  if (next === current) throw httpError(400, "the new password matches the old one");

  const user = state.users[userID];
  const storedHash = user?.passwordHash || (await passwordHashFromPool(userID));
  if (!storedHash) {
    throw httpError(400, "this account signs in with Google and has no password");
  }
  if (!(await verifyPassword(current, storedHash))) {
    throw httpError(401, "current password is incorrect");
  }

  const passwordHash = await hashPassword(next);
  const pool = getPool();
  if (pool) {
    await pool.query("update users set password_hash = $1 where id = $2", [passwordHash, userID]);
  }
  if (user) user.passwordHash = passwordHash;
  await save();
  return { ok: true };
}

/**
 * Drop the Google connection while keeping the account.
 *
 * Sign-out already revokes the grant, but it also ends the session — there was
 * no way to stay signed in to EVE and disconnect the mailbox. Tokens are
 * deleted rather than marked stale so nothing can keep reading mail on a
 * connection the user just withdrew.
 *
 * The briefing and audit history stay: they are a record of what EVE did, and
 * disconnecting is not a request to erase it. Deleting the account is.
 *
 * @param {string} userID
 */
export async function disconnectGoogle(userID) {
  const user = state.users[userID];
  if (!user) throw httpError(404, "account not found");

  const token = user.googleTokens?.access_token || user.googleTokens?.refresh_token || "";
  delete user.googleTokens;
  user.googleConnected = false;
  user.connectionMode = "none";
  await save();

  // Best-effort: tell Google too. A failure here doesn't undo the local
  // disconnect — the tokens are already gone from our side.
  if (token) {
    try {
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
      });
    } catch {
      /* the grant may already be gone; nothing to do */
    }
  }

  return { googleConnected: false, connectionMode: "none" };
}

/**
 * Revoke every session for this user, including the one making the request.
 *
 * Deliberately not "every session except mine": someone reaching for this has
 * lost a device or suspects a borrowed one, and the safe reading of "sign out
 * everywhere" is everywhere. The caller's own token dies with the rest, so the
 * app returns to the sign-in screen.
 *
 * @param {string} userID
 */
export async function revokeAllSessions(userID) {
  const pool = getPool();
  let revoked = 0;

  if (pool) {
    const result = await pool.query("delete from auth_sessions where user_id = $1", [userID]);
    revoked = Number(result.rowCount || 0);
  }

  for (const [tokenHash, session] of Object.entries(state.sessions || {})) {
    if (session?.userID !== userID) continue;
    delete state.sessions[tokenHash];
    if (!pool) revoked += 1;
  }
  await save();

  return { ok: true, revoked };
}

/**
 * Postgres keeps the authoritative password hash; the JSON state mirrors it for
 * single-process runs. Read through to the pool when the mirror is empty.
 *
 * @param {string} userID
 */
async function passwordHashFromPool(userID) {
  const pool = getPool();
  if (!pool) return "";
  const result = await pool.query("select password_hash from users where id = $1", [userID]);
  return result.rows[0]?.password_hash || "";
}
