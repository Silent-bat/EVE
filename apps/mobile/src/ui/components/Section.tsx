/**
 * A titled section of the home screen.
 *
 * Sections collapse when they have nothing to show — the brief asks for a
 * screen that is calm when the day is quiet, and an empty "Needs attention"
 * heading over a "nothing here" card is noise pretending to be content. The
 * exception is a section that is loading or has failed, where the heading has
 * to stay so the state has something to belong to.
 */
import { Ionicons } from "@expo/vector-icons";
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { PressableScale } from "../motion";
import { HIT_SLOP, radius, spacing } from "../theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../ThemeContext";

export function Section({
  title,
  subtitle,
  count,
  icon,
  children,
  /** Hides the whole section, heading included. */
  hidden = false,
  action,
}: {
  title: string;
  /** A line under the title, for state the title can't carry on its own. */
  subtitle?: string;
  /** Shown beside the title when there's more than one item. */
  count?: number;
  icon?: keyof typeof Ionicons.glyphMap;
  children: ReactNode;
  hidden?: boolean;
  action?: { label: string; onPress: () => void };
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);

  if (hidden) return null;

  return (
    <View style={styles.section}>
      <View style={styles.header}>
        {icon ? <Ionicons name={icon} size={20} color={palette.text} /> : null}
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        {typeof count === "number" && count > 1 ? (
          <View style={styles.count}>
            <Text style={styles.countText}>{count}</Text>
          </View>
        ) : null}
        <View style={styles.spacer} />
        {action ? (
          <PressableScale
            onPress={action.onPress}
            hitSlop={HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={`${action.label}, ${title}`}
            style={styles.action}
          >
            <Text style={[styles.actionText, { color: palette.ambient }]}>{action.label}</Text>
            <Ionicons name="chevron-forward" size={16} color={palette.ambient} />
          </PressableScale>
        ) : null}
      </View>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      <View style={styles.body}>{children}</View>
    </View>
  );
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    section: { marginTop: spacing.xxxl },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      marginBottom: spacing.lg,
      paddingHorizontal: spacing.xs,
    },
    // Sentence case at title size, the way the reference sets "Topics" — the
    // old 12px uppercase label read as a form fieldset rather than a heading.
    title: { ...type.title },
    count: {
      minWidth: 22,
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: radius.pill,
      backgroundColor: palette.ambientTint,
      alignItems: "center",
    },
    countText: { fontSize: 12, fontWeight: "800", color: palette.ambient },
    subtitle: {
      ...type.bodyMuted,
      marginTop: -spacing.sm,
      marginBottom: spacing.lg,
      paddingHorizontal: spacing.xs,
    },
    spacer: { flex: 1 },
    action: { flexDirection: "row", alignItems: "center", gap: 2, paddingVertical: 4 },
    actionText: { fontSize: 14, fontWeight: "700" },
    body: { gap: spacing.lg },
  });
}
