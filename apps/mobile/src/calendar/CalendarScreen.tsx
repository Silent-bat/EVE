/**
 * Calendar — the agenda view from the new design.
 *
 * A month label with paging arrows, a horizontal week strip with the selected
 * day highlighted, and a timed agenda of the day's events. Events come from the
 * briefing the app already loads; the selected-day highlight is local.
 */
import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import type { CalendarEvent } from "../types";
import { useTheme, useThemedStyles, type ThemeValue } from "../ui/ThemeContext";
import { BOTTOM_NAV_CLEARANCE } from "../ui/components";
import { spacing, radius } from "../ui/theme";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function startOfWeek(d: Date): Date {
  const copy = new Date(d);
  const day = (copy.getDay() + 6) % 7; // Monday = 0
  copy.setDate(copy.getDate() - day);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function CalendarScreen({ events }: { events: CalendarEvent[] }) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();

  const today = useMemo(() => new Date(), []);
  const [selected, setSelected] = useState<Date>(today);
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(today));

  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      return d;
    }),
    [weekStart],
  );

  const monthLabel = selected.toLocaleDateString([], { month: "long", year: "numeric" });

  const dayEvents = useMemo(() => {
    const key = selected.toDateString();
    return events
      .filter((e) => {
        const d = new Date(e.startsAt);
        return !Number.isNaN(d.getTime()) && d.toDateString() === key;
      })
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  }, [events, selected]);

  const shiftWeek = (dir: number) => {
    const next = new Date(weekStart);
    next.setDate(weekStart.getDate() + dir * 7);
    setWeekStart(next);
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Ionicons name="calendar-outline" size={22} color={palette.text} />
          <Text style={styles.title}>Calendar</Text>
        </View>
      </View>

      <View style={styles.monthRow}>
        <Pressable onPress={() => shiftWeek(-1)} hitSlop={10} accessibilityLabel="Previous week">
          <Ionicons name="chevron-back" size={20} color={palette.textMuted} />
        </Pressable>
        <Text style={styles.month}>{monthLabel}</Text>
        <Pressable onPress={() => shiftWeek(1)} hitSlop={10} accessibilityLabel="Next week">
          <Ionicons name="chevron-forward" size={20} color={palette.textMuted} />
        </Pressable>
      </View>

      <View style={styles.weekStrip}>
        {weekDays.map((d, i) => {
          const active = d.toDateString() === selected.toDateString();
          return (
            <Pressable
              key={d.toISOString()}
              onPress={() => setSelected(d)}
              style={styles.dayCol}
              accessibilityRole="button"
              accessibilityLabel={d.toDateString()}
              accessibilityState={{ selected: active }}
            >
              <Text style={styles.dayLabel}>{DAY_LABELS[i]}</Text>
              <View style={[styles.dayNum, active && { backgroundColor: palette.primary }]}>
                <Text style={[styles.dayNumText, active && { color: palette.onPrimary }]}>{d.getDate()}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>

      <ScrollView contentContainerStyle={[styles.agenda, { paddingBottom: BOTTOM_NAV_CLEARANCE + insets.bottom }]}>
        {dayEvents.length === 0 ? (
          <Text style={styles.empty}>Nothing scheduled for this day.</Text>
        ) : (
          dayEvents.map((e) => (
            <View key={e.id} style={styles.slot}>
              <Text style={styles.slotTime}>{fmtTime(e.startsAt)}</Text>
              <View style={styles.slotCard}>
                <View style={styles.slotBar} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.slotTitle} numberOfLines={1}>{e.title}</Text>
                  {e.location ? <Text style={styles.slotSub} numberOfLines={1}>{e.location}</Text> : null}
                </View>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: palette.background },
    header: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm },
    titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    title: { ...type.display },
    monthRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    month: { ...type.title },
    weekStrip: {
      flexDirection: "row",
      justifyContent: "space-between",
      paddingHorizontal: spacing.md,
      paddingBottom: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
    },
    dayCol: { alignItems: "center", gap: 6, flex: 1 },
    dayLabel: { ...type.caption, color: palette.textMuted },
    dayNum: { width: 34, height: 34, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" },
    dayNumText: { ...type.body, fontWeight: "700", color: palette.text },
    agenda: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxxl },
    empty: { ...type.bodyMuted, textAlign: "center", marginTop: spacing.xxl },
    slot: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start" },
    slotTime: { ...type.caption, color: palette.textMuted, width: 64, paddingTop: spacing.md },
    slotCard: {
      flex: 1,
      flexDirection: "row",
      gap: spacing.md,
      backgroundColor: palette.surface,
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    slotBar: { width: 3, borderRadius: radius.pill, backgroundColor: palette.primary, alignSelf: "stretch" },
    slotTitle: { ...type.title, fontSize: 15 },
    slotSub: { ...type.caption, color: palette.textMuted, marginTop: 2 },
  });
}
