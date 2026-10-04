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
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { VoiceDock } from "./VoiceDock";
import { StatStrip } from "./StatStrip";
import { TodayHeader } from "./TodayHeader";
import { displayName, type DayContext } from "./greeting";
import { fetchInbox, markThought } from "../proactive/api";
import { AttentionCard, CalendarCard, GradientButton, NextUpCard, Section, SuggestionCard } from "../ui/components";
import { spacing } from "../ui/theme";
import { useTheme } from "../ui/ThemeContext";
import type { Briefing, BriefingEmail, CalendarEvent, EmailStatus, ProactiveThought } from "../types";

type Props = {
  briefing: Briefing;
  /** Google's display name, when there is one. */
  name?: string | null;
  /** Falls back to the mailbox for the greeting when there's no name. */
  email: string | null;
  photoURL?: string | null;
  /** True once the user has connected Gmail (drives the simple-vs-full UX). */
  gmailConnected?: boolean;
  /** Kicks off the Gmail connect flow from the simple-mode prompt. */
  onConnectGmail?: () => void;
  /** Opens the full Email insights screen (Gmail users). */
  onOpenInsights?: () => void;
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
  gmailConnected = true,
  onConnectGmail,
  onOpenInsights,
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
  const { palette } = useTheme();
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

      {/* EVE's assist card — the signature element from the new design. When
          there's something waiting, EVE offers to take it on; tapping opens the
          conversation. Hidden when there's nothing to act on. */}
      {pending.length + thoughts.length > 0 ? (
        <Pressable
          onPress={onOpenChat}
          style={[styles.assist, { backgroundColor: palette.primaryTint, borderColor: palette.primary }]}
          accessibilityRole="button"
          accessibilityLabel="Ask EVE to help with today's items"
        >
          <View style={[styles.assistOrb, { backgroundColor: palette.primary }]}>
            <Ionicons name="sparkles" size={16} color={palette.onPrimary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.assistTitle, { color: palette.text }]}>EVE</Text>
            <Text style={[styles.assistBody, { color: palette.textMuted }]}>
              You have {pending.length + thoughts.length} thing
              {pending.length + thoughts.length > 1 ? "s" : ""} that need you today. Shall I help with them?
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={palette.primary} />
        </Pressable>
      ) : null}
      {/* Sits directly under the greeting when switched on: the microphone is
          open the moment the app opens, without leaving this page. */}
      {askEnabled && !voiceActive ? (
        <View style={styles.ask}>
          <VoiceDock onError={onError} onOpenVoice={onOpenVoice} onOpenChat={onOpenChat} />
        </View>
      ) : null}

      {gmailConnected ? (
        <View style={styles.stats}>
          <StatStrip briefing={briefing} />
          <Pressable
            onPress={onOpenInsights}
            style={styles.insightsLink}
            accessibilityRole="button"
            accessibilityLabel="Open email insights"
          >
            <Ionicons name="mail-outline" size={16} color={palette.primary} />
            <Text style={[styles.insightsText, { color: palette.primary }]}>Email insights</Text>
            <Ionicons name="chevron-forward" size={15} color={palette.primary} />
          </Pressable>
        </View>
      ) : null}

      {/* Simple mode: EVE works without Gmail (chat, notification triage,
          tasks). Connecting Gmail unlocks briefings, drafts and email triage. */}
      <Section
        title="Connect Gmail"
        subtitle="EVE is running in simple mode. Connect Gmail to get inbox briefings, smart reply drafts, and email prioritization."
        icon="mail-outline"
        hidden={gmailConnected}
      >
        <View style={styles.connect}>
          <GradientButton label="Connect Gmail" icon="logo-google" onPress={() => onConnectGmail?.()} />
        </View>
      </Section>

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
  assist: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginTop: spacing.lg,
    padding: spacing.lg,
    borderRadius: 18,
    borderWidth: 1,
  },
  assistOrb: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  assistTitle: { fontSize: 13, fontWeight: "800" },
  assistBody: { fontSize: 14, fontWeight: "500", lineHeight: 20, marginTop: 2 },
  insightsLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    marginTop: spacing.md,
    paddingVertical: spacing.xs,
  },
  insightsText: { fontSize: 14, fontWeight: "700" },
  connect: { marginTop: spacing.sm, alignItems: "flex-start" },
});
