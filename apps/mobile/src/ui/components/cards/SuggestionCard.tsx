/**
 * An EVE suggestion — one proactive thought she raised on her own.
 *
 * This is the card that most needs to look like it came from EVE rather than
 * from the user's mail, so it's the tinted variant with her avatar. The feedback
 * controls matter more than they look: "not now" and "never" are how the
 * proactive engine learns, and burying them would leave it guessing forever.
 */
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";

import { CardShell } from "./CardShell";
import { AIAvatar } from "../AIAvatar";
import { Chip } from "../../primitives";
import { PressableScale } from "../../motion";
import { HIT_SLOP, MIN_TOUCH, radius, spacing } from "../../theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../../ThemeContext";
import { relativeTime } from "../../../utils/formatters";
import { CATEGORY_META, urgencyLabel, urgencyTone } from "../../../proactive/categories";
import type { ProactiveThought } from "../../../types";

export function SuggestionCard({
  thought,
  onPress,
  onDismiss,
  onHelpful,
}: {
  thought: ProactiveThought;
  onPress?: () => void;
  onDismiss?: () => void;
  onHelpful?: () => void;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const meta = CATEGORY_META[thought.category];
  const tone = urgencyTone(thought.urgency);
  const unread = thought.status === "new";

  const content = (
    <>
      <View style={styles.header}>
        <AIAvatar size="sm" />
        <View style={styles.headerText}>
          <View style={styles.titleRow}>
            {unread ? <View style={styles.unreadDot} /> : null}
            <Text style={styles.title} numberOfLines={2}>
              {thought.title}
            </Text>
          </View>
          <View style={styles.metaRow}>
            <Ionicons name={meta.icon} size={11} color={palette.textMuted} />
            <Text style={styles.meta}>{meta.label}</Text>
            <Text style={styles.meta}>·</Text>
            <Text style={styles.meta}>{relativeTime(thought.createdAt)}</Text>
          </View>
        </View>
        {thought.urgency === "high" || thought.urgency === "critical" ? (
          <Chip label={urgencyLabel(thought.urgency)} tone={tone} compact />
        ) : null}
      </View>

      <Text style={styles.text}>{thought.body}</Text>
    </>
  );

  return (
    <CardShell tinted style={styles.card}>
      {/* The feedback buttons sit outside this pressable on purpose. An
          `accessible` container hides its descendants from a screen reader, so
          wrapping the whole card would make "Helpful" and "Not now"
          unreachable for anyone using one. */}
      {onPress ? (
        <PressableScale
          onPress={onPress}
          scaleTo={0.985}
          accessible
          accessibilityRole="button"
          accessibilityLabel={`EVE suggests: ${thought.title}. ${thought.body}`}
          accessibilityHint="Opens this suggestion"
          style={styles.body}
        >
          {content}
        </PressableScale>
      ) : (
        <View style={styles.body}>{content}</View>
      )}

      {onHelpful || onDismiss ? (
        <View style={styles.feedback}>
          {onHelpful ? (
            <FeedbackButton
              icon="thumbs-up-outline"
              label="Helpful"
              onPress={onHelpful}
              active={thought.feedback === "helpful"}
            />
          ) : null}
          {onDismiss ? (
            <FeedbackButton icon="close" label="Not now" onPress={onDismiss} />
          ) : null}
        </View>
      ) : null}
    </CardShell>
  );
}

function FeedbackButton({
  icon,
  label,
  onPress,
  active = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  active?: boolean;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const ink = active ? palette.ambient : palette.textMuted;

  return (
    <PressableScale
      onPress={onPress}
      hitSlop={HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      style={[styles.feedbackButton, active ? { borderColor: palette.ambient } : null]}
    >
      <Ionicons name={icon} size={13} color={ink} />
      <Text style={[styles.feedbackText, { color: ink }]}>{label}</Text>
    </PressableScale>
  );
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    card: { gap: spacing.md },
    body: { gap: spacing.md },
    header: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
    headerText: { flex: 1, gap: 3 },
    titleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    unreadDot: {
      width: 7,
      height: 7,
      borderRadius: radius.pill,
      backgroundColor: palette.ambient,
    },
    title: { ...type.title, flex: 1 },
    metaRow: { flexDirection: "row", alignItems: "center", gap: 4 },
    meta: { ...type.caption },
    text: { ...type.body, color: palette.text, opacity: 0.9 },
    feedback: { flexDirection: "row", gap: spacing.sm },
    feedbackButton: {
      minHeight: MIN_TOUCH - 8,
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: spacing.md,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: palette.borderStrong,
    },
    feedbackText: { fontSize: 12, fontWeight: "700" },
  });
}
