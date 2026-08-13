/**
 * Smart Chat — the typed counterpart to the voice screen.
 *
 * Two things separate this from a generic chatbot, and both come from what EVE
 * actually is. First, an answer that ran a tool is rendered as an outcome card
 * rather than a paragraph, because "Draft approved" is an event in the user's
 * mailbox and shouldn't look like conversation. Second, the empty state offers
 * concrete openers drawn from the real capabilities the backend exposes, so the
 * first message doesn't have to be a guess about what EVE can do.
 *
 * History is in-memory by design: this is a scratchpad for asking about today,
 * not a transcript to mine. The voice screen owns the persistent conversation.
 */
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { askAssistant } from "../assistant/api";
import {
  AIAvatar,
  BOTTOM_NAV_CLEARANCE,
  ChatBubble,
  EmptyState,
  describeError,
} from "../ui/components";
import { gradientsFor, withAlpha } from "../ui/gradient";
import { FadeSlideIn, PressableScale } from "../ui/motion";
import { elevation, HIT_SLOP, MIN_TOUCH, radius, spacing } from "../ui/theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../ui/ThemeContext";
import { describeAction } from "../utils/formatters";
import type { AssistantAnswer } from "../types";

/**
 * Openers. Each maps to a capability the API genuinely has, so none of them
 * dead-ends in "I can't do that".
 */
const OPENERS = [
  "What needs my attention today?",
  "Summarise my unread mail",
  "What's on my calendar?",
  "Pull anything new from Gmail",
] as const;

type Turn = {
  id: string;
  prompt: string;
  /** null while in flight. */
  answer: AssistantAnswer | null;
  error: string | null;
};

export function ChatScreen() {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const seq = useRef(0);

  const send = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (!prompt || busy) return;

      seq.current += 1;
      const id = `t${seq.current}`;
      setTurns((prev) => [...prev, { id, prompt, answer: null, error: null }]);
      setDraft("");
      setBusy(true);

      try {
        const answer = await askAssistant(prompt);
        setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, answer } : t)));
      } catch (error) {
        setTurns((prev) =>
          prev.map((t) => (t.id === id ? { ...t, error: describeError(error) } : t)),
        );
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        {turns.length === 0 ? (
          <View style={styles.intro}>
            <EmptyState
              icon="chatbubbles-outline"
              title="Ask EVE anything"
              body="She can see your mail, your meetings, and what she's already drafted for you."
            />
            <View style={styles.openers}>
              {OPENERS.map((opener) => (
                <PressableScale
                  key={opener}
                  onPress={() => void send(opener)}
                  hitSlop={HIT_SLOP}
                  accessibilityRole="button"
                  accessibilityLabel={opener}
                  style={styles.opener}
                >
                  <Text style={styles.openerText}>{opener}</Text>
                  <Ionicons name="arrow-forward" size={13} color={palette.ambient} />
                </PressableScale>
              ))}
            </View>
          </View>
        ) : null}

        {turns.map((turn) => (
          <View key={turn.id} style={styles.turn}>
            <ChatBubble author="user" text={turn.prompt} />
            {turn.error ? (
              <ChatBubble author="eve" text={turn.error} />
            ) : turn.answer ? (
              <AnswerBlock answer={turn.answer} />
            ) : (
              <ChatBubble author="eve" pending />
            )}
          </View>
        ))}
      </ScrollView>

      <Composer value={draft} onChange={setDraft} onSend={() => void send(draft)} busy={busy} />
    </KeyboardAvoidingView>
  );
}

/**
 * EVE's side of a turn. A plain answer is a bubble; an answer that ran a tool
 * gets an outcome card above it, because the action is the more important half.
 */
