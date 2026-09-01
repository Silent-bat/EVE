/**
 * Email cards.
 *
 * `AttentionCard` is the loud one: a pending draft that EVE wants a decision on.
 * It carries the approve/reject controls that used to own their own tab, and it
 * shows the draft inline — the whole promise of the product is that nothing goes
 * out unread, so the text being approved has to be visible at the point of
 * approval, not one tap away.
 *
 * `EmailCard` is the quiet one: a row in the full list, no actions.
 */
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";

import { CardShell } from "./CardShell";
import { Chip } from "../../primitives";
import { PressableScale } from "../../motion";
import { HIT_SLOP, MIN_TOUCH, radius, spacing, type Tone } from "../../theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../../ThemeContext";
import { initials, relativeTime } from "../../../utils/formatters";
import type { BriefingEmail } from "../../../types";

/**
 * Urgency is scored 0–100 by the backend. These are the bands the UI shows.
 *
 * `HIGH_SCORE` is the one number that decides whether a mail is worth flagging,
 * and it is exported because more than one surface has to agree about it: the
 * chip on this card and the counter at the top of the same screen were computed
 * from two different thresholds, so nine mails could wear a HIGH chip under a
 * tile reading "0 high priority". Anything counting urgent mail imports this.
 */
export const HIGH_SCORE = 55;
export const CRITICAL_SCORE = 80;

export function emailUrgencyTone(score: number): Tone {
  if (score >= CRITICAL_SCORE) return "danger";
  if (score >= HIGH_SCORE) return "warning";
  return "info";
}

export function emailUrgencyLabel(score: number): string {
  if (score >= CRITICAL_SCORE) return "Critical";
  if (score >= HIGH_SCORE) return "High";
  if (score >= 30) return "Medium";
  return "Low";
}

/** How many of these need looking at. The tile and the chips share this. */
export function countHighPriority(emails: { urgencyScore: number }[]): number {
  return emails.filter((email) => email.urgencyScore >= HIGH_SCORE).length;
}

function Avatar({ name }: { name: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.avatar}>
      <Text style={styles.avatarText}>{initials(name || "?")}</Text>
    </View>
  );
}

