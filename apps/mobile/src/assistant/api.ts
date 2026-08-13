/**
 * Typed client for /v1/assistant/ask.
 *
 * The endpoint answers in one shot and may report a tool it ran on the way —
 * `action` names it, `result` carries whatever the tool returned. The chat
 * screen renders that as a card so an answer that *did something* is visually
 * distinct from an answer that merely said something. That distinction matters
 * in an app whose core promise is that it never acts without you knowing.
 */
import { apiFetch } from "../api/client";
import type { AssistantAnswer } from "../types";

export async function askAssistant(prompt: string): Promise<AssistantAnswer> {
  return apiFetch<AssistantAnswer>("/v1/assistant/ask", {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });
}
