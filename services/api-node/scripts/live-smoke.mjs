/**
 * Smoke test the /v1/voice/live WebSocket bridge end-to-end.
 *
 * Creates a session for the configured Google user, opens the WS, sends
 * a text turn (we skip audio for this smoke test — proves the brain
 * works without needing PCM input), and prints every message Gemini
 * streams back. Exits after the model says turn-complete.
 *
 * Usage:
 *   USER_ID=020adc15-... node /tmp/eve-live-smoke.mjs "what's on my calendar today?"
 */
import { WebSocket } from "ws";
import { initialize } from "/Users/kanafranklin/Desktop/project EVE/services/api-node/src/storage/index.mjs";
import { createSession } from "/Users/kanafranklin/Desktop/project EVE/services/api-node/src/auth/index.mjs";

const USER_ID = process.env.USER_ID || "020adc15-b49d-4c2b-bd8f-2749dea9d67e";
const PROMPT = process.argv[2] || "Hello EVE, can you hear me? Reply briefly in one sentence.";
const URL_BASE = process.env.EVE_API_URL || "ws://127.0.0.1:8080";

await initialize();
const token = await createSession(USER_ID);
const url = `${URL_BASE}/v1/voice/live?token=${encodeURIComponent(token)}`;
console.log("connecting", url.replace(token, "<redacted>"));

const ws = new WebSocket(url);
let audioFrames = 0;
let outputText = "";

ws.on("open", () => {
  console.log("[client] ws open");
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  switch (msg.type) {
    case "ready":
      console.log("[gemini] ready — sending prompt:", JSON.stringify(PROMPT));
      ws.send(JSON.stringify({ type: "text", text: PROMPT }));
      break;
    case "audio":
      audioFrames += 1;
      if (audioFrames === 1) console.log("[gemini] first audio frame received");
      break;
    case "input-transcript":
      console.log("[input-transcript]", JSON.stringify(msg.text));
      break;
    case "output-transcript":
      outputText += msg.text || "";
      process.stdout.write(msg.text || "");
      break;
    case "turn-complete":
      console.log(`\n[gemini] turn complete. audio frames: ${audioFrames}, text: ${outputText.length} chars`);
      ws.close();
      break;
    case "tool-call":
      console.log("[tool-call]", msg.name, "→", JSON.stringify(msg.result).slice(0, 200));
      break;
    case "error":
      console.error("[error]", msg.message);
      break;
    default:
      console.log("[other]", msg);
  }
});

ws.on("close", (code, reasonBuf) => {
  console.log("[client] closed", code, reasonBuf?.toString?.());
  process.exit(0);
});

ws.on("error", (err) => {
  console.error("[client] ws error", err.message);
  process.exit(1);
});

// Hard timeout — if Gemini never sends turn-complete in 30s, bail.
setTimeout(() => {
  console.error("[smoke] timed out after 30s");
  process.exit(2);
}, 30_000);
