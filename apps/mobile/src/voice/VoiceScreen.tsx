/**
 * VoiceScreen — full-screen modal conversation with EVE, now wired to
 * the realtime Gemini Live bridge (/v1/voice/live).
 *
 * Data flow per turn:
 *   1. useAlwaysListening detects speech and captures an m4a clip
 *   2. A short silence ends the turn → POST /v1/voice/transcribe
 *   3. Transcript text → useGeminiLive.sendText → upstream WS
 *   4. Gemini streams back transcript deltas + 24kHz PCM audio chunks
 *   5. On turn-complete we wrap accumulated PCM in a WAV header and
 *      play it via expo-audio's AudioPlayer
 *
 * Wins over the previous flow:
 *   - One round trip for the response (was: transcribe, then assistant/ask)
 *   - Tools work natively (Gemini Live calls them server-side)
 *   - Memory + briefing context live in the session-setup system prompt
 *   - Transcript renders live as the model speaks
 *
 * This is hands-free turn taking rather than full duplex: the microphone is
 * open while EVE is idle, closes while she thinks or speaks, then re-arms.
 * That prevents her loudspeaker output from becoming the next user turn.
 *
 * The stage is a `ParticleField` rather than a solid orb: a cloud of motes can
 * look agitated, which is what reads as a voice, where a sphere can only get
 * bigger. It takes the recorder's amplitude while listening and the speaker's
 * measured envelope while EVE talks — expo-audio exposes no output level, so
 * that one is computed from her PCM before it plays. See useSpeaker.
 */
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ChatBubble, ParticleField, TopNav, Waveform, type FieldState } from "../ui/components";
import { radius, spacing } from "../ui/theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../ui/ThemeContext";
import { transcribeAudio } from "./api";
import { useAlwaysListening, type ListenPhase } from "./useAlwaysListening";
import { useGeminiLive } from "./useGeminiLive";
import { useSpeaker } from "./useSpeaker";

type Status = "connecting" | "idle" | "listening" | "encoding" | "thinking" | "speaking" | "error";

type Props = {
  visible: boolean;
  onClose: () => void;
};

