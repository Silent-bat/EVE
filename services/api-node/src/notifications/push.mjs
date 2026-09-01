/**
 * Expo Push notification helper.
 *
 * Stores push tokens per user on state.users[userID].pushTokens (an array
 * of unique strings, capped at 5 — same user logged in on 5 devices is the
 * realistic upper bound). Sends via the Expo Push Service:
 *
 *   https://docs.expo.dev/push-notifications/sending-notifications/
 *
 * No-ops gracefully when no token is registered or the network call fails;
 * push is best-effort, the system notification entry is the source of truth.
 */
import { moduleLogger } from "../logger.mjs";
import { config } from "../config.mjs";
import { httpError } from "../http/responses.mjs";
import { state } from "../storage/index.mjs";
import { readBoundedResponseJSON } from "../google/oauth.mjs";

const log = moduleLogger("notifications.push");
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const TOKEN_LIMIT_PER_USER = 5;

/**
 * Validate an Expo push token shape. Expo's tokens look like:
 *   ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]
 *
 * @param {unknown} value
 */
export function isExpoPushToken(value) {
  return typeof value === "string" && /^ExponentPushToken\[[A-Za-z0-9_-]+\]$/.test(value);
}

/**
 * Register (or refresh) a push token for the calling user.
 *
 * @param {string} userID
 * @param {{ token?: unknown, platform?: unknown }} input
 */
export function registerPushToken(userID, input) {
  const token = input?.token;
  if (!isExpoPushToken(token)) {
    throw httpError(400, "token must be a valid ExponentPushToken[...] string");
  }
  const user = state.users[userID];
  if (!user) throw httpError(404, "user not found");
  let platform;
  if (input?.platform !== undefined) {
    if (typeof input.platform !== "string" || !/^[a-z0-9_-]{1,16}$/i.test(input.platform)) {
      throw httpError(400, "platform must be a short identifier");
    }
    platform = input.platform.toLowerCase();
  }

  user.pushTokens ||= [];
  // Move to front (most-recently-active wins if we ever evict)
  user.pushTokens = [
    /** @type {string} */ (token),
    ...user.pushTokens.filter((/** @type {string} */ t) => t !== token),
  ].slice(0, TOKEN_LIMIT_PER_USER);

  if (platform) user.pushPlatform = platform;
  user.pushTokenUpdatedAt = new Date().toISOString();

  return { tokens: user.pushTokens.length };
}

/**
 * Remove a token from the user (e.g. after Expo reports DeviceNotRegistered).
 *
 * @param {string} userID
 * @param {string} token
 */
export function dropPushToken(userID, token) {
  const user = state.users[userID];
  if (!user?.pushTokens) return;
  user.pushTokens = user.pushTokens.filter((/** @type {string} */ t) => t !== token);
}

/**
 * Remove one installation token, or every token when none is supplied.
 *
 * @param {string} userID
 * @param {string} [token]
 */
export function unregisterPushToken(userID, token = "") {
  const user = state.users[userID];
  if (!user) throw httpError(404, "user not found");
  if (token) {
    dropPushToken(userID, token);
  } else {
    delete user.pushTokens;
    delete user.pushPlatform;
    delete user.pushTokenUpdatedAt;
  }
  return { tokens: user.pushTokens?.length || 0 };
}

/**
 * Send a push to every device the user has registered. Returns the number of
 * pushes that the Expo service accepted.
 *
 * @param {string} userID
 * @param {{ title: string, body: string, data?: Record<string, unknown> }} payload
 */
export async function sendPushToUser(userID, payload) {
  const user = state.users[userID];
  const tokens = user?.pushTokens || [];
  if (tokens.length === 0) return { sent: 0 };

  const messages = tokens.map((/** @type {string} */ token) => ({
    to: token,
    sound: "default",
    title: payload.title,
    body: payload.body,
    data: payload.data || {},
  }));

  /** @type {Response} */
  let response;
  try {
    response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      signal: AbortSignal.timeout(config.outboundTimeoutMs),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
      },
      body: JSON.stringify(messages),
    });
  } catch (error) {
    log.warn({ err: error, userID }, "expo push transport failed");
    return { sent: 0 };
  }

  if (!response.ok) {
    log.warn({ userID, status: response.status, statusText: response.statusText }, "expo push rejected");
    return { sent: 0 };
  }

  let body = null;
  try {
    body = /** @type {any} */ (await readBoundedResponseJSON(response, config.googleResponseMaxBytes));
  } catch {
    return { sent: 0 };
  }

  const tickets = Array.isArray(body?.data) ? body.data : [];
  // Drop tokens Expo flagged as invalid — keeps state from accumulating dead devices.
  tickets.forEach((/** @type {any} */ ticket, /** @type {number} */ index) => {
    if (ticket?.status === "error") {
      const code = ticket?.details?.error;
      if (code === "DeviceNotRegistered" || code === "InvalidCredentials") {
        const dead = tokens[index];
        if (dead) {
          log.info({ userID, code }, "dropping dead push token");
          dropPushToken(userID, dead);
        }
      }
    }
  });

  const sent = tickets.filter((/** @type {any} */ t) => t?.status === "ok").length;
  return { sent };
}
