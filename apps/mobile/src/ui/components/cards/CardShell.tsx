/**
 * The card shell every content card on the home screen is built from.
 *
 * Cards are the app's main unit, so this is where the shared behaviour lives:
 * the press treatment, the accent rail, and the rule that a whole card is one
 * accessibility element rather than a pile of loose text nodes. Screens should
 * reach for a specific card (EmailCard, CalendarCard…) and only use this
 * directly for something genuinely new.
 */
import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { withAlpha } from "../../gradient";
import { PressableScale } from "../../motion";
import { elevation, radius, spacing } from "../../theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../../ThemeContext";

export function CardShell({
  children,
  onPress,
  /** Vertical accent stripe down the leading edge. Signals urgency or source. */
  accent,
  /** Tints the whole card. For EVE-authored content. */
  tinted = false,
  accessibilityLabel,
  accessibilityHint,
  style,
}: {
  children: ReactNode;
  onPress?: () => void;
  accent?: string;
  tinted?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);

  const body = (
    <>
      {accent ? <View style={[styles.accent, { backgroundColor: accent }]} /> : null}
      {children}
    </>
  );

  const shell = [
    styles.card,
    tinted ? { backgroundColor: palette.ambientTint, borderColor: withAlpha(palette.ambient, 0.2) } : null,
    accent ? styles.withAccent : null,
    style,
  ];

  if (!onPress) {
    return <View style={shell}>{body}</View>;
  }

  return (
    <PressableScale
      onPress={onPress}
      scaleTo={0.985}
      // One label for the card. Without this a screen reader reads the sender,
      // subject, summary, and every chip as separate stops, and swiping through
      // a list of ten emails takes fifty gestures.
      accessible
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      style={shell}
    >
      {body}
    </PressableScale>
  );
}

function makeStyles({ palette }: ThemeValue) {
  return StyleSheet.create({
    card: {
      backgroundColor: palette.surface,
      borderRadius: radius.xl,
      borderWidth: 1,
      borderColor: palette.border,
      padding: spacing.xl,
      gap: spacing.md,
      overflow: "hidden",
      ...elevation.sm,
    },
    withAccent: { paddingLeft: spacing.xl + 4 },
    accent: { position: "absolute", left: 0, top: 0, bottom: 0, width: 4 },
  });
}
