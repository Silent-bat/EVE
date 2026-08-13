/**
 * MailScreen — the whole message.
 *
 * Every list in the app shows EVE's summary of a mail, which is the right thing
 * for scanning and the wrong thing the moment you want to know what somebody
 * actually wrote. This is the screen that answers that: the real body, fetched
 * on tap, with EVE's read kept alongside rather than in place of it.
 *
 * Order is deliberate. The message comes first and EVE's interpretation second,
 * because a summary read before the source frames the source. The draft reply
 * sits last, next to its approve/reject controls — the promise is that nothing
 * is sent unread, so the decision lives at the bottom of the thing you read.
 *
 * The body is never cached. Mail changes, and a stale message is worse than a
 * second of waiting.
 */
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { fetchEmailBody } from "./api";
import { Card, Chip } from "../ui/primitives";
import {
  ErrorState,
  LoadingState,
  TopNav,
  emailUrgencyLabel,
  emailUrgencyTone,
} from "../ui/components";
import { PressableScale } from "../ui/motion";
import { HIT_SLOP, MIN_TOUCH, radius, spacing, type Tone } from "../ui/theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../ui/ThemeContext";
import { initials, longDateTime } from "../utils/formatters";
import type { BriefingEmail, EmailBody, EmailStatus } from "../types";