export function VoiceScreen({ visible, onClose }: Props) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [paused, setPaused] = useState(false);
  const scrollRef = useRef<ScrollView | null>(null);

  // Playback lives in useSpeaker, shared with the home dock — including the two
  // fixes that were learned here: leaving record mode so the answer comes from
  // the speaker, and constructing the player with its URI rather than calling
  // `replace`, which resolved after `play()` and produced silence.
  const speaker = useSpeaker(setErrorMessage);
  const live = useGeminiLive({
    enabled: visible,
    onError: (msg) => setErrorMessage(msg),
    onAudioResponse: speaker.play,
  });

  const onUtterance = useCallback(
    async (clip: { audio: string; mimeType: string }) => {
      setSending(true);
      setErrorMessage(null);
      try {
        const { text, accepted } = await transcribeAudio({
          audio: clip.audio,
          mimeType: clip.mimeType,
        });
        if (accepted === false) return;
        const transcript = text.trim();
        if (!transcript) return;
        if (!live.sendText(transcript)) {
          setErrorMessage("Voice connection isn't ready.");
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Voice request failed");
      } finally {
        setSending(false);
      }
    },
    [live],
  );

  // The mic owns the idle gap only. It closes before transcription begins and
  // stays closed until EVE's audio has completely finished playing.
  const readyToListen =
    visible && !paused && live.status === "idle" && !speaker.busy && !sending;
  const listen = useAlwaysListening({
    active: readyToListen,
    onUtterance,
    onError: setErrorMessage,
  });

  const status: Status = deriveStatus({
    visible,
    paused,
    listenPhase: listen.phase,
    recorderPermission: listen.permission,
    liveStatus: live.status,
    speakerBusy: speaker.busy,
    sending,
  });

  const statusDotColor = statusColor(palette, status);

  // Auto-scroll on new turns.
  useEffect(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, [live.turns]);

  // When the modal closes, stop everything.
  useEffect(() => {
    if (visible) return;
    speaker.stop();
    setPaused(false);
    setSending(false);
    setErrorMessage(null);
    // Deliberately keyed on `visible` alone — this is a teardown that should run
    // when the modal closes, not whenever the recorder identity changes.
  }, [visible]);

  // Clear only the error banner on open — the conversation persists
  // across modal opens (and across app restarts via the cache).
  useEffect(() => {
    if (!visible) return;
    setErrorMessage(null);
  }, [visible]);

  const headerStatus = useMemo(
    () => statusLabel(status, listen.permission, live.errorMessage),
    [status, listen.permission, live.errorMessage],
  );

  const togglePause = useCallback(() => {
    setPaused((current) => {
      const next = !current;
      if (next) speaker.stop();
      return next;
    });
  }, [speaker]);

  // The most recent thing said, whoever said it, shown large — whoever is on
  // this screen is listening, not reading. Everything before it is the
  // scrollback below; the latest turn is deliberately excluded from that list
  // so it doesn't appear twice on the same screen.
  const latest = live.turns.length > 0 ? live.turns[live.turns.length - 1] : null;
  const history = useMemo(() => live.turns.slice(0, -1), [live.turns]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        <TopNav
          title="Voice"
          onBack={onClose}
          backIcon="close"
          backLabel="End voice session"
        />

        <View style={styles.stage}>
          {/* Whichever of the two is making sound. The recorder is stopped for
              the whole of EVE's turn, so its level is flat zero while she talks;
              the speaker measures its own output instead. */}
          <ParticleField
            state={fieldState(status)}
            level={status === "speaking" ? speaker.level : listen.level}
            size={220}
          />

          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: statusDotColor }]} />
            <Text style={styles.statusText}>{headerStatus}</Text>
          </View>

          {/* Fixed-height slot: the line swaps between the prompt and live
              speech constantly, and letting it resize would bounce the field. */}
          <View style={styles.spokenSlot}>
            {latest ? (
              <Text style={styles.spoken} numberOfLines={3}>
                {latest.text}
              </Text>
            ) : (
              <Text style={styles.prompt}>
                Just speak. EVE detects when you start and stop talking, answers aloud,
                then listens again.
              </Text>
            )}
          </View>

          {/* Reserved whether or not the waveform is showing, for the same
              reason — it only appears while listening. */}
          <View style={styles.waveSlot}>
            {status === "listening" ? (
              <Waveform level={listen.level} active />
            ) : null}
          </View>
        </View>

        <ScrollView
          ref={scrollRef}
          style={styles.transcriptScroll}
          contentContainerStyle={styles.transcript}
          showsVerticalScrollIndicator={false}
        >
          {history.map((turn) => (
            <ChatBubble
              key={turn.id}
              author={turn.role === "user" ? "user" : "eve"}
              text={turn.text}
            />
          ))}
        </ScrollView>

        {errorMessage ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle-outline" size={14} color={palette.dangerDeep} />
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}

        <View style={styles.controls}>
          <MicButton
            status={status}
            palette={palette}
            paused={paused}
            onTogglePause={togglePause}
          />
          <Text style={styles.controlsHint}>{controlHint(status, paused)}</Text>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

/** Recorder/socket status → the particle field's four visual states. */
function fieldState(status: Status): FieldState {
  switch (status) {
    case "listening":
      return "listening";
    case "encoding":
    case "thinking":
    case "connecting":
      return "thinking";
    case "speaking":
      return "speaking";
    default:
      return "idle";
  }
}

// ---------- subcomponents ----------

