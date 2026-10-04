/**
 * Local email urgency scoring
 *
 * Ports the logic from services/api-node/src/briefing/scoring.mjs
 */

/**
 * Compute urgency score (0-100) for a message using local heuristics.
 * This runs before LLM analysis as the baseline score.
 */
export function urgencyScore(message: any): number {
  let score = 50; // baseline

  // Extract headers
  const headers = message.payload?.headers || [];
  const getHeader = (name: string) => {
    const header = headers.find(
      (h: any) => h.name.toLowerCase() === name.toLowerCase(),
    );
    return header?.value || "";
  };

  const subject = getHeader("subject").toLowerCase();
  const from = getHeader("from").toLowerCase();
  const to = getHeader("to").toLowerCase();

  // High-urgency keywords in subject
  const urgentKeywords = [
    "urgent",
    "asap",
    "immediate",
    "critical",
    "deadline",
    "action required",
    "important",
  ];
  if (urgentKeywords.some((kw) => subject.includes(kw))) {
    score += 20;
  }

  // Direct mentions ("to me" vs "cc'd")
  if (to && !to.includes("@")) {
    score += 10; // directly addressed
  }

  // Reply or forward
  if (subject.startsWith("re:") || subject.startsWith("fwd:")) {
    score += 5;
  }

  // Known low-priority patterns
  const lowPriorityKeywords = [
    "newsletter",
    "unsubscribe",
    "marketing",
    "promotional",
    "no-reply",
    "noreply",
  ];
  if (lowPriorityKeywords.some((kw) => subject.includes(kw) || from.includes(kw))) {
    score -= 30;
  }

  // Automated senders
  if (from.includes("no-reply") || from.includes("noreply")) {
    score -= 20;
  }

  // Clamp to [0, 100]
  return Math.max(0, Math.min(100, score));
}
