/**
 * Pure helpers that read and shape the in-memory state object. No I/O.
 *
 * The in-memory state is a single shared object that every domain module
 * mutates. We keep the shape here and provide narrow helpers so call sites
 * stop reaching into the bag directly.
 *
 * `sessions` and `oauthStates` are required, not optional: `emptyState` seeds
 * both, and `loadFromJSON` defaults both when a persisted file predates them.
 * Marking them optional only pushed a null check onto every call site that
 * reads a session, none of which can actually observe them missing.
 *
 * @typedef {Object} StateShape
 * @property {Record<string, any>} users
 * @property {Record<string, Record<string, any>>} briefings
 * @property {Record<string, any[]>} audit
 * @property {Record<string, any[]>} deviceNotifications
 * @property {Record<string, any>} sessions
 * @property {Record<string, any>} oauthStates
 */

export const LOCAL_USER_ID = "local-user";

/**
 * Empty seed used by both JSON and Postgres loaders.
 * @returns {StateShape}
 */
export function emptyState() {
  return {
    users: {},
    briefings: {},
    audit: {},
    deviceNotifications: {},
    sessions: {},
    oauthStates: {},
  };
}

/**
 * Ensure a user record exists in the given state container with sane defaults.
 *
 * @param {StateShape} target
 * @param {string} userID
 */
export function ensureUserIn(target, userID) {
  target.users[userID] ||= {
    id: userID,
    email: undefined,
    googleConnected: false,
    connectionMode: "none",
    preferences: normalizePreferences({ userId: userID }),
    proactiveInbox: [],
  };
  // Backfill for users created before the proactive inbox existed.
  target.users[userID].proactiveInbox ||= [];
  target.briefings[userID] ||= {};
  target.audit[userID] ||= [];
  target.deviceNotifications ||= {};
  target.deviceNotifications[userID] ||= [];
}

/**
 * Merge a persisted payload (from Postgres `app_state`) into a state container.
 *
 * @param {StateShape} target
 * @param {string} userID
 * @param {Record<string, any>} payload
 */
export function mergePersistedUser(target, userID, payload) {
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

/**
 * Strip private fields and shape the payload we persist per user. Used by both
 * JSON and Postgres writers.
 *
 * @param {StateShape} state
 * @param {string} userID
 */
export function statePayload(state, userID) {
  const user = state.users[userID] || {};
  const { passwordHash: _ignore, ...safeUser } = user;
  return {
    user: safeUser,
    briefings: state.briefings[userID] || {},
    audit: state.audit[userID] || [],
    deviceNotifications: state.deviceNotifications?.[userID] || [],
  };
}

/**
 * Build the session payload sent to the client. Pulled out of legacy
 * server.mjs and tightened a bit.
 *
 * @param {StateShape} state
 * @param {string} userID
 * @param {{ google: string, llm: string, emailSending: string }} integrationMode
 */
export function sessionPayload(state, userID, integrationMode) {
  const user = state.users[userID] || {};
  return {
    userId: userID,
    email: user.email || null,
    // The header avatar reads these. Both are optional — a password account has
    // neither, and a Google account without a photo has only the name.
    displayName: user.displayName || null,
    photoURL: user.photoURL || null,
    googleConnected: isGoogleUsable(user),
    connectionMode: user.connectionMode || "none",
    // Whether there is a password to change. A Google-only account has none, and
    // the account page hides the control rather than offering one that can only
    // fail. Never the hash itself — only whether one exists.
    hasPassword: Boolean(user.passwordHash),
    integrationMode,
    preferences: user.preferences || normalizePreferences({ userId: userID }),
  };
}

/**
 * Is this user's Google connection actually usable right now?
 *
 * The client gates its whole signed-in experience on `googleConnected`, while
 * every server-side Gmail path additionally requires `connectionMode` to be
 * "google" and an access token to exist. When those disagree the app shows a
 * connected account whose mail never loads — the reads just return empty. So
 * report the connection the way the readers actually evaluate it, rather than
 * echoing a stored flag that can outlive the tokens behind it.
 *
 * @param {{ googleConnected?: boolean, connectionMode?: string, googleTokens?: any }} user
 */
export function isGoogleUsable(user) {
  return Boolean(
    user.googleConnected &&
      user.connectionMode === "google" &&
      user.googleTokens?.access_token &&
      !user.googleTokens?.needsReconnect,
  );
}

/**
 * Shape and validate the user-facing preference fields. The `proactive`
 * sub-object is passed through unmodified — the proactive module owns its
 * own schema and normalizes on read (and the HTTP layer validates on write).
 *
 * @param {{ userId?: string, briefingTime?: string, pushEnabled?: boolean, timezone?: string, proactive?: unknown }} input
 */
export function normalizePreferences(input) {
  const out = {
    userId: input.userId || LOCAL_USER_ID,
    briefingTime: validTime(input.briefingTime) ? input.briefingTime : "08:00",
    pushEnabled: typeof input.pushEnabled === "boolean" ? input.pushEnabled : true,
    timezone: input.timezone || "Africa/Douala",
  };
  if (input.proactive !== undefined) {
    /** @type {any} */ (out).proactive = input.proactive;
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function validTime(value) {
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value);
}
