import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hashPassword,
  hashToken,
  MAX_PASSWORD_CHARS,
  normalizeEmail,
  verifyPassword,
} from "../src/auth/password.mjs";

test("normalizeEmail lowercases and trims", () => {
  assert.equal(normalizeEmail("  Test@Example.COM  "), "test@example.com");
});

test("normalizeEmail rejects malformed addresses", () => {
  assert.equal(normalizeEmail("not-an-email"), "");
  assert.equal(normalizeEmail("missing@tld"), "");
  assert.equal(normalizeEmail(""), "");
  assert.equal(normalizeEmail(null), "");
  assert.equal(normalizeEmail(undefined), "");
});

test("hashPassword produces a scrypt-formatted string", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.match(hash, /^scrypt:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
});

test("verifyPassword accepts the matching password", async () => {
  const hash = await hashPassword("topsecret123");
  assert.equal(await verifyPassword("topsecret123", hash), true);
});

test("verifyPassword rejects a different password", async () => {
  const hash = await hashPassword("topsecret123");
  assert.equal(await verifyPassword("not-the-same", hash), false);
});

test("verifyPassword rejects malformed stored hashes without throwing", async () => {
  assert.equal(await verifyPassword("any", ""), false);
  assert.equal(await verifyPassword("any", "scrypt:onlyone"), false);
  assert.equal(await verifyPassword("any", "bcrypt:salt:hash"), false);
});

test("password hashing rejects oversized input before doing scrypt work", async () => {
  const oversized = "x".repeat(MAX_PASSWORD_CHARS + 1);
  await assert.rejects(() => hashPassword(oversized), /at most 256/i);
  assert.equal(await verifyPassword(oversized, "scrypt:salt:hash"), false);
});

test("hashToken is deterministic and base64url", () => {
  const a = hashToken("abc123");
  const b = hashToken("abc123");
  assert.equal(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(hashToken("abc"), hashToken("abd"));
});
