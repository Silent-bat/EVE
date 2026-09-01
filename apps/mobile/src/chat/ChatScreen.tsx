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
 * Conversations are stored per user on the device. The compact history view is
 * also the navigator: it keeps the main Messages destination useful without
 * bringing a second navigation library into a four-screen app.
 */
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { askAssistant } from "../assistant/api";
import { AIAvatar, BOTTOM_NAV_CLEARANCE, ChatBubble, EmptyState, describeError } from "../ui/components";
import { gradientsFor, withAlpha } from "../ui/gradient";
import { FadeSlideIn, PressableScale } from "../ui/motion";
import { elevation, HIT_SLOP, MIN_TOUCH, radius, spacing } from "../ui/theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../ui/ThemeContext";
import { describeAction } from "../utils/formatters";
import type { AssistantAnswer } from "../types";
import {
  conversationTitle,
  readChatHistory,
  writeChatHistory,
  type ChatConversation,
  type ChatTurn,
} from "./history";

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

export function ChatScreen({ userID }: { userID: string }) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [draft, setDraft] = useState("");
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [activeID, setActiveID] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const seq = useRef(0);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeID) ?? null,
    [activeID, conversations],
  );
  const turns = activeConversation?.turns ?? [];

  useEffect(() => {
    let active = true;
    setHydrated(false);
    setActiveID(null);
    setConversations([]);

    void readChatHistory(userID).then((stored) => {
      if (!active) return;
      setConversations(stored);
      setActiveID(stored[0]?.id ?? null);
      setHydrated(true);
    });

    return () => {
      active = false;
    };
  }, [userID]);

  useEffect(() => {
    if (hydrated) void writeChatHistory(userID, conversations);
  }, [conversations, hydrated, userID]);

  const updateConversation = useCallback(
    (conversationID: string, update: (conversation: ChatConversation) => ChatConversation) => {
      setConversations((current) =>
        current
          .map((conversation) => (conversation.id === conversationID ? update(conversation) : conversation))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      );
    },
    [],
  );

  const send = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (!prompt || busy || !hydrated) return;

      seq.current += 1;
      const now = new Date().toISOString();
      const conversationID = activeID ?? `c-${Date.now()}-${seq.current}`;
      const turnID = `t-${Date.now()}-${seq.current}`;
      const turn: ChatTurn = {
        id: turnID,
        prompt,
        answer: null,
        error: null,
        createdAt: now,
      };

      if (activeID) {
        updateConversation(conversationID, (conversation) => ({
          ...conversation,
          updatedAt: now,
          turns: [...conversation.turns, turn],
        }));
      } else {
        setConversations((current) => [
          {
            id: conversationID,
            title: conversationTitle(prompt),
            createdAt: now,
            updatedAt: now,
            turns: [turn],
          },
          ...current,
        ]);
        setActiveID(conversationID);
      }

      setDraft("");
      setBusy(true);

      try {
        const answer = await askAssistant(prompt);
        updateConversation(conversationID, (conversation) => ({
          ...conversation,
          updatedAt: new Date().toISOString(),
          turns: conversation.turns.map((item) => (item.id === turnID ? { ...item, answer } : item)),
        }));
      } catch (error) {
        updateConversation(conversationID, (conversation) => ({
          ...conversation,
          updatedAt: new Date().toISOString(),
          turns: conversation.turns.map((item) =>
            item.id === turnID ? { ...item, error: describeError(error) } : item,
          ),
        }));
      } finally {
        setBusy(false);
      }
    },
    [activeID, busy, hydrated, updateConversation],
  );

  const newConversation = useCallback(() => {
    if (busy) return;
    setActiveID(null);
    setDraft("");
    setShowHistory(false);
  }, [busy]);

  const removeConversation = useCallback(
    (conversationID: string) => {
      if (busy && conversationID === activeID) return;
      setConversations((current) => current.filter((item) => item.id !== conversationID));
      if (conversationID === activeID) setActiveID(null);
    },
    [activeID, busy],
  );

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.chatNav}>
        <PressableScale
          onPress={() => setShowHistory((current) => !current)}
          hitSlop={HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={showHistory ? "Return to conversation" : "Open message history"}
          style={[styles.navButton, showHistory ? styles.navButtonActive : null]}
        >
          <Ionicons
            name={showHistory ? "chatbubble" : "time-outline"}
            size={20}
            color={showHistory ? palette.textInverse : palette.text}
          />
        </PressableScale>
        <View style={styles.navTitleWrap}>
          <Text style={styles.navTitle}>
            {showHistory ? "History" : (activeConversation?.title ?? "Messages")}
          </Text>
          {!showHistory && turns.length > 0 ? (
            <Text style={styles.navMeta}>
              {turns.length} {turns.length === 1 ? "message" : "messages"}
            </Text>
          ) : null}
        </View>
        <PressableScale
          onPress={newConversation}
          disabled={busy}
          hitSlop={HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel="New conversation"
          accessibilityState={{ disabled: busy }}
          style={styles.navButton}
        >
          <Ionicons name="create-outline" size={21} color={busy ? palette.textMuted : palette.text} />
        </PressableScale>
      </View>

      {showHistory ? (
        <HistoryNavigator
          conversations={conversations}
          activeID={activeID}
          onSelect={(conversationID) => {
            setActiveID(conversationID);
            setShowHistory(false);
          }}
          onDelete={removeConversation}
        />
      ) : (
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
              <ChatBubble author="user" text={turn.prompt} timestamp={formatTurnTime(turn.createdAt)} />
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
      )}

      {!showHistory ? (
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={() => void send(draft)}
          busy={busy || !hydrated}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

function HistoryNavigator({
  conversations,
  activeID,
  onSelect,
  onDelete,
}: {
  conversations: ChatConversation[];
  activeID: string | null;
  onSelect: (conversationID: string) => void;
  onDelete: (conversationID: string) => void;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);

  return (
    <ScrollView contentContainerStyle={styles.history}>
      {conversations.length === 0 ? (
        <EmptyState
          icon="time-outline"
          title="No message history"
          body="Your conversations will appear here."
        />
      ) : (
        conversations.map((conversation) => {
          const lastTurn = conversation.turns[conversation.turns.length - 1];
          const preview = lastTurn?.answer?.answer ?? lastTurn?.error ?? lastTurn?.prompt ?? "";
          const selected = conversation.id === activeID;

          return (
            <View
              key={conversation.id}
              style={[styles.historyRow, selected ? styles.historyRowActive : null]}
            >
              <PressableScale
                onPress={() => onSelect(conversation.id)}
                accessibilityRole="button"
                accessibilityLabel={`Open ${conversation.title}`}
                style={styles.historyMain}
              >
                <View style={styles.historyCopy}>
                  <Text numberOfLines={1} style={styles.historyTitle}>
                    {conversation.title}
                  </Text>
                  <Text numberOfLines={1} style={styles.historyPreview}>
                    {preview}
                  </Text>
                </View>
                <Text style={styles.historyDate}>{formatHistoryDate(conversation.updatedAt)}</Text>
              </PressableScale>
              <PressableScale
                onPress={() => onDelete(conversation.id)}
                hitSlop={HIT_SLOP}
                accessibilityRole="button"
                accessibilityLabel={`Delete ${conversation.title}`}
                style={styles.deleteButton}
              >
                <Ionicons name="trash-outline" size={18} color={palette.textMuted} />
              </PressableScale>
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

function formatTurnTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatHistoryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return formatTurnTime(value);
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
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
          style={[styles.send, { backgroundColor: inert ? palette.surfaceAlt : sendInk }]}
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
    chatNav: {
      minHeight: 62,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
      backgroundColor: palette.background,
    },
    navButton: {
      width: MIN_TOUCH,
      height: MIN_TOUCH,
      borderRadius: radius.pill,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.surface,
    },
    navButtonActive: { backgroundColor: palette.text, borderColor: palette.text },
    navTitleWrap: { flex: 1, minWidth: 0 },
    navTitle: { ...type.title, fontSize: 16 },
    navMeta: { ...type.caption, marginTop: 2 },
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
    history: {
      padding: spacing.lg,
      paddingBottom: BOTTOM_NAV_CLEARANCE,
      gap: spacing.sm,
      flexGrow: 1,
    },
    historyRow: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: 72,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.surface,
    },
    historyRowActive: { borderColor: palette.borderStrong, backgroundColor: palette.surfaceMuted },
    historyMain: {
      flex: 1,
      minWidth: 0,
      minHeight: 70,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingLeft: spacing.lg,
      paddingVertical: spacing.md,
    },
    historyCopy: { flex: 1, minWidth: 0, gap: 4 },
    historyTitle: { ...type.label, fontSize: 14 },
    historyPreview: { ...type.bodyMuted, fontSize: 13 },
    historyDate: { ...type.caption },
    deleteButton: {
      width: MIN_TOUCH,
      height: MIN_TOUCH,
      alignItems: "center",
      justifyContent: "center",
      marginHorizontal: spacing.xs,
    },
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
