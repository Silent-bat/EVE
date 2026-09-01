import { test } from "node:test";
import assert from "node:assert/strict";

import { requireUserID } from "../src/auth/index.mjs";
import { emptyState, ensureUserIn, isValidUserID } from "../src/storage/state.mjs";

function request(headers = {}) {
  return /** @type {any} */ ({ headers });
}

test("user IDs accept generated and local identifiers but reject object prototype keys", () => {
  for (const value of ["local-user", "550e8400-e29b-41d4-a716-446655440000", "test_user.v2", "acct:+demo"]) {
    assert.equal(isValidUserID(value), true, value);
  }
  for (const value of [
    "__proto__",
    "constructor",
    "prototype",
    "../escape",
    "",
    "x".repeat(129),
    "a b",
    "a\n b",
  ]) {
    assert.equal(isValidUserID(value), false, value);
  }
});

test("ensureUserIn cannot mutate Object.prototype through a hostile key", () => {
  const target = emptyState();
  assert.throws(() => ensureUserIn(target, "__proto__"), { status: 400 });
  assert.equal(/** @type {any} */ (Object.prototype).email, undefined);
  assert.equal(/** @type {any} */ (Object.prototype).preferences, undefined);
  assert.equal(Object.getPrototypeOf(target.users), null);
});

test("development header authentication trims and validates the user ID", async () => {
  assert.equal(await requireUserID(request({ "x-eve-user-id": "  local-user  " })), "local-user");
  await assert.rejects(
    requireUserID(request({ "x-eve-user-id": "__proto__" })),
    (error) => /** @type {any} */ (error)?.status === 401,
  );
  await assert.rejects(
    requireUserID(request({ "x-eve-user-id": "../other-user" })),
    (error) => /** @type {any} */ (error)?.status === 401,
  );
});
