import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addMinutes,
  atLocalDateInZone,
  atTime,
  atTimeInZone,
  dayKey,
  dayKeyInZone,
  startOfDayInZone,
  startOfNextDayInZone,
  timeKey,
  timeKeyInZone,
  zonedParts,
} from "../src/utils/dates.mjs";

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

test("zone helpers preserve the user's wall clock instead of applying the offset backwards", () => {
  const reference = new Date("2024-06-01T12:00:00.000Z");
  const result = atTimeInZone(reference, 8, 5, "America/New_York");
  assert.equal(result.toISOString(), "2024-06-01T12:05:00.000Z");
  assert.deepEqual(zonedParts(result, "America/New_York"), {
    year: 2024,
    month: 6,
    day: 1,
    hour: 8,
    minute: 5,
    second: 0,
  });
  assert.equal(dayKeyInZone(result, "America/New_York"), "2024-06-01");
  assert.equal(timeKeyInZone(result, "America/New_York"), "08:05");
});

test("zone day bounds follow 23- and 25-hour DST days", () => {
  const spring = new Date("2024-03-10T12:00:00.000Z");
  const springStart = startOfDayInZone(spring, "America/New_York");
  const springEnd = startOfNextDayInZone(spring, "America/New_York");
  assert.equal(springStart.toISOString(), "2024-03-10T05:00:00.000Z");
  assert.equal(springEnd.toISOString(), "2024-03-11T04:00:00.000Z");
  assert.equal(springEnd.getTime() - springStart.getTime(), 23 * 60 * 60 * 1000);

  const autumn = new Date("2024-11-03T12:00:00.000Z");
  const autumnStart = startOfDayInZone(autumn, "America/New_York");
  const autumnEnd = startOfNextDayInZone(autumn, "America/New_York");
  assert.equal(autumnStart.toISOString(), "2024-11-03T04:00:00.000Z");
  assert.equal(autumnEnd.toISOString(), "2024-11-04T05:00:00.000Z");
  assert.equal(autumnEnd.getTime() - autumnStart.getTime(), 25 * 60 * 60 * 1000);
});

test("all-day calendar dates are interpreted in the user's zone", () => {
  const result = atLocalDateInZone("2024-06-01", 0, 0, "America/New_York");
  assert.equal(result.toISOString(), "2024-06-01T04:00:00.000Z");
  assert.deepEqual(zonedParts(result, "America/New_York"), {
    year: 2024,
    month: 6,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
  });
});
