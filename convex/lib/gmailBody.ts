/**
 * Parse a raw Gmail `format=full` message into the fields EVE's UI needs.
 *
 * Ports the body-decoding logic from services/api-node/src/google/api.mjs:
 * prefer text/plain across the MIME tree, fall back to text/html (stripped),
 * then to any bytes. Gmail returns base64url-encoded UTF-8.
 */

/** Max characters of body we keep — enough to read, bounded for memory/UI. */
const MAX_BODY_CHARS = 40_000;

export interface ParsedGmailMessage {
  threadId: string;
  senderName: string;
  senderEmail: string;
  subject: string;
  receivedAt: string;
  body: string;
}

export function parseGmailMessage(message: any): ParsedGmailMessage {
  const headers = message?.payload?.headers ?? [];
  const from = headerValue(headers, "From");
  const sender = parseSender(from);
  const internal = Number(message?.internalDate);
  return {
    threadId: String(message?.threadId ?? ""),
    senderName: sender.name,
    senderEmail: sender.email,
    subject: headerValue(headers, "Subject") || "(no subject)",
    receivedAt: new Date(Number.isFinite(internal) && internal > 0 ? internal : Date.now()).toISOString(),
    body: decodeGmailBody(message?.payload),
  };
}

export function headerValue(headers: any, name: string): string {
  if (!Array.isArray(headers)) return "";
  const wanted = name.toLowerCase();
  const entry = headers.find(
    (h: any) => h && typeof h.name === "string" && h.name.toLowerCase() === wanted,
  );
  return entry && typeof entry.value === "string" ? entry.value.trim() : "";
}

/** Split "Display Name <addr@x>" into name + email (either may be empty). */
export function parseSender(value: string): { name: string; email: string } {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(.*?)<([^>]+)>\s*$/);
  if (match) {
    const name = (match[1] ?? "").trim().replace(/^"(.*)"$/, "$1");
    return { name, email: (match[2] ?? "").trim() };
  }
  // Bare address, or a name with no angle brackets.
  if (/^[^\s@]+@[^\s@]+$/.test(raw)) return { name: "", email: raw };
  return { name: raw, email: "" };
}

function decodeGmailBody(payload: any): string {
  if (!payload) return "";
  const plain = findPartData(payload, "text/plain");
  if (plain) return limitBody(scrubText(decodeBase64Url(plain)));
  const html = findPartData(payload, "text/html");
  if (html) return limitBody(stripHtml(decodeBase64Url(html)));
  const any = findPartData(payload, null);
  return any ? limitBody(stripHtml(decodeBase64Url(any))) : "";
}

/** Depth-first search for the base64url data of the first matching part. */
function findPartData(payload: any, mimeType: string | null): string {
  if (!payload || payload.filename) return "";
  const type = String(payload.mimeType ?? "").toLowerCase();
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

/** Decode Gmail base64url (UTF-8) to a string. */
export function decodeBase64Url(value: string): string {
  try {
    const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", bull: "•", middot: "·",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  copy: "©", reg: "®", trade: "™", euro: "€", pound: "£",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] ?? m);
}

function safeFromCodePoint(cp: number): string {
  try {
    return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : "";
  } catch {
    return "";
  }
}

/** Reduce an HTML body to readable text. */
function stripHtml(html: string): string {
  const withoutBlocks = html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ");
  const withBreaks = withoutBlocks
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const text = withBreaks.replace(/<[^>]+>/g, " ");
  return collapse(decodeEntities(text));
}

/** Tidy a plain-text body: normalize whitespace, drop zero-width chars. */
function scrubText(text: string): string {
  return collapse(decodeEntities(text.replace(/[​-‍­﻿]/g, "")));
}

function collapse(text: string): string {
  return shortenUrls(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Marketing/notification emails bury readable text under giant tracking URLs
 * (LinkedIn, ZipRecruiter, …). A 400-character link wrapping across a dozen
 * lines makes the message unreadable, so collapse any long URL to a compact
 * "scheme://host/…" form. Short links are left intact.
 */
function shortenUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s]+/gi, (url) => {
    if (url.length <= 60) return url;
    const m = url.match(/^(https?:\/\/[^/\s]+)/i);
    return m ? `${m[1]}/…` : `${url.slice(0, 57)}…`;
  });
}

function limitBody(text: string): string {
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n…` : text;
}
