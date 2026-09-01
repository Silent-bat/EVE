import assert from "node:assert/strict";
import { test } from "node:test";

import { tryWithAdvisoryLock } from "../src/storage/index.mjs";

test("background advisory locks skip an overlapping local operation", async () => {
  const lockName = `test-lock-${Date.now()}-${Math.random()}`;
  /** @type {(value?: unknown) => void} */
  let enteredResolve = () => {};
  const entered = new Promise((resolve) => {
    enteredResolve = () => resolve(undefined);
  });
  /** @type {(value?: unknown) => void} */
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve(undefined);
  });

  const first = tryWithAdvisoryLock(lockName, async () => {
    enteredResolve();
    await gate;
    return "first";
  });
  await entered;

  const second = await tryWithAdvisoryLock(lockName, async () => "second");
  assert.deepEqual(second, { acquired: false });

  release();
  assert.deepEqual(await first, { acquired: true, value: "first" });
  const third = await tryWithAdvisoryLock(lockName, async () => "third");
  assert.deepEqual(third, { acquired: true, value: "third" });
});

test("background advisory locks release after a failed operation", async () => {
  const lockName = `test-lock-failure-${Date.now()}-${Math.random()}`;
  await assert.rejects(
    () =>
      tryWithAdvisoryLock(lockName, async () => {
        throw new Error("expected failure");
      }),
    /expected failure/,
  );
  const retry = await tryWithAdvisoryLock(lockName, async () => "recovered");
  assert.deepEqual(retry, { acquired: true, value: "recovered" });
});
