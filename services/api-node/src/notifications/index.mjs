/**
 * Device notifications: record from the Android listener, retrieve recent
 * history.
 */
import crypto from "node:crypto";
import { config } from "../config.mjs";
import { httpError } from "../http/responses.mjs";
import { getPool, save, state } from "../storage/index.mjs";
import { sanitizePlainText, validDateISOString } from "../briefing/scoring.mjs";

const NOTIFICATION_LIMIT = 100;
const PACKAGE_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/;

function retentionCutoff() {
  return new Date(Date.now() - config.deviceNotificationRetentionDays * 86_400_000);
}

/**
 * @param {string} userID
 * @param {Record<string, any>} input
 * @param {{ idempotencyKey?: unknown }} [options]
 */
export async function recordDeviceNotification(userID, input, options = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const packageName = sanitizePlainText(source.packageName, 120);
  if (!packageName) throw httpError(400, "packageName is required");
  // Android package names are stable identifiers, not arbitrary display text.
  // Rejecting malformed values keeps forged clients from polluting the shared
  // notification history with paths, control characters, or huge labels.
  if (!PACKAGE_NAME_PATTERN.test(packageName)) throw httpError(400, "invalid packageName");

  // The listener normally supplies a stable provider key. If a malformed key
  // sanitizes to an empty string, generate one instead of creating a single
  // empty-ID bucket that every such event would collide with.
  const bodyID = source.id ? sanitizePlainText(source.id, 160) : "";
  const headerID = options.idempotencyKey ? sanitizePlainText(options.idempotencyKey, 160) : "";
  if (bodyID && headerID && bodyID !== headerID) {
    throw httpError(400, "idempotency key does not match notification id");
  }
  const suppliedID = bodyID || headerID;

  // A retry can arrive after the first replica has committed. Return the
  // canonical stored row rather than constructing a second event with a new
  // receivedAt timestamp or, worse, returning data that was never persisted.
  if (suppliedID) {
    pruneMemoryNotifications(userID);
    const existing = await findDeviceNotification(userID, suppliedID);
    if (existing) return rememberInMemory(existing);
  }

  const event = {
    id: suppliedID || `notif-${Date.now()}-${crypto.randomUUID()}`,
    userId: userID,
    packageName,
    appName: sanitizePlainText(source.appName, 120),
    title: sanitizePlainText(source.title, 240),
    body: sanitizePlainText(source.body || source.text, 2000),
    postedAt: validDateISOString(source.postedAt) || new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    raw: safeRawNotification(source),
  };
  if (!event.title && !event.body) throw httpError(400, "notification title or body is required");

  const persisted = await persistDeviceNotification(event);
  if (getPool() && !persisted) {
    // A conflicting insert should always be readable immediately. If it is
    // not, do not acknowledge the native retry with an unpersisted preview.
    throw httpError(503, "notification could not be persisted");
  }
  const canonical = persisted || event;
  rememberInMemory(canonical);
  await save();
  return canonical;
}

/**
 * Persist an already-normalized notification in the dedicated Postgres table.
 * JSON mode has no second table, so its normal `save()` path remains the
 * durable store. Keeping this helper separate lets system-generated events use
 * the same table without asking generic app-state saves to copy stale arrays.
 *
 * @param {{ userId: string, id: string, packageName: string, appName?: string, title?: string, body?: string, postedAt: string, receivedAt: string, raw?: Record<string, any> }} event
 * @returns {Promise<any | null>}
 */
export async function persistDeviceNotification(event) {
  const pool = getPool();
  if (!pool) return;
  const cutoff = retentionCutoff();
  await pool.query("delete from device_notifications where user_id = $1 and received_at < $2", [
    event.userId,
    cutoff,
  ]);
  const inserted = await pool.query(
    `insert into device_notifications
      (id, user_id, package_name, app_name, title, body, posted_at, received_at, raw)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (user_id, id) do nothing
     returning id, user_id, package_name, app_name, title, body, posted_at, received_at, raw`,
    [
      event.id,
      event.userId,
      event.packageName,
      event.appName || null,
      event.title || null,
      event.body || null,
      event.postedAt,
      event.receivedAt,
      event.raw || {},
    ],
  );
  // The in-memory and read APIs expose the newest 100 notifications. Prune
  // older rows at insertion time so a long-lived Postgres deployment does not
  // grow without bound while preserving the same retention semantics after a
  // restart.
  await pool.query(
    `delete from device_notifications
     where user_id = $1
       and id in (
       select id from (
         select id, row_number() over (order by received_at desc) as row_number
         from device_notifications
         where user_id = $1
       ) recent
         where row_number > $2
     )`,
    [event.userId, NOTIFICATION_LIMIT],
  );
  if (inserted.rowCount) return event;
  // Another worker won the race. Read its row so callers receive exactly what
  // the database considers authoritative instead of an unpersisted local copy.
  return findDeviceNotification(event.userId, event.id);
}

