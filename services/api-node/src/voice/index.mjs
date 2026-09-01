/**
 * Voice transcription via Gemini 2.5 Flash multimodal inline_data.
 *
 * The mobile client records audio (m4a/aac on iOS+Android via expo-audio),
 * base64-encodes it, and POSTs it here. We send a single multimodal call
 * to Gemini asking it to transcribe — the model returns plain text and the
 * caller hands that off to the existing assistant pipeline for tool use
 * and response generation. The same model also acts as the semantic voice
 * gate: only one clear foreground human speaker is accepted. Noise, media,
 * distant conversation, overlapping/group speech, and unintelligible audio
 * are rejected before the assistant sees any text.
 *
 * Split intentionally from the assistant: STT is its own concern with its
 * own failure modes (missing key, oversized audio, codec rejection). We
 * keep the assistant agnostic to whether its input came from a keyboard or
 * a microphone.
 */
import { config } from "../config.mjs";
import { moduleLogger } from "../logger.mjs";
import { httpError } from "../http/responses.mjs";
import { readBoundedResponseJSON } from "../google/oauth.mjs";

const log = moduleLogger("voice");

const MAX_AUDIO_BASE64_BYTES = 1_500_000; // legacy ceiling; config can make it stricter

// Gemini accepts these audio mime types inline. m4a containers are reported
// as audio/mp4 on iOS — we accept that and let Gemini decode.
const ACCEPTED_MIME = new Set([
  "audio/m4a",
  "audio/mp4",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/flac",
]);

/**
 * Inject a custom fetch for testing. Production code uses globalThis.fetch.
 *
 * @type {typeof fetch | null}
 */
let injectedFetch = null;

/**
 * Test seam — pass null to clear.
 *
 * @param {typeof fetch | null} fn
 */
export function __setFetch(fn) {
  injectedFetch = fn;
}

/**
 * Test seam for the gemini config block. When set, overrides config.gemini
 * (which is determined at boot from env). Pass null to clear.
 *
 * @type {{ apiKey: string } | null}
 */
let injectedGemini = null;

/** @param {{ apiKey: string } | null} value */
export function __setGemini(value) {
  injectedGemini = value;
}

/**
 * Transcribe a single audio clip to text. Returns the trimmed transcript or
 * throws an httpError that bubbles to the standard response writer.
 *
 * @param {{ audioBase64: string, mimeType: string }} input
 * @returns {Promise<{
 *   text: string,
 *   accepted: boolean,
 *   rejectionReason: string | null,
 *   durationMs: number,
 *   model: string
 * }>}
 */
