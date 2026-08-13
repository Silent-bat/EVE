/**
 * Typed client for the /v1/voice/* endpoints.
 */
import { apiFetch } from "../api/client";

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
  return apiFetch<TranscribeResult>("/v1/voice/transcribe", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
