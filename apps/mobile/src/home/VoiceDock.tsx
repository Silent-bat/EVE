/**
 * VoiceDock — EVE listening, from the moment the app opens.
 *
 * This replaced a text box. The setting behind it promised that EVE was
 * reachable without leaving home, and a composer technically delivered that
 * while missing the point: you still had to type, which is the slowest way to
 * ask anything and the least like talking to someone. Now the microphone is
 * simply open. You speak, she answers aloud, and the mic re-arms — no button.
 *
 * ## The turn, end to end
 *
 * `useAlwaysListening` watches the input level and hands over a clip when you
 * stop talking. That clip goes through the existing `/v1/voice/transcribe`
 * route, and the text goes into the live session over `sendText`. Her reply
 * arrives as streamed transcript plus 24kHz PCM, which `useSpeaker` plays.
 *
 * It is deliberately the same path the voice screen uses, and worth being plain
 * about why it isn't a true duplex stream: nothing installed here can stream PCM
 * up to the model, so a turn is a recorded clip transcribed and sent, not live
 * audio. The difference you can feel is about a second of latency after you stop
 * speaking. The difference you can't is that barge-in doesn't work mid-answer —
 * she has to finish before the mic reopens.
 *
 * ## Why she doesn't answer herself
 *
 * The mic is only armed while the session is idle and the speaker is silent.
 * Everything else — connecting, thinking, speaking — holds it closed, which is
 * what stops her voice from being heard as your next question. `Pause` closes
 * both the mic and the socket, because a session held open costs something and
 * a paused assistant should not be quietly billing for a connection.
 */
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { ParticleField, describeError, type FieldState } from "../ui/components";
import { PressableScale } from "../ui/motion";
import { elevation, HIT_SLOP, radius, spacing } from "../ui/theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../ui/ThemeContext";
import { transcribeAudio } from "../voice/api";
import { useAlwaysListening } from "../voice/useAlwaysListening";
import { useGeminiLive } from "../voice/useGeminiLive";
import { useSpeaker } from "../voice/useSpeaker";

