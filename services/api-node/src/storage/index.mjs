/**
 * Storage facade. Hides the dual-write (Postgres + JSON) behavior so callers
 * just see `state`, `load()`, and `save()`.
 *
 * When DATABASE_URL is set, reads come from Postgres and writes go to
 * Postgres only. When unset, JSON is the source of truth.
 *
 * The dual-write is intentional (per user choice) but lives entirely inside
 * this module — the rest of the codebase stays storage-agnostic.
 */
import { config } from "../config.mjs";
import { httpError } from "../http/responses.mjs";
import { moduleLogger } from "../logger.mjs";
import { loadFromJSON, saveToJSON } from "./json.mjs";
import {
  closePool,
  createPool,
  consumeOAuthStateFromPostgres,
  ensureSchema,
  getPool,
  loadFromPostgres,
  OAUTH_ADVISORY_LOCK,
  STATE_SAVE_LOCK,
  BACKGROUND_SWEEP_LOCK,
  forgetPersistedUser,
  saveOAuthStateToPostgres,
  pingDatabase,
  refreshUserFromPostgres,
  saveToPostgres,
  StateConflictError,
  tryWithPostgresAdvisoryLock,
} from "./postgres.mjs";
import { emptyState, LOCAL_USER_ID, assertUserID, ensureUserIn, isValidUserID } from "./state.mjs";

export { BACKGROUND_SWEEP_LOCK };

const log = moduleLogger("storage");

/**
 * Module-level state container. After `initialize()` returns, this is
 * populated and safe to mutate from caller modules.
 *
 * @type {import("./state.mjs").StateShape}
 */
export const state = emptyState();

// Domain handlers can finish on different microtasks. Serialize persistence so
// a slower snapshot cannot land after a newer one within this process. Database
// transactions in postgres.mjs provide the cross-table atomicity; this queue
// closes the common same-instance race.
/** @type {Promise<unknown>} */
let saveChain = Promise.resolve();

// A request can authenticate just before deletion and reach an `ensureUser`
// call after the in-memory record has been removed. Keep a process-local
// tombstone so that path cannot silently recreate the account while purge is in
// flight. The database delete remains the cross-process source of truth.
const deletedUsers = new Set();

/** Process-local fallback for background jobs when Postgres is not configured. */
const localAdvisoryLocks = new Set();

/** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
function enqueuePersistence(operation) {
  const result = saveChain.then(operation, operation);
  saveChain = result.catch(() => undefined);
  return result;
}

/**
 * Initialize the storage backend. Creates the Postgres pool (if configured),
 * runs the schema bootstrap, loads state, and seeds the local user.
 */
export async function initialize() {
  deletedUsers.clear();
  createPool();
  await ensureSchema();
  const loaded = getPool() ? await loadFromPostgres() : await loadFromJSON();
  Object.assign(state, loaded);
  pruneLocalSessions();
  // Only seed local-user in JSON mode. In Postgres mode that user has no row
  // in the users table and the app_state FK would reject any save.
  if (!getPool()) {
    ensureUserIn(state, LOCAL_USER_ID);
  }
  log.info(
    { storage: getPool() ? "postgres" : "json", users: Object.keys(state.users).length },
    "storage initialized",
  );
}

/**
 * Persist the current state. Writes to Postgres when configured, otherwise
 * to the JSON file. The dual-write happens here.
 */
export async function save() {
  await enqueuePersistence(async () => {
    pruneLocalSessions();
    if (getPool()) {
      try {
        await saveToPostgres(state);
      } catch (error) {
        // A compare-and-swap conflict means this process is holding an older
        // snapshot. Refresh only the account that lost the race before the
        // 409 reaches the caller; otherwise every later save would retry the
        // same stale version and a deleted account could be recreated locally.
        if (error instanceof StateConflictError && error.userID) {
          try {
            const refreshed = await refreshUserFromPostgres(state, error.userID);
            if (!refreshed.exists) deletedUsers.add(error.userID);
          } catch (refreshError) {
            // Preserve the original 409. A transient refresh failure must not
            // turn a known concurrency conflict into a misleading 500, and
            // the unchanged marker will force a fresh conflict on the next
            // attempt rather than allowing an overwrite.
            log.warn(
              { err: refreshError, userID: error.userID },
              "failed to refresh state after postgres conflict",
            );
          }
        }
        throw error;
      }
      return;
    }
    await saveToJSON(state);
  });
}

