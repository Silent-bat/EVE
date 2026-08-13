/**
 * Calendar cards.
 *
 * `CalendarCard` is a single event. `NextUpCard` is the one event that matters
 * right now, shown larger at the top of the day — a person glancing at their
 * phone between things wants "what's next", not a list to parse.
 */
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";

import { CardShell } from "./CardShell";
import { withAlpha } from "../../gradient";
import { radius, spacing } from "../../theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../../ThemeContext";
import { formatTime, formatTimeRange } from "../../../utils/formatters";
import type { CalendarEvent } from "../../../types";

/** Minutes until an event starts. Negative once it has begun. */
function minutesUntil(startsAt: string, now: number = Date.now()): number {
  const start = new Date(startsAt).getTime();
  if (Number.isNaN(start)) return Number.POSITIVE_INFINITY;
  return Math.round((start - now) / 60000);
}

function countdownLabel(startsAt: string, endsAt: string, now: number = Date.now()): string {
  const until = minutesUntil(startsAt, now);
  const end = new Date(endsAt).getTime();

  if (!Number.isNaN(end) && now >= end) return "Ended";
  if (until <= 0) return "Now";
  if (until < 60) return `in ${until}m`;
  const hours = Math.floor(until / 60);
  if (hours < 24) return `in ${hours}h`;
  return formatTime(startsAt);
}

export function CalendarCard({
  event,
  onPress,
}: {
  event: CalendarEvent;
  onPress?: () => void;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const imminent = minutesUntil(event.startsAt) <= 15;

  return (
    <CardShell
      onPress={onPress}
      accessibilityLabel={`${event.title} at ${formatTimeRange(event.startsAt, event.endsAt)}${
        event.location ? `, ${event.location}` : ""
      }`}
      style={styles.card}
    >
      <View style={styles.row}>
        {/* A time gutter rather than an icon: a column of aligned start times is
            scannable in a way that a column of identical calendar glyphs isn't. */}
        <View style={styles.gutter}>
          <Text style={[styles.time, imminent ? { color: palette.ambient } : null]}>
            {formatTime(event.startsAt)}
          </Text>
          <Text style={styles.until}>{countdownLabel(event.startsAt, event.endsAt)}</Text>
        </View>

        <View style={styles.divider} />

        <View style={styles.details}>
          <Text style={styles.title} numberOfLines={2}>
            {event.title}
          </Text>
          {event.location ? (
            <View style={styles.locationRow}>
              <Ionicons name="location-outline" size={12} color={palette.textMuted} />
              <Text style={styles.location} numberOfLines={1}>
                {event.location}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </CardShell>
  );
}

export function NextUpCard({
  event,
  onPress,
}: {
  event: CalendarEvent;
  onPress?: () => void;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);

  return (
    <CardShell
      onPress={onPress}
      accent={palette.ambient}
      accessibilityLabel={`Next up: ${event.title}, ${formatTimeRange(event.startsAt, event.endsAt)}`}
      style={styles.next}
    >
      <View style={styles.nextHeader}>
        <View style={[styles.pill, { backgroundColor: withAlpha(palette.ambient, 0.12) }]}>
          <Ionicons name="time-outline" size={12} color={palette.ambient} />
          <Text style={[styles.pillText, { color: palette.ambient }]}>Next up</Text>
        </View>
        <Text style={[styles.countdown, { color: palette.ambient }]}>
          {countdownLabel(event.startsAt, event.endsAt)}
        </Text>
      </View>

      <Text style={styles.nextTitle} numberOfLines={2}>
        {event.title}
      </Text>

      <View style={styles.nextMeta}>
        <Ionicons name="calendar-outline" size={13} color={palette.textMuted} />
        <Text style={styles.nextMetaText}>{formatTimeRange(event.startsAt, event.endsAt)}</Text>
        {event.location ? (
          <>
            <Text style={styles.nextMetaText}>·</Text>
            <Text style={styles.nextMetaText} numberOfLines={1}>
              {event.location}
            </Text>
          </>
        ) : null}
      </View>
    </CardShell>
  );
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    card: { gap: 0 },
    row: { flexDirection: "row", alignItems: "center", gap: spacing.md },
    gutter: { width: 56, alignItems: "flex-start", gap: 1 },
    time: { ...type.label, fontSize: 15 },
    until: { ...type.caption, fontSize: 11 },
    divider: { width: 1, alignSelf: "stretch", backgroundColor: palette.border },
    details: { flex: 1, gap: 3 },
    title: { ...type.body, fontWeight: "700" },
    locationRow: { flexDirection: "row", alignItems: "center", gap: 4 },
    location: { ...type.caption, flexShrink: 1 },
    next: { gap: spacing.sm },
    nextHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    pill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingVertical: 4,
      paddingHorizontal: 10,
      borderRadius: radius.pill,
    },
    pillText: { fontSize: 11, fontWeight: "800", letterSpacing: 0.3 },
    countdown: { fontSize: 13, fontWeight: "800" },
    nextTitle: { ...type.displayLg, fontSize: 20, lineHeight: 26 },
    nextMeta: { flexDirection: "row", alignItems: "center", gap: 5 },
    nextMetaText: { ...type.caption, flexShrink: 1 },
  });
}
