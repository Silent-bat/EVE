import { test } from "node:test";
import assert from "node:assert/strict";

import { boundedProviderExpiry, normalizeGoogleTokenPayload } from "../src/google/oauth.mjs";

test("Google token payload normalization requires an access token and drops extras", () => {
  const result = normalizeGoogleTokenPayload({
    access_token: " access-token ",
    refresh_token: " refresh-token ",
    token_type: "Bearer",
    scope: "openid gmail.readonly",
    expires_in: 99_999,
    id_token: "should-not-be-persisted",
    client_secret: "should-not-be-persisted",
  });
  assert.equal(result.access_token, "access-token");
  assert.equal(result.refresh_token, "refresh-token");
  assert.equal(result.expires_in, 3_600);
  assert.equal("id_token" in result, false);
  assert.equal("client_secret" in result, false);
  assert.ok(result.expires_at > Date.now());
});

test("Google token payload normalization rejects unusable provider responses", () => {
  for (const payload of [
    null,
    [],
    {},
    { access_token: "" },
    { access_token: 42 },
    { access_token: "bad\nvalue" },
  ]) {
    assert.throws(
      () => normalizeGoogleTokenPayload(payload),
      (error) => /** @type {any} */ (error)?.status === 502,
    );
  }
});

test("provider expiry is finite and bounded", () => {
  assert.equal(boundedProviderExpiry(-1), 60);
  assert.equal(boundedProviderExpiry("not-a-number"), 3_600);
  assert.equal(boundedProviderExpiry(3_601), 3_600);
  assert.equal(boundedProviderExpiry(300), 300);
});
