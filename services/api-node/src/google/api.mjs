/**
 * Google API client: token refresh + Gmail + Calendar reads.
 */
import { config } from "../config.mjs";
import { save } from "../storage/index.mjs";
import { googleJSON } from "./oauth.mjs";

/**
 * Refresh the access token if expired (or about to expire). No-op when no
 * refresh token is available. Mutates the user's googleTokens object.
 *
 * @param {{ googleTokens?: any }} user
 * @returns {Promise<string | undefined>}
 */
export async function refreshGoogleToken(user) {
  if (!user.googleTokens?.refresh_token) {
    return user.googleTokens?.access_token;
  }
  if (user.googleTokens.expires_at && user.googleTokens.expires_at > Date.now() + 60_000) {
    return user.googleTokens.access_token;
  }

  const clientID =
    user.googleTokens.client_id ||
    config.google?.clientId ||
    config.google?.androidClientId;
  if (!clientID) return user.googleTokens.access_token;

  const body = new URLSearchParams({
    refresh_token: user.googleTokens.refresh_token,
    client_id: clientID,
    grant_type: "refresh_token",
  });
  if (config.google?.clientSecret && clientID === config.google.clientId) {
    body.set("client_secret", config.google.clientSecret);
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error_description || payload.error || "google refresh failed");

  user.googleTokens = {
    ...user.googleTokens,
    ...payload,
    expires_at: Date.now() + Number(payload.expires_in || 3600) * 1000,
  };
  await save();
  return user.googleTokens.access_token;
}

/**
 * Pull the latest ~10 Gmail messages from the last 24h.
 *
 * @param {any} user
 * @param {Date} now
 */
export async function fetchGmailMessages(user, now) {
  const accessToken = await refreshGoogleToken(user);
  if (!accessToken) return [];

  const after = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime() / 1000);
  const listURL = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listURL.searchParams.set("maxResults", "20");
  listURL.searchParams.set("q", `newer:${after}`);

  const list = await googleJSON(listURL, accessToken);
  const messages = await Promise.all(
    (list.messages || []).slice(0, 10).map((/** @type {any} */ item) =>
      googleJSON(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=full`, accessToken),
    ),
  );

  return messages.map((/** @type {any} */ message) => {
    const headers = message.payload?.headers || [];
    const from = headerValue(headers, "From");
    const parsedFrom = parseSender(from);
    const date = new Date(Number(message.internalDate || Date.now()));
    return {
      id: message.id,
      threadId: message.threadId,
      senderName: parsedFrom.name,
      senderEmail: parsedFrom.email,
      subject: headerValue(headers, "Subject") || "(no subject)",
      receivedAtHour: date.getHours(),
      receivedAtMinute: date.getMinutes(),
      body: decodeGmailBody(message.payload) || message.snippet || "",
    };
  });
}

/**
 * Today's Google Calendar events.
 *
 * @param {any} user
 * @param {Date} now
 */
export async function fetchCalendarEvents(user, now) {
  const accessToken = await refreshGoogleToken(user);
  if (!accessToken) return [];

  const timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).toISOString();
  const timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0).toISOString();
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);

  const payload = await googleJSON(url, accessToken);
  return (payload.items || []).slice(0, 10).map((/** @type {any} */ event) => {
    const startsAt = new Date(event.start?.dateTime || event.start?.date || now);
    const endsAt = new Date(event.end?.dateTime || event.end?.date || startsAt.getTime() + 30 * 60 * 1000);
    return {
      id: event.id,
      title: event.summary || "(busy)",
      startHour: startsAt.getHours(),
      startMinute: startsAt.getMinutes(),
      durationMinutes: Math.max(15, Math.round((endsAt.getTime() - startsAt.getTime()) / 60000)),
      location: event.location || event.hangoutLink || "Calendar",
    };
  });
}

/**
 * @param {Array<{ name: string, value: string }>} headers
 * @param {string} name
 */
export function headerValue(headers, name) {
  const entry = headers.find((header) => header.name.toLowerCase() === name.toLowerCase());
  return entry ? String(entry.value || "") : "";
}

/**
 * @param {string} value
 */
export function parseSender(value) {
  if (!value) return { name: "Unknown sender", email: "" };
  const match = value.match(/^(.*?)<(.+)>$/);
  if (match && match[1] !== undefined && match[2] !== undefined) {
    return { name: match[1].trim().replace(/^"|"$/g, "") || match[2], email: match[2].trim() };
  }
  return { name: value.trim(), email: value.trim() };
}

/**
 * Decode the (possibly nested, possibly base64url) body of a Gmail message
 * payload.
 *
 * @param {any} payload
 * @returns {string}
 */
export function decodeGmailBody(payload) {
  if (!payload) return "";
  if (payload.body?.data) return decodeBase64URL(payload.body.data);
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const nested = decodeGmailBody(part);
      if (nested) return nested;
    }
  }
  return "";
}

/**
 * @param {string} value
 */
export function decodeBase64URL(value) {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64")
    .toString("utf8")
    .replace(/\s+/g, " ")
    .trim();
}
