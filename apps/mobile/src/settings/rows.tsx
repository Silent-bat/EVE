/**
 * The two pieces the settings index is built from: a grouped card, and the rows
 * that sit inside it.
 *
 * The previous settings screen gave every control its own card. That made a
 * theme picker look exactly as important as a sign-out button, and the page
 * became a wall you had to read end to end to find anything. Grouping puts the
 * card around the *topic* instead, so the rows inside can be quiet and the eye
 * lands on the four or five group labels rather than on twenty equal boxes.
 *
 * Rows come in two shapes and no others:
 *   - a row that navigates (chevron, optional value on the right)
 *   - a row that carries one control (switch, button, stepper)
 * A row that did both would leave the tap target ambiguous.
 */
import { Ionicons } from "@expo/vector-icons";
import type { ReactNode } from "react";
import { Children, Fragment, isValidElement } from "react";
import { StyleSheet, Switch, Text, View } from "react-native";

import { PressableScale } from "../ui/motion";
import { elevation, radius, spacing, toneInkIn, toneSurfaceIn, MIN_TOUCH, type Tone } from "../ui/theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../ui/ThemeContext";

/**
 * A titled card holding a run of rows, with hairlines drawn *between* them.
 *
 * The divider belongs to the group rather than the row because only the group
 * knows which row is last — a row that draws its own bottom border leaves a
 * rule hanging under the final item with nothing beneath it.
 */
export function SettingsGroup({
  title,
  footer,
  children,
}: {
  title?: string;
  /** Explanatory line under the card. For the caveat that won't fit in a row. */
  footer?: string;
  children: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const rows = Children.toArray(children).filter(isValidElement);

  return (
    <View style={styles.group}>
      {title ? <Text style={styles.groupTitle}>{title}</Text> : null}
      <View style={styles.card}>
        {rows.map((row, index) => (
          <Fragment key={row.key ?? index}>
            {index > 0 ? <View style={styles.divider} /> : null}
            {row}
          </Fragment>
        ))}
      </View>
      {footer ? <Text style={styles.groupFooter}>{footer}</Text> : null}
    </View>
  );
}

/**
 * One row. Pass `onPress` for a row that navigates, `control` for a row that
 * holds a switch or a button, and neither for a row that just states a fact.
 */
export function SettingsRowItem({
  icon,
  tone = "neutral",
  title,
  subtitle,
  value,
  onPress,
  control,
  destructive = false,
  disabled = false,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  /** Tints the icon chip. Use it to group rows by meaning, not to decorate. */
  tone?: Tone;
  title: string;
  subtitle?: string;
  /** Current setting, shown on the right. The whole point of an index row. */
  value?: string;
  onPress?: () => void;
  control?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);

  const body = (
    <>
      {icon ? (
        <View
          style={[
            styles.iconChip,
            { backgroundColor: destructive ? palette.dangerTint : toneSurfaceIn(palette, tone) },
          ]}
        >
          <Ionicons
            name={icon}
            size={17}
            color={destructive ? palette.dangerDeep : toneInkIn(palette, tone)}
          />
        </View>
      ) : null}

      <View style={styles.text}>
        <Text style={[styles.title, destructive ? { color: palette.dangerDeep } : null]}>{title}</Text>
        {/* One line. The subtitles are written to fit; the cap is what stops a
            long one from doubling the row's height and floating the value or
            control off into the middle of nowhere. */}
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>

      {value ? (
        <Text style={styles.value} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {control}
      {onPress ? <Ionicons name="chevron-forward" size={16} color={palette.textMuted} /> : null}
    </>
  );

  if (!onPress) {
    return <View style={[styles.row, disabled ? styles.rowDisabled : null]}>{body}</View>;
  }

  return (
    <PressableScale
      onPress={onPress}
      scaleTo={0.99}
      disabled={disabled}
      accessible
      accessibilityRole="button"
      // Subtitle as the hint rather than part of the label: the label is what
      // the row *is*, the hint is what tapping it does.
      accessibilityLabel={value ? `${title}, ${value}` : title}
      accessibilityHint={subtitle}
      accessibilityState={{ disabled }}
      style={[styles.row, disabled ? styles.rowDisabled : null]}
    >
      {body}
    </PressableScale>
  );
}

/**
 * The app's one switch. Wrapped so every toggle in settings has the same track
 * colour and the same accessibility shape — a bare `Switch` announces only
 * "on"/"off" with no idea what it governs.
 */
export function SettingsSwitch({
  value,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  const { palette } = useTheme();
  return (
    <Switch
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      accessibilityLabel={label}
      accessibilityHint={hint}
      trackColor={{ true: palette.ambient, false: palette.border }}
      thumbColor={palette.surface}
    />
  );
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    group: { marginTop: spacing.xxl },
    groupTitle: {
      ...type.caption,
      fontSize: 12,
      fontWeight: "800",
      letterSpacing: 0.6,
      textTransform: "uppercase",
      marginBottom: spacing.md,
      paddingHorizontal: spacing.xs,
    },
    card: {
      backgroundColor: palette.surface,
      borderRadius: radius.xl,
      borderWidth: 1,
      borderColor: palette.border,
      overflow: "hidden",
      ...elevation.sm,
    },
    groupFooter: {
      ...type.caption,
      marginTop: spacing.sm,
      paddingHorizontal: spacing.xs,
      lineHeight: 17,
    },
    row: {
      minHeight: MIN_TOUCH + 12,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    rowDisabled: { opacity: 0.45 },
    // Left inset only: the hairline starts under the text, not under the icon,
    // which is what makes a run of rows read as one list rather than as stripes.
    divider: {
      height: 1,
      backgroundColor: palette.border,
      marginLeft: spacing.lg + 34 + spacing.md,
    },
    iconChip: {
      width: 34,
      height: 34,
      borderRadius: radius.md,
      alignItems: "center",
      justifyContent: "center",
    },
    text: { flex: 1, gap: 2 },
    title: { ...type.label, fontSize: 15 },
    subtitle: { ...type.caption, lineHeight: 17 },
    value: { ...type.caption, color: palette.textMuted, maxWidth: 120, textAlign: "right" },
  });
}
