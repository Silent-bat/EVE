import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_NATIVE_GOOGLE_CLIENT_ID_CHARS,
  MAX_NATIVE_GOOGLE_CODE_CHARS,
  MAX_NATIVE_GOOGLE_TOKEN_CHARS,
  normalizeNativeGoogleInput,
} from "../src/auth/google-native.mjs";

const googleConfig = {
  clientId: "web-client.apps.googleusercontent.com",
  androidClientId: "android-client.apps.googleusercontent.com",
};

test("native Google input keeps only validated credentials and bounds expiry", () => {
  const result = normalizeNativeGoogleInput(
    {
      accessToken: " access-token ",
      serverAuthCode: " auth-code ",
      clientId: googleConfig.androidClientId,
      expiresIn: 99_999,
      refreshToken: "attacker-refresh",
      idToken: "attacker-id-token",
      scope: "mail",
    },
    googleConfig,
  );

  assert.deepEqual(result, {
    accessToken: "access-token",
    serverAuthCode: "auth-code",
    clientID: googleConfig.androidClientId,
    expiresIn: 3_600,
  });
});

test("native Google input requires a bounded access token", () => {
  for (const accessToken of [
    undefined,
    null,
    "",
    "x".repeat(MAX_NATIVE_GOOGLE_TOKEN_CHARS + 1),
    "bad\nvalue",
  ]) {
    assert.throws(
      () => normalizeNativeGoogleInput({ accessToken }, googleConfig),
      (error) => /** @type {any} */ (error)?.status === 400,
    );
  }
});

test("native Google input rejects malformed optional credentials", () => {
  assert.throws(
    () =>
      normalizeNativeGoogleInput(
        { accessToken: "token", serverAuthCode: "x".repeat(MAX_NATIVE_GOOGLE_CODE_CHARS + 1) },
        googleConfig,
      ),
    (error) => /** @type {any} */ (error)?.status === 400,
  );
  assert.throws(
    () =>
      normalizeNativeGoogleInput(
        { accessToken: "token", clientId: "x".repeat(MAX_NATIVE_GOOGLE_CLIENT_ID_CHARS + 1) },
        googleConfig,
      ),
    (error) => /** @type {any} */ (error)?.status === 400,
  );
});

test("native Google input accepts only configured client IDs", () => {
  assert.throws(
    () =>
      normalizeNativeGoogleInput(
        { accessToken: "token", clientId: "other.apps.googleusercontent.com" },
        googleConfig,
      ),
    (error) => /** @type {any} */ (error)?.status === 400,
  );
  const noClientID = normalizeNativeGoogleInput({ accessToken: "token", clientId: "" }, googleConfig);
  assert.equal(noClientID.clientID, googleConfig.clientId);
});

test("native Google input clamps invalid and short expiry hints", () => {
  assert.equal(
    normalizeNativeGoogleInput({ accessToken: "token", expiresIn: -1 }, googleConfig).expiresIn,
    60,
  );
  assert.equal(
    normalizeNativeGoogleInput({ accessToken: "token", expiresIn: "not-a-number" }, googleConfig).expiresIn,
    3_600,
  );
});
