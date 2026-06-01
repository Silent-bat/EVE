import { test } from "node:test";
import assert from "node:assert/strict";

import { addMinutes, atTime, dayKey, timeKey } from "../src/utils/dates.mjs";

test("dayKey formats as YYYY-MM-DD with zero padding", () => {
  assert.equal(dayKey(new Date(2026, 0, 3)), "2026-01-03");
  assert.equal(dayKey(new Date(2026, 11, 31)), "2026-12-31");
});

test("timeKey formats as HH:MM with zero padding", () => {
  const date = new Date();
  date.setHours(7, 5, 0, 0);
  assert.equal(timeKey(date), "07:05");
  date.setHours(23, 59, 0, 0);
  assert.equal(timeKey(date), "23:59");
});

test("atTime composes the requested hour/minute on the same calendar day", () => {
  const reference = new Date(2026, 4, 15, 12, 0, 0);
  const result = atTime(reference, 9, 30);
  assert.equal(result.getFullYear(), 2026);
  assert.equal(result.getMonth(), 4);
  assert.equal(result.getDate(), 15);
  assert.equal(result.getHours(), 9);
  assert.equal(result.getMinutes(), 30);
});

test("addMinutes shifts a date forward", () => {
  const base = new Date(2026, 0, 1, 0, 0, 0);
  const moved = addMinutes(base, 45);
  assert.equal(moved.getMinutes(), 45);
  assert.equal(moved.getHours(), 0);

  const next = addMinutes(base, 75);
  assert.equal(next.getHours(), 1);
  assert.equal(next.getMinutes(), 15);
});
