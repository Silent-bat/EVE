/**
 * Tests for the AI tool harness. We exercise the dispatcher directly,
 * stubbing out the heavier tools (generate_briefing, refresh_gmail, drafts)
 * by seeding state for the simpler ones (answer, update_preferences) and
 * asserting error paths for the rest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  appendSystemNotification,
  hasExplicitActionIntent,
  normalizeMemoryKind,
  rememberFact,
  runTool,
  TOOL_CATALOG,
  toolCatalogPrompt,
} from "../src/briefing/tools.mjs";
import { state } from "../src/storage/index.mjs";
import { ensureUserIn } from "../src/storage/state.mjs";

const USER = "tool-test-user";

function seed() {
  ensureUserIn(state, USER);
  state.users[USER].email = "tools@example.com";
  state.users[USER].connectionMode = "none";
  delete state.users[USER].googleTokens;
  state.deviceNotifications[USER] = [];
}

test("TOOL_CATALOG contains the expected actions", () => {
  const names = TOOL_CATALOG.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "answer",
    "approve_draft",
    "forget",
    "generate_briefing",
    "refresh_gmail",
    "reject_draft",
    "remember",
    "search_emails",
    "update_preferences",
  ]);
});

test("toolCatalogPrompt mentions every tool", () => {
  const prompt = toolCatalogPrompt();
  for (const t of TOOL_CATALOG) assert.ok(prompt.includes(t.name), `missing ${t.name}`);
});

test("mutating tool intent must be a direct user command", () => {
  assert.equal(hasExplicitActionIntent("approve_draft", "approve this draft"), true);
  assert.equal(hasExplicitActionIntent("approve_draft", "please send the email"), true);
  assert.equal(hasExplicitActionIntent("reject_draft", "reject that reply"), true);
  assert.equal(hasExplicitActionIntent("remember", "remember my mother's appointment is Tuesday"), true);
  assert.equal(hasExplicitActionIntent("forget", "please forget this memory"), true);
  assert.equal(hasExplicitActionIntent("update_preferences", "change my timezone to Europe/Paris"), true);

  // Text quoted in a message, or a user describing a non-command, must not
  // authorize a model-selected action.
  assert.equal(hasExplicitActionIntent("approve_draft", "the email says approve it"), false);
  assert.equal(hasExplicitActionIntent("approve_draft", "I don't want you to send it"), false);
  assert.equal(hasExplicitActionIntent("approve_draft", "yes"), false);
  assert.equal(hasExplicitActionIntent("remember", "the note says remember this"), false);
  assert.equal(hasExplicitActionIntent("update_preferences", "the email says change my timezone"), false);
});

test("runTool answer returns null", async () => {
  seed();
  const result = await runTool(USER, { name: "answer", args: { text: "hi" } });
  assert.equal(result, null);
});

test("memory kinds are normalized to the supported categories", () => {
  seed();
  state.users[USER].memory = [];
  assert.equal(normalizeMemoryKind(" PROFILE "), "profile");
  assert.equal(normalizeMemoryKind("PROJECT"), "project");
  assert.equal(normalizeMemoryKind("provider-controlled"), "general");
  assert.equal(normalizeMemoryKind(42), "general");
  const entry = rememberFact(USER, "Ada works on Atlas", "  PROJECT ");
  assert.equal(entry.kind, "project");
  const fallback = rememberFact(USER, "Ada likes tea", "<prompt injection>");
  assert.equal(fallback.kind, "general");
});

test("runTool update_preferences merges into the user's preferences", async () => {
  seed();
  const result = /** @type {any} */ (
    await runTool(
      USER,
      {
        name: "update_preferences",
        args: { briefingTime: "07:15", timezone: "Europe/Paris" },
      },
      { userPrompt: "change my briefing time and timezone" },
    )
  );
  assert.equal(result.preferences.briefingTime, "07:15");
  assert.equal(result.preferences.timezone, "Europe/Paris");
  // Defaults preserved for unspecified fields
  assert.equal(result.preferences.pushEnabled, true);
});

test("runTool update_preferences ignores invalid briefingTime", async () => {
  seed();
  const result = /** @type {any} */ (
    await runTool(
      USER,
      {
        name: "update_preferences",
        args: { briefingTime: "not-a-time" },
      },
      { userPrompt: "change my briefing time" },
    )
  );
  // normalizePreferences silently falls back to the default for invalid values
  assert.equal(result.preferences.briefingTime, "08:00");
});

test("runTool update_preferences normalizes nested proactive settings", async () => {
  seed();
  const result = /** @type {any} */ (
    await runTool(
      USER,
      {
        name: "update_preferences",
        args: {
          proactive: {
            enabled: false,
            quietHoursStart: "25:99",
            maxPushesPerDay: 999,
            categories: {
              briefing_ready: { enabled: false, deliveryMode: "invalid" },
              unknown_category: { enabled: true },
            },
          },
        },
      },
      { userPrompt: "disable my proactive notifications" },
    )
  );
  assert.equal(result.preferences.proactive.enabled, false);
  assert.equal(result.preferences.proactive.quietHoursStart, "22:00");
  assert.equal(result.preferences.proactive.maxPushesPerDay, 50);
  assert.equal(result.preferences.proactive.categories.briefing_ready.enabled, false);
  assert.equal(result.preferences.proactive.categories.briefing_ready.deliveryMode, "push");
  assert.equal(result.preferences.proactive.categories.unknown_category, undefined);
});

test("runTool approve_draft without draftId throws 400", async () => {
  seed();
  await assert.rejects(() => runTool(USER, { name: "approve_draft", args: {} }), {
    status: 400,
  });
});

test("runTool blocks a model-inferred draft action without the current user command", async () => {
  seed();
  await assert.rejects(() => runTool(USER, { name: "approve_draft", args: { draftId: "draft-hostile" } }), {
    status: 400,
    message: "explicit user confirmation is required for draft actions",
  });
});

test("runTool blocks durable mutations without the current user command", async () => {
  seed();
  await assert.rejects(() => runTool(USER, { name: "remember", args: { fact: "untrusted" } }), {
    status: 400,
    message: "explicit user instruction is required to save a memory",
  });
  await assert.rejects(() => runTool(USER, { name: "update_preferences", args: { timezone: "UTC" } }), {
    status: 400,
    message: "explicit user instruction is required to change preferences",
  });
});

test("runTool refresh_gmail throws 400 when Gmail is not connected", async () => {
  seed();
  await assert.rejects(() => runTool(USER, { name: "refresh_gmail", args: {} }), {
    status: 400,
  });
});

test("runTool with an unknown tool name throws 400", async () => {
  seed();
  await assert.rejects(() => runTool(USER, { name: "drop_database", args: {} }), {
    status: 400,
  });
});

test("appendSystemNotification prepends an entry capped at 100", () => {
  seed();
  for (let i = 0; i < 105; i++) {
    appendSystemNotification(USER, { title: `t${i}`, body: `b${i}` });
  }
  const entries = state.deviceNotifications[USER];
  assert.equal(entries.length, 100);
  // Most-recent is at index 0
  assert.equal(entries[0].title, "t104");
  assert.equal(entries[0].appName, "EVE");
  assert.equal(entries[0].packageName, "com.eve.agent");
});
