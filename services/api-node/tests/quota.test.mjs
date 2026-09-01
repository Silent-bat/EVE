import assert from "node:assert/strict";
import test from "node:test";

import { createConnectionQuota } from "../src/voice/quota.mjs";

test("voice quota remains occupied until the client socket is released", () => {
  const quota = createConnectionQuota(1);
  const socket = {};

  assert.equal(quota.tryAcquire("user-1"), true);
  // A resolved upstream/Gemini setup does not release this reservation. The
  // bridge must wait for the client close path below.
  assert.equal(quota.tryAcquire("user-1"), false);
  assert.equal(quota.count("user-1"), 1);

  quota.release("user-1", socket);
  assert.equal(quota.count("user-1"), 0);
  assert.equal(quota.tryAcquire("user-1"), true);
});

test("voice quota release is idempotent when setup failure races close", () => {
  const quota = createConnectionQuota(2);
  const socket = {};

  assert.equal(quota.tryAcquire("user-1"), true);
  quota.release("user-1", socket);
  quota.release("user-1", socket);
  assert.equal(quota.count("user-1"), 0);
});

test("voice quota is isolated per user", () => {
  const quota = createConnectionQuota(1);
  assert.equal(quota.tryAcquire("user-1"), true);
  assert.equal(quota.tryAcquire("user-2"), true);
  assert.equal(quota.count("user-1"), 1);
  assert.equal(quota.count("user-2"), 1);
});
