/**
 * Screen header: circular back button, centred title, optional circular action.
 *
 * The title is centred against the screen rather than against the space left
 * between the buttons, so it doesn't shift sideways when a trailing action
 * appears or disappears. That's why both sides reserve the same width even when
 * one is empty.
 */
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";

import { PressableScale } from "../motion";
import { HIT_SLOP, MIN_TOUCH, radius, spacing } from "../theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../ThemeContext";

export function TopNav({
  title,
  subtitle,
  onBack,
  backIcon = "chevron-back",
  backLabel = "Go back",
  action,
}: {
  title?: string;
  subtitle?: string;
  onBack?: () => void;
  backIcon?: keyof typeof Ionicons.glyphMap;
  backLabel?: string;
  action?: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void };
}) {
  const styles = useThemedStyles(makeStyles);

  return (
    <View style={styles.row}>
      <View style={styles.side}>
        {onBack ? <RoundButton icon={backIcon} label={backLabel} onPress={onBack} /> : null}
      </View>

      <View style={styles.middle}>
        {title ? (
          <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
            {title}
          </Text>
        ) : null}
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>

      <View style={[styles.side, styles.sideEnd]}>
        {action ? <RoundButton icon={action.icon} label={action.label} onPress={action.onPress} /> : null}
      </View>
    </View>
  );
}

/**
 * Circular chrome button. Exported because the voice screen needs the same
 * shape for its pause and close controls, outside a TopNav.
 */
export function RoundButton({
  icon,
  label,
  onPress,
  tone = "surface",
  badge = false,
  disabled = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  /** `ambient` for a purple-tinted button; `surface` is the default white. */
  tone?: "surface" | "ambient";
  badge?: boolean;
  disabled?: boolean;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const ambient = tone === "ambient";

  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      hitSlop={HIT_SLOP}
      scaleTo={0.92}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={[
        styles.round,
        ambient ? { backgroundColor: palette.ambientTint } : null,
        disabled ? styles.roundDisabled : null,
      ]}
    >
      <Ionicons name={icon} size={20} color={ambient ? palette.ambient : palette.text} />
      {badge ? <View style={styles.badge} /> : null}
    </PressableScale>
  );
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      gap: spacing.sm,
    },
    // Equal, fixed sides keep the centre column centred on the screen.
    side: { width: MIN_TOUCH, alignItems: "flex-start" },
    sideEnd: { alignItems: "flex-end" },
    middle: { flex: 1, alignItems: "center" },
    title: { ...type.title },
    subtitle: { ...type.caption, marginTop: 1 },
    round: {
      width: MIN_TOUCH,
      height: MIN_TOUCH,
      borderRadius: radius.pill,
      backgroundColor: palette.surface,
      borderWidth: 1,
      borderColor: palette.border,
      alignItems: "center",
      justifyContent: "center",
    },
    roundDisabled: { opacity: 0.45 },
    badge: {
      position: "absolute",
      top: 9,
      right: 10,
      width: 9,
      height: 9,
      borderRadius: radius.pill,
      backgroundColor: palette.danger,
      borderWidth: 1.5,
      borderColor: palette.surface,
    },
  });
}
