/**
 * The three numbers for today: urgent mail, meetings, replies sent.
 *
 * Two of the three come straight from `BriefingStats`. The urgent count does
 * not, and deliberately: the backend calls a mail "priority" at a score of 75,
 * while every chip in the app calls it "High" at 55. On a real inbox that read
 * as nine cards chipped HIGH sitting under a tile saying 0 urgent mail — both
 * numbers right, neither believable. The strip now counts the mails it is
 * sitting above, using the same threshold the chips on them use.
 */
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";

import { countHighPriority } from "../ui/components";
import { PressableScale } from "../ui/motion";
import { elevation, radius, spacing } from "../ui/theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../ui/ThemeContext";
import type { Briefing, BriefingStats } from "../types";

type IoniconName = keyof typeof Ionicons.glyphMap;

type StatKey = keyof BriefingStats;

type StatTile = {
  key: StatKey;
  label: string;
  icon: IoniconName;
};

const TILES: StatTile[] = [
  { key: "priorityEmails", label: "urgent mail", icon: "mail-unread-outline" },
  { key: "meetingsToday", label: "meetings", icon: "calendar-outline" },
  { key: "approvedReplies", label: "replies sent", icon: "send-outline" },
];

export function StatStrip({
  briefing,
  onPressStat,
}: {
  briefing: Briefing;
  onPressStat?: (key: StatKey) => void;
}) {
  const values: Record<StatKey, number> = {
    ...briefing.stats,
    priorityEmails: countHighPriority(briefing.emails),
  };

  return (
    <View style={strip.row}>
      {TILES.map((tile) => (
        <Tile
          key={tile.key}
          tile={tile}
          value={values[tile.key] ?? 0}
          onPress={onPressStat ? () => onPressStat(tile.key) : undefined}
        />
      ))}
    </View>
  );
}

function Tile({
  tile,
  value,
  onPress,
}: {
  tile: StatTile;
  value: number;
  onPress?: () => void;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);

  const body = (
    <>
      <Ionicons name={tile.icon} size={16} color={palette.ambient} />
      <Text style={styles.value}>{value}</Text>
      <Text style={styles.label} numberOfLines={2}>
        {tile.label}
      </Text>
    </>
  );

  // Read as one thing: "3, urgent mail" rather than three separate stops.
  const label = `${value} ${tile.label}`;

  if (!onPress) {
    return (
      <View style={styles.tile} accessible accessibilityLabel={label}>
        {body}
      </View>
    );
  }

  return (
    <PressableScale
      onPress={onPress}
      scaleTo={0.97}
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      style={styles.tile}
    >
      {body}
    </PressableScale>
  );
}

const strip = StyleSheet.create({
  row: { flexDirection: "row", gap: spacing.md },
});

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    tile: {
      flex: 1,
      backgroundColor: palette.surface,
      borderRadius: radius.xl,
      borderWidth: 1,
      borderColor: palette.border,
      paddingVertical: spacing.xl,
      paddingHorizontal: spacing.lg,
      gap: spacing.xs,
      minHeight: 120,
      ...elevation.sm,
    },
    value: { ...type.displayLg, marginTop: spacing.sm },
    label: { ...type.caption, lineHeight: 17 },
  });
}
