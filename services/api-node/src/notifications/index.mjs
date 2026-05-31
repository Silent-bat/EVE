/**
 * Device notifications: record from the Android listener, retrieve recent
 * history.
 */
import crypto from "node:crypto";
import { httpError } from "../http/responses.mjs";
import { getPool, save, state } from "../storage/index.mjs";
import { sanitizePlainText, validDateISOString } from "../briefing/scoring.mjs";

/**
 * @param {string} userID
 * @param {Record<string, any>} input
 */
export async function recordDeviceNotification(userID, input) {
  const packageName = sanitizePlainText(input.packageName, 120);
  if (!packageName) throw httpError(400, "packageName is required");

  const event = {
    id: input.id ? sanitizePlainText(input.id, 160) : `notif-${Date.now()}-${crypto.randomUUID()}`,
    userId: userID,
    packageName,
    appName: sanitizePlainText(input.appName, 120),
    title: sanitizePlainText(input.title, 240),
    body: sanitizePlainText(input.body || input.text, 2000),
    postedAt: validDateISOString(input.postedAt) || new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    raw: safeRawNotification(input),
  };

  const pool = getPool();
  if (pool) {
    await pool.query(
      `insert into device_notifications
        (id, user_id, package_name, app_name, title, body, posted_at, received_at, raw)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (id) do nothing`,
      [
        event.id,
        userID,
        event.packageName,
        event.appName,
        event.title,
        event.body,
        event.postedAt,
        event.receivedAt,
        event.raw,
      ],
    );
  }

  state.deviceNotifications ||= {};
  state.deviceNotifications[userID] ||= [];
  if (!state.deviceNotifications[userID].some((item) => item.id === event.id)) {
    state.deviceNotifications[userID].unshift(event);
    state.deviceNotifications[userID] = state.deviceNotifications[userID].slice(0, 100);
  }
  await save();
  return event;
}

/**
 * @param {string} userID
 * @param {number} limit
 */
export async function getDeviceNotifications(userID, limit) {
  const pool = getPool();
  if (pool) {
    const result = await pool.query(
      `select id, user_id, package_name, app_name, title, body, posted_at, received_at, raw
       from device_notifications
       where user_id = $1
       order by received_at desc
       limit $2`,
      [userID, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      packageName: row.package_name,
      appName: row.app_name || "",
      title: row.title || "",
      body: row.body || "",
      postedAt: row.posted_at.toISOString(),
      receivedAt: row.received_at.toISOString(),
      raw: row.raw || {},
    }));
  }

  const entries = state.deviceNotifications?.[userID] || [];
  return entries.slice(0, limit);
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
