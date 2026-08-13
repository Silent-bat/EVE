/**
 * Typed client for reading one whole email.
 *
 * The briefing carries summaries only — EVE's one-line read of a thread, not
 * the thread. Tapping a row is a request for the actual message, so it is
 * fetched here on demand and never cached: mail changes, and a stale body is
 * worse than a short wait.
 */
import { apiFetch } from "../api/client";
import type { EmailBody } from "../types";

export async function fetchEmailBody(emailID: string): Promise<EmailBody> {
  return apiFetch<EmailBody>(`/v1/emails/${encodeURIComponent(emailID)}/body`);
}
