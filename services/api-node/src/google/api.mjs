/**
 * Google API client: token refresh + Gmail + Calendar reads.
 */
import { config } from "../config.mjs";
import { save } from "../storage/index.mjs";
import { googleJSON } from "./oauth.mjs";

/**
 * Mark a Google connection as unusable so the client prompts a fresh sign-in.
 *
 * The app gates its Google UI on `googleConnected`, so clearing only the
 * internal token flag would leave it showing a connected account whose every
 * request 401s. Clear both.
 *
 * @param {{ googleTokens?: any, googleConnected?: boolean }} user
 */
async function markGoogleNeedsReconnect(user) {
  user.googleTokens ||= {};
  user.googleTokens.needsReconnect = true;
  user.googleConnected = false;
  await save();
}

/**
 * Refresh the access token if expired (or about to expire). No-op when no
 * refresh token is available. Mutates the user's googleTokens object.
 *
 * @param {{ googleTokens?: any }} user
 * @returns {Promise<string | undefined>}
 */
export async function refreshGoogleToken(user) {
  if (!user.googleTokens?.refresh_token) {
    // Without a refresh token an expired access token can never be renewed,
    // so returning it would 401 against Gmail on every poll forever. Flag the
    // connection as needing re-auth instead, which sends the app back to the
    // connect screen where the user can actually fix it.
    if (user.googleTokens?.expires_at && user.googleTokens.expires_at <= Date.now()) {
      await markGoogleNeedsReconnect(user);
      return undefined;
    }
    return user.googleTokens?.access_token;
  }
  if (user.googleTokens.expires_at && user.googleTokens.expires_at > Date.now() + 60_000) {
    return user.googleTokens.access_token;
  }

  // The refresh_token was issued by exchangeGoogleCode under
  // config.google.clientId + clientSecret. Always use that pair for
  // refresh — the stored client_id field on the user can be the
  // Android/iOS client (left over from native sign-in), which won't
  // accept the refresh. Falling back to androidClientId would still
  // mismatch the secret.
  const clientID = config.google?.clientId || user.googleTokens.client_id;
  if (!clientID) return user.googleTokens.access_token;

  const body = new URLSearchParams({
    refresh_token: user.googleTokens.refresh_token,
    client_id: clientID,
    grant_type: "refresh_token",
  });
  // ALWAYS include the secret if we have one. The token endpoint
  // validates the (client_id, client_secret, refresh_token) tuple;
  // omitting the secret fails fast with invalid_client.
  if (config.google?.clientSecret) {
    body.set("client_secret", config.google.clientSecret);
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    signal: AbortSignal.timeout(config.outboundTimeoutMs),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const payload = await response.json();
  if (!response.ok) {
    // invalid_grant means the refresh_token was revoked or doesn't
    // match this client. Drop it so the next sign-in starts clean
    // (otherwise we keep trying with the same bad token forever).
    if (payload.error === "invalid_grant") {
      delete user.googleTokens.refresh_token;
      await markGoogleNeedsReconnect(user);
    }
    throw new Error(payload.error_description || payload.error || "google refresh failed");
  }

  user.googleTokens = {
    ...user.googleTokens,
    ...payload,
    // Google's refresh response only returns a NEW refresh_token if
    // there's a security event. When omitted, keep the old one.
    refresh_token: payload.refresh_token || user.googleTokens.refresh_token,
    expires_at: Date.now() + Number(payload.expires_in || 3600) * 1000,
    client_id: clientID,
    needsReconnect: false,
  };
  await save();
  return user.googleTokens.access_token;
}

/**
 * Pull recent Gmail INBOX messages. Range controls how far back we
 * look and how many we fetch:
 *   "day"   — recent inbox (no time filter beyond maxResults=50)
 *   "week"  — newer_than:7d, up to 80 messages
 *   "month" — newer_than:30d, up to 150 messages
 *
 * @param {any} user
 * @param {Date} _now
 * @param {"day" | "week" | "month"} [range]
 */
export async function fetchGmailMessages(user, _now, range = "day") {
  const accessToken = await refreshGoogleToken(user);
  if (!accessToken) return [];

  const listURL = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  const max = range === "month" ? 150 : range === "week" ? 80 : 50;
  listURL.searchParams.set("maxResults", String(max));
  listURL.searchParams.set("labelIds", "INBOX");
  if (range === "week") listURL.searchParams.set("q", "newer_than:7d");
  if (range === "month") listURL.searchParams.set("q", "newer_than:30d");

  const list = await googleJSON(listURL, accessToken);
  const messages = await Promise.all(
    (list.messages || [])
      .slice(0, max)
      .map((/** @type {any} */ item) =>
        googleJSON(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=full`,
          accessToken,
        ),
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
 * List Gmail INBOX message IDs only (no bodies, no metadata). Used by
 * the poller to diff against the already-known set before paying for
 * full message fetches + Pro analysis. ~1KB response for 50 IDs.
 *
 * @param {any} user
 * @param {{ limit?: number, range?: "day" | "week" | "month" }} [opts]
 * @returns {Promise<Array<{ id: string, threadId: string }>>}
 */
export async function listGmailMessageIds(user, opts = {}) {
  const accessToken = await refreshGoogleToken(user);
  if (!accessToken) return [];

  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  const max = opts.limit || (opts.range === "month" ? 150 : opts.range === "week" ? 80 : 50);
  url.searchParams.set("maxResults", String(max));
  url.searchParams.set("labelIds", "INBOX");
  if (opts.range === "week") url.searchParams.set("q", "newer_than:7d");
  if (opts.range === "month") url.searchParams.set("q", "newer_than:30d");

  const list = await googleJSON(url, accessToken);
  if (!Array.isArray(list.messages)) return [];
  return list.messages.map((/** @type {any} */ item) => ({
    id: String(item.id),
    threadId: String(item.threadId),
  }));
}

/**
 * Fetch full bodies + headers for a specific set of message IDs. Use
 * this after listGmailMessageIds + diff so you only pay for messages
 * you actually need to analyze.
 *
 * @param {any} user
 * @param {string[]} messageIds
 */
export async function fetchGmailMessagesByIds(user, messageIds) {
  const accessToken = await refreshGoogleToken(user);
  if (!accessToken || messageIds.length === 0) return [];

  const messages = await Promise.all(
    messageIds.map((id) =>
      googleJSON(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
        accessToken,
      ).catch(() => null),
    ),
  );

  return messages.filter(Boolean).map((/** @type {any} */ message) => {
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
      receivedAt: date.toISOString(),
      body: decodeGmailBody(message.payload) || message.snippet || "",
    };
  });
}

/**
 * Fetch a single email body by id. Cheap on-demand pull for the agent
 * when the cached summary isn't enough.
 *
 * @param {any} user
 * @param {string} messageId
 */
export async function fetchGmailMessageBody(user, messageId) {
  const accessToken = await refreshGoogleToken(user);
  if (!accessToken) throw new Error("Gmail is not connected");
  const message = await googleJSON(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    accessToken,
  );
  const headers = message.payload?.headers || [];
  const from = headerValue(headers, "From");
  const parsedFrom = parseSender(from);
  return {
    id: message.id,
    threadId: message.threadId,
    senderName: parsedFrom.name,
    senderEmail: parsedFrom.email,
    subject: headerValue(headers, "Subject") || "(no subject)",
    receivedAt: new Date(Number(message.internalDate || Date.now())).toISOString(),
    body: decodeGmailBody(message.payload) || message.snippet || "",
  };
}

/**
 * Search Gmail with a free-form query (Gmail q= syntax). Returns a small
 * array of summary objects suited for the model — id, threadId, sender,
 * subject, snippet, receivedAt — so the agent can decide what to do
 * next without burning tokens on full message bodies.
 *
 * @param {any} user
 * @param {{ query: string, limit?: number }} input
 */
export async function searchGmailMessages(user, input) {
  const accessToken = await refreshGoogleToken(user);
  if (!accessToken) return [];
  const limit = Math.max(1, Math.min(Number(input.limit) || 10, 25));
  const listURL = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listURL.searchParams.set("maxResults", String(limit));
  listURL.searchParams.set("q", String(input.query || ""));

  const list = await googleJSON(listURL, accessToken);
  const items = Array.isArray(list.messages) ? list.messages.slice(0, limit) : [];
  if (items.length === 0) return [];
  const messages = await Promise.all(
    items.map((/** @type {any} */ item) =>
      googleJSON(
        // metadata format is much cheaper than full — we only need
        // headers + snippet for search results.
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        accessToken,
      ),
    ),
  );
  return messages.map((/** @type {any} */ message) => {
    const headers = message.payload?.headers || [];
    const from = headerValue(headers, "From");
    const parsedFrom = parseSender(from);
    return {
      id: message.id,
      threadId: message.threadId,
      senderName: parsedFrom.name,
      senderEmail: parsedFrom.email,
      subject: headerValue(headers, "Subject") || "(no subject)",
      receivedAt: new Date(Number(message.internalDate || Date.now())).toISOString(),
      snippet: message.snippet || "",
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
 * payload, always as plain text.
 *
 * A multipart message carries the same content twice — `text/plain` and
 * `text/html` — and walking the tree for the first part that happens to have
 * bytes picks whichever the sender listed first. For most marketing mail that
 * is the HTML, so the "body" came back as a wall of `<!DOCTYPE html …>`, which
 * then reached the urgency heuristics, the LLM prompt, and the user's screen.
 *
 * So: prefer `text/plain` across the whole tree, fall back to `text/html` with
 * the markup stripped, and only then fall back to whatever bytes exist.
 *
 * @param {any} payload
 * @returns {string}
 */
export function decodeGmailBody(payload) {
  if (!payload) return "";

  const plain = findPartData(payload, "text/plain");
  if (plain) return scrubText(decodeBase64URL(plain));

  const html = findPartData(payload, "text/html");
  if (html) return stripHTML(decodeBase64URL(html));

  // Neither type declared — some senders omit or misreport mimeType. Take the
  // first bytes in the tree, and strip markup in case they turn out to be HTML.
  const any = findPartData(payload, null);
  return any ? stripHTML(decodeBase64URL(any)) : "";
}

/**
 * Depth-first search for the base64url payload of the first part matching
 * `mimeType` (or any part when `mimeType` is null). Parts carrying a filename
 * are attachments — their bytes are never the message body.
 *
 * @param {any} payload
 * @param {string | null} mimeType
 * @returns {string}
 */
function findPartData(payload, mimeType) {
  if (!payload || payload.filename) return "";
  const type = String(payload.mimeType || "").toLowerCase();
  if ((mimeType === null || type === mimeType) && payload.body?.data) {
    return payload.body.data;
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const found = findPartData(part, mimeType);
      if (found) return found;
    }
  }
  return "";
}

/** The entities that actually show up in mail. Anything else falls through. */
const NAMED_ENTITIES = /** @type {Record<string, string>} */ ({
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", bull: "•", middot: "·",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  copy: "©", reg: "®", trade: "™", euro: "€", pound: "£",
  // Invisible spacers. Decoded rather than ignored so the scrub below can
  // delete them — left encoded they render as literal "&zwnj;" in a summary.
  zwnj: "\u200c", zwj: "\u200d", shy: "\u00ad",
  ensp: " ", emsp: " ", thinsp: " ",
});

/**
 * Reduce an HTML email body to readable text.
 *
 * Deliberately regex-based rather than a parser dependency: this service ships
 * with no runtime dependencies, and the output only ever feeds a summary, a
 * keyword scorer, and an LLM prompt — none of which need a faithful DOM.
 *
 * @param {string} value
 * @returns {string}
 */
export function stripHTML(value) {
  if (!value) return "";
  const text = String(value)
    // Elements whose text content is machinery, not message.
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " ")
    .replace(/<![^>]*>/g, " ")
    .replace(/<[^>]*>/g, " ");
  return scrubText(text);
}

/**
 * Decode entities and drop invisible padding. Applied to plain-text parts too,
 * not just stripped HTML: bulk senders pad the text/plain alternative with runs
 * of `&zwnj;` and U+034F to stretch the inbox preview line, and those survive
 * into the summary as either a literal "&zwnj;" or invisible junk.
 *
 * Tag removal deliberately stays in `stripHTML` — a plain-text body can
 * legitimately contain `<https://…>` or `<name@example.com>`, and stripping
 * angle brackets there would eat real content.
 *
 * @param {string} value
 * @returns {string}
 */
export function scrubText(value) {
  if (!value) return "";
  return decodeEntities(String(value))
    // Zero-width and soft-hyphen padding. Written as escapes because the literal
    // characters are invisible in source.
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "")
    // U+034F (combining grapheme joiner) gets its own pass: it is a combining
    // mark, and inside a character class that reads as a misleading class.
    .replace(/\u034f/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} value
 * @returns {string}
 */
function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return " ";
      try {
        return String.fromCodePoint(code);
      } catch {
        return " ";
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
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