export async function transcribeAudio({ audioBase64, mimeType }) {
  const gemini = injectedGemini || config.gemini;
  if (!gemini) {
    throw httpError(503, "voice transcription requires GEMINI_API_KEY");
  }
  if (typeof audioBase64 !== "string" || audioBase64.length === 0) {
    throw httpError(400, "audio is required");
  }
  const maxAudioBytes = Math.min(MAX_AUDIO_BASE64_BYTES, config.voice.maxAudioBytes);
  if (audioBase64.length > maxAudioBytes) {
    throw httpError(413, `audio exceeds ${maxAudioBytes} base64 bytes`);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(audioBase64) || audioBase64.length % 4 === 1) {
    throw httpError(400, "audio must be valid base64");
  }
  const normalizedMime = normalizeMimeType(mimeType);
  if (!ACCEPTED_MIME.has(normalizedMime)) {
    throw httpError(415, `unsupported audio mime type: ${mimeType}`);
  }

  // Pin voice STT to Flash — pro is slower and we don't need its reasoning
  // for raw transcription. Override via GEMINI_VOICE_MODEL if you want to
  // experiment (e.g. flash-lite once it ships for audio).
  const model = process.env.GEMINI_VOICE_MODEL || "gemini-2.5-flash";
  const modelName = model.startsWith("models/") ? model : `models/${model}`;
  const apiKey = gemini.apiKey;
  // Keep the billable credential out of the URL. Google accepts the API key in
  // this header, while query strings are routinely retained by proxies/loggers.
  const url = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent`;

  // This is deliberately stricter than ordinary transcription. Always-on
  // microphones hear televisions, conversations across the room, several
  // people talking at once, and mechanical noise. Those must not become user
  // commands merely because some words can be guessed from them.
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { inline_data: { mime_type: normalizedMime, data: audioBase64 } },
          {
            text: [
              "Judge whether this audio is a valid direct voice command for a personal assistant, then transcribe it.",
              "Accept only when exactly one clear foreground human speaker is close to the microphone and the words are intelligible.",
              "Reject non-speech noise; wind, taps, fans, traffic, and music; TV/radio/device playback; distant or background conversation; overlapping speakers or group speech; whisper/mumble/audio too unclear to transcribe reliably.",
              "Do not reconstruct or guess unclear words. Background voices do not count as the user even if a sentence is partly understandable.",
              'Return JSON only: {"accepted":boolean,"text":string,"reason":"clear_foreground_speech|non_speech_noise|media_audio|background_speech|multiple_speakers|unintelligible"}.',
              "When rejected, text must be an empty string.",
            ].join(" "),
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 200,
      responseMimeType: "application/json",
    },
  };

  const startedAt = Date.now();
  const fetchImpl = injectedFetch || globalThis.fetch;
  /** @type {Response} */
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      signal: AbortSignal.timeout(config.outboundTimeoutMs),
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
  } catch (error) {
    log.warn({ err: error }, "gemini transcription transport failed");
    throw httpError(502, "voice transcription service unavailable");
  }

  /** @type {any} */
  let payload = null;
  try {
    payload = await readBoundedResponseJSON(response, config.googleResponseMaxBytes);
  } catch {
    throw httpError(502, "voice transcription returned an invalid response");
  }

  if (!response.ok) {
    const reason = payload?.error?.message || `gemini error (${response.status})`;
    log.warn({ status: response.status, reason }, "gemini transcription rejected");
    throw httpError(502, `voice transcription failed: ${reason}`);
  }

  const rawText = (payload.candidates || [])
    .flatMap((/** @type {any} */ c) => c.content?.parts || [])
    .map((/** @type {any} */ p) => p.text || "")
    .join("\n")
    .trim();
  const verdict = parseVoiceVerdict(rawText);

  return {
    text: verdict.accepted ? verdict.text : "",
    accepted: verdict.accepted,
    rejectionReason: verdict.accepted ? null : verdict.reason,
    durationMs: Date.now() - startedAt,
    model,
  };
}

const REJECTION_REASONS = new Set([
  "non_speech_noise",
  "media_audio",
  "background_speech",
  "multiple_speakers",
  "unintelligible",
]);

/**
 * Parse the structured voice-quality verdict. The quality gate is security
 * sensitive, so a model response that is not valid JSON is rejected rather than
 * treated as an implicit approval.
 *
 * @param {string} raw
 */
function parseVoiceVerdict(raw) {
  if (!raw) return { accepted: false, text: "", reason: "unintelligible" };
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    const accepted = parsed?.accepted === true;
    const text = typeof parsed?.text === "string" ? parsed.text.trim() : "";
    if (accepted && text) {
      return { accepted: true, text, reason: "clear_foreground_speech" };
    }
    const reason = REJECTION_REASONS.has(parsed?.reason) ? parsed.reason : "unintelligible";
    return { accepted: false, text: "", reason };
  } catch {
    return { accepted: false, text: "", reason: "unintelligible" };
  }
}

/**
 * @param {unknown} value
 */
function normalizeMimeType(value) {
  if (typeof value !== "string") return "";
  // Drop any ;codecs=... suffix and lowercase
  return value.toLowerCase().split(";")[0].trim();
}
