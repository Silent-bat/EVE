/**
 * Pure helpers that read and shape the in-memory state object. No I/O.
 *
 * The in-memory state is a single shared object that every domain module
 * mutates. We keep the shape here and provide narrow helpers so call sites
 * stop reaching into the bag directly.
 *
 * @typedef {Object} StateShape
 * @property {Record<string, any>} users
 * @property {Record<string, Record<string, any>>} briefings
 * @property {Record<string, any[]>} audit
 * @property {Record<string, any[]>} deviceNotifications
 * @property {Record<string, any>} [sessions]
 * @property {Record<string, any>} [oauthStates]
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
  };
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
    googleConnected: Boolean(user.googleConnected),
    connectionMode: user.connectionMode || "none",
    integrationMode,
    preferences: user.preferences || normalizePreferences({ userId: userID }),
  };
}

/**
 * @param {{ userId?: string, briefingTime?: string, pushEnabled?: boolean, timezone?: string }} input
 */
export function normalizePreferences(input) {
  return {
    userId: input.userId || LOCAL_USER_ID,
    briefingTime: validTime(input.briefingTime) ? input.briefingTime : "08:00",
    pushEnabled: typeof input.pushEnabled === "boolean" ? input.pushEnabled : true,
    timezone: input.timezone || "Africa/Douala",
  };
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function validTime(value) {
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value);
}