export function AttentionCard({
  email,
  onApprove,
  onReject,
  onPress,
  busy = false,
}: {
  email: BriefingEmail;
  onApprove: () => void;
  onReject: () => void;
  /** Opens the full thread. Optional — the card is useful without it. */
  onPress?: () => void;
  busy?: boolean;
}) {
  const { palette, toneAccent } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const tone = emailUrgencyTone(email.urgencyScore);

  return (
    <CardShell
      accent={toneAccent(tone)}
      accessibilityLabel={`${emailUrgencyLabel(email.urgencyScore)} priority. From ${email.senderName}. ${email.subject}`}
      style={styles.card}
    >
      <View style={styles.header}>
        <Avatar name={email.senderName} />
        <View style={styles.headerText}>
          <Text style={styles.sender} numberOfLines={1}>
            {email.senderName}
          </Text>
          <Text style={styles.subject} numberOfLines={2}>
            {email.subject}
          </Text>
        </View>
        <Text style={styles.age}>{relativeTime(email.receivedAt)}</Text>
      </View>

      <View style={styles.chips}>
        <Chip label={emailUrgencyLabel(email.urgencyScore)} tone={tone} compact />
        {email.urgencyReason ? (
          <Text style={styles.reason} numberOfLines={1}>
            {email.urgencyReason}
          </Text>
        ) : null}
      </View>

      {email.summary ? (
        <Text style={styles.summary} numberOfLines={3}>
          {email.summary}
        </Text>
      ) : null}

      {email.draftReply ? (
        <View style={styles.draft}>
          <View style={styles.draftHeader}>
            <Ionicons name="sparkles" size={12} color={palette.ambient} />
            <Text style={styles.draftLabel}>EVE's draft reply</Text>
          </View>
          <Text style={styles.draftBody} numberOfLines={4}>
            {email.draftReply}
          </Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        <ActionButton
          label="Reject"
          icon="close"
          tone="danger"
          onPress={onReject}
          disabled={busy}
          hint={`Discard the draft reply to ${email.senderName}`}
        />
        <ActionButton
          label="Approve & send"
          icon="checkmark"
          tone="success"
          onPress={onApprove}
          disabled={busy}
          hint={`Send EVE's reply to ${email.senderName}`}
        />
      </View>

      {onPress ? (
        <PressableScale
          onPress={onPress}
          hitSlop={HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel="Open full thread"
          style={styles.openRow}
        >
          <Text style={styles.openText}>Open full thread</Text>
          <Ionicons name="chevron-forward" size={13} color={palette.textMuted} />
        </PressableScale>
      ) : null}
    </CardShell>
  );
}

/**
 * Approve/reject. Kept local to this file — these two buttons only ever appear
 * side by side on this card, and the previous standalone component was used
 * exactly once.
 */
function ActionButton({
  label,
  icon,
  tone,
  onPress,
  disabled,
  hint,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  tone: Tone;
  onPress: () => void;
  disabled?: boolean;
  hint?: string;
}) {
  const { toneSurface, toneInk } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const ink = toneInk(tone);

  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      hitSlop={HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={[styles.action, { backgroundColor: toneSurface(tone) }, disabled ? styles.disabled : null]}
    >
      <Ionicons name={icon} size={16} color={ink} />
      <Text style={[styles.actionText, { color: ink }]}>{label}</Text>
    </PressableScale>
  );
}

export function EmailCard({ email, onPress }: { email: BriefingEmail; onPress?: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const tone = emailUrgencyTone(email.urgencyScore);

  const statusTone: Tone =
    email.status === "approved" ? "success" : email.status === "rejected" ? "neutral" : "warning";
  const statusLabel =
    email.status === "approved" ? "Sent" : email.status === "rejected" ? "Dismissed" : "Awaiting you";

  return (
    <CardShell
      onPress={onPress}
      accessibilityLabel={`From ${email.senderName}. ${email.subject}. ${statusLabel}.`}
      accessibilityHint={onPress ? "Opens the message" : undefined}
      style={styles.compact}
    >
      <View style={styles.header}>
        <Avatar name={email.senderName} />
        <View style={styles.headerText}>
          <Text style={styles.sender} numberOfLines={1}>
            {email.senderName}
          </Text>
          <Text style={styles.subjectQuiet} numberOfLines={1}>
            {email.subject}
          </Text>
        </View>
        <Text style={styles.age}>{relativeTime(email.receivedAt)}</Text>
      </View>
      {email.summary ? (
        <Text style={styles.summary} numberOfLines={2}>
          {email.summary}
        </Text>
      ) : null}
      <View style={styles.chips}>
        <Chip label={statusLabel} tone={statusTone} compact />
        <Chip label={emailUrgencyLabel(email.urgencyScore)} tone={tone} compact />
      </View>
    </CardShell>
  );
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    card: { gap: spacing.md },
    compact: { gap: spacing.sm },
    header: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
    headerText: { flex: 1, gap: 2 },
    avatar: {
      width: 40,
      height: 40,
      borderRadius: radius.pill,
      backgroundColor: palette.surfaceAlt,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarText: { ...type.label, fontSize: 13, color: palette.text },
    sender: { ...type.label },
    subject: { ...type.body, fontWeight: "600" },
    subjectQuiet: { ...type.bodyMuted },
    age: { ...type.caption, marginTop: 2 },
    chips: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
    reason: { ...type.caption, flexShrink: 1 },
    summary: { ...type.bodyMuted },
    draft: {
      backgroundColor: palette.surfaceMuted,
      borderRadius: radius.lg,
      padding: spacing.md,
      gap: 6,
    },
    draftHeader: { flexDirection: "row", alignItems: "center", gap: 5 },
    draftLabel: {
      ...type.caption,
      color: palette.ambient,
      textTransform: "uppercase",
      letterSpacing: 0.4,
    },
    draftBody: { ...type.bodyMuted, color: palette.text },
    actions: { flexDirection: "row", gap: spacing.sm },
    action: {
      flex: 1,
      minHeight: MIN_TOUCH,
      borderRadius: radius.pill,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingHorizontal: spacing.md,
    },
    actionText: { fontSize: 13, fontWeight: "800" },
    disabled: { opacity: 0.45 },
    openRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4 },
    openText: { ...type.caption, fontWeight: "700" },
  });
}
