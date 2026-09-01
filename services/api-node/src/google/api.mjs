/**
 * Google API client: token refresh + Gmail + Calendar reads.
 */
import { config } from "../config.mjs";
import { httpError } from "../http/responses.mjs";
import { atLocalDateInZone, startOfDayInZone, startOfNextDayInZone, zonedParts } from "../utils/dates.mjs";
import { save } from "../storage/index.mjs";
import {
  GoogleResponseTooLargeError,
  googleJSON,
  normalizeGoogleTokenPayload,
  readBoundedResponseJSON,
} from "./oauth.mjs";
import { parseEmailAddress, sanitizeHeaderValue } from "./address.mjs";

// Gmail IDs are opaque provider values, but they are URL path segments in the
// calls below. Restricting them to the URL-safe alphabet prevents a malformed
// provider response (or a stale client value) from escaping the message path.
export const MAX_GMAIL_MESSAGE_ID_CHARS = 256;
export const MAX_GMAIL_MESSAGE_IDS = 150;
export const DEFAULT_GMAIL_SEARCH_LIMIT = 10;
export const MAX_GMAIL_SEARCH_LIMIT = 25;
export const DEFAULT_GMAIL_MAX_BODY_CHARS = 20_000;
export const GMAIL_MAX_BODY_CHARS =
  Number.isSafeInteger(config.gmailMaxBodyChars) && config.gmailMaxBodyChars > 0
    ? config.gmailMaxBodyChars
    : DEFAULT_GMAIL_MAX_BODY_CHARS;
