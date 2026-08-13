/**
 * The primary action button — EVE's purple, pill-shaped, gradient-filled.
 *
 * Reserved for the single most important action on a screen (send, start
 * listening, connect). The design brief asks for restraint with gradients, and
 * the rule this file encodes is that a purple gradient means "this is the thing
 * to press". Secondary actions use `InlineButton` from primitives and stay flat.
 */
import { Ionicons } from "@expo/vector-icons";
import { ActivityIndicator, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { SoftGradient } from "../gradient";
import { PressableScale } from "../motion";
import { elevation, MIN_TOUCH, radius, spacing } from "../theme";
import { useTheme } from "../ThemeContext";

export function GradientButton({
  label,
  onPress,
  icon,
  /** Trailing icon instead of leading. For "Continue →" style actions. */
  iconTrailing = false,
  disabled = false,
  loading = false,
  fullWidth = false,
  /** Shorter and tighter, for buttons that sit inside a card rather than under one. */
  compact = false,
  accessibilityHint,
  style,
}: {
  label: string;
  onPress: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  iconTrailing?: boolean;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  compact?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { palette } = useTheme();
  // A loading button is still disabled — without this a double tap fires the
  // action twice while the first is in flight.
  const inert = disabled || loading;

  const glyph = icon ? (
    <Ionicons name={icon} size={compact ? 15 : 18} color={palette.textInverse} />
  ) : null;

  return (
    <PressableScale
      onPress={onPress}
      disabled={inert}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inert, busy: loading }}
      style={[
        styles.button,
        compact ? styles.compact : null,
        fullWidth ? styles.fullWidth : null,
        { backgroundColor: palette.ambient },
        inert ? styles.inert : elevation.md,
        style,
      ]}
    >
      <SoftGradient
        colors={[palette.ambient, palette.ambientDeep]}
        direction="diagonal"
        bands={12}
        radius={radius.pill}
      />
      {loading ? (
        <ActivityIndicator color={palette.textInverse} />
      ) : (
        <View style={[styles.content, compact ? styles.contentCompact : null]}>
          {iconTrailing ? null : glyph}
          <Text
            numberOfLines={1}
            style={[styles.label, compact ? styles.labelCompact : null, { color: palette.textInverse }]}
          >
            {label}
          </Text>
          {iconTrailing ? glyph : null}
        </View>
      )}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 54,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.xxl,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-start",
    overflow: "hidden",
  },
  // Sized to survive a half-width card. The full-size button's 28pt side padding
  // alone eats most of a 160pt column.
  compact: { minHeight: 42, paddingHorizontal: spacing.md },
  fullWidth: { alignSelf: "stretch" },
  inert: { opacity: 0.45 },
  content: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: MIN_TOUCH,
  },
  contentCompact: { minHeight: 0, gap: spacing.xs },
  label: { fontSize: 16, fontWeight: "700" },
  labelCompact: { fontSize: 14 },
});
