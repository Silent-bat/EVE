/**
 * Tests for account deletion and the profile fields behind the header avatar.
 *
 * `purgeUser` is the only destructive operation in the app, so the tests here
 * are mostly about completeness: every per-user collection has to be empty
 * afterwards, and a second user's data has to survive untouched. Running
 * against the JSON backend (no DATABASE_URL) exercises the in-memory branch;
 * the Postgres branch is a single cascading delete.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { purgeUser, state } from "../src/storage/index.mjs";
import { ensureUserIn, sessionPayload } from "../src/storage/state.mjs";

const USER = "purge-test-user";
const NEIGHBOUR = "purge-test-neighbour";

const MODE = { google: "configured", llm: "configured", emailSending: "gmail-api" };

/**
 * @param {string} userID
 * @param {string} email
 */
function seed(userID, email) {
  ensureUserIn(state, userID);
  state.users[userID].email = email;
  state.users[userID].googleTokens = { access_token: "secret", refresh_token: "also-secret" };
  state.briefings[userID] = { "2026-08-09": { emails: [] } };
  state.audit[userID] = [{ id: "a1", action: "approve" }];
  state.deviceNotifications[userID] = [{ id: "n1", title: "hi" }];
  state.sessions ||= {};
  state.sessions[`hash-${userID}`] = { userID, expiresAt: "2099-01-01T00:00:00.000Z" };
}

test("purgeUser removes every trace of the user", async () => {
  seed(USER, "purge@example.com");

  await purgeUser(USER);

  assert.equal(state.users[USER], undefined);
  assert.equal(state.briefings[USER], undefined);
  assert.equal(state.audit[USER], undefined);
  assert.equal(state.deviceNotifications[USER], undefined);
  assert.equal(state.sessions[`hash-${USER}`], undefined);
});

test("purgeUser leaves other users alone", async () => {
  seed(USER, "purge@example.com");
  seed(NEIGHBOUR, "neighbour@example.com");

  await purgeUser(USER);

  assert.equal(state.users[NEIGHBOUR].email, "neighbour@example.com");
  assert.equal(state.audit[NEIGHBOUR].length, 1);
  assert.ok(state.sessions[`hash-${NEIGHBOUR}`]);
});

test("purgeUser revokes the deleted user's sessions but not others'", async () => {
  seed(USER, "purge@example.com");
  seed(NEIGHBOUR, "neighbour@example.com");
  // A second session for the same user — deletion is by owner, not by count.
  state.sessions["hash-second"] = { userID: USER, expiresAt: "2099-01-01T00:00:00.000Z" };

  await purgeUser(USER);

  const remaining = Object.values(state.sessions).filter((entry) => entry?.userID === USER);
  assert.equal(remaining.length, 0);
  assert.ok(state.sessions[`hash-${NEIGHBOUR}`]);
});

test("purgeUser is safe to call for a user that does not exist", async () => {
  await purgeUser("no-such-user");
  assert.equal(state.users["no-such-user"], undefined);
});

test("sessionPayload exposes displayName and photoURL when Google supplied them", () => {
  ensureUserIn(state, USER);
  state.users[USER].displayName = "Ada Lovelace";
  state.users[USER].photoURL = "https://lh3.googleusercontent.com/a/ada";

  const payload = sessionPayload(state, USER, MODE);

  assert.equal(payload.displayName, "Ada Lovelace");
  assert.equal(payload.photoURL, "https://lh3.googleusercontent.com/a/ada");
});

test("sessionPayload nulls the profile fields for an account without them", () => {
  ensureUserIn(state, NEIGHBOUR);
  delete state.users[NEIGHBOUR].displayName;
  delete state.users[NEIGHBOUR].photoURL;

  const payload = sessionPayload(state, NEIGHBOUR, MODE);

  // null rather than undefined, so the field survives JSON serialization and
  // the client can tell "no photo" from "field missing".
  assert.equal(payload.displayName, null);
  assert.equal(payload.photoURL, null);
});
