/**
 * Typed client for voice transcription.
 *
 * Calls the Convex `voice.transcribe` action (not a raw HTTP fetch) so the
 * Convex auth session travels with the request automatically. The old raw
 * fetch hit the wrong host (.cloud instead of the .site HTTP-actions domain)
 * with no auth header and failed with 502/401.
 */
import { convex, api } from "../api/convexApi";

export type TranscribeResult = {
  text: string;
  accepted: boolean;
  rejectionReason: string | null;
  durationMs: number;
  model: string;
};

export async function transcribeAudio(input: {
  audio: string; // base64
  mimeType: string;
}): Promise<TranscribeResult> {
  return (await convex.action(api.voice.transcribe, {
    audio: input.audio,
    mimeType: input.mimeType,
  })) as TranscribeResult;
}
