/**
 * Tests for the voice transcription module.
 *
 * The Gemini fetch is mocked via the __setFetch / __setGemini seams so we
 * don't make real network calls. We cover the input-validation paths
 * (missing audio, oversized, unsupported mime), the happy path, and the
 * transport / non-OK / empty-response failure modes — all reasons the
 * mobile client might receive a non-200 from this endpoint.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { transcribeAudio, __setFetch, __setGemini } from "../src/voice/index.mjs";

const TINY_AUDIO_B64 = "AAAA"; // 4 chars — irrelevant content, fetch is mocked

afterEach(() => {
  __setFetch(null);
  __setGemini(null);
});

function mockGeminiOK(text = "hello world") {
  __setFetch(async () => {
    return /** @type {any} */ ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text }] } }],
      }),
    });
  });
}

/** @param {unknown} verdict */
function mockGeminiVerdict(verdict) {
  mockGeminiOK(JSON.stringify(verdict));
}

test("transcribeAudio returns 503 when GEMINI_API_KEY is not configured", async () => {
  __setGemini(null); // explicit, in case config has a real key
  // Clear the underlying config seam — we test the env-unconfigured path
  // by leaving injectedGemini null AND assuming the test env has no key.
  // If a key IS present in the env, this test is meaningless — skip in
  // that case via a guard:
  const { config } = await import("../src/config.mjs");
  if (config.gemini) {
    return; // env has a key; the 503 path is unreachable
  }
  await assert.rejects(() => transcribeAudio({ audioBase64: TINY_AUDIO_B64, mimeType: "audio/mp4" }), {
    status: 503,
  });
});

test("transcribeAudio rejects empty audio", async () => {
  __setGemini({ apiKey: "test-key" });
  await assert.rejects(() => transcribeAudio({ audioBase64: "", mimeType: "audio/mp4" }), { status: 400 });
});

test("transcribeAudio rejects oversized audio (413)", async () => {
  __setGemini({ apiKey: "test-key" });
  const oversize = "A".repeat(1_500_001);
  await assert.rejects(() => transcribeAudio({ audioBase64: oversize, mimeType: "audio/mp4" }), {
    status: 413,
  });
});

test("transcribeAudio rejects unsupported mime type (415)", async () => {
  __setGemini({ apiKey: "test-key" });
  await assert.rejects(() => transcribeAudio({ audioBase64: TINY_AUDIO_B64, mimeType: "video/mp4" }), {
    status: 415,
  });
});

test("transcribeAudio normalizes ';codecs=...' suffix on mime type", async () => {
  __setGemini({ apiKey: "test-key" });
  mockGeminiVerdict({ accepted: true, text: "ok", reason: "clear_foreground_speech" });
  const result = await transcribeAudio({
    audioBase64: TINY_AUDIO_B64,
    mimeType: "audio/mp4;codecs=mp4a.40.2",
  });
  assert.equal(result.text, "ok");
  assert.equal(result.accepted, true);
});

test("transcribeAudio returns trimmed transcript on success", async () => {
  __setGemini({ apiKey: "test-key" });
  mockGeminiVerdict({ accepted: true, text: "  Hello world  \n", reason: "clear_foreground_speech" });
  const result = await transcribeAudio({
    audioBase64: TINY_AUDIO_B64,
    mimeType: "audio/mp4",
  });
  assert.equal(result.text, "Hello world");
  assert.equal(result.accepted, true);
  assert.equal(result.rejectionReason, null);
  assert.ok(result.durationMs >= 0);
  assert.ok(result.model.length > 0);
});

test("transcribeAudio keeps the Gemini API key out of the request URL", async () => {
  __setGemini({ apiKey: "secret-test-key" });
  let requestURL = "";
  /** @type {any} */
  let requestInit = null;
  __setFetch(async (url, init) => {
    requestURL = String(url);
    requestInit = init;
    return /** @type {any} */ ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({ accepted: true, text: "hello", reason: "clear_foreground_speech" }),
                },
              ],
            },
          },
        ],
      }),
    });
  });

  await transcribeAudio({ audioBase64: TINY_AUDIO_B64, mimeType: "audio/mp4" });
  assert.equal(requestURL.includes("secret-test-key"), false);
  assert.equal(requestURL.includes("?key="), false);
  assert.equal(requestInit?.headers?.["x-goog-api-key"], "secret-test-key");
});

