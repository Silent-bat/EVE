import assert from "node:assert/strict";
import test from "node:test";

import { config } from "../src/config.mjs";
import { resetForTests } from "../src/auth/rate-limit.mjs";
import {
  enforceVoiceToolRateLimit,
  parseVoiceUpgradeURL,
  voiceToolCategory,
} from "../src/voice/wsServer.mjs";

test("voice upgrade URL parsing does not trust the Host header", () => {
  const parsed = parseVoiceUpgradeURL("/v1/voice/live?token=abc");
  assert.ok(parsed);
  assert.equal(parsed.origin, "http://eve.invalid");
  assert.equal(parsed.pathname, "/v1/voice/live");
  assert.equal(parseVoiceUpgradeURL("http://[bad"), null);
});

test("voice tools map to stable billable categories", () => {
  assert.equal(voiceToolCategory("search_emails"), "gmail");
  assert.equal(voiceToolCategory("generate_briefing"), "gmail");
  assert.equal(voiceToolCategory("approve_draft"), "mail_mutation");
  assert.equal(voiceToolCategory("remember"), "memory_mutation");
  assert.equal(voiceToolCategory("made_up_tool"), "other");
});

test("voice tool limits are per user and per category", () => {
  resetForTests();
  const cap = config.rateLimit.userPerMin;

  for (let i = 0; i < cap; i += 1) enforceVoiceToolRateLimit("voice-user", "search_emails");
  assert.throws(() => enforceVoiceToolRateLimit("voice-user", "search_emails"), { status: 429 });

  // A different category has an independent budget, and another user is not
  // affected by the first user's Gmail calls.
  enforceVoiceToolRateLimit("voice-user", "remember");
  enforceVoiceToolRateLimit("other-user", "search_emails");
});