export const DEFAULT_GMAIL_FETCH_CONCURRENCY = 6;
export const GMAIL_FETCH_CONCURRENCY =
  Number.isSafeInteger(config.gmailFetchConcurrency) && config.gmailFetchConcurrency > 0
    ? config.gmailFetchConcurrency
    : DEFAULT_GMAIL_FETCH_CONCURRENCY;

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

  let response;
  try {
    response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      signal: AbortSignal.timeout(config.outboundTimeoutMs),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch {
    throw new Error("google refresh service unavailable");
  }

  let payload;
  try {
    payload = await readBoundedResponseJSON(response);
  } catch (error) {
    if (error instanceof GoogleResponseTooLargeError) {
      throw new Error("google refresh response too large");
    }
    throw new Error("google refresh service returned invalid JSON");
  }
  if (!response.ok) {
    // invalid_grant means the refresh_token was revoked or doesn't
    // match this client. Drop it so the next sign-in starts clean
    // (otherwise we keep trying with the same bad token forever).
    const providerError = payload && typeof payload === "object" ? payload : {};
    if (providerError.error === "invalid_grant") {
      delete user.googleTokens.refresh_token;
      await markGoogleNeedsReconnect(user);
    }
    throw new Error(providerError.error_description || providerError.error || "google refresh failed");
  }

  let normalized;
  try {
    normalized = normalizeGoogleTokenPayload(payload);
  } catch {
    throw new Error("google refresh response did not include a usable access token");
  }
  user.googleTokens = {
    ...user.googleTokens,
    ...normalized,
    // Google's refresh response only returns a NEW refresh_token if
    // there's a security event. When omitted, keep the old one.
    refresh_token: normalized.refresh_token || user.googleTokens.refresh_token,
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
  const max = Math.min(MAX_GMAIL_MESSAGE_IDS, range === "month" ? 150 : range === "week" ? 80 : 50);
  listURL.searchParams.set("maxResults", String(max));
  listURL.searchParams.set("labelIds", "INBOX");
  if (range === "week") listURL.searchParams.set("q", "newer_than:7d");
  if (range === "month") listURL.searchParams.set("q", "newer_than:30d");

  const list = await googleJSON(listURL, accessToken);
  const items = normalizeGmailMessageItems(list.messages).slice(0, max);
  const messages = await mapWithConcurrency(
    items,
    ({ id }) => googleJSON(gmailMessageURL(id, "full"), accessToken),
    GMAIL_FETCH_CONCURRENCY,
  );

  return messages.map((/** @type {any} */ message) => {
    const headers = message.payload?.headers || [];
    const from = headerValue(headers, "From");
    const parsedFrom = parseSender(from);
    const date = new Date(Number(message.internalDate || Date.now()));
    const receivedParts = zonedParts(date, user.preferences?.timezone || "UTC");
    return {
      id: message.id,
      threadId: message.threadId,
      senderName: parsedFrom.name,
      senderEmail: parsedFrom.email,
      subject: headerValue(headers, "Subject") || "(no subject)",
      receivedAtHour: receivedParts.hour,
      receivedAtMinute: receivedParts.minute,
      body: boundedGmailBody(message),
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
  const max = boundedGmailLimit(opts.limit, defaultGmailLimit(opts.range));
  url.searchParams.set("maxResults", String(max));
  url.searchParams.set("labelIds", "INBOX");
  if (opts.range === "week") url.searchParams.set("q", "newer_than:7d");
  if (opts.range === "month") url.searchParams.set("q", "newer_than:30d");

  const list = await googleJSON(url, accessToken);
  return normalizeGmailMessageItems(list.messages).slice(0, max);
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
  const ids = normalizeGmailMessageIds(messageIds);
  if (!accessToken || ids.length === 0) return [];

  const messages = await mapWithConcurrency(
    ids,
    (id) => googleJSON(gmailMessageURL(id, "full"), accessToken).catch(() => null),
    GMAIL_FETCH_CONCURRENCY,
  );

  return messages.filter(Boolean).map((/** @type {any} */ message) => {
    const headers = message.payload?.headers || [];
    const from = headerValue(headers, "From");
    const parsedFrom = parseSender(from);
    const date = new Date(Number(message.internalDate || Date.now()));
    const receivedParts = zonedParts(date, user.preferences?.timezone || "UTC");
    return {
      id: message.id,
      threadId: message.threadId,
      senderName: parsedFrom.name,
      senderEmail: parsedFrom.email,
      subject: headerValue(headers, "Subject") || "(no subject)",
      receivedAtHour: receivedParts.hour,
      receivedAtMinute: receivedParts.minute,
      receivedAt: date.toISOString(),
      body: boundedGmailBody(message),
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
  const id = normalizeGmailMessageId(messageId);
  if (!id) throw httpError(400, "invalid Gmail message id");
  const accessToken = await refreshGoogleToken(user);
  if (!accessToken) throw new Error("Gmail is not connected");
  const message = await googleJSON(gmailMessageURL(id, "full"), accessToken);
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
    body: boundedGmailBody(message),
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
  const options = /** @type {{ query?: unknown, limit?: unknown }} */ (
    input && typeof input === "object" ? input : {}
  );
  const limit = normalizeGmailSearchLimit(options.limit);
  const listURL = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listURL.searchParams.set("maxResults", String(limit));
  listURL.searchParams.set("q", String(options.query || ""));

  const list = await googleJSON(listURL, accessToken);
  const items = normalizeGmailMessageItems(list.messages).slice(0, limit);
  if (items.length === 0) return [];
  const messages = await mapWithConcurrency(
    items,
    ({ id }) =>
      googleJSON(
        // metadata format is much cheaper than full — we only need
        // headers + snippet for search results.
        gmailMessageURL(id, "metadata", ["From", "Subject", "Date"]),
        accessToken,
      ),
    GMAIL_FETCH_CONCURRENCY,
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
      snippet: limitGmailBody(typeof message.snippet === "string" ? message.snippet : ""),
    };
  });
}

/**
 * Normalize the model-provided search limit to a finite positive integer. The
 * Gmail API rejects fractional and non-finite `maxResults` values; malformed
 * model output falls back to the conservative default rather than reaching
 * the provider or changing an unbounded request into a surprising value.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeGmailSearchLimit(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return DEFAULT_GMAIL_SEARCH_LIMIT;
  }
  return Math.min(value, MAX_GMAIL_SEARCH_LIMIT);
}

/**
 * Run provider requests through a bounded worker pool. Gmail list endpoints
 * can return 150 IDs, and launching one promise per ID creates a burst of
 * sockets and response buffers that is disproportionate to the user's poll.
 * Results retain input order so callers keep their existing behavior.
 *
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R>} worker
 * @param {number} concurrency
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, worker, concurrency) {
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(Math.floor(Number(concurrency)) || 1, items.length));
  const results = /** @type {R[]} */ (new Array(items.length));
  let next = 0;

  const runWorker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: width }, () => runWorker()));
  return results;
}

/** @param {unknown} value */
export function normalizeGmailMessageId(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  if (typeof value === "number" && !Number.isSafeInteger(value)) return "";
  const id = String(value).trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) && id.length <= MAX_GMAIL_MESSAGE_ID_CHARS ? id : "";
}

/** @param {unknown} value */
function normalizeGmailMessageIds(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  /** @type {string[]} */
  const ids = [];
  for (const candidate of value) {
    const id = normalizeGmailMessageId(candidate);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_GMAIL_MESSAGE_IDS) break;
  }
  return ids;
}

