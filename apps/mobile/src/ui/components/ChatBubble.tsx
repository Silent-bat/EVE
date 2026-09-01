/**
 * Chat surfaces.
 *
 * `ChatBubble` carries plain conversational turns. EVE's replies sit left in a
 * white card with her avatar; the user's sit right in a purple pill. Structured
 * answers — the ones with sources, actions, or a list of emails behind them —
 * do not belong in a bubble and get a card instead (see `AnswerCard`).
 *
 * `VoiceMessage` is the transcript of something spoken, shown with a static
 * waveform so a voice turn is distinguishable from a typed one at a glance.
 */
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { AIAvatar } from "./AIAvatar";
import { withAlpha } from "../gradient";
import { FadeSlideIn } from "../motion";
import { elevation, radius, spacing } from "../theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../ThemeContext";

export type ChatAuthor = "eve" | "user";

export function ChatBubble({
  author,
  text,
  /** Rendered under the text — chips, actions, a source list. */
  footer,
  /** Shown instead of text while EVE composes a reply. */
  pending = false,
  timestamp,
}: {
  author: ChatAuthor;
  text?: string;
  footer?: ReactNode;
  pending?: boolean;
  timestamp?: string;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const fromEve = author === "eve";

  return (
    <FadeSlideIn style={fromEve ? styles.rowLeft : styles.rowRight}>
      {fromEve ? <AIAvatar size="sm" flat style={styles.avatar} /> : null}
      <View style={styles.column}>
        <View
          style={[
            styles.bubble,
            fromEve ? styles.bubbleEve : styles.bubbleUser,
            fromEve ? null : { backgroundColor: palette.ambient },
          ]}
        >
          {pending ? (
            <TypingDots />
          ) : (
            <Text
              style={[styles.text, fromEve ? null : { color: palette.textInverse }]}
              // The bubble already reads as a message; naming the speaker is
              // what a screen reader is missing.
              accessibilityLabel={`${fromEve ? "EVE" : "You"}: ${text ?? ""}`}
            >
              {text}
            </Text>
          )}
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </View>
        {timestamp ? (
          <Text style={[styles.timestamp, fromEve ? null : styles.timestampRight]}>{timestamp}</Text>
        ) : null}
      </View>
    </FadeSlideIn>
  );
}

/**
 * Three dots at rest. Deliberately static rather than animated: this appears
 * for a second or two at a time, and a looping animation that short reads as
 * flicker. The `busy` accessibility state carries the meaning instead.
 */
function TypingDots() {
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      style={styles.dots}
      accessibilityRole="progressbar"
      accessibilityLabel="EVE is thinking"
      accessibilityState={{ busy: true }}
    >
      <View style={styles.dot} />
      <View style={[styles.dot, styles.dotMid]} />
      <View style={styles.dot} />
    </View>
  );
}

export function VoiceMessage({
  author,
  transcript,
  duration,
}: {
  author: ChatAuthor;
  transcript: string;
  /** Formatted for display, e.g. "0:12". */
  duration?: string;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const fromEve = author === "eve";
  const tint = fromEve ? palette.ambient : palette.textInverse;

  return (
    <ChatBubble
      author={author}
      text={transcript}
      footer={
        <View style={styles.voiceRow}>
          {/* Static bars: this is a record of a finished utterance, not a live
              level, so animating it would be a lie about what's happening. */}
          <View style={styles.voiceBars}>
            {[0.4, 0.75, 0.5, 1, 0.6, 0.85, 0.45].map((weight, i) => (
              <View
                key={i}
                style={[styles.voiceBar, { height: 18 * weight, backgroundColor: withAlpha(tint, 0.65) }]}
              />
            ))}
          </View>
          {duration ? (
            <Text style={[styles.duration, { color: withAlpha(tint, 0.8) }]}>{duration}</Text>
          ) : null}
        </View>
      }
    />
  );
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    rowLeft: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: spacing.sm,
      marginBottom: spacing.lg,
      maxWidth: "88%",
      alignSelf: "flex-start",
    },
    rowRight: {
      flexDirection: "row",
      alignItems: "flex-end",
      marginBottom: spacing.lg,
      maxWidth: "82%",
      alignSelf: "flex-end",
    },
    avatar: { marginBottom: 2 },
    column: { flexShrink: 1 },
    bubble: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg, gap: spacing.sm },
    // Asymmetric corners: the corner nearest the speaker is tightened so the
    // bubble points back at whoever said it.
    bubbleEve: {
      backgroundColor: palette.surface,
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: radius.xl,
      borderBottomLeftRadius: radius.xs,
      ...elevation.sm,
    },
    bubbleUser: { borderRadius: radius.xl, borderBottomRightRadius: radius.xs },
    text: { ...type.body, lineHeight: 22 },
    footer: { marginTop: 2 },
    timestamp: { ...type.caption, marginTop: 4, marginLeft: spacing.xs },
    timestampRight: { textAlign: "right", marginRight: spacing.xs },
    dots: { flexDirection: "row", gap: 5, paddingVertical: 6 },
    dot: {
      width: 7,
      height: 7,
      borderRadius: radius.pill,
      backgroundColor: palette.textMuted,
      opacity: 0.45,
    },
    dotMid: { opacity: 0.75 },
    voiceRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
    voiceBars: { flexDirection: "row", alignItems: "center", gap: 3, height: 20 },
    voiceBar: { width: 3, borderRadius: radius.pill },
    duration: { fontSize: 11, fontWeight: "700" },
  });
}
