import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clampNumber,
  localDraft,
  localMessageAnalysis,
  normalizeMessageAnalysis,
  sanitizePlainText,
  summarizeMessage,
  urgencyReason,
  urgencyScore,
  validDateISOString,
} from "../src/briefing/scoring.mjs";

test("urgencyScore boosts time-pressure keywords", () => {
  const score = urgencyScore({ subject: "Today only", body: "Please confirm before noon" });
  assert.ok(score > 80, `expected >80, got ${score}`);
});

test("urgencyScore penalises newsletters", () => {
  const score = urgencyScore({ subject: "Weekly newsletter", body: "Updates from the team" });
  assert.ok(score < 30, `expected <30, got ${score}`);
});

test("urgencyScore clamps to [1, 99]", () => {
  const high = urgencyScore({
    subject: "today noon confirm needed investor contract",
    body: "today noon confirm needed investor contract",
  });
  assert.equal(high, 99);

  const low = urgencyScore({
    subject: "newsletter newsletter newsletter newsletter newsletter",
    body: "newsletter",
  });
  assert.ok(low >= 1);
});

test("urgencyReason returns a meaningful string for every score", () => {
  for (const score of [10, 40, 70, 95]) {
    const reason = urgencyReason({ subject: "x", body: "y" }, score);
    assert.equal(typeof reason, "string");
    assert.ok(reason.length > 0);
  }
});

test("summarizeMessage clips at 150 chars with ellipsis", () => {
  const body = "a".repeat(200);
  const summary = summarizeMessage({ body });
  assert.equal(summary.length, 150);
  assert.ok(summary.endsWith("..."));
});

test("localDraft returns 'No reply needed.' for low-score informational emails", () => {
  const draft = localDraft({ senderName: "Bob Smith", subject: "Hello" }, 10);
  assert.equal(draft, "No reply needed.");
});

test("localDraft formats contract reply with greeting", () => {
  const draft = localDraft({ senderName: "Alice Brown", subject: "Contract review" }, 80);
  assert.ok(draft.startsWith("Hi Alice,"));
  assert.ok(draft.includes("agreement"));
});

test("localMessageAnalysis assembles a valid analysis object", () => {
  const analysis = localMessageAnalysis(
    { senderName: "Test", senderEmail: "t@x.com", subject: "Meeting", body: "Tomorrow at 10" },
    65,
  );
  assert.equal(analysis.urgencyScore, 65);
  assert.equal(typeof analysis.urgencyReason, "string");
  assert.equal(typeof analysis.summary, "string");
  assert.equal(typeof analysis.draftReply, "string");
});

test("normalizeMessageAnalysis falls back when fields are missing", () => {
  const fallback = {
    urgencyScore: 50,
    urgencyReason: "default reason",
    summary: "default summary",
    draftReply: "default draft",
  };
  const result = normalizeMessageAnalysis({}, fallback);
  assert.equal(result.urgencyScore, 50);
  assert.equal(result.urgencyReason, "default reason");
});

test("normalizeMessageAnalysis clamps urgencyScore to [1, 99]", () => {
  const fallback = { urgencyScore: 50, urgencyReason: "x", summary: "y", draftReply: "z" };
  assert.equal(normalizeMessageAnalysis({ urgencyScore: 999 }, fallback).urgencyScore, 99);
  assert.equal(normalizeMessageAnalysis({ urgencyScore: -10 }, fallback).urgencyScore, 1);
  assert.equal(normalizeMessageAnalysis({ urgencyScore: "not a number" }, fallback).urgencyScore, 50);
});

test("sanitizePlainText collapses whitespace and clamps length", () => {
  assert.equal(sanitizePlainText("hello   \n\tworld", 50), "hello world");
  assert.equal(sanitizePlainText("a".repeat(200), 10), "a".repeat(10));
  assert.equal(sanitizePlainText(undefined, 10), "");
});

test("validDateISOString returns ISO for parseable input, empty for garbage", () => {
  assert.equal(validDateISOString("2026-01-01T00:00:00Z"), "2026-01-01T00:00:00.000Z");
  assert.equal(validDateISOString("not a date"), "");
});

test("clampNumber rounds and clamps", () => {
  assert.equal(clampNumber(3.7, 1, 10, 5), 4);
  assert.equal(clampNumber(20, 1, 10, 5), 10);
  assert.equal(clampNumber(0, 1, 10, 5), 1);
  assert.equal(clampNumber("garbage", 1, 10, 5), 5);
});
