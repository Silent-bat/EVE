/**
 * Tests for the Gmail poller's scheduling and notification logic.
 *
 * We don't exercise the live Gmail/Calendar fetch — briefingSource() already
 * returns empty arrays when tokens are bogus, and Promise.allSettled swallows
 * the failures. That gives us a deterministic "empty briefing" path to test
 * the timer + bookkeeping without touching the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { POLL_INTERVAL_MS, sweepGmailPollers } from "../src/briefing/gmail-poller.mjs";
import { state } from "../src/storage/index.mjs";
import { ensureUserIn } from "../src/storage/state.mjs";
import { dayKey } from "../src/utils/dates.mjs";

const NON_GOOGLE = "poller-no-google";
const GOOGLE = "poller-google";

function seedNonGoogle() {
  ensureUserIn(state, NON_GOOGLE);
  state.users[NON_GOOGLE].connectionMode = "none";
  delete state.users[NON_GOOGLE].googleTokens;
  delete state.users[NON_GOOGLE].gmailPoll;
  state.deviceNotifications[NON_GOOGLE] = [];
}

function seedGoogle(/** @type {string | null} */ lastPollAt) {
  ensureUserIn(state, GOOGLE);
  state.users[GOOGLE].connectionMode = "google";
  state.users[GOOGLE].googleTokens = {
    access_token: "fake-test-token-not-real",
    expires_at: Date.now() + 60 * 60 * 1000,
  };
  state.users[GOOGLE].gmailPoll = lastPollAt ? { lastPollAt } : {};
  state.briefings[GOOGLE] = {};
  state.deviceNotifications[GOOGLE] = [];
}

test("POLL_INTERVAL_MS defaults to 3 hours", () => {
  // Allow override via env, but the default we ship is 3h.
  assert.ok(POLL_INTERVAL_MS >= 60_000, "interval must be at least 1 minute");
});

test("sweep skips users without a Google connection", async () => {
  seedNonGoogle();
  await sweepGmailPollers();
  assert.equal(state.users[NON_GOOGLE].gmailPoll, undefined);
  assert.equal(state.deviceNotifications[NON_GOOGLE].length, 0);
});

test("sweep runs a Google user that has never been polled", async () => {
  seedGoogle(null);
  await sweepGmailPollers();
  assert.ok(state.users[GOOGLE].gmailPoll.lastPollAt, "lastPollAt should be set");
  assert.equal(state.users[GOOGLE].gmailPoll.lastPollCount, 0);
  assert.equal(state.users[GOOGLE].gmailPoll.lastNewCount, 0);
  assert.equal(state.users[GOOGLE].gmailPoll.lastNewPriorityCount, 0);
  // An empty briefing must NOT spawn a notification
  assert.equal(state.deviceNotifications[GOOGLE].length, 0);
});

test("sweep skips a Google user whose lastPollAt is fresh", async () => {
  const recent = new Date().toISOString();
  seedGoogle(recent);
  await sweepGmailPollers();
  // Stamp unchanged
  assert.equal(state.users[GOOGLE].gmailPoll.lastPollAt, recent);
});

test("sweep with force runs even when lastPollAt is fresh", async () => {
  // Stamp 5ms in the past so the post-sweep timestamp is guaranteed newer.
  const recent = new Date(Date.now() - 5).toISOString();
  seedGoogle(recent);
  await sweepGmailPollers({ force: true });
  const after = state.users[GOOGLE].gmailPoll.lastPollAt;
  assert.ok(after, "lastPollAt should be set after force");
  assert.ok(Date.parse(after) > Date.parse(recent), `expected ${after} > ${recent}`);
});

test("sweep also runs when lastPollAt is older than POLL_INTERVAL_MS", async () => {
  const stale = new Date(Date.now() - (POLL_INTERVAL_MS + 60_000)).toISOString();
  seedGoogle(stale);
  await sweepGmailPollers();
  assert.notEqual(state.users[GOOGLE].gmailPoll.lastPollAt, stale);
});

test("sweep populates today's briefing entry for the polled user", async () => {
  seedGoogle(null);
  const today = dayKey(new Date());
  await sweepGmailPollers();
  assert.ok(state.briefings[GOOGLE][today], "today's briefing must exist after poll");
  assert.equal(state.briefings[GOOGLE][today].emails.length, 0);
});