function AnswerBlock({ answer }: { answer: AssistantAnswer }) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const acted = Boolean(answer.action && answer.action.name !== "answer");

  return (
    <FadeSlideIn style={styles.answer}>
      {acted && answer.action ? (
        <View style={[styles.outcome, { borderColor: withAlpha(palette.success, 0.35) }]}>
          <View style={[styles.outcomeIcon, { backgroundColor: withAlpha(palette.success, 0.14) }]}>
            <Ionicons name="checkmark-done" size={15} color={palette.success} />
          </View>
          <View style={styles.outcomeText}>
            <Text style={styles.outcomeTitle}>{describeAction(answer.action.name)}</Text>
            <Text style={styles.outcomeBody}>EVE ran this for you</Text>
          </View>
        </View>
      ) : null}

      <ChatBubble
        author="eve"
        text={answer.answer}
        footer={
          answer.source === "local" ? (
            <View style={styles.sourceRow}>
              <Ionicons name="cloud-offline-outline" size={11} color={palette.textMuted} />
              <Text style={styles.sourceText}>Answered without the model</Text>
            </View>
          ) : undefined
        }
      />
    </FadeSlideIn>
  );
}

function Composer({
  value,
  onChange,
  onSend,
  busy,
}: {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  busy: boolean;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const inert = !value.trim() || busy;
  // The send button is a primary AI action, so it takes the action gradient's
  // deep end rather than a flat accent.
  const sendInk = gradientsFor(palette).action[1];

  return (
    <View style={styles.composerWrap}>
      <View style={styles.composer}>
        <AIAvatar size="sm" flat />
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder="Message EVE"
          placeholderTextColor={palette.textMuted}
          style={styles.input}
          returnKeyType="send"
          onSubmitEditing={onSend}
          editable={!busy}
          multiline
          accessibilityLabel="Message EVE"
        />
        <PressableScale
          onPress={onSend}
          disabled={inert}
          hitSlop={HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={busy ? "Sending" : "Send"}
          accessibilityState={{ disabled: inert, busy }}
          style={[
            styles.send,
            { backgroundColor: inert ? palette.surfaceAlt : sendInk },
          ]}
        >
          <Ionicons
            name={busy ? "ellipsis-horizontal" : "arrow-up"}
            size={18}
            color={inert ? palette.textMuted : palette.textInverse}
          />
        </PressableScale>
      </View>
    </View>
  );
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    flex: { flex: 1 },
    scroll: {
      padding: spacing.lg,
      paddingBottom: spacing.xl,
      gap: spacing.lg,
      flexGrow: 1,
    },
    intro: { gap: spacing.md, paddingTop: spacing.xl },
    openers: { gap: spacing.sm },
    opener: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: spacing.sm,
      minHeight: MIN_TOUCH,
      paddingHorizontal: spacing.lg,
      backgroundColor: palette.surface,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: palette.border,
    },
    openerText: { ...type.body, flex: 1 },
    turn: { gap: spacing.sm },
    answer: { gap: spacing.sm },
    outcome: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      alignSelf: "flex-start",
      maxWidth: "86%",
      backgroundColor: palette.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      padding: spacing.md,
    },
    outcomeIcon: {
      width: 30,
      height: 30,
      borderRadius: radius.pill,
      alignItems: "center",
      justifyContent: "center",
    },
    outcomeText: { flexShrink: 1, gap: 1 },
    outcomeTitle: { ...type.label },
    outcomeBody: { ...type.caption },
    sourceRow: { flexDirection: "row", alignItems: "center", gap: 4 },
    sourceText: { ...type.caption, fontSize: 11 },
    composerWrap: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: BOTTOM_NAV_CLEARANCE,
      backgroundColor: palette.background,
    },
    composer: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: spacing.sm,
      backgroundColor: palette.surface,
      borderRadius: radius.xxl,
      borderWidth: 1,
      borderColor: palette.border,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      ...elevation.sm,
    },
    input: {
      ...type.body,
      flex: 1,
      maxHeight: 120,
      paddingTop: Platform.OS === "ios" ? 8 : 6,
      paddingBottom: Platform.OS === "ios" ? 8 : 6,
    },
    send: {
      width: 38,
      height: 38,
      borderRadius: radius.pill,
      alignItems: "center",
      justifyContent: "center",
    },
  });
}
