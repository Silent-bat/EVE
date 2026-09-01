/**
 * The words at the top of the home screen.
 *
 * Two parts: a time-aware salutation, and a line that says something true about
 * the day. The second part is the one that earns its place. "How can I help?"
 * is what every assistant opens with, and it hands the work straight back to
 * the person reading it. Leading with what EVE already found — "3 replies are
 * waiting on you" — is the difference between a chat box and an assistant.
 *
 * Kept free of React so the phrasing can be reasoned about on its own.
 */

export function salutation(now: Date = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 22) return "Good evening";
  return "Winding down";
}

export type DayContext = {
  loading: boolean;
  pendingCount: number;
  suggestionCount: number;
  meetingsToday: number;
  /** Total ranked mail in the briefing, pending or not. */
  emailCount: number;
};

/**
 * One sentence about the state of the day, in priority order: things needing a
 * decision first, then things worth knowing, then the quiet case.
 *
 * Only ever mentions two facts. A greeting that lists four numbers is a report,
 * and the sections below it are already the report.
 */
export function contextLine(ctx: DayContext): string {
  if (ctx.loading) return "Catching up on your day…";

  const facts: string[] = [];

  if (ctx.pendingCount > 0) {
    facts.push(
      ctx.pendingCount === 1
        ? "one reply is waiting on you"
        : `${ctx.pendingCount} replies are waiting on you`,
    );
  }

  if (ctx.meetingsToday > 0) {
    facts.push(ctx.meetingsToday === 1 ? "one meeting today" : `${ctx.meetingsToday} meetings today`);
  }

  if (facts.length < 2 && ctx.suggestionCount > 0) {
    facts.push(
      ctx.suggestionCount === 1
        ? "one thing EVE wants to flag"
        : `${ctx.suggestionCount} things EVE wants to flag`,
    );
  }

  if (facts.length === 0) {
    // Nothing pending is a result, not an absence of one. Say so plainly rather
    // than falling back to a prompt — the calm state is the product working.
    return ctx.emailCount > 0
      ? "You're all caught up. Nothing needs a decision."
      : "Nothing needs you yet. EVE is watching your inbox.";
  }

  const [first, second] = facts;
  if (!first) return "Nothing needs you yet.";
  const sentence = second ? `${first}, and ${second}` : first;
  return capitalize(sentence) + ".";
}

/** First name only, for the header. Falls back to the mailbox before the @. */
export function displayName(input: { name?: string | null; email?: string | null }): string {
  const name = (input.name ?? "").trim();
  if (name) {
    const firstWord = name.split(/\s+/)[0];
    if (firstWord) return capitalize(firstWord);
  }

  const local = (input.email ?? "").split("@")[0]?.trim() ?? "";
  if (!local) return "there";
  // Mailbox names are usually delimited rather than spaced: ada.lovelace,
  // ada_lovelace, ada-lovelace all become "Ada".
  const first = local.split(/[._-]+/)[0];
  return first ? capitalize(first) : "there";
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}
