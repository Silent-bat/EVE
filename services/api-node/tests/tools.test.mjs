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

test("runTool answer returns null", async () => {
  seed();
  const result = await runTool(USER, { name: "answer", args: { text: "hi" } });
  assert.equal(result, null);
});

test("runTool update_preferences merges into the user's preferences", async () => {
  seed();
  const result = /** @type {any} */ (
    await runTool(USER, {
      name: "update_preferences",
      args: { briefingTime: "07:15", timezone: "Europe/Paris" },
    })
  );
  assert.equal(result.preferences.briefingTime, "07:15");
  assert.equal(result.preferences.timezone, "Europe/Paris");
  // Defaults preserved for unspecified fields
  assert.equal(result.preferences.pushEnabled, true);
});

test("runTool update_preferences ignores invalid briefingTime", async () => {
  seed();
  const result = /** @type {any} */ (
    await runTool(USER, {
      name: "update_preferences",
      args: { briefingTime: "not-a-time" },
    })
  );
  // normalizePreferences silently falls back to the default for invalid values
  assert.equal(result.preferences.briefingTime, "08:00");
});

test("runTool approve_draft without draftId throws 400", async () => {
  seed();
  await assert.rejects(() => runTool(USER, { name: "approve_draft", args: {} }), {
    status: 400,
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