function MicButton({
  status,
  palette,
  paused,
  onTogglePause,
}: {
  status: Status;
  palette: ThemeValue["palette"];
  paused: boolean;
  onTogglePause: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const tone = paused ? palette.textMuted : status === "listening" ? palette.danger : palette.ambient;
  const icon = paused ? "mic-off" : "mic";

  return (
    <Pressable
      style={[styles.mic, { backgroundColor: tone }]}
      onPress={onTogglePause}
      accessibilityRole="button"
      accessibilityLabel={paused ? "Resume automatic listening" : "Pause automatic listening"}
      accessibilityState={{ selected: !paused }}
    >
      {status === "listening" && !paused ? <View style={styles.micPulse} /> : null}
      <Ionicons name={icon} size={32} color={palette.textInverse} />
    </Pressable>
  );
}

// ---------- helpers ----------

function deriveStatus(args: {
  visible: boolean;
  paused: boolean;
  listenPhase: ListenPhase;
  recorderPermission: "unknown" | "granted" | "denied";
  liveStatus: ReturnType<typeof useGeminiLive>["status"];
  speakerBusy: boolean;
  sending: boolean;
}): Status {
  if (!args.visible) return "idle";
  if (args.recorderPermission === "denied") return "error";
  if (args.liveStatus === "error") return "error";
  if (args.liveStatus === "connecting") return "connecting";
  if (args.speakerBusy || args.liveStatus === "speaking") return "speaking";
  if (args.sending || args.listenPhase === "working") return "encoding";
  if (args.liveStatus === "thinking") return "thinking";
  if (!args.paused && args.listenPhase === "hearing") return "listening";
  return "idle";
}

function statusLabel(
  status: Status,
  permission: "unknown" | "granted" | "denied",
  liveError: string | null,
): string {
  if (permission === "denied") return "Microphone is blocked";
  if (status === "error" && liveError) return liveError;
  switch (status) {
    case "connecting":
      return "Connecting…";
    case "listening":
      return "Listening…";
    case "encoding":
      return "Encoding…";
    case "thinking":
      return "EVE is thinking…";
    case "speaking":
      return "EVE is speaking";
    case "error":
      return "Something went wrong";
    default:
      return "Ready";
  }
}

function controlHint(status: Status, paused: boolean): string {
  if (paused) return "Paused — tap to resume";
  switch (status) {
    case "connecting":
      return "Connecting to EVE…";
    case "listening":
      return "I hear you — pause when you're done";
    case "speaking":
      return "EVE is answering";
    case "thinking":
    case "encoding":
      return "Working…";
    default:
      return "Listening automatically · tap to pause";
  }
}

function statusColor(palette: ThemeValue["palette"], status: Status): string {
  if (status === "listening") return palette.danger;
  if (status === "thinking" || status === "encoding" || status === "connecting")
    return palette.warning;
  if (status === "speaking") return palette.ambient;
  if (status === "error") return palette.danger;
  return palette.success;
}

// ---------- styles ----------

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: palette.background },
    // The particle field and the live line own the top of the screen.
    // Content-sized rather than flexed, so the field sits still while the
    // transcript below it grows —
    // the transcript is the element that takes the leftover height.
    stage: {
      alignItems: "center",
      paddingTop: spacing.lg,
      paddingHorizontal: spacing.lg,
      gap: spacing.md,
    },
    statusRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    statusDot: { width: 9, height: 9, borderRadius: 5 },
    statusText: {
      ...type.caption,
      color: palette.text,
      textTransform: "uppercase",
      letterSpacing: 0.6,
    },
    spokenSlot: {
      height: 96,
      justifyContent: "center",
      paddingHorizontal: spacing.lg,
    },
    waveSlot: { height: 44, justifyContent: "center" },
    // Deliberately large. Whoever is looking at this screen is listening, not
    // reading, and glanceable is the whole requirement.
    spoken: {
      ...type.displayLg,
      textAlign: "center",
    },
    prompt: {
      ...type.lead,
      textAlign: "center",
    },
    // flex:1 is load-bearing: without it the ScrollView sizes to its content
    // and pushes the mic button off the bottom of the screen.
    transcriptScroll: { flex: 1 },
    transcript: { flexGrow: 1, padding: spacing.lg, gap: spacing.md },
    errorBox: {
      marginHorizontal: spacing.lg,
      marginBottom: spacing.sm,
      padding: spacing.md,
      flexDirection: "row",
      gap: 8,
      alignItems: "center",
      borderRadius: radius.sm,
      backgroundColor: palette.dangerTint,
    },
    errorText: { color: palette.dangerDeep, fontSize: 12, fontWeight: "700", flex: 1 },
    controls: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      paddingBottom: spacing.lg,
      alignItems: "center",
      gap: spacing.sm,
    },
    mic: {
      width: 96,
      height: 96,
      borderRadius: 48,
      alignItems: "center",
      justifyContent: "center",
    },
    micPulse: {
      position: "absolute",
      top: -8,
      left: -8,
      right: -8,
      bottom: -8,
      borderRadius: 56,
      borderWidth: 3,
      borderColor: palette.danger + "55",
    },
    controlsHint: { color: palette.textMuted, fontSize: 12, fontWeight: "700" },
  });
}
