import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  emptyState,
  mergePersistedUser,
  normalizePreferences,
  validTime,
  validTimezone,
} from "../src/storage/state.mjs";

const execFileAsync = promisify(execFile);

test("preference time validation rejects impossible clock values", () => {
  assert.equal(validTime("00:00"), true);
  assert.equal(validTime("23:59"), true);
  assert.equal(validTime("24:00"), false);
  assert.equal(validTime("12:60"), false);
  assert.equal(validTime("9:05"), false);
});

test("preference timezone validation rejects unknown identifiers", () => {
  assert.equal(validTimezone("Africa/Douala"), true);
  assert.equal(validTimezone("America/New_York"), true);
  assert.equal(validTimezone("not/a-timezone"), false);
  assert.equal(validTimezone(""), false);
  assert.equal(normalizePreferences({ timezone: "not/a-timezone" }).timezone, "Africa/Douala");
});

test("JSON password accounts remain login-capable after a process restart", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "eve-state-restart-"));
  const sourceRoot = path.resolve(import.meta.dirname, "..");
  const childEnv = /** @type {Record<string, string | undefined>} */ ({
    ...process.env,
    NODE_ENV: "test",
    EVE_DATA_DIR: dataDir,
    LOG_LEVEL: "silent",
  });
  // An inherited empty DATABASE_URL is still present in some shells (and zod
  // correctly rejects it as an invalid URL). Force the child to use JSON mode
  // by removing the variable rather than passing an empty string.
  delete childEnv.DATABASE_URL;
  const bootstrap = `
    const { initialize } = await import(${JSON.stringify(path.join(sourceRoot, "src/storage/index.mjs"))});
    const { signup } = await import(${JSON.stringify(path.join(sourceRoot, "src/auth/index.mjs"))});
    await initialize();
    await signup({ email: "restart@example.com", password: "restart-password" });
  `;
  const verify = `
    const { initialize } = await import(${JSON.stringify(path.join(sourceRoot, "src/storage/index.mjs"))});
    const { findAuthUserByEmail } = await import(${JSON.stringify(path.join(sourceRoot, "src/auth/index.mjs"))});
    await initialize();
    const user = await findAuthUserByEmail("restart@example.com");
    if (!user?.passwordHash) throw new Error("password hash missing after restart");
    process.stdout.write(JSON.stringify({ email: user.email, hasHash: true }));
  `;
  try {
    await execFileAsync(process.execPath, ["--input-type=module", "-e", bootstrap], { env: childEnv });
    const result = await execFileAsync(process.execPath, ["--input-type=module", "-e", verify], {
      env: childEnv,
    });
    assert.deepEqual(JSON.parse(result.stdout), { email: "restart@example.com", hasHash: true });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("loading persisted user history applies retention caps", () => {
  const target = emptyState();
  const now = new Date().toISOString();
  mergePersistedUser(target, "retention-user", {
    user: { email: "retention@example.com", memory: Array.from({ length: 300 }, (_, i) => ({ id: i })) },
    briefings: Object.fromEntries(
      Array.from({ length: 160 }, (_, i) => [
        `day-${i}`,
        { id: `briefing-${now.slice(0, 10)}-${i}`, generatedAt: now },
      ]),
    ),
    audit: Array.from({ length: 700 }, (_, i) => ({ id: i })),
    deviceNotifications: Array.from({ length: 180 }, (_, i) => ({ id: i })),
  });

  assert.equal(target.users["retention-user"].memory.length, 200);
  assert.equal(Object.keys(target.briefings["retention-user"]).length, 120);
  assert.equal(target.audit["retention-user"].length, 500);
  assert.equal(target.deviceNotifications["retention-user"].length, 100);
});
