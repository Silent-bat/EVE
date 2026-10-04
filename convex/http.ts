/**
 * HTTP endpoints for Convex
 *
 * Provides HTTP routes that the mobile app calls.
 * Replaces services/api-node/server.mjs routes.
 */
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { auth } from "./auth";
import { geminiFetch } from "./lib/geminiFetch";

const http = httpRouter();

/**
 * POST /v1/voice/transcribe
 *
 * Transcribe audio to text using Gemini.
 */
http.route({
  path: "/v1/voice/transcribe",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await request.json();
    const { audio, mimeType } = body;

    if (!audio || !mimeType) {
      return new Response(JSON.stringify({ error: "Missing audio or mimeType" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await transcribeAudio({
      audioBase64: audio,
      mimeType,
    });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

/**
 * POST /v1/device-notifications
 *
 * The native Android NotificationListenerService posts captured notifications
 * here directly (bearer auth in the header). Records + schedules AI triage.
 */
http.route({
  path: "/v1/device-notifications",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    // The native payload is the notification itself ({id, packageName, appName,
    // title, body, postedAt}); accept either that or a { notification } wrapper.
    const notification = body?.notification ?? body;
    await ctx.runMutation(api.notifications.recordDeviceNotification, { notification });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

/**
 * POST /v1/briefing/generate
 *
 * Generate or refresh a user's briefing.
 */
http.route({
  path: "/v1/briefing/generate",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await request.json();
    const { range = "day" } = body;

    const briefing = await ctx.runAction(api.briefings.generateBriefing, {
      range,
    });

    return new Response(JSON.stringify(briefing), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

/**
 * GET /v1/briefing/today
 *
 * Get today's cached briefing.
 */
http.route({
  path: "/v1/briefing/today",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const url = new URL(request.url);
    const range = url.searchParams.get("range") || "day";

    const briefing = await ctx.runQuery(api.briefings.getTodayBriefing, {
      range: range as "day" | "week" | "month",
    });

    return new Response(JSON.stringify(briefing || {}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// Serves /.well-known/openid-configuration and /.well-known/jwks.json
// so Convex can verify the JWTs issued by auth:signIn.
auth.addHttpRoutes(http);

export default http;

// --- Helper functions ---

const MAX_AUDIO_BASE64_BYTES = 1_500_000;
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

interface TranscribeResult {
  text: string;
  accepted: boolean;
  rejectionReason: string | null;
  durationMs: number;
  model: string;
}

export async function transcribeAudio({
  audioBase64,
  mimeType,
}: {
  audioBase64: string;
  mimeType: string;
}): Promise<TranscribeResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("voice transcription requires GEMINI_API_KEY");
  }

  if (!audioBase64 || audioBase64.length === 0) {
    throw new Error("audio is required");
  }

  if (audioBase64.length > MAX_AUDIO_BASE64_BYTES) {
    throw new Error(`audio exceeds ${MAX_AUDIO_BASE64_BYTES} base64 bytes`);
  }

  const mimePart = mimeType.toLowerCase().split(";")[0];
  const normalizedMime = (mimePart ?? "").trim();
  if (!ACCEPTED_MIME.has(normalizedMime)) {
    throw new Error(`unsupported audio mime type: ${mimeType}`);
  }

  // gemini-3.6-flash is Google's named replacement for the retired
  // gemini-2.5-flash (which now 404s). Pinned explicitly.
  const model = process.env.GEMINI_VOICE_MODEL || "gemini-3.6-flash";
  const modelName = model.startsWith("models/") ? model : `models/${model}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent`;

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
  const response = await geminiFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${text}`);
  }

  const payload = await response.json();
  const rawText = (payload.candidates || [])
    .flatMap((c: any) => c.content?.parts || [])
    .map((p: any) => p.text || "")
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

function parseVoiceVerdict(raw: string): {
  accepted: boolean;
  text: string;
  reason: string;
} {
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

    const reason = REJECTION_REASONS.has(parsed?.reason)
      ? parsed.reason
      : "unintelligible";
    return { accepted: false, text: "", reason };
  } catch {
    return { accepted: false, text: "", reason: "unintelligible" };
  }
}
