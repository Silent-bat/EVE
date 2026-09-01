/**
 * Tests for account management — everything a signed-in user can change about
 * their account short of deleting it. Deletion itself is covered in
 * account.test.mjs.
 *
 * These run in JSON-storage mode (no DATABASE_URL), so they exercise the
 * in-memory branch of each function. The Postgres branch shares all of the
 * argument validation, which is where the interesting failures are, and adds a
 * single UPDATE or DELETE on top.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { changePassword, disconnectGoogle, revokeAllSessions, setDisplayName } from "../src/auth/account.mjs";
import { hashPassword } from "../src/auth/password.mjs";
import { state } from "../src/storage/index.mjs";
import { ensureUserIn } from "../src/storage/state.mjs";

const USER = "manage-test-user";
const OTHER = "manage-test-other";

async function seed() {
  ensureUserIn(state, USER);
  ensureUserIn(state, OTHER);
  state.users[USER].email = "manage@example.com";
  state.users[USER].displayName = "Old Name";
  state.users[USER].passwordHash = await hashPassword("correct-horse");
  state.users[USER].connectionMode = "google";
  state.users[USER].googleConnected = true;
  state.users[USER].googleTokens = { access_token: "token-abc" };

  state.sessions = {
    "hash-mine": { userID: USER, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    "hash-other-device": { userID: USER, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    "hash-someone-else": { userID: OTHER, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  };
}

test("setDisplayName trims and caps the stored name", async () => {
  await seed();
  const result = await setDisplayName(USER, "  Ada Lovelace  ");
  assert.equal(result.displayName, "Ada Lovelace");
  assert.equal(state.users[USER].displayName, "Ada Lovelace");

  const long = await setDisplayName(USER, "x".repeat(200));
  assert.equal(long.displayName.length, 80);
});

test("setDisplayName clears the name on empty input", async () => {
  await seed();
  const result = await setDisplayName(USER, "   ");
  assert.equal(result.displayName, null);
});

test("setDisplayName rejects a non-string", async () => {
  await seed();
  await assert.rejects(() => setDisplayName(USER, 42), /must be a string/i);
});

test("changePassword validates both fields before touching the hash", async () => {
  await seed();
  await assert.rejects(() => changePassword(USER, { newPassword: "longenough" }), /required/i);
  await assert.rejects(
    () => changePassword(USER, { currentPassword: "correct-horse", newPassword: "short" }),
    /at least 8/i,
  );
  await assert.rejects(
    () => changePassword(USER, { currentPassword: "correct-horse", newPassword: "correct-horse" }),
    /matches the old one/i,
  );
  await assert.rejects(
    () => changePassword(USER, { currentPassword: "correct-horse", newPassword: "x".repeat(257) }),
    /at most 256/i,
  );
});

test("changePassword rejects a wrong current password", async () => {
  await seed();
  await assert.rejects(
    () => changePassword(USER, { currentPassword: "wrong-guess", newPassword: "new-passphrase" }),
    /incorrect/i,
  );
});

test("changePassword replaces the stored hash, and the new one is what works", async () => {
  await seed();
  const before = state.users[USER].passwordHash;
  const result = await changePassword(USER, {
    currentPassword: "correct-horse",
    newPassword: "battery-staple",
  });
  assert.equal(result.ok, true);
  assert.notEqual(state.users[USER].passwordHash, before);

  await assert.rejects(
    () => changePassword(USER, { currentPassword: "correct-horse", newPassword: "another-one" }),
    /incorrect/i,
  );
  await changePassword(USER, { currentPassword: "battery-staple", newPassword: "third-secret" });
});

test("changePassword explains itself on a Google-only account", async () => {
  await seed();
  delete state.users[USER].passwordHash;
  await assert.rejects(
    () => changePassword(USER, { currentPassword: "anything", newPassword: "new-passphrase" }),
    /signs in with Google/i,
  );
});

test("disconnectGoogle drops the tokens and both connection flags", async () => {
  await seed();
  const result = await disconnectGoogle(USER);
  assert.equal(result.googleConnected, false);
  assert.equal(result.connectionMode, "none");
  assert.equal(state.users[USER].googleTokens, undefined);
  assert.equal(state.users[USER].googleConnected, false);
});

test("disconnectGoogle keeps the account and its history", async () => {
  await seed();
  state.briefings[USER] = { "2026-08-09": { id: "b1" } };
  await disconnectGoogle(USER);
  assert.ok(state.users[USER], "the account must survive a disconnect");
  assert.ok(state.briefings[USER], "history is a record of what EVE did, not a token");
});

test("revokeAllSessions clears every session for the user and no others", async () => {
  await seed();
  const result = await revokeAllSessions(USER);
  assert.equal(result.revoked, 2);
  assert.equal(state.sessions["hash-mine"], undefined);
  assert.equal(state.sessions["hash-other-device"], undefined);
  assert.ok(state.sessions["hash-someone-else"], "another user's session must survive");
});
