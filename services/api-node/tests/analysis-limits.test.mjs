import assert from "node:assert/strict";
import { test } from "node:test";

import { config } from "../src/config.mjs";
import { buildAnalysisPrompt } from "../src/briefing/analysis.mjs";

test("analysis prompt stays below its configured limit and keeps valid JSON", () => {
  const scored = Array.from({ length: 160 }, (_, index) => ({
    score: 60,
    message: {
      senderName: `Sender ${index}`,
      senderEmail: `sender-${index}@example.com`,
      subject: "Subject ".concat("x".repeat(900)),
      body: "Body ".concat("y".repeat(20_000)),
      receivedAtHour: 9,
      receivedAtMinute: 30,
    },
  }));

  const prompt = buildAnalysisPrompt(scored, {
    profileBlock: "profile ".repeat(5_000),
    memoryFacts: Array.from({ length: 200 }, () => "memory fact ".repeat(100)),
  });

  assert.ok(prompt.length <= config.geminiPromptMaxChars);
  const marker = "Emails JSON:\n";
  const jsonStart = prompt.lastIndexOf(marker);
  assert.ok(jsonStart >= 0, "prompt must include the email payload");
  assert.doesNotThrow(() => JSON.parse(prompt.slice(jsonStart + marker.length)));
});
