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
import { moduleLogger } from "../logger.mjs";
import { loadFromJSON, saveToJSON } from "./json.mjs";
import {
  closePool,
  createPool,
  ensureSchema,
  getPool,
  loadFromPostgres,
  pingDatabase,
  saveToPostgres,
} from "./postgres.mjs";
import { emptyState, LOCAL_USER_ID, ensureUserIn } from "./state.mjs";

const log = moduleLogger("storage");

/**
 * Module-level state container. After `initialize()` returns, this is
 * populated and safe to mutate from caller modules.
 *
 * @type {import("./state.mjs").StateShape}
 */
export const state = emptyState();

/**
 * Initialize the storage backend. Creates the Postgres pool (if configured),
 * runs the schema bootstrap, loads state, and seeds the local user.
 */
export async function initialize() {
  createPool();
  await ensureSchema();
  const loaded = getPool() ? await loadFromPostgres() : await loadFromJSON();
  Object.assign(state, loaded);
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
  if (getPool()) {
    await saveToPostgres(state);
    return;
  }
  await saveToJSON(state);
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

  const pool = getPool();
  if (pool) {
    // auth_sessions, app_state, and device_notifications all reference
    // users(id) `on delete cascade`, so the one delete takes the rest with it.
    await pool.query("delete from users where id = $1", [userID]);
    return;
  }
  await saveToJSON(state);
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
  return getPool() ? "postgres+json" : "json";
}

/**
 * Graceful close — used by the shutdown handler.
 */
export async function close() {
  await closePool();
}

export { LOCAL_USER_ID };
export { ensureUserIn };
export { getPool };