test("transcribeAudio returns empty string for silent audio (model returns nothing)", async () => {
  __setGemini({ apiKey: "test-key" });
  mockGeminiOK("");
  const result = await transcribeAudio({
    audioBase64: TINY_AUDIO_B64,
    mimeType: "audio/mp4",
  });
  assert.equal(result.text, "");
  assert.equal(result.accepted, false);
  assert.equal(result.rejectionReason, "unintelligible");
});

test("transcribeAudio accepts one clear foreground speaker", async () => {
  __setGemini({ apiKey: "test-key" });
  mockGeminiVerdict({
    accepted: true,
    text: "What's on my calendar?",
    reason: "clear_foreground_speech",
  });
  const result = await transcribeAudio({
    audioBase64: TINY_AUDIO_B64,
    mimeType: "audio/mp4",
  });
  assert.equal(result.accepted, true);
  assert.equal(result.text, "What's on my calendar?");
  assert.equal(result.rejectionReason, null);
});

test("transcribeAudio rejects overlapping group speech", async () => {
  __setGemini({ apiKey: "test-key" });
  mockGeminiVerdict({
    accepted: false,
    text: "someone said calendar",
    reason: "multiple_speakers",
  });
  const result = await transcribeAudio({
    audioBase64: TINY_AUDIO_B64,
    mimeType: "audio/mp4",
  });
  assert.equal(result.accepted, false);
  assert.equal(result.text, "");
  assert.equal(result.rejectionReason, "multiple_speakers");
});

test("transcribeAudio rejects distant background conversation", async () => {
  __setGemini({ apiKey: "test-key" });
  mockGeminiVerdict({
    accepted: false,
    text: "",
    reason: "background_speech",
  });
  const result = await transcribeAudio({
    audioBase64: TINY_AUDIO_B64,
    mimeType: "audio/mp4",
  });
  assert.equal(result.accepted, false);
  assert.equal(result.rejectionReason, "background_speech");
});

test("transcribeAudio rejects malformed JSON-like verdicts", async () => {
  __setGemini({ apiKey: "test-key" });
  mockGeminiOK('{"accepted": true');
  const result = await transcribeAudio({
    audioBase64: TINY_AUDIO_B64,
    mimeType: "audio/mp4",
  });
  assert.equal(result.accepted, false);
  assert.equal(result.text, "");
});

test("transcribeAudio surfaces a 502 when Gemini returns a non-OK response", async () => {
  __setGemini({ apiKey: "test-key" });
  __setFetch(
    async () =>
      /** @type {any} */ ({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: "audio too short" } }),
      }),
  );
  await assert.rejects(
    () =>
      transcribeAudio({
        audioBase64: TINY_AUDIO_B64,
        mimeType: "audio/mp4",
      }),
    { status: 502, message: /audio too short/ },
  );
});

test("transcribeAudio surfaces a 502 when the fetch transport throws", async () => {
  __setGemini({ apiKey: "test-key" });
  __setFetch(async () => {
    throw new Error("network down");
  });
  await assert.rejects(
    () =>
      transcribeAudio({
        audioBase64: TINY_AUDIO_B64,
        mimeType: "audio/mp4",
      }),
    { status: 502 },
  );
});

test("transcribeAudio surfaces a 502 when Gemini returns invalid JSON", async () => {
  __setGemini({ apiKey: "test-key" });
  __setFetch(
    async () =>
      /** @type {any} */ ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("not json");
        },
      }),
  );
  await assert.rejects(
    () =>
      transcribeAudio({
        audioBase64: TINY_AUDIO_B64,
        mimeType: "audio/mp4",
      }),
    { status: 502 },
  );
});

test("transcribeAudio rejects a non-JSON model verdict", async () => {
  __setGemini({ apiKey: "test-key" });
  mockGeminiOK("hello world");
  const result = await transcribeAudio({ audioBase64: TINY_AUDIO_B64, mimeType: "audio/mp4" });
  assert.equal(result.accepted, false);
  assert.equal(result.rejectionReason, "unintelligible");
});