/** @param {unknown} value */
function normalizeGmailMessageItems(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  /** @type {Array<{ id: string, threadId: string }>} */
  const items = [];
  for (const raw of value) {
    const id = normalizeGmailMessageId(raw?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const threadId = normalizeGmailMessageId(raw?.threadId);
    items.push({ id, threadId });
    if (items.length >= MAX_GMAIL_MESSAGE_IDS) break;
  }
  return items;
}

/** @param {unknown} range */
function defaultGmailLimit(range) {
  return range === "month" ? 150 : range === "week" ? 80 : 50;
}

/** @param {unknown} value @param {number} fallback */
function boundedGmailLimit(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Math.min(MAX_GMAIL_MESSAGE_IDS, fallback);
  return Math.max(1, Math.min(MAX_GMAIL_MESSAGE_IDS, Math.floor(numeric)));
}

/** @param {string} id @param {"full" | "metadata"} format @param {string[]} [metadataHeaders] */
function gmailMessageURL(id, format, metadataHeaders = []) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
  url.searchParams.set("format", format);
  for (const header of metadataHeaders) url.searchParams.append("metadataHeaders", header);
  return url;
}

/** @param {any} message */
function boundedGmailBody(message) {
  const decoded = decodeGmailBody(message?.payload);
  const fallback = typeof message?.snippet === "string" ? message.snippet : "";
  return limitGmailBody(decoded || fallback);
}

/** @param {string} value */
function limitGmailBody(value) {
  const text = typeof value === "string" ? value : String(value || "");
  return text.length > GMAIL_MAX_BODY_CHARS ? text.slice(0, GMAIL_MAX_BODY_CHARS) : text;
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

  const timezone = user.preferences?.timezone || "UTC";
  const start = startOfDayInZone(now, timezone);
  const end = startOfNextDayInZone(now, timezone);
  const timeMin = start.toISOString();
  const timeMax = end.toISOString();
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);

  const payload = await googleJSON(url, accessToken);
  const items = Array.isArray(payload.items) ? payload.items : [];
  return items.slice(0, 10).map((/** @type {any} */ event) => {
    const startsAt = calendarInstant(event.start, timezone, now);
    const endsAt = calendarInstant(event.end, timezone, new Date(startsAt.getTime() + 30 * 60 * 1000));
    const startParts = zonedParts(startsAt, timezone);
    return {
      id: event.id,
      title: event.summary || "(busy)",
      startHour: startParts.hour,
      startMinute: startParts.minute,
      durationMinutes: Math.max(15, Math.round((endsAt.getTime() - startsAt.getTime()) / 60000)),
      location: event.location || event.hangoutLink || "Calendar",
    };
  });
}

/** @param {any} endpoint @param {string} timezone @param {Date} fallback */
function calendarInstant(endpoint, timezone, fallback) {
  if (typeof endpoint?.dateTime === "string") {
    const parsed = new Date(endpoint.dateTime);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  if (typeof endpoint?.date === "string") {
    const parsed = atLocalDateInZone(endpoint.date, 0, 0, timezone);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return fallback;
}

/**
 * @param {unknown} headers
 * @param {string} name
 */
export function headerValue(headers, name) {
  if (!Array.isArray(headers) || typeof name !== "string") return "";
  const wanted = name.toLowerCase();
  const entry = headers.find(
    (header) =>
      header &&
      typeof header === "object" &&
      typeof header.name === "string" &&
      header.name.toLowerCase() === wanted,
  );
  return entry && typeof entry === "object" ? sanitizeHeaderValue(entry.value) : "";
}

/**
 * @param {string} value
 */
export function parseSender(value) {
  return parseEmailAddress(value);
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
  if (plain) return limitGmailBody(scrubText(decodeBase64URL(plain)));

  const html = findPartData(payload, "text/html");
  if (html) return limitGmailBody(stripHTML(decodeBase64URL(html)));

  // Neither type declared — some senders omit or misreport mimeType. Take the
  // first bytes in the tree, and strip markup in case they turn out to be HTML.
  const any = findPartData(payload, null);
  return any ? limitGmailBody(stripHTML(decodeBase64URL(any))) : "";
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
  if (
    (mimeType === null || type === mimeType) &&
    typeof payload.body?.data === "string" &&
    payload.body.data
  ) {
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
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  bull: "•",
  middot: "·",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  // Invisible spacers. Decoded rather than ignored so the scrub below can
  // delete them — left encoded they render as literal "&zwnj;" in a summary.
  zwnj: "\u200c",
  zwj: "\u200d",
  shy: "\u00ad",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
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
  return (
    decodeEntities(String(value))
      // Zero-width and soft-hyphen padding. Written as escapes because the literal
      // characters are invisible in source.
      .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "")
      // U+034F (combining grapheme joiner) gets its own pass: it is a combining
      // mark, and inside a character class that reads as a misleading class.
      .replace(/\u034f/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
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
