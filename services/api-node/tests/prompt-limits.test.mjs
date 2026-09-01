import assert from "node:assert/strict";
import test from "node:test";

import { config } from "../src/config.mjs";
import {
  buildAssistantPlannerPrompt,
  buildAssistantSummaryPrompt,
  buildMemoryExtractionPrompt,
} from "../src/briefing/assistant.mjs";
import { boundedJSONValue, stringifyPromptValue } from "../src/briefing/prompt.mjs";
import { buildSystemInstruction, flattenToolResult } from "../src/voice/wsServer.mjs";

test("assistant planner prompt has a hard total cap and keeps the authenticated turn", () => {
  const prompt = buildAssistantPlannerPrompt(
    "show my priorities",
    /** @type {any} */ ({
      recentNotifications: [{ body: "x".repeat(300_000) }],
      memory: Array.from({ length: 400 }, () => ({ fact: "y".repeat(2_000) })),
    }),
  );

  assert.ok(prompt.length <= config.geminiPromptMaxChars);
  assert.match(prompt, /authenticated user: show my priorities/);
  assert.match(prompt, /UNTRUSTED_WORKSPACE_CONTEXT/);
});

test("assistant summary prompt bounds a large tool result", () => {
  const prompt = buildAssistantSummaryPrompt(
    "find the latest message",
    { name: "search_emails", args: {} },
    { results: Array.from({ length: 500 }, () => ({ body: "z".repeat(2_000) })) },
  );

  assert.ok(prompt.length <= config.geminiPromptMaxChars);
  assert.match(prompt, /User request: find the latest message/);
  assert.match(prompt, /Action taken: search_emails/);
});

test("memory extraction prompt excludes a verbose generated answer", () => {
  const prompt = buildMemoryExtractionPrompt("My name is Ada", "answer ".repeat(100_000));

  assert.ok(prompt.length <= config.geminiPromptMaxChars);
  assert.match(prompt, /User: My name is Ada/);
  assert.doesNotMatch(prompt, /answer answer/);
  assert.doesNotMatch(prompt, /Assistant:/);
});

test("bounded JSON tool values stay valid and under their cap", () => {
  const value = boundedJSONValue({ body: "q".repeat(100_000) }, 800);
  assert.ok(value && typeof value === "object");
  assert.equal(/** @type {any} */ (value)._truncated, true);
  assert.ok(stringifyPromptValue(value).length <= 800);
  assert.doesNotThrow(() => JSON.parse(stringifyPromptValue(value)));
});

test("bounded JSON values replace cyclic provider data", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const value = boundedJSONValue(cyclic, 800);
  assert.ok(value && typeof value === "object");
  assert.ok(stringifyPromptValue(value).length <= 800);
  assert.doesNotThrow(() => JSON.stringify(value));
});

test("Live system and tool-result context stay bounded", () => {
  assert.ok(buildSystemInstruction("missing-user").length <= 32_000);
  const payload = flattenToolResult({ body: "r".repeat(100_000) });
  assert.ok(stringifyPromptValue(payload.result).length <= 2_000);
});
