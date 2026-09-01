import { test } from "node:test";
import assert from "node:assert/strict";

import { GeminiLiveSession } from "../src/voice/live.mjs";

test("Gemini Live ignores malformed provider frame shapes", () => {
  const session = new GeminiLiveSession({ apiKey: "test-key", userID: "user-live" });
  assert.doesNotThrow(() => session.handleServerMessage(null));
  assert.doesNotThrow(() => session.handleServerMessage([]));
  assert.doesNotThrow(() =>
    session.handleServerMessage({
      server_content: {
        model_turn: { parts: [null, [], { text: 42 }, { inline_data: { data: 42 } }] },
        input_transcription: { text: 42 },
        output_transcription: { text: 42 },
      },
    }),
  );
});

test("Gemini Live tool dispatch contains non-Error failures", async () => {
  const session = new GeminiLiveSession({
    apiKey: "test-key",
    userID: "user-live",
    onToolCall: async () => {
      throw {
        toString() {
          throw new Error("coercion failed");
        },
      };
    },
  });
  /** @type {Array<{ id?: string, name?: string, result?: { error?: string } }>} */
  const results = [];
  session.on("toolCallResult", (payload) => results.push(payload));
  await assert.doesNotReject(() =>
    session.handleToolCall({ function_calls: [{ id: "call-1", name: "remember", args: {} }] }),
  );
  assert.equal(results.length, 1);
  const firstResult = results[0];
  assert.ok(firstResult);
  assert.equal(firstResult.result?.error, "tool dispatch failed");
});
