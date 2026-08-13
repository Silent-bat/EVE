/**
 * Regression tests for the "dead Google connection" path.
 *
 * The app has no `needsReconnect` field — it decides whether to show the
 * connect screen purely from `googleConnected` (App.tsx). So a connection that
 * can no longer be refreshed has to clear `googleConnected`, or the app keeps
 * rendering a connected account whose every Gmail call 401s, with no way back.
 *
 * These cover only the offline branches: token refresh over the network needs
 * real Google credentials, which tests don't have.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureGoogleAuthUser } from "../src/auth/index.mjs";
import { refreshGoogleToken } from "../src/google/api.mjs";
import { integrationMode } from "../src/google/oauth.mjs";
import { state } from "../src/storage/index.mjs";
import { ensureUserIn, sessionPayload } from "../src/storage/state.mjs";

const HOUR = 60 * 60 * 1000;

/**
 * @param {string} userID
 * @param {Record<string, unknown>} tokens
 */
function seedGoogleUser(userID, tokens) {
  ensureUserIn(state, userID);
  state.users[userID].googleConnected = true;
  state.users[userID].connectionMode = "google";
  state.users[userID].googleTokens = tokens;
  return state.users[userID];
}

test("expired token with no refresh token flags re-auth instead of looping on 401s", async () => {
  const user = seedGoogleUser("reauth-expired", {
    access_token: "fake-expired-token-not-real",
    expires_at: Date.now() - HOUR,
  });

  const accessToken = await refreshGoogleToken(user);

  // Returning the dead token would 401 against Gmail on every poll forever.
  assert.equal(accessToken, undefined, "must not hand back an unusable token");
  assert.equal(user.googleTokens.needsReconnect, true);
  // The flag the app actually reads.
  assert.equal(user.googleConnected, false);
});

test("the session payload reports a dead connection as disconnected", async () => {
  const user = seedGoogleUser("reauth-session", {
    access_token: "fake-expired-token-not-real",
    expires_at: Date.now() - HOUR,
  });

  await refreshGoogleToken(user);
  const payload = sessionPayload(state, "reauth-session", integrationMode());

  // sessionPayload does not carry needsReconnect, so this is the only signal
  // the client gets that it should send the user back to sign-in.
  assert.equal(payload.googleConnected, false);
});

test("a still-valid access token with no refresh token is left alone", async () => {
  const user = seedGoogleUser("reauth-valid", {
    access_token: "fake-valid-token-not-real",
    expires_at: Date.now() + HOUR,
  });

  const accessToken = await refreshGoogleToken(user);

  assert.equal(accessToken, "fake-valid-token-not-real");
  assert.notEqual(user.googleTokens.needsReconnect, true);
  assert.equal(user.googleConnected, true, "a working connection must stay connected");
});

test("re-login clears needsReconnect and restores the connection", async () => {
  const user = seedGoogleUser("reauth-relogin", {
    access_token: "fake-expired-token-not-real",
    expires_at: Date.now() - HOUR,
  });
  await refreshGoogleToken(user);
  assert.equal(user.googleConnected, false, "precondition: connection is flagged dead");

  const userID = await ensureGoogleAuthUser("reauth-relogin@example.com", {
    access_token: "fake-fresh-token-not-real",
    refresh_token: "fake-refresh-token-not-real",
    expires_at: Date.now() + HOUR,
  });
  const reconnected = state.users[userID];

  // Spreading the previous token object would carry needsReconnect: true into
  // a working login and leave the app stuck on the connect screen.
  assert.equal(reconnected.googleTokens.needsReconnect, false);
  assert.equal(reconnected.googleConnected, true);
  assert.equal(reconnected.connectionMode, "google");
});

test("re-login keeps the stored refresh token when Google omits it", async () => {
  ensureUserIn(state, "reauth-merge");
  state.users["reauth-merge"].email = "reauth-merge@example.com";
  state.users["reauth-merge"].googleTokens = {
    access_token: "fake-old-token-not-real",
    refresh_token: "fake-kept-refresh-token-not-real",
    expires_at: Date.now() - HOUR,
  };

  // Google only re-issues a refresh_token when the grant is new, so a re-login
  // against an existing grant arrives without one. Dropping the stored token
  // here forced a full logout/login every time the access token expired.
  const userID = await ensureGoogleAuthUser("reauth-merge@example.com", {
    access_token: "fake-new-token-not-real",
    expires_at: Date.now() + HOUR,
  });

  assert.equal(state.users[userID].googleTokens.refresh_token, "fake-kept-refresh-token-not-real");
  assert.equal(state.users[userID].googleTokens.access_token, "fake-new-token-not-real");
});

test("a connected flag with no token behind it is not reported as connected", () => {
  // Real shape found in stored data: googleConnected true, connectionMode from
  // an old build, and an empty token object. Every server Gmail path requires
  // connectionMode "google" + an access token, so echoing the stored flag let
  // the app past its login gate into an account whose mail silently never
  // loaded.
  ensureUserIn(state, "reauth-orphan");
  state.users["reauth-orphan"].googleConnected = true;
  state.users["reauth-orphan"].connectionMode = "demo";
  state.users["reauth-orphan"].googleTokens = {};

  const payload = sessionPayload(state, "reauth-orphan", integrationMode());

  assert.equal(payload.googleConnected, false, "no usable token means not connected");
});

test("a genuine google connection is still reported as connected", () => {
  seedGoogleUser("reauth-usable", {
    access_token: "fake-valid-token-not-real",
    refresh_token: "fake-refresh-token-not-real",
    expires_at: Date.now() + HOUR,
  });

  const payload = sessionPayload(state, "reauth-usable", integrationMode());

  assert.equal(payload.googleConnected, true);
  assert.equal(payload.connectionMode, "google");
});
