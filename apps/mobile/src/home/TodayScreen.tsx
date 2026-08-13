/**
 * Today — the home screen, and the answer to what EVE actually is.
 *
 * The reference this design follows makes "talk to the AI" the whole product.
 * That is deliberately not what this screen does. EVE's differentiator is that
 * she has already read the mail, ranked it, drafted the replies, and noticed the
 * meeting you haven't prepared for — so the home screen leads with findings.
 *
 * It holds one question: what needs me today? Everything that answers that is
 * here — the counters, the drafts waiting on approval, EVE's flags, the next
 * meeting. Everything that does not has moved to where it belongs: the full
 * inbox and the task list to Briefing, what EVE knows to the avatar menu, the
 * receipts to Activity. Four destinations on the nav bar and a menu behind the
 * avatar mean nothing on this page has to double as a launcher.
 *
 * Sections collapse to nothing when empty, so a quiet day is a short calm
 * screen rather than a column of empty headings.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";

import { VoiceDock } from "./VoiceDock";
import { StatStrip } from "./StatStrip";
import { TodayHeader } from "./TodayHeader";
import { displayName, type DayContext } from "./greeting";
import { fetchInbox, markThought } from "../proactive/api";
import {
  AttentionCard,
  CalendarCard,
  NextUpCard,
  Section,
  SuggestionCard,
} from "../ui/components";
import { spacing } from "../ui/theme";
import type {
  Briefing,
  BriefingEmail,
  CalendarEvent,
  EmailStatus,
  ProactiveThought,
} from "../types";

type Props = {
  briefing: Briefing;
  /** Google's display name, when there is one. */
  name?: string | null;
  /** Falls back to the mailbox for the greeting when there's no name. */
  email: string | null;
  photoURL?: string | null;
  /** True while an email action is in flight, from App.tsx. */
  saving: boolean;
  /** Whether the always-on ask dock is switched on in settings. */
  askEnabled?: boolean;
  /** Full-screen voice owns the microphone while its modal is open. */
  voiceActive?: boolean;
  onEmailAction: (emailId: string, status: EmailStatus) => void;
  onOpenEmail?: (email: BriefingEmail) => void;
  /** Opens the avatar menu — settings, account, what EVE knows. */
  onOpenMenu?: () => void;
  onOpenChat?: () => void;
  onOpenVoice?: () => void;
  /**
   * Scrolls the page, which App.tsx owns. The header bell uses it to jump to
   * whatever is waiting — there is no separate notifications screen, because
   * the notifications are already on this page.
   */
  onScrollTo?: (y: number) => void;
  onError: (message: string) => void;
};

