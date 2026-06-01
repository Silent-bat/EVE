import { test } from "node:test";
import assert from "node:assert/strict";

import { config } from "../src/config.mjs";
import { enforceAuthRateLimit, resetForTests } from "../src/auth/rate-limit.mjs";

test("rate limit lets through requests under the per-IP cap", () => {
  resetForTests();
  for (let i = 0; i < config.rateLimit.authIpPerMin; i++) {
    enforceAuthRateLimit("10.0.0.1", "");
  }
});

test("rate limit blocks the next IP request once the cap is reached", () => {
  resetForTests();
  const cap = config.rateLimit.authIpPerMin;
  for (let i = 0; i < cap; i++) {
    enforceAuthRateLimit("10.0.0.2", "");
  }
  assert.throws(() => enforceAuthRateLimit("10.0.0.2", ""), { status: 429 });
});

test("rate limit isolates IPs", () => {
  resetForTests();
  const cap = config.rateLimit.authIpPerMin;
  for (let i = 0; i < cap; i++) {
    enforceAuthRateLimit("10.0.0.3", "");
  }
  // a different IP is unaffected
  enforceAuthRateLimit("10.0.0.4", "");
});

test("rate limit blocks per-email regardless of IP", () => {
  resetForTests();
  const cap = config.rateLimit.authEmailPer15Min;
  for (let i = 0; i < cap; i++) {
    // rotate IPs so the per-IP limit doesn't trip
    enforceAuthRateLimit(`10.0.${i}.1`, "victim@example.com");
  }
  assert.throws(() => enforceAuthRateLimit("10.0.99.1", "victim@example.com"), { status: 429 });
});

test("rate limit ignores empty IP and email", () => {
  resetForTests();
  enforceAuthRateLimit("", "");
  enforceAuthRateLimit("", "");
});
