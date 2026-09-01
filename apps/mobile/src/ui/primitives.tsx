/**
 * Composable UI primitives for the EVE app. Each one is a thin, themed
 * wrapper that new screens can mix and match without inventing a new
 * stylesheet. Kept in a single file so the surface is easy to scan; if any
 * one of these grows past a screenful, split it out.
 */
import { Ionicons } from "@expo/vector-icons";
import type { ReactNode } from "react";
import { Animated, Pressable, StyleSheet, Switch, Text, View, type ViewStyle } from "react-native";

import { elevation, HIT_SLOP, MIN_TOUCH, radius, spacing, type Tone } from "./theme";
import { useTheme, useThemedStyles, type ThemeValue } from "./ThemeContext";
import { usePressScale } from "./motion";

// ---------- Card ----------

export function Card({
  children,
  tone = "neutral",
  style,
}: {
  children: ReactNode;
  tone?: Tone;
  style?: ViewStyle;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      style={[
        styles.card,
        tone === "ambient"
          ? { borderColor: palette.ambient + "33", backgroundColor: palette.ambientTint }
          : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

// ---------- Chip ----------

export function Chip({
  label,
  tone = "neutral",
  icon,
  compact = false,
}: {
  label: string;
  tone?: Tone;
  icon?: keyof typeof Ionicons.glyphMap;
  compact?: boolean;
}) {
  const { toneSurface, toneInk } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.chip, compact ? styles.chipCompact : null, { backgroundColor: toneSurface(tone) }]}>
      {icon ? <Ionicons name={icon} size={11} color={toneInk(tone)} /> : null}
      <Text style={[styles.chipText, { color: toneInk(tone) }]}>{label}</Text>
    </View>
  );
}

// ---------- Section header ----------

export function SectionHeader({ title, note, action }: { title: string; note?: string; action?: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.sectionHeader}>
      <View style={styles.flexOne}>
        <Text style={styles.sectionTitle} accessibilityRole="header">
          {title}
        </Text>
        {note ? <Text style={styles.sectionNote}>{note}</Text> : null}
      </View>
      {action}
    </View>
  );
}

// ---------- Settings row ----------

export function SettingsRow({
  icon,
  title,
  subtitle,
  action,
  divider = false,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  /**
   * Rule along the bottom edge. Off by default because most rows are the only
   * one in their card, where a trailing rule reads as a row that failed to
   * load. Set it on every row of a stack except the last.
   */
  divider?: boolean;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.row, divider ? styles.rowDivider : null]}>
      {icon ? <Ionicons name={icon} size={22} color={palette.text} /> : null}
      <View style={styles.flexOne}>
        <Text style={styles.rowTitle}>{title}</Text>
        {subtitle ? <Text style={styles.rowText}>{subtitle}</Text> : null}
      </View>
      {action}
    </View>
  );
}

// ---------- Toggle row (icon + title + subtitle + switch) ----------

export function ToggleRow({
  icon,
  title,
  subtitle,
  value,
  onChange,
  divider = false,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  value: boolean;
  onChange: (next: boolean) => void;
  divider?: boolean;
}) {
  const { palette } = useTheme();
  return (
    <SettingsRow
      icon={icon}
      title={title}
      subtitle={subtitle}
      divider={divider}
      action={
        <Switch
          value={value}
          onValueChange={onChange}
          accessibilityLabel={title}
          accessibilityHint={subtitle}
          trackColor={{ true: palette.ambient, false: palette.border }}
          thumbColor={palette.background}
        />
      }
    />
  );
}

// ---------- Segmented control ----------

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  tone = "neutral",
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  tone?: Tone;
  label?: string;
}) {
  const { palette, toneAccent } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.segmented} accessibilityRole="tablist" accessibilityLabel={label}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            accessibilityRole="tab"
            accessibilityLabel={opt.label}
            accessibilityState={{ selected: active }}
            style={[styles.segment, active && { backgroundColor: toneAccent(tone) }]}
          >
            <Text
              // One line, always. A segment is sized by its siblings, so a label
              // that doesn't fit wraps mid-word and then gets clipped by the
              // pill's fixed height — "Crit" rendering as "Cri / t". Truncating
              // is the honest failure here; shrinking to fit sizes each label
              // independently and the row ends up with three different sizes.
              numberOfLines={1}
              style={[styles.segmentText, active ? { color: palette.textInverse } : null]}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------- Inline button ----------

export function InlineButton({
  label,
  onPress,
  tone = "neutral",
  icon,
  disabled = false,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  tone?: Tone;
  icon?: keyof typeof Ionicons.glyphMap;
  disabled?: boolean;
  accessibilityHint?: string;
}) {
  const { toneSurface, toneInk } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const press = usePressScale();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
    >
      <Animated.View
        style={[
          styles.inlineButton,
          { backgroundColor: toneSurface(tone) },
          disabled ? styles.disabled : press.animatedStyle,
        ]}
      >
        {icon ? <Ionicons name={icon} size={14} color={toneInk(tone)} /> : null}
        <Text style={[styles.inlineButtonText, { color: toneInk(tone) }]}>{label}</Text>
      </Animated.View>
    </Pressable>
  );
}

// ---------- Icon button ----------

export function IconButton({
  icon,
  onPress,
  label,
  disabled = false,
  tone = "neutral",
}: {
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  label: string;
  disabled?: boolean;
  tone?: Tone;
}) {
  const { toneSurface, toneInk } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const press = usePressScale(0.92);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
    >
      <Animated.View
        style={[
          styles.iconButton,
          { backgroundColor: toneSurface(tone) },
          disabled ? styles.disabled : press.animatedStyle,
        ]}
      >
        <Ionicons name={icon} size={18} color={toneInk(tone)} />
      </Animated.View>
    </Pressable>
  );
}