export function VoiceDock({
  onError,
  onOpenVoice,
  onOpenChat,
}: {
  onError: (message: string) => void;
  onOpenVoice?: () => void;
  onOpenChat?: () => void;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);

  const [paused, setPaused] = useState(false);
  const [sending, setSending] = useState(false);

  const speaker = useSpeaker(onError);
  const live = useGeminiLive({
    enabled: !paused,
    onError,
    onAudioResponse: speaker.play,
  });

  // Armed only in the gap between turns. See the docblock — this is the whole
  // reason she doesn't hear her own answer and reply to it. `busy` rather than
  // `playing`: the audio takes a moment to reach the player, and gating on
  // `playing` reopened the mic during exactly that moment.
  const ready = live.status === "idle" && !speaker.busy && !sending;

  const onUtterance = useCallback(
    async (clip: { audio: string; mimeType: string }) => {
      setSending(true);
      try {
        const { text, accepted } = await transcribeAudio({
          audio: clip.audio,
          mimeType: clip.mimeType,
        });
        if (accepted === false) return;
        const heard = text.trim();
        // Silence that cleared the level gate still transcribes to nothing.
        // Saying so would be noise; dropping it re-arms as if you hadn't spoken.
        if (heard) live.sendText(heard);
      } catch (error) {
        onError(describeError(error));
      } finally {
        setSending(false);
      }
    },
    [live, onError],
  );

  const listen = useAlwaysListening({
    active: !paused && ready,
    onUtterance,
    onError,
  });

  const blocked = listen.phase === "blocked";

  function togglePause() {
    const next = !paused;
    setPaused(next);
    if (next) speaker.stop();
  }
  const field: FieldState = speaker.busy
    ? "speaking"
    : live.status === "thinking" || sending
      ? "thinking"
      : listen.phase === "hearing"
        ? "listening"
        : "idle";

  /* Whichever of the two is actually making sound. `ready` above closes the mic
     for the whole of EVE's turn, so `listen.level` is flat zero while she talks —
     passing it unconditionally left the orb sitting perfectly still through the
     one moment it most obviously should move. The speaker measures its own
     output; see useSpeaker's level. */
  const level = field === "speaking" ? speaker.level : listen.level;

  // The last thing said, whoever said it. One line, because the dock sits above
  // the day's actual contents and a growing transcript would push them off.
  const caption = useMemo(() => lastTurn(live.turns), [live.turns]);

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <View style={styles.fieldSlot}>
          <ParticleField
            state={field}
            level={level}
            size={FIELD}
            count={18}
            backdrop={palette.surface}
          />
        </View>

        <View style={styles.copy}>
          <Text style={styles.status} accessibilityLiveRegion="polite">
            {headline({ paused, blocked, field, phase: listen.phase, status: live.status })}
          </Text>
          <Text style={styles.caption} numberOfLines={2}>
            {blocked
              ? "Allow the microphone in system settings to talk to EVE from here."
              : caption || "Say anything — no button to hold."}
          </Text>
        </View>

        <PressableScale
          onPress={togglePause}
          hitSlop={HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={paused ? "Start listening" : "Stop listening"}
          style={[styles.toggle, paused ? styles.toggleOff : null]}
        >
          <Ionicons
            name={paused ? "mic-off-outline" : "mic"}
            size={20}
            color={paused ? palette.textMuted : palette.textInverse}
          />
        </PressableScale>
      </View>

      <View style={styles.links}>
        <PressableScale
          onPress={onOpenVoice}
          hitSlop={HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel="Open the full voice screen"
          style={styles.link}
        >
          <Ionicons name="expand-outline" size={15} color={palette.ambient} />
          <Text style={styles.linkText}>Full screen</Text>
        </PressableScale>
        <PressableScale
          onPress={onOpenChat}
          hitSlop={HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel="Type to EVE instead"
          style={styles.link}
        >
          <Ionicons name="chatbubble-ellipses-outline" size={15} color={palette.ambient} />
          <Text style={styles.linkText}>Type instead</Text>
        </PressableScale>
      </View>
    </View>
  );
}

/** Field diameter. Small enough that the dock stays a strip, not a screen. */
const FIELD = 76;

function lastTurn(turns: { role: "user" | "agent"; text: string }[]): string {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const text = turns[i]?.text.trim();
    if (text) return text;
  }
  return "";
}

/**
 * One line naming the current state. Phrased as what EVE is doing rather than
 * what the machine is doing — "Listening", not "Recording".
 */
function headline({
  paused,
  blocked,
  field,
  phase,
  status,
}: {
  paused: boolean;
  blocked: boolean;
  field: FieldState;
  phase: string;
  status: string;
}): string {
  if (blocked) return "Microphone blocked";
  if (paused) return "Paused";
  if (status === "error") return "Reconnecting";
  if (status === "connecting") return "Waking up…";
  if (field === "speaking") return "EVE is speaking";
  if (field === "thinking") return "Thinking…";
  if (phase === "hearing") return "Listening…";
  if (phase === "waiting") return "Listening for you";
  return "Ready when you are";
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    card: {
      backgroundColor: palette.surface,
      borderRadius: radius.xl,
      borderWidth: 1,
      borderColor: palette.border,
      padding: spacing.lg,
      gap: spacing.md,
      ...elevation.sm,
    },
    row: { flexDirection: "row", alignItems: "center", gap: spacing.md },
    // Fixed box so the row doesn't reflow as the field's motes swing outward.
    fieldSlot: { width: FIELD, height: FIELD, alignItems: "center", justifyContent: "center" },
    copy: { flex: 1, gap: 2 },
    status: { ...type.title, fontSize: 16 },
    caption: { ...type.caption },
    toggle: {
      width: 44,
      height: 44,
      borderRadius: radius.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: palette.ambient,
    },
    toggleOff: { backgroundColor: palette.surfaceMuted },
    links: { flexDirection: "row", gap: spacing.xl },
    link: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingVertical: 2 },
    linkText: { ...type.label, fontSize: 13, color: palette.ambient },
  });
}
