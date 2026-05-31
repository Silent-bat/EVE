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