/**
 * Run a background operation only when this process/replica owns the named
 * lock. Postgres provides the cross-replica guard; JSON mode gets the same
 * non-overlap guarantee within one process. A skipped tick is intentional:
 * the next interval will retry after the current owner releases the lock.
 *
 * @template T
 * @param {string} lockName
 * @param {() => Promise<T>} operation
 * @returns {Promise<{ acquired: boolean, value?: T }>}
 */
export async function tryWithAdvisoryLock(lockName, operation) {
  if (getPool()) return tryWithPostgresAdvisoryLock(lockName, operation);
  if (localAdvisoryLocks.has(lockName)) return { acquired: false };
  localAdvisoryLocks.add(lockName);
  try {
    return { acquired: true, value: await operation() };
  } finally {
    localAdvisoryLocks.delete(lockName);
  }
}

function pruneLocalSessions() {
  const now = Date.now();
  for (const [tokenHash, session] of Object.entries(state.sessions || {})) {
    const expiresAt = Date.parse(String(session?.expiresAt || ""));
    if (!Number.isFinite(expiresAt) || expiresAt <= now) delete state.sessions[tokenHash];
  }
}

/**
 * Persist one OAuth state entry without coupling its lifetime to an unrelated
 * user snapshot. Postgres uses a dedicated row operation; JSON mode writes the
 * complete private state file as before.
 *
 * @param {string} stateKey
 * @param {{ userID?: string | null, mode?: string, returnTo?: string, expiresAt?: string }} entry
 */
export async function saveOAuthState(stateKey, entry) {
  await enqueuePersistence(async () => {
    if (getPool()) {
      await saveOAuthStateToPostgres(stateKey, entry);
      return;
    }
    await saveToJSON(state);
  });
}

/**
 * Consume one OAuth state entry. In Postgres the DELETE ... RETURNING happens
 * under a database lock, so concurrent API workers cannot both accept it. The
 * JSON fallback removes the local entry and persists that deletion before it
 * returns.
 *
 * @param {string} stateKey
 * @returns {Promise<{ userID?: string | null, mode?: string, returnTo?: string, expiresAt?: string } | null>}
 */
export async function consumePersistedOAuthState(stateKey) {
  return enqueuePersistence(async () => {
    if (getPool()) {
      const entry = await consumeOAuthStateFromPostgres(stateKey);
      // A different worker may have consumed this key already. Remove our
      // stale copy either way so it cannot linger in memory or be exposed to
      // callers that still use the synchronous compatibility helper.
      delete state.oauthStates?.[stateKey];
      return entry;
    }
    const entry = state.oauthStates?.[stateKey] || null;
    delete state.oauthStates?.[stateKey];
    await saveToJSON(state);
    return entry;
  });
}

/**
 * Erase every trace of a user: the in-memory record, all their per-user
 * collections, their sessions, and their rows in Postgres.
 *
 * Deliberately not a soft delete. The account-deletion control in the app tells
 * the user their data is removed, so it has to be, including the Google tokens
 * — leaving those behind would keep a revoked account readable.
 *
 * Sessions are dropped before the user so that a request racing this one can't
 * re-create the record it is authenticated against.
 *
 * @param {string} userID
 */
