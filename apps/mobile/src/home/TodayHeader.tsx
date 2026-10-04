/**
 * The top of the home screen: who you are, what time it is, what's waiting.
 *
 * The reference puts an avatar, a two-line greeting, and a notification bell
 * across the top, and that composition survives here. What changes is the
 * second line — instead of a stock question it carries `contextLine`, so the
 * first thing read on opening the app is a fact about the day.
 *
 * The avatar is *yours*, not EVE's. It used to be the sparkle mark, which made
 * tapping it read as "ask EVE" when what it actually opens is your own menu.
 * Your photo makes the target say what it does.
 */
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";

import { contextLine, salutation, type DayContext } from "./greeting";
import { UserAvatar } from "../ui/components";
import { PressableScale } from "../ui/motion";
import { elevation, HIT_SLOP, radius, spacing } from "../ui/theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../ui/ThemeContext";

export function TodayHeader({
  name,
  context,
  /** Unread proactive thoughts. Drives the dot on the bell. */
  alertCount = 0,
  email,
  photoURL,
  onPressAlerts,
  onPressAvatar,
}: {
  name: string;
  context: DayContext;
  alertCount?: number;
  email?: string | null;
  photoURL?: string | null;
  onPressAlerts?: () => void;
  onPressAvatar?: () => void;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);

  const avatar = <UserAvatar photoURL={photoURL} name={name} email={email} size="lg" />;
  // The greeting already varies by hour, so the icon has to as well — a sun next
  // to "Good evening" reads as a bug.
  const hour = new Date().getHours();
  const timeIcon: keyof typeof Ionicons.glyphMap =
    hour < 12 ? "sunny" : hour < 18 ? "partly-sunny" : "moon";

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <View style={styles.flexOne} />
        {onPressAlerts ? (
          <PressableScale
            onPress={onPressAlerts}
            hitSlop={HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={
              alertCount > 0 ? `Notifications, ${alertCount} new` : "Notifications, nothing new"
            }
            style={styles.bell}
          >
            <Ionicons name="notifications-outline" size={19} color={palette.text} />
            {alertCount > 0 ? <View style={[styles.dot, { borderColor: palette.background }]} /> : null}
          </PressableScale>
        ) : null}

        {onPressAvatar ? (
          <PressableScale
            onPress={onPressAvatar}
            hitSlop={HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel="Your profile and settings"
            accessibilityHint="Opens the menu"
          >
            {avatar}
          </PressableScale>
        ) : (
          avatar
        )}
      </View>

      <View style={styles.greeting}>
        <View style={styles.heroRow}>
          <Ionicons name={timeIcon} size={24} color={palette.warning} />
          <Text style={styles.hero} numberOfLines={1}>
            {salutation()}, {name.split(" ")[0]}
          </Text>
        </View>
        <Text style={styles.line}>{contextLine(context)}</Text>
      </View>
    </View>
  );
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    wrap: { gap: spacing.lg },
    row: { flexDirection: "row", alignItems: "center", gap: spacing.md },
    flexOne: { flex: 1 },
    bell: {
      width: 48,
      height: 48,
      borderRadius: radius.pill,
      backgroundColor: palette.surface,
      borderWidth: 1,
      borderColor: palette.border,
      alignItems: "center",
      justifyContent: "center",
      ...elevation.sm,
    },
    dot: {
      position: "absolute",
      top: 11,
      right: 12,
      width: 10,
      height: 10,
      borderRadius: radius.pill,
      backgroundColor: palette.danger,
      borderWidth: 2,
    },
    greeting: { gap: spacing.sm },
    heroRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    hero: { ...type.hero, flexShrink: 1 },
    // The context line is the payload of the header, so it gets body weight
    // rather than caption — it is meant to be read, not skimmed past.
    line: { ...type.lead, color: palette.textMuted, maxWidth: 320 },
  });
}