export function TodayScreen({
  briefing,
  name,
  email,
  photoURL,
  saving,
  askEnabled = false,
  voiceActive = false,
  onEmailAction,
  onOpenEmail,
  onOpenMenu,
  onOpenChat,
  onOpenVoice,
  onScrollTo,
  onError,
}: Props) {
  // Where the header bell scrolls to. Measured rather than computed, because
  // the section above collapses when empty and its height isn't knowable here.
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const [thoughts, setThoughts] = useState<ProactiveThought[]>([]);
  const [thoughtsLoading, setThoughtsLoading] = useState(true);

  const load = useCallback(async () => {
    setThoughtsLoading(true);
    try {
      const inbox = await fetchInbox({ status: "new", limit: 20 });
      setThoughts(inbox.thoughts);
    } catch (error) {
      onError(describe(error, "Could not load EVE's suggestions"));
    } finally {
      setThoughtsLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = useMemo(
    () =>
      briefing.emails
        .filter((item) => item.status === "pending")
        .slice()
        .sort((a, b) => b.urgencyScore - a.urgencyScore),
    [briefing.emails],
  );

  const { nextUp, laterToday } = useMemo(() => splitCalendar(briefing.calendar), [briefing.calendar]);

  const measure = useCallback(
    (key: string) => (event: LayoutChangeEvent) => {
      const { y } = event.nativeEvent.layout;
      setOffsets((current) => (current[key] === y ? current : { ...current, [key]: y }));
    },
    [],
  );

  // Whichever decision section is actually on screen, topmost first.
  const alertTarget =
    pending.length > 0 ? offsets.attention : thoughts.length > 0 ? offsets.suggestions : null;

  const context: DayContext = {
    loading: thoughtsLoading && briefing.emails.length === 0,
    pendingCount: pending.length,
    suggestionCount: thoughts.length,
    meetingsToday: briefing.stats.meetingsToday,
    emailCount: briefing.emails.length,
  };

  async function dismissThought(thought: ProactiveThought) {
    setThoughts((current) => current.filter((item) => item.id !== thought.id));
    try {
      await markThought(thought.id, { status: "dismissed", feedback: "not_now" });
    } catch (error) {
      // Put it back. A suggestion that silently vanished without being recorded
      // would come back on the next load anyway, which is more confusing.
      setThoughts((current) => [thought, ...current]);
      onError(describe(error, "Could not dismiss that"));
    }
  }

  async function markHelpful(thought: ProactiveThought) {
    setThoughts((current) =>
      current.map((item) => (item.id === thought.id ? { ...item, feedback: "helpful" } : item)),
    );
    try {
      await markThought(thought.id, { status: "seen", feedback: "helpful" });
    } catch (error) {
      setThoughts((current) => current.map((item) => (item.id === thought.id ? thought : item)));
      onError(describe(error, "Could not save that"));
    }
  }

  return (
    <View style={styles.screen}>
      <TodayHeader
        name={name || displayName({ email })}
        email={email}
        photoURL={photoURL}
        context={context}
        // Everything waiting on a decision, not just suggestions — a bell that
        // reads 0 with seven drafts pending would be lying about the same screen.
        alertCount={pending.length + thoughts.length}
        onPressAvatar={onOpenMenu}
        onPressAlerts={onScrollTo ? () => onScrollTo(alertTarget ?? 0) : undefined}
      />

      {/* Sits directly under the greeting when switched on: the microphone is
          open the moment the app opens, without leaving this page. */}
      {askEnabled && !voiceActive ? (
        <View style={styles.ask}>
          <VoiceDock onError={onError} onOpenVoice={onOpenVoice} onOpenChat={onOpenChat} />
        </View>
      ) : null}

      <View style={styles.stats}>
        <StatStrip briefing={briefing} />
      </View>

      <View onLayout={measure("attention")}>
        <Section
          title="Needs attention"
          icon="alert-circle-outline"
          count={pending.length}
          hidden={pending.length === 0}
        >
          {pending.map((item) => (
            <AttentionCard
              key={item.id}
              email={item}
              busy={saving}
              onApprove={() => onEmailAction(item.id, "approved")}
              onReject={() => onEmailAction(item.id, "rejected")}
              onPress={onOpenEmail ? () => onOpenEmail(item) : undefined}
            />
          ))}
        </Section>
      </View>

      <View onLayout={measure("suggestions")}>
        <Section
          title="EVE suggestions"
          icon="sparkles-outline"
          count={thoughts.length}
          hidden={thoughts.length === 0}
        >
          {thoughts.map((thought) => (
            <SuggestionCard
              key={thought.id}
              thought={thought}
              onHelpful={() => void markHelpful(thought)}
              onDismiss={() => void dismissThought(thought)}
            />
          ))}
        </Section>
      </View>

      <View onLayout={measure("calendar")}>
        <Section
          title="Today's calendar"
          icon="calendar-outline"
          count={briefing.calendar.length}
          hidden={briefing.calendar.length === 0}
        >
          {nextUp ? <NextUpCard event={nextUp} /> : null}
          {laterToday.map((event) => (
            <CalendarCard key={event.id} event={event} />
          ))}
        </Section>
      </View>
    </View>
  );
}

/**
 * Splits today's events into the one coming up next and the rest.
 *
 * "Next" means the first event that hasn't ended yet, so a meeting in progress
 * stays the hero rather than being skipped for the one after it. When the day is
 * over, every event falls into the list and there is no hero.
 */
function splitCalendar(events: CalendarEvent[]): {
  nextUp: CalendarEvent | null;
  laterToday: CalendarEvent[];
} {
  const ordered = events
    .slice()
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());

  const now = Date.now();
  const index = ordered.findIndex((event) => {
    const ends = new Date(event.endsAt).getTime();
    return Number.isNaN(ends) ? false : ends >= now;
  });

  if (index === -1) return { nextUp: null, laterToday: ordered };
  return {
    nextUp: ordered[index] ?? null,
    laterToday: ordered.filter((_unused, i) => i !== index),
  };
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  return fallback;
}

const styles = StyleSheet.create({
  screen: { gap: 0 },
  ask: { marginTop: spacing.xl },
  stats: { marginTop: spacing.md },
});
