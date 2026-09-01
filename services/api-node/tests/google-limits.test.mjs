/**
 * Resource-limit tests for the Google provider adapters.
 *
 * These stay entirely offline: fetch is replaced with a small response double
 * and restored after each test. The production path uses streaming Response
 * bodies; the JSON-only double also exercises the compatibility fallback.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fetchGmailMessages,
  fetchGmailMessagesByIds,
  GMAIL_FETCH_CONCURRENCY,
  GMAIL_MAX_BODY_CHARS,
  headerValue,
  listGmailMessageIds,
  MAX_GMAIL_MESSAGE_IDS,
  MAX_GMAIL_SEARCH_LIMIT,
  normalizeGmailSearchLimit,
  normalizeGmailMessageId,
  searchGmailMessages,
} from "../src/google/api.mjs";
import { GoogleResponseTooLargeError, readBoundedResponseJSON } from "../src/google/oauth.mjs";
import { state } from "../src/storage/index.mjs";
import { ensureUserIn } from "../src/storage/state.mjs";

const USER = "google-limits-test";

function seedUser() {
  ensureUserIn(state, USER);
  state.users[USER].connectionMode = "google";
  state.users[USER].googleTokens = {
    access_token: "offline-test-token",
    expires_at: Date.now() + 60 * 60 * 1000,
  };
  return state.users[USER];
}

/** @param {unknown} payload */
function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  };
}

/** @param {string} value */
function base64url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

test("normalizeGmailMessageId rejects path values and oversized ids", () => {
  assert.equal(normalizeGmailMessageId("safe-id_123"), "safe-id_123");
  assert.equal(normalizeGmailMessageId("../users/me"), "");
  assert.equal(normalizeGmailMessageId("a".repeat(257)), "");
  assert.equal(normalizeGmailMessageId(Number.NaN), "");
  assert.equal(normalizeGmailMessageId("-leading-hyphen"), "");
  assert.equal(normalizeGmailMessageId(null), "");
});

test("headerValue ignores malformed Gmail header entries", () => {
  assert.equal(
    headerValue([null, {}, { name: 42, value: "bad" }, { name: "Subject", value: "ok" }], "subject"),
    "ok",
  );
  assert.equal(headerValue(null, "subject"), "");
});

test("search limits normalize to finite positive integers", async () => {
  assert.equal(normalizeGmailSearchLimit(undefined), 10);
  assert.equal(normalizeGmailSearchLimit(1), 1);
  assert.equal(normalizeGmailSearchLimit(MAX_GMAIL_SEARCH_LIMIT + 100), MAX_GMAIL_SEARCH_LIMIT);
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5", null]) {
    assert.equal(normalizeGmailSearchLimit(value), 10, `invalid limit ${String(value)}`);
  }

  const user = seedUser();
  const previousFetch = globalThis.fetch;
  const requested = /** @type {string[]} */ ([]);
  globalThis.fetch = /** @type {typeof fetch} */ (
    async (input) => {
      requested.push(String(input));
      return jsonResponse({ messages: [] });
    }
  );
  try {
    await searchGmailMessages(user, { query: "hello", limit: 2.5 });
    await searchGmailMessages(user, { query: "hello", limit: 999 });
    assert.equal(new URL(requested[0]).searchParams.get("maxResults"), "10");
    assert.equal(new URL(requested[1]).searchParams.get("maxResults"), String(MAX_GMAIL_SEARCH_LIMIT));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Gmail detail fetches stay within the configured concurrency and cap bodies", async () => {
  const user = seedUser();
  const previousFetch = globalThis.fetch;
  let active = 0;
  let peak = 0;
  const ids = Array.from({ length: 20 }, (_, index) => ({ id: `msg-${index}`, threadId: `thread-${index}` }));
  const oversizedBody = "body ".repeat(Math.ceil((GMAIL_MAX_BODY_CHARS + 100) / 5));

  globalThis.fetch = /** @type {typeof fetch} */ (
    async (input) => {
      const url = String(input);
      if (new URL(url).searchParams.has("maxResults")) return jsonResponse({ messages: ids });
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return jsonResponse({
        id: url.split("/").pop()?.split("?")[0],
        threadId: "thread",
        internalDate: String(Date.now()),
        payload: { mimeType: "text/plain", body: { data: base64url(oversizedBody) } },
      });
    }
  );

  try {
    const messages = await fetchGmailMessages(user, new Date(), "month");
    assert.equal(messages.length, ids.length);
    assert.ok(peak <= GMAIL_FETCH_CONCURRENCY, `peak ${peak} exceeded ${GMAIL_FETCH_CONCURRENCY}`);
    assert.ok(messages.every((message) => message.body.length <= GMAIL_MAX_BODY_CHARS));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Gmail ID listing and by-id fetch deduplicate, validate, and cap IDs", async () => {
  const user = seedUser();
  const previousFetch = globalThis.fetch;
  const listed = [
    { id: "first", threadId: "thread-first" },
    { id: "first", threadId: "duplicate" },
    { id: "../escape", threadId: "bad" },
    ...Array.from({ length: MAX_GMAIL_MESSAGE_IDS + 20 }, (_, index) => ({
      id: `listed-${index}`,
      threadId: `thread-${index}`,
    })),
  ];
  const requested = /** @type {string[]} */ ([]);
  globalThis.fetch = /** @type {typeof fetch} */ (
    async (input) => {
      const url = String(input);
      if (new URL(url).searchParams.has("maxResults")) return jsonResponse({ messages: listed });
      requested.push(url);
      return jsonResponse({ id: url.split("/").pop()?.split("?")[0], threadId: "thread" });
    }
  );

  try {
    const result = await listGmailMessageIds(user, { limit: 9999, range: "month" });
    assert.equal(result.length, MAX_GMAIL_MESSAGE_IDS);
    assert.equal(result[0].id, "first");
    assert.equal(
      result.some((entry) => entry.id.includes("escape")),
      false,
    );

    const fetched = await fetchGmailMessagesByIds(user, [
      "first",
      "first",
      "../escape",
      ...result.map((entry) => entry.id),
    ]);
    assert.equal(fetched.length, MAX_GMAIL_MESSAGE_IDS);
    assert.equal(new Set(requested).size, requested.length);
    assert.ok(requested.every((url) => !url.includes("../escape")));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("bounded response reader cancels a stream before parsing oversized JSON", async () => {
  let canceled = false;
  let released = false;
  const body = {
    getReader() {
      return {
        async read() {
          return { done: false, value: new TextEncoder().encode('{"payload":"too big"}') };
        },
        async cancel() {
          canceled = true;
        },
        releaseLock() {
          released = true;
        },
      };
    },
  };

  await assert.rejects(
    readBoundedResponseJSON({ body }, 5),
    (error) => error instanceof GoogleResponseTooLargeError,
  );
  assert.equal(canceled, true);
  assert.equal(released, true);
});