/**
 * Find one notification by its user-scoped provider key.
 * @param {string} userID
 * @param {string} id
 * @returns {Promise<any | null>}
 */
async function findDeviceNotification(userID, id) {
  const pool = getPool();
  if (pool) {
    const result = await pool.query(
      `select id, user_id, package_name, app_name, title, body, posted_at, received_at, raw
       from device_notifications
       where user_id = $1 and id = $2
         and received_at >= $3
       limit 1`,
      [userID, id, retentionCutoff()],
    );
    return result.rows[0] ? mapNotificationRow(result.rows[0]) : null;
  }
  const existing = state.deviceNotifications?.[userID]?.find((entry) => entry?.id === id);
  return existing || null;
}

/** @param {any} row */
function mapNotificationRow(row) {
  return {
    id: row.id,
    userId: row.user_id || row.userId,
    packageName: row.package_name || row.packageName || "",
    appName: row.app_name || row.appName || "",
    title: row.title || "",
    body: row.body || "",
    postedAt: validDateISOString(row.posted_at || row.postedAt) || new Date().toISOString(),
    receivedAt: validDateISOString(row.received_at || row.receivedAt) || new Date().toISOString(),
    raw: row.raw || {},
  };
}

/** @param {any} event */
function rememberInMemory(event) {
  const userID = event.userId;
  state.deviceNotifications ||= {};
  state.deviceNotifications[userID] ||= [];
  pruneMemoryNotifications(userID);
  const index = state.deviceNotifications[userID].findIndex((item) => item?.id === event.id);
  if (index < 0) {
    state.deviceNotifications[userID].unshift(event);
  } else if (getPool()) {
    // Preserve the database's canonical version on retries, but repair an old
    // in-memory snapshot if another replica inserted this row first. JSON mode
    // keeps the first writer's payload when two local retries race.
    state.deviceNotifications[userID][index] = event;
  }
  state.deviceNotifications[userID] = state.deviceNotifications[userID].slice(0, NOTIFICATION_LIMIT);
  return event;
}

/**
 * @param {string} userID
 * @param {number} limit
 */
export async function getDeviceNotifications(userID, limit) {
  const pool = getPool();
  if (pool) {
    const cutoff = retentionCutoff();
    await pool.query("delete from device_notifications where user_id = $1 and received_at < $2", [
      userID,
      cutoff,
    ]);
    const result = await pool.query(
      `select id, user_id, package_name, app_name, title, body, posted_at, received_at, raw
       from device_notifications
       where user_id = $1
         and received_at >= $3
       order by received_at desc
       limit $2`,
      [userID, limit, cutoff],
    );
    return result.rows.map(mapNotificationRow);
  }

  pruneMemoryNotifications(userID);
  // Read the bucket after pruning: `pruneMemoryNotifications` replaces the
  // array so retaining a reference from before the call would return expired
  // entries to the client.
  return (state.deviceNotifications?.[userID] || []).slice(0, limit);
}

/**
 * Delete all captured notification previews for one account. This is separate
 * from account deletion so a user can clear the sensitive inbox without
 * disconnecting Google or losing the rest of EVE's state.
 *
 * @param {string} userID
 */
export async function clearDeviceNotifications(userID) {
  const pool = getPool();
  if (pool) await pool.query("delete from device_notifications where user_id = $1", [userID]);
  if (state.deviceNotifications) delete state.deviceNotifications[userID];
  await save();
  return { deleted: true };
}

/** @param {string} userID */
function pruneMemoryNotifications(userID) {
  const entries = state.deviceNotifications?.[userID];
  if (!Array.isArray(entries)) return;
  const cutoff = retentionCutoff().getTime();
  state.deviceNotifications[userID] = entries
    .filter((entry) => {
      const received = Date.parse(String(entry?.receivedAt || ""));
      // Older JSON snapshots did not record receivedAt. Keep those entries
      // through the bounded migration path rather than silently deleting user
      // history; newly-written records always have a timestamp and expire
      // normally.
      return !String(entry?.receivedAt || "").trim() || (Number.isFinite(received) && received >= cutoff);
    })
    .slice(0, NOTIFICATION_LIMIT);
}

/**
 * @param {Record<string, any>} input
 */
function safeRawNotification(input) {
  return {
    packageName: sanitizePlainText(input.packageName, 120),
    appName: sanitizePlainText(input.appName, 120),
    title: sanitizePlainText(input.title, 240),
    body: sanitizePlainText(input.body || input.text, 2000),
    postedAt: validDateISOString(input.postedAt) || null,
  };
}
