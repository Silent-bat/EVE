import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.mjs";
import { emptyState, ensureUserIn, LOCAL_USER_ID, mergePersistedUser, statePayload } from "./state.mjs";

/**
 * Load state from the JSON file (created lazily on first save). Falls back to
 * an empty seeded state if the file is missing.
 *
 * @returns {Promise<import("./state.mjs").StateShape>}
 */
export async function loadFromJSON() {
  try {
    const raw = await readFile(config.statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("state file must contain an object");
    }
    const root = /** @type {Record<string, any>} */ (parsed);
    const users = root.users === undefined ? {} : asRecord(root.users, "users");
    const loaded = emptyState();
    for (const [userID, payload] of Object.entries(users)) {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error(`state.users.${userID} must contain an object`);
      }
      mergePersistedUser(loaded, userID, {
        user: payload,
        briefings: asOptionalRecord(root.briefings, "briefings")?.[userID],
        audit: asOptionalRecord(root.audit, "audit")?.[userID],
        deviceNotifications: asOptionalRecord(root.deviceNotifications, "deviceNotifications")?.[userID],
      });
    }
    loaded.sessions = asOptionalRecord(root.sessions, "sessions") || {};
    loaded.oauthStates = asOptionalRecord(root.oauthStates, "oauthStates") || {};
    return loaded;
  } catch (error) {
    // A missing file is the normal first boot. Any other failure is a data
    // integrity problem and must stop startup instead of being overwritten by
    // an empty state on the next save.
    if (/** @type {{ code?: string }} */ (error)?.code !== "ENOENT") throw error;
    const seeded = emptyState();
    ensureUserIn(seeded, LOCAL_USER_ID);
    return seeded;
  }
}

/** @param {unknown} value @param {string} name */
function asRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`state.${name} must contain an object`);
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} value @param {string} name */
function asOptionalRecord(value, name) {
  if (value === undefined || value === null) return null;
  return asRecord(value, name);
}

/**
 * @param {import("./state.mjs").StateShape} state
 */
export async function saveToJSON(state) {
  // 0700 / 0600: this file holds Google refresh tokens and password hashes, and
  // the default would leave it readable by every local account. Only applies to
  // files created from here on. Re-apply the mode on every save so an existing
  // file copied in with loose permissions is tightened on the next write.
  await mkdir(path.dirname(config.statePath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(config.statePath), 0o700);
  const persisted = {
    /** @type {Record<string, any>} */ users: {},
    /** @type {Record<string, any>} */ briefings: {},
    /** @type {Record<string, any>} */ audit: {},
    /** @type {Record<string, any>} */ deviceNotifications: {},
    sessions: state.sessions || {},
    oauthStates: state.oauthStates || {},
  };
  for (const userID of Object.keys(state.users || {})) {
    const payload = statePayload(state, userID);
    // `statePayload` is intentionally safe for Postgres' app_state table,
    // where the users table owns password hashes. JSON mode has no second
    // table, so retain the one-way hash in the private 0600 state file or
    // password accounts cannot authenticate after a process restart.
    const passwordHash = state.users[userID]?.passwordHash;
    persisted.users[userID] = passwordHash ? { ...payload.user, passwordHash } : payload.user;
    persisted.briefings[userID] = payload.briefings;
    persisted.audit[userID] = payload.audit;
    persisted.deviceNotifications[userID] = payload.deviceNotifications;
  }
  const tempPath = `${config.statePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  await rename(tempPath, config.statePath);
  await chmod(config.statePath, 0o600);
}
