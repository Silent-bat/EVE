/**
 * Tests for reading one whole email.
 *
 * The Gmail fetch itself isn't exercised here — a live fetch needs a real
 * token — but the offline failure branch is: a connection whose token can't be
 * renewed makes the fetch throw before it reaches the network, which is the
 * same catch path a live 401 would take. These cover the parts that decide
 * what the detail screen renders: id normalisation, the stored-summary
 * fallback, and the two unavailable cases, which have to degrade rather than
 * throw.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { getEmailBody, gmailIDFor } from "../src/briefing/messages.mjs";
import { state } from "../src/storage/index.mjs";
import { ensureUserIn } from "../src/storage/state.mjs";

const USER = "messages-test-user";
const HOUR = 60 * 60 * 1000;

function inboxEntry() {
  return {
    id: "draft-abc123",
    threadId: "thread-1",
    senderName: "Dana Reed",
    senderEmail: "dana@example.com",
    subject: "Contract signature",
    summary: "Dana needs the countersigned contract before Friday.",
    draftReply: "Sending it over today.",
    urgencyScore: 72,
    urgencyReason: "Deadline this week",
    category: "other",
    receivedAt: new Date().toISOString(),
    addedAt: new Date().toISOString(),
    status: "pending",
  };
}

function seed() {
  ensureUserIn(state, USER);
  state.users[USER].email = "messages@example.com";
  state.users[USER].connectionMode = "none";
  delete state.users[USER].googleTokens;
  state.users[USER].priorityInbox = [inboxEntry()];
}

/**
 * A user Gmail still counts as connected, holding an access token that expired
 * and no refresh token to renew it with. `refreshGoogleToken` gives up before
 * it reaches the network, so the fetch throws without a live credential — which
 * is the only way to exercise the catch branch offline.
 *
 * @param {string} userID
 */
function seedDeadConnection(userID) {
  ensureUserIn(state, userID);
  state.users[userID].email = `${userID}@example.com`;
  state.users[userID].connectionMode = "google";
  state.users[userID].googleConnected = true;
  state.users[userID].googleTokens = {
    access_token: "fake-expired-token-not-real",
    expires_at: Date.now() - HOUR,
  };
  state.users[userID].priorityInbox = [inboxEntry()];
}

test("gmailIDFor strips the draft prefix and passes raw ids through", () => {
  assert.equal(gmailIDFor("draft-abc123"), "abc123");
  assert.equal(gmailIDFor("abc123"), "abc123");
  assert.equal(gmailIDFor("  draft-xyz  "), "xyz");
  assert.equal(gmailIDFor(""), "");
});

test("getEmailBody rejects an empty id", async () => {
  seed();
  await assert.rejects(() => getEmailBody(USER, "draft-"), /email id is required/i);
});

test("getEmailBody returns the stored summary when Gmail is not connected", async () => {
  seed();
  const email = await getEmailBody(USER, "draft-abc123");

  assert.equal(email.bodyAvailable, false);
  assert.equal(email.body, "");
  assert.ok(email.reason, "an unavailable body should say why");
  assert.match(email.reason, /not connected/i);
  // The header still has to render, so the summary fields come through.
  assert.equal(email.senderName, "Dana Reed");
  assert.equal(email.subject, "Contract signature");
  assert.equal(email.urgencyScore, 72);
  assert.equal(email.status, "pending");
});

test("getEmailBody degrades to the summary when the Gmail fetch fails", async () => {
  seedDeadConnection("messages-dead-connection");
  const email = await getEmailBody("messages-dead-connection", "draft-abc123");

  // A failed body fetch must not fail the screen: MailScreen renders the
  // header and EVE's summary either way, and shows `reason` as an explanation
  // rather than an error.
  assert.equal(email.bodyAvailable, false);
  assert.equal(email.body, "");
  assert.ok(email.reason, "an unavailable body should say why");
  assert.match(email.reason, /couldn't reach gmail/i);
  assert.equal(email.senderName, "Dana Reed");
  assert.equal(email.subject, "Contract signature");
  assert.equal(email.summary, "Dana needs the countersigned contract before Friday.");
  assert.equal(email.urgencyScore, 72);
  assert.equal(email.status, "pending");
});

test("getEmailBody accepts a raw Gmail id for a stored email", async () => {
  seed();
  const email = await getEmailBody(USER, "abc123");
  assert.equal(email.id, "draft-abc123");
  assert.equal(email.subject, "Contract signature");
});

test("getEmailBody synthesises a shell for an unknown id", async () => {
  seed();
  const email = await getEmailBody(USER, "draft-never-seen");

  assert.equal(email.id, "draft-never-seen");
  assert.equal(email.subject, "(no subject)");
  assert.equal(email.bodyAvailable, false);
  assert.equal(email.urgencyScore, 0);
});