export async function purgeUser(userID) {
  await enqueuePersistence(async () => {
    deletedUsers.add(userID);

    const token =
      state.users[userID]?.googleTokens?.refresh_token ||
      state.users[userID]?.googleTokens?.access_token ||
      "";
    const snapshot = captureUserState(userID);

    try {
      const pool = getPool();
      if (pool) {
        // auth_sessions, app_state, and device_notifications all reference
        // users(id) `on delete cascade`, so the one delete takes the rest with it.
        // Keep the OAuth + state locks while revoking the external grant: a
        // stale worker cannot insert a new handoff between the revoke and delete.
        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query(`select pg_advisory_xact_lock(hashtext('${OAUTH_ADVISORY_LOCK}'))`);
          await client.query(`select pg_advisory_xact_lock(hashtext('${STATE_SAVE_LOCK}'))`);
          if (!(await revokeGoogleGrant(token))) {
            throw httpError(503, "Google access could not be revoked; account was not deleted");
          }
          await client.query("delete from oauth_states where user_id = $1", [userID]);
          await client.query("delete from users where id = $1", [userID]);
          await client.query("commit");
        } catch (error) {
          try {
            await client.query("rollback");
          } catch {
            /* best-effort */
          }
          throw error;
        } finally {
          client.release();
        }
        removeUserFromMemory(userID);
        forgetPersistedUser(userID);
        return;
      }

      if (!(await revokeGoogleGrant(token))) {
        throw httpError(503, "Google access could not be revoked; account was not deleted");
      }
      removeUserFromMemory(userID);
      await saveToJSON(state);
    } catch (error) {
      // JSON persistence can fail after the in-memory keys have been removed;
      // restore the exact references so a transient disk error does not leave
      // this process looking deleted while the durable file still contains the
      // account. Postgres failures happen before removal, but the same restore
      // keeps this invariant explicit.
      restoreUserState(snapshot, userID);
      deletedUsers.delete(userID);
      throw error;
    }
  });
}

/** @param {string} userID */
export function isUserDeleted(userID) {
  return deletedUsers.has(userID);
}

/** @param {unknown} token */
async function revokeGoogleGrant(token) {
  // A test/local account may carry placeholder tokens without Google being
  // configured. Avoid a needless network call in that mode.
  if (!config.google || typeof token !== "string" || !token) return true;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        signal: AbortSignal.timeout(Math.min(config.outboundTimeoutMs, 5_000)),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
      });
      // Google returns 400 for a token that is already invalid/revoked. Treat
      // that as success; any other non-2xx means we cannot honestly claim the
      // account is fully disconnected.
      if (response.ok || response.status === 400) return true;
      log.warn({ status: response.status, attempt }, "Google grant revocation was rejected during purge");
    } catch (error) {
      log.warn({ err: error, attempt }, "Google grant revocation failed during purge");
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** @param {string} userID */
function captureUserState(userID) {
  return {
    user: state.users[userID],
    briefing: state.briefings[userID],
    audit: state.audit[userID],
    notifications: state.deviceNotifications?.[userID],
    sessions: Object.fromEntries(
      Object.entries(state.sessions || {}).filter(([, session]) => session?.userID === userID),
    ),
    oauthStates: Object.fromEntries(
      Object.entries(state.oauthStates || {}).filter(([, entry]) => entry?.userID === userID),
    ),
  };
}

/** @param {string} userID */
function removeUserFromMemory(userID) {
  for (const [tokenHash, session] of Object.entries(state.sessions || {})) {
    if (session?.userID === userID) delete state.sessions[tokenHash];
  }
  for (const [key, entry] of Object.entries(state.oauthStates || {})) {
    if (entry?.userID === userID) delete state.oauthStates[key];
  }
  delete state.users[userID];
  delete state.briefings[userID];
  delete state.audit[userID];
  if (state.deviceNotifications) delete state.deviceNotifications[userID];
}

/** @param {ReturnType<typeof captureUserState>} snapshot @param {string} userID */
function restoreUserState(snapshot, userID) {
  if (snapshot.user !== undefined) state.users[userID] = snapshot.user;
  if (snapshot.briefing !== undefined) state.briefings[userID] = snapshot.briefing;
  if (snapshot.audit !== undefined) state.audit[userID] = snapshot.audit;
  if (snapshot.notifications !== undefined) {
    state.deviceNotifications ||= {};
    state.deviceNotifications[userID] = snapshot.notifications;
  }
  state.sessions ||= {};
  Object.assign(state.sessions, snapshot.sessions);
  state.oauthStates ||= {};
  Object.assign(state.oauthStates, snapshot.oauthStates);
}

/**
 * @returns {Promise<boolean>}
 */
export async function isDatabaseConnected() {
  return pingDatabase();
}

/**
 * Storage info for the health endpoint.
 */
export function storageInfo() {
  return getPool() ? "postgres" : "json";
}

/**
 * Graceful close — used by the shutdown handler.
 */
export async function close() {
  await closePool();
}

export { LOCAL_USER_ID };
export { ensureUserIn };
export { assertUserID, isValidUserID };
export { getPool };
