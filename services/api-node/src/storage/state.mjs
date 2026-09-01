/**
 * Helpers that read and shape the in-memory state object. Persistence-specific
 * credential protection lives in `secrets.mjs`; the in-memory shape remains
 * usable by the domain modules.
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
 * @property {Record<string, { userID?: string | null, mode?: "login" | "connect" | "handoff", returnTo?: string, expiresAt?: string }>} oauthStates
 */

import { config } from "../config.mjs";
import { httpError } from "../http/responses.mjs";
import { protectGoogleTokens, restoreGoogleTokens } from "./secrets.mjs";

export const LOCAL_USER_ID = "local-user";
export const MAX_USER_ID_CHARS = 128;
export const MAX_PERSISTED_BRIEFINGS = 120;
export const MAX_PERSISTED_AUDIT = 500;
export const MAX_PERSISTED_NOTIFICATIONS = 100;
export const MAX_PERSISTED_MEMORIES = 200;
export const MAX_PERSISTED_THOUGHTS = 200;
export const MAX_PERSISTED_MESSAGE_IDS = 2_000;

const RESERVED_USER_IDS = new Set(["__proto__", "constructor", "prototype"]);
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+~-]{0,127}$/;

/**
 * User IDs are database keys and object-property keys throughout the JSON
 * fallback. Keep them to a compact, printable alphabet so a caller cannot
 * select a prototype property (or smuggle control characters into logs,
 * paths, or persistence keys).
 *
 * @param {unknown} value
 * @returns {value is string}
 */
export function isValidUserID(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_USER_ID_CHARS &&
    !RESERVED_USER_IDS.has(value.toLowerCase()) &&
    USER_ID_PATTERN.test(value)
  );
}

/**
 * Validate an ID at an internal state boundary. HTTP callers should use
 * `isValidUserID` first so they can return an authentication error instead of
 * turning malformed input into a generic server failure.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function assertUserID(value) {
  if (!isValidUserID(value)) throw httpError(400, "invalid user id");
  return value;
}

/** @param {unknown} value @returns {Record<string, any>} */
function dictionary(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (Object.getPrototypeOf(value) === null) return /** @type {Record<string, any>} */ (value);
    const copy = Object.create(null);
    for (const [key, entry] of Object.entries(value)) copy[key] = entry;
    return copy;
  }
  return Object.create(null);
}

/**
 * Empty seed used by both JSON and Postgres loaders.
 * @returns {StateShape}
 */
export function emptyState() {
  return {
    users: Object.create(null),
    briefings: Object.create(null),
    audit: Object.create(null),
    deviceNotifications: Object.create(null),
    sessions: Object.create(null),
    oauthStates: Object.create(null),
  };
}

/**
 * Ensure a user record exists in the given state container with sane defaults.
 *
 * @param {StateShape} target
 * @param {string} userID
 */
