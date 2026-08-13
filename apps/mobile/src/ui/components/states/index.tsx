/**
 * Loading, empty, and error states.
 *
 * These three carry more weight in EVE than in most apps. Whole sections are
 * legitimately empty — the calendar has no events until Google Calendar is
 * enabled, tasks have no endpoint yet — so "nothing here" has to read as a
 * known state rather than a bug. `ErrorState` treats a 404 specially for that
 * reason: an endpoint that doesn't exist yet is a roadmap item, not a failure,
 * and saying so is more honest than "Something went wrong".
 */
import { Ionicons } from "@expo/vector-icons";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { withAlpha } from "../../gradient";
import { PressableScale } from "../../motion";
import { HIT_SLOP, MIN_TOUCH, radius, spacing } from "../../theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../../ThemeContext";
import { ApiError } from "../../../api/client";

type IoniconName = keyof typeof Ionicons.glyphMap;

/**
 * Skeleton placeholder. Static rather than shimmering — a pulse animation on
 * every section of a loading home screen is a lot of movement for very little
 * information, and it fights the calm the rest of the design is going for.
 */
export function SkeletonCard({ lines = 2 }: { lines?: number }) {
  const styles = useThemedStyles(makeStyles);

  return (
    <View style={styles.skeleton} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={styles.skeletonHeader}>
        <View style={styles.skeletonAvatar} />
        <View style={styles.skeletonHeaderText}>
          <View style={[styles.bar, { width: "45%" }]} />
          <View style={[styles.bar, { width: "70%" }]} />
        </View>
      </View>
      {Array.from({ length: lines }, (_unused, i) => (
        <View key={i} style={[styles.bar, { width: i === lines - 1 ? "60%" : "100%" }]} />
      ))}
    </View>
  );
}

export function LoadingState({
  label = "Loading",
  cards = 2,
}: {
  label?: string;
  /** Skeletons to show. Set 0 for a plain spinner. */
  cards?: number;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);

  if (cards === 0) {
    return (
      <View style={styles.spinnerBox} accessibilityRole="progressbar" accessibilityLabel={label}>
        <ActivityIndicator color={palette.ambient} />
        <Text style={styles.spinnerText}>{label}</Text>
      </View>
    );
  }

  return (
    <View style={styles.stack} accessibilityRole="progressbar" accessibilityLabel={label}>
      {Array.from({ length: cards }, (_unused, i) => (
        <SkeletonCard key={i} />
      ))}
    </View>
  );
}

export function EmptyState({
  icon = "sparkles-outline",
  title,
  body,
  action,
}: {
  icon?: IoniconName;
  title: string;
  body?: string;
  action?: { label: string; onPress: () => void };
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);

  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: withAlpha(palette.ambient, 0.09) }]}>
        <Ionicons name={icon} size={22} color={palette.ambient} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      {body ? <Text style={styles.emptyBody}>{body}</Text> : null}
      {action ? <StateAction label={action.label} onPress={action.onPress} /> : null}
    </View>
  );
}

export function ErrorState({
  error,
  onRetry,
  /** What this section is, for the not-yet-available message. e.g. "Tasks". */
  subject,
}: {
  error: unknown;
  onRetry?: () => void;
  subject?: string;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const message = describeError(error);
  const missing = isNotFound(error);

  if (missing) {
    return (
      <View style={styles.empty}>
        <View style={[styles.emptyIcon, { backgroundColor: palette.surfaceAlt }]}>
          <Ionicons name="construct-outline" size={22} color={palette.textMuted} />
        </View>
        <Text style={styles.emptyTitle}>{subject ? `${subject} aren't live yet` : "Not available yet"}</Text>
        <Text style={styles.emptyBody}>
          The screen is ready and will fill in as soon as the service is switched on.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.error, { borderColor: withAlpha(palette.danger, 0.3) }]}>
      <View style={styles.errorHeader}>
        <Ionicons name="alert-circle-outline" size={18} color={palette.danger} />
        <Text style={[styles.errorTitle, { color: palette.danger }]}>Couldn't load this</Text>
      </View>
      <Text style={styles.emptyBody}>{message}</Text>
      {onRetry ? <StateAction label="Try again" onPress={onRetry} tone="danger" /> : null}
    </View>
  );
}

function StateAction({
  label,
  onPress,
  tone = "ambient",
}: {
  label: string;
  onPress: () => void;
  tone?: "ambient" | "danger";
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const ink = tone === "danger" ? palette.danger : palette.ambient;

  return (
    <PressableScale
      onPress={onPress}
      hitSlop={HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.action, { borderColor: ink }]}
    >
      <Text style={[styles.actionText, { color: ink }]}>{label}</Text>
    </PressableScale>
  );
}

/** True when the failure was a 404 — the endpoint isn't there yet. */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function describeError(error: unknown): string {
  if (!error) return "Unknown error.";
  if (typeof error === "string") return error;
  // A timed-out request is reported as status 0 by the client. "request timed
  // out" is technically accurate but tells the user nothing they can act on.
  if (error instanceof ApiError && error.status === 0) {
    return "EVE couldn't reach the server. Check your connection and try again.";
  }
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : "Unknown error.";
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    stack: { gap: spacing.md },
    skeleton: {
      backgroundColor: palette.surface,
      borderRadius: radius.xl,
      borderWidth: 1,
      borderColor: palette.border,
      padding: spacing.lg,
      gap: spacing.sm,
    },
    skeletonHeader: { flexDirection: "row", alignItems: "center", gap: spacing.md },
    skeletonHeaderText: { flex: 1, gap: 6 },
    skeletonAvatar: {
      width: 40,
      height: 40,
      borderRadius: radius.pill,
      backgroundColor: palette.surfaceAlt,
    },
    bar: { height: 10, borderRadius: radius.xs, backgroundColor: palette.surfaceAlt },
    spinnerBox: { alignItems: "center", gap: spacing.sm, paddingVertical: spacing.xxl },
    spinnerText: { ...type.caption },
    empty: {
      alignItems: "center",
      gap: spacing.sm,
      paddingVertical: spacing.xl,
      paddingHorizontal: spacing.lg,
    },
    emptyIcon: {
      width: 48,
      height: 48,
      borderRadius: radius.pill,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 2,
    },
    emptyTitle: { ...type.title, textAlign: "center" },
    emptyBody: { ...type.bodyMuted, textAlign: "center", maxWidth: 300 },
    error: {
      backgroundColor: palette.surface,
      borderRadius: radius.xl,
      borderWidth: 1,
      padding: spacing.lg,
      gap: spacing.sm,
      alignItems: "center",
    },
    errorHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
    errorTitle: { ...type.label },
    action: {
      minHeight: MIN_TOUCH - 8,
      justifyContent: "center",
      borderWidth: 1,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.lg,
      marginTop: 2,
    },
    actionText: { fontSize: 13, fontWeight: "800" },
  });
}
