/**
 * fetch() wrapper that retries transient Gemini failures.
 *
 * Gemini returns 503 ("high demand … temporary") and 429 under load; a single
 * blip would otherwise drop a whole voice utterance or briefing. Retries a few
 * times with short backoff before giving up. Non-transient errors (4xx other
 * than 429) return immediately for the caller to handle.
 */
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const DELAYS_MS = [400, 1200, 2500];

export async function geminiFetch(url: string, init: RequestInit): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt <= DELAYS_MS.length; attempt++) {
    const res = await fetch(url, init);
    if (res.ok || !TRANSIENT.has(res.status)) return res;
    last = res;
    if (attempt < DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, DELAYS_MS[attempt]));
    }
  }
  return last as Response;
}