export function ensureUserIn(target, userID) {
  assertUserID(userID);
  target.users = dictionary(target.users);
  target.briefings = dictionary(target.briefings);
  target.audit = dictionary(target.audit);
  target.deviceNotifications = dictionary(target.deviceNotifications);
  target.sessions = dictionary(target.sessions);
  target.oauthStates = dictionary(target.oauthStates);
  target.users[userID] ||= {
    id: userID,
    email: undefined,
    googleConnected: false,
    connectionMode: "none",
    preferences: normalizePreferences({ userId: userID }),
    proactiveInbox: [],
  };
  // Backfill for users created before the proactive inbox existed.
  const user = target.users[userID];
  user.proactiveInbox = Array.isArray(user.proactiveInbox)
    ? user.proactiveInbox.slice(0, MAX_PERSISTED_THOUGHTS)
    : [];
  if (Array.isArray(user.memory)) user.memory = user.memory.slice(0, MAX_PERSISTED_MEMORIES);
  if (Array.isArray(user.knownMessageIds))
    user.knownMessageIds = user.knownMessageIds.slice(-MAX_PERSISTED_MESSAGE_IDS);
  if (Array.isArray(user.pushTokens)) user.pushTokens = user.pushTokens.slice(0, 5);
  if (
    !target.briefings[userID] ||
    typeof target.briefings[userID] !== "object" ||
    Array.isArray(target.briefings[userID])
  ) {
    target.briefings[userID] = {};
  }
  if (!Array.isArray(target.audit[userID])) target.audit[userID] = [];
  target.audit[userID] = target.audit[userID].slice(-MAX_PERSISTED_AUDIT);
  if (!target.deviceNotifications || typeof target.deviceNotifications !== "object") {
    target.deviceNotifications = {};
  }
  if (!Array.isArray(target.deviceNotifications[userID])) target.deviceNotifications[userID] = [];
  target.deviceNotifications[userID] = pruneNotifications(target.deviceNotifications[userID]);
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
  target.users[userID].proactiveInbox = Array.isArray(target.users[userID].proactiveInbox)
    ? target.users[userID].proactiveInbox.slice(0, MAX_PERSISTED_THOUGHTS)
    : [];
  if (Array.isArray(target.users[userID].memory)) {
    target.users[userID].memory = target.users[userID].memory.slice(0, MAX_PERSISTED_MEMORIES);
  }
  if (Array.isArray(target.users[userID].knownMessageIds)) {
    target.users[userID].knownMessageIds =
      target.users[userID].knownMessageIds.slice(-MAX_PERSISTED_MESSAGE_IDS);
  }
  if (Array.isArray(target.users[userID].pushTokens)) {
    target.users[userID].pushTokens = target.users[userID].pushTokens.slice(0, 5);
  }
  if (user.googleTokens !== undefined) {
    target.users[userID].googleTokens = restoreGoogleTokens(user.googleTokens);
  }
  target.briefings[userID] = pruneBriefings(payload.briefings);
  target.audit[userID] = Array.isArray(payload.audit) ? payload.audit.slice(-MAX_PERSISTED_AUDIT) : [];
  target.deviceNotifications[userID] = pruneNotifications(payload.deviceNotifications);
}

/** @param {unknown} value @returns {any[]} */
function pruneNotifications(value) {
  if (!Array.isArray(value)) return [];
  const cutoff = Date.now() - config.deviceNotificationRetentionDays * 86_400_000;
  return value
    .filter((entry) => {
      const rawReceivedAt = String(entry?.receivedAt || "").trim();
      const receivedAt = Date.parse(rawReceivedAt);
      // Preserve legacy snapshots that predate notification timestamps. They
      // are still bounded below, and are assigned a timestamp when migrated
      // into a typed persistence backend.
      return !rawReceivedAt || (Number.isFinite(receivedAt) && receivedAt >= cutoff);
    })
    .slice(0, MAX_PERSISTED_NOTIFICATIONS);
}

/** @param {unknown} value @returns {Record<string, any>} */
function pruneBriefings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const cutoff = Date.now() - 45 * 86_400_000;
  const entries = Object.entries(value)
    .filter(([, briefing]) => {
      if (!briefing || typeof briefing !== "object") return false;
      const generated = Date.parse(String(briefing.generatedAt || ""));
      if (Number.isFinite(generated)) return generated >= cutoff;
      const key = String(briefing.id || "").match(/briefing-(\d{4}-\d{2}-\d{2})/)?.[1];
      const keyTime = key ? Date.parse(key) : NaN;
      return !Number.isFinite(keyTime) || keyTime >= cutoff;
    })
    .sort(([, left], [, right]) => {
      const a = Date.parse(String(left?.generatedAt || ""));
      const b = Date.parse(String(right?.generatedAt || ""));
      return (Number.isFinite(b) ? b : 0) - (Number.isFinite(a) ? a : 0);
    });
  return Object.fromEntries(entries.slice(0, MAX_PERSISTED_BRIEFINGS));
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
  const { passwordHash: _ignore, googleTokens, ...safeUser } = user;
  if (googleTokens) safeUser.googleTokens = protectGoogleTokens(googleTokens);
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
  const source = input && typeof input === "object" ? input : {};
  const out = {
    userId: source.userId || LOCAL_USER_ID,
    briefingTime: validTime(source.briefingTime) ? source.briefingTime : "08:00",
    pushEnabled: typeof source.pushEnabled === "boolean" ? source.pushEnabled : true,
    timezone: validTimezone(source.timezone) ? source.timezone : "Africa/Douala",
  };
  if (source.proactive !== undefined) {
    /** @type {any} */ (out).proactive = source.proactive;
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function validTime(value) {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return false;
  return Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

/**
 * Accept only real IANA timezone identifiers. Keeping the validation here
 * means briefing generation, calendar windows, and quiet hours all agree on
 * the same fallback instead of each silently choosing a different one.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
export function validTimezone(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