// ---------- Banner ----------

export function Banner({
  icon,
  title,
  body,
  tone = "ambient",
  action,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  body?: string;
  tone?: Tone;
  action?: ReactNode;
}) {
  const { palette, toneSurface, toneInk, toneAccent } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      style={[styles.banner, { backgroundColor: toneSurface(tone), borderColor: toneAccent(tone) + "33" }]}
    >
      {icon ? (
        <View style={[styles.bannerIcon, { backgroundColor: toneAccent(tone) }]}>
          <Ionicons name={icon} size={14} color={palette.textInverse} />
        </View>
      ) : null}
      <View style={styles.flexOne}>
        <Text style={[styles.bannerTitle, { color: toneInk(tone) }]}>{title}</Text>
        {body ? <Text style={[styles.bannerBody, { color: toneInk(tone) }]}>{body}</Text> : null}
      </View>
      {action}
    </View>
  );
}

// ---------- Error banner ----------

/**
 * Errors get a dismiss and, where the caller can retry, a retry. Announced
 * via role="alert" so a screen reader picks it up when it appears.
 */
export function ErrorBanner({
  message,
  onDismiss,
  onRetry,
}: {
  message: string;
  onDismiss: () => void;
  onRetry?: () => void;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.errorBanner} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <Ionicons name="alert-circle" size={18} color={palette.danger} />
      <View style={styles.flexOne}>
        <Text style={styles.errorBannerText}>{message}</Text>
        {onRetry ? (
          <Pressable
            onPress={onRetry}
            hitSlop={HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel="Try again"
          >
            <Text style={styles.errorRetry}>Try again</Text>
          </Pressable>
        ) : null}
      </View>
      <Pressable
        onPress={onDismiss}
        hitSlop={HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel="Dismiss error"
      >
        <Ionicons name="close" size={18} color={palette.danger} />
      </Pressable>
    </View>
  );
}

// ---------- styles ----------

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    flexOne: { flex: 1 },
    disabled: { opacity: 0.45 },
    // White, generously rounded, lifted by a violet shadow rather than a heavy
    // border — the hairline is there to hold the edge on dark, where a shadow
    // over a dark background is nearly invisible.
    card: {
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: radius.xl,
      padding: spacing.xl,
      backgroundColor: palette.surface,
      marginBottom: spacing.md,
      gap: spacing.sm,
      ...elevation.sm,
    },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingVertical: 5,
      paddingHorizontal: 10,
      borderRadius: radius.pill,
      alignSelf: "flex-start",
    },
    chipCompact: { paddingVertical: 3, paddingHorizontal: 8 },
    chipText: {
      fontSize: 11,
      fontWeight: "700",
      letterSpacing: 0.3,
      textTransform: "uppercase",
    },
    sectionHeader: {
      marginTop: spacing.xl,
      marginBottom: spacing.md,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
    },
    sectionTitle: type.title,
    sectionNote: { color: palette.textMuted, fontSize: 12, marginTop: 2 },
    row: {
      flexDirection: "row",
      gap: spacing.md,
      paddingVertical: 13,
      alignItems: "center",
    },
    rowDivider: {
      borderBottomWidth: 1,
      borderBottomColor: palette.border,
    },
    rowTitle: type.label,
    rowText: { color: palette.textMuted, fontSize: 13, lineHeight: 19, marginTop: 2 },
    // Fully rounded track and thumb. At this radius the selected pill reads as
    // an object sliding inside the track rather than a highlighted rectangle.
    segmented: {
      flexDirection: "row",
      backgroundColor: palette.surfaceMuted,
      borderRadius: radius.pill,
      padding: 4,
      gap: 2,
    },
    segment: {
      flex: 1,
      minHeight: 38,
      paddingHorizontal: spacing.sm,
      borderRadius: radius.pill,
      alignItems: "center",
      justifyContent: "center",
    },
    segmentText: { color: palette.textMuted, fontSize: 12, fontWeight: "800" },
    inlineButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      minHeight: MIN_TOUCH,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.lg,
      justifyContent: "center",
    },
    inlineButtonText: { fontSize: 12, fontWeight: "800" },
    // Circular, matching the reference's round chrome buttons.
    iconButton: {
      width: MIN_TOUCH,
      height: MIN_TOUCH,
      borderRadius: radius.pill,
      alignItems: "center",
      justifyContent: "center",
    },
    banner: {
      flexDirection: "row",
      gap: spacing.md,
      padding: spacing.lg,
      borderRadius: radius.lg,
      borderWidth: 1,
      alignItems: "center",
    },
    bannerIcon: {
      width: 30,
      height: 30,
      borderRadius: radius.pill,
      alignItems: "center",
      justifyContent: "center",
    },
    bannerTitle: { fontSize: 13, fontWeight: "800" },
    bannerBody: { fontSize: 12, marginTop: 2, opacity: 0.85 },
    errorBanner: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: spacing.sm,
      backgroundColor: palette.dangerTint,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: palette.danger + "33",
      padding: spacing.md,
      marginBottom: spacing.md,
    },
    errorBannerText: { color: palette.danger, fontSize: 13, lineHeight: 18 },
    errorRetry: {
      color: palette.danger,
      fontSize: 12,
      fontWeight: "800",
      marginTop: 6,
      textDecorationLine: "underline",
    },
  });
}