export function MailScreen({
  email,
  visible,
  saving = false,
  onAction,
  onClose,
}: {
  /** The list row that was tapped. Its fields render while the body loads. */
  email: BriefingEmail | null;
  visible: boolean;
  saving?: boolean;
  onAction?: (emailID: string, status: Exclude<EmailStatus, "pending">) => void;
  onClose: () => void;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);

  const [full, setFull] = useState<EmailBody | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const emailID = email?.id ?? null;

  /**
   * Which fetch is allowed to write. Two paths load a body — the effect below,
   * and the Retry button — and they race each other, not just themselves: fail a
   * fetch, tap Retry, then switch mail before it lands, and the retry resolves
   * holding the previous message's body. A flag scoped to one of them cannot see
   * the other, so both claim a number here and only the current claimant writes.
   * Anything older has been overtaken and stays silent.
   */
  const request = useRef(0);

  const load = useCallback(async () => {
    if (!emailID) return;
    const token = (request.current += 1);
    setLoading(true);
    setError(null);
    try {
      const body = await fetchEmailBody(emailID);
      if (request.current === token) setFull(body);
    } catch (err) {
      if (request.current === token) setError(err);
    } finally {
      if (request.current === token) setLoading(false);
    }
  }, [emailID]);

  // Keyed on the id, not the object: re-opening the same mail should refetch,
  // and a new object identity for the same mail should not.
  //
  // Why the guard above matters here: open one message, tap back, open another
  // before the first request lands, and without it the slow response overwrites
  // the fast one — leaving the second message's header above the first message's
  // body, which reads as EVE showing you someone else's mail.
  useEffect(() => {
    if (!visible || !emailID) return;
    // Clear immediately so the previous message's body is never shown under the
    // new one's header, even for the frame before the fetch resolves.
    setFull(null);
    void load();
    return () => {
      // Closing the sheet or switching mail retires whatever is in flight.
      request.current += 1;
    };
  }, [visible, emailID, load]);

  if (!email) return null;

  const shown = full ?? email;
  const tone = emailUrgencyTone(shown.urgencyScore);
  const pending = shown.status === "pending";

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        <TopNav title="Message" onBack={onClose} backIcon="close" backLabel="Close message" />

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <Text style={styles.subject}>{shown.subject}</Text>

          <View style={styles.from}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initials(shown.senderName || shown.senderEmail || "?")}</Text>
            </View>
            <View style={styles.fromText}>
              <Text style={styles.senderName} numberOfLines={1}>
                {shown.senderName || shown.senderEmail || "Unknown sender"}
              </Text>
              {shown.senderEmail && shown.senderName ? (
                <Text style={styles.senderEmail} numberOfLines={1}>
                  {shown.senderEmail}
                </Text>
              ) : null}
              {shown.receivedAt ? (
                <Text style={styles.received}>{longDateTime(shown.receivedAt)}</Text>
              ) : null}
            </View>
          </View>

          <View style={styles.chips}>
            <Chip label={emailUrgencyLabel(shown.urgencyScore)} tone={tone} compact />
            <Chip label={statusLabel(shown.status)} tone={statusTone(shown.status)} compact />
          </View>

          <MessageBody full={full} loading={loading} error={error} onRetry={load} />

          {shown.summary ? (
            <Card style={styles.read}>
              <View style={styles.readHeader}>
                <Ionicons name="sparkles" size={13} color={palette.ambient} />
                <Text style={styles.readLabel}>EVE's read</Text>
              </View>
              <Text style={styles.readBody}>{shown.summary}</Text>
              {shown.urgencyReason ? (
                <Text style={styles.readWhy}>Flagged because: {shown.urgencyReason}</Text>
              ) : null}
            </Card>
          ) : null}

          {shown.draftReply ? (
            <Card style={styles.draft}>
              <View style={styles.readHeader}>
                <Ionicons name="create-outline" size={13} color={palette.ambient} />
                <Text style={styles.readLabel}>
                  {pending ? "Draft reply — not sent" : "Draft reply"}
                </Text>
              </View>
              <Text style={styles.draftBody}>{shown.draftReply}</Text>

              {pending && onAction ? (
                <View style={styles.actions}>
                  <DecisionButton
                    label="Reject"
                    icon="close"
                    tone="danger"
                    disabled={saving}
                    hint={`Discard the draft reply to ${shown.senderName || "this sender"}`}
                    onPress={() => onAction(shown.id, "rejected")}
                  />
                  <DecisionButton
                    label="Approve & send"
                    icon="checkmark"
                    tone="success"
                    disabled={saving}
                    hint={`Send EVE's reply to ${shown.senderName || "this sender"}`}
                    onPress={() => onAction(shown.id, "approved")}
                  />
                </View>
              ) : (
                <Text style={styles.decided}>
                  {shown.status === "approved"
                    ? "You approved this — it has been sent."
                    : "You rejected this — nothing was sent."}
                </Text>
              )}
            </Card>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

/**
 * The message itself, in its four possible conditions: loading, failed,
 * withheld by Gmail, or there. The withheld case is not an error — it means the
 * account isn't connected — so it reads as an explanation, not a failure.
 */
function MessageBody({
  full,
  loading,
  error,
  onRetry,
}: {
  full: EmailBody | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);

  if (loading && !full) {
    return (
      <Card style={styles.body}>
        <LoadingState label="Fetching the message" cards={0} />
      </Card>
    );
  }

  if (error) {
    return (
      <Card style={styles.body}>
        <ErrorState error={error} onRetry={onRetry} subject="Messages" />
      </Card>
    );
  }

  if (full && !full.bodyAvailable) {
    return (
      <Card style={styles.body}>
        <View style={styles.notice}>
          <Ionicons name="cloud-offline-outline" size={16} color={palette.textMuted} />
          <Text style={styles.noticeText}>
            {full.reason || "The full message isn't available"}. EVE's summary is below.
          </Text>
        </View>
      </Card>
    );
  }

  if (!full) return null;

  return (
    <Card style={styles.body}>
      {/* Selectable: quoting a line back to someone is the most likely thing
          anyone wants to do on this screen. */}
      <Text style={styles.bodyText} selectable>
        {full.body}
      </Text>
    </Card>
  );
}

function DecisionButton({
  label,
  icon,
  tone,
  disabled,
  hint,
  onPress,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  tone: Tone;
  disabled?: boolean;
  hint?: string;
  onPress: () => void;
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
      style={[
        styles.action,
        { backgroundColor: toneSurface(tone) },
        disabled ? styles.disabled : null,
      ]}
    >
      <Ionicons name={icon} size={16} color={ink} />
      <Text style={[styles.actionText, { color: ink }]}>{label}</Text>
    </PressableScale>
  );
}

function statusLabel(status: EmailStatus): string {
  if (status === "approved") return "Reply sent";
  if (status === "rejected") return "Dismissed";
  return "Awaiting you";
}

function statusTone(status: EmailStatus): Tone {
  if (status === "approved") return "success";
  if (status === "rejected") return "neutral";
  return "warning";
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: palette.background },
    content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
    subject: { ...type.title, fontSize: 21, lineHeight: 28 },
    from: { flexDirection: "row", alignItems: "center", gap: spacing.md },
    avatar: {
      width: 44,
      height: 44,
      borderRadius: radius.pill,
      backgroundColor: palette.surfaceAlt,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarText: { ...type.label, fontSize: 14, color: palette.text },
    fromText: { flex: 1, gap: 1 },
    senderName: { ...type.label, fontSize: 15 },
    senderEmail: { ...type.caption, fontSize: 12 },
    received: { ...type.caption, fontSize: 11 },
    chips: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
    body: { gap: spacing.sm },
    // Roomier than body copy elsewhere: this is the one place in the app
    // somebody reads several paragraphs rather than scanning a card.
    bodyText: { ...type.body, lineHeight: 23 },
    notice: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
    noticeText: { ...type.caption, flex: 1, lineHeight: 18 },
    read: { gap: 6, backgroundColor: palette.surfaceMuted },
    readHeader: { flexDirection: "row", alignItems: "center", gap: 5 },
    readLabel: {
      ...type.caption,
      color: palette.ambient,
      textTransform: "uppercase",
      letterSpacing: 0.4,
    },
    readBody: { ...type.body },
    readWhy: { ...type.caption },
    draft: { gap: spacing.sm },
    draftBody: { ...type.body, lineHeight: 22 },
    decided: { ...type.caption },
    actions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
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
  });
}
