/**
 * useAlwaysListening — EVE hears you without being asked to.
 *
 * Push-to-talk makes you tell the assistant you are about to speak, which is
 * the one thing a person talking to another person never has to do. This hook
 * removes that step: while it is active the microphone is open, and speech is
 * detected, captured, and handed off on its own.
 *
 * ## Why it is a cycle of windows rather than one long recording
 *
 * The only recorder available here writes to a file. Leaving it open for the
 * length of a session would produce an enormous one, nearly all silence. So the
 * mic is armed for a window at a time: if nothing is said, the window is
 * discarded and a fresh one opens; if something is, the recording continues
 * past the end of the window until you stop talking. The seam between windows
 * is a few tens of milliseconds, which is shorter than the pause between two
 * words, and the onset delay below means the first syllable would be clipped
 * by more than that anyway.
 *
 * ## The detector
 *
 * `useVoiceRecorder` already reports a normalised input level against a -60dBFS
 * floor, which is a usable voice-activity signal without a native module. Two
 * thresholds rather than one, because a single one chatters on every dip
 * between syllables: speech has to cross the higher one to begin and fall below
 * the lower one to end. Onset needs a couple of hundred milliseconds above the
 * line, so a door closing doesn't start a turn, and the end needs most of a
 * second below it, so a breath mid-sentence doesn't cut you off.
 *
 * ## What the caller owns
 *
 * Nothing here decides when a voice session should exist — only how to detect a
 * foreground speaker. The caller passes `active` false when the session is
 * paused or the screen closes. While EVE is speaking, the same loop stays
 * armed with a stricter echo-resistant gate so a person can interrupt her.
 * The loop tears down cleanly at any await point, so flipping that flag
 * mid-turn is safe.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { setAudioModeAsync } from "expo-audio";

import { useVoiceRecorder, type VoiceClip } from "./useVoiceRecorder";

/**
 * off      — not listening, by the caller's choice
 * waiting  — mic open, nothing said yet
 * hearing  — speech in progress
 * working  — captured, being handed off
 * blocked  — the microphone permission was refused
 */
export type ListenPhase = "off" | "waiting" | "hearing" | "working" | "blocked";

/** Matches the recorder's own metering interval; sampling faster gains nothing. */
const TICK_MS = 90;

/** Lowest gates, before the room's measured noise floor is added. */
const MIN_SPEECH_ON = 0.1;
const MIN_SPEECH_OFF = 0.05;

/** How far above steady room noise a sound must rise to look like foreground speech. */
const NOISE_ON_MARGIN = 0.08;
const NOISE_OFF_MARGIN = 0.035;

/** Prevent a very noisy room from teaching the detector an impossible threshold. */
const MAX_SPEECH_ON = 0.34;

/** Time above the line before it counts as speech. Rejects taps and clatter. */
const ONSET_MS = 180;

/** Silence that ends a turn. Long enough to survive a mid-sentence breath. */
const HANGOVER_MS = 800;

/** Hard cap on one turn, so a running tap can't record forever. */
const MAX_UTTERANCE_MS = 15_000;

/** How long a silent window stays open before it is thrown away and reopened. */
const WINDOW_MS = 9_000;

/** Shorter than this is a noise, not a sentence. */
const MIN_UTTERANCE_MS = 450;

/**
 * Breath between handing off a turn and re-arming.
 *
 * Load-bearing: `onUtterance` typically starts the answer, which flips `active`
 * false a render later. This delay lets that arrive before the mic reopens, so
 * EVE doesn't briefly listen to the beginning of her own reply.
 */
const REARM_MS = 350;

/** Let the room settle before treating a level as foreground speech. */
const CALIBRATION_MS = 650;

/** Barge-in needs a little more evidence than an idle wake-up. */
const BARGE_IN_ONSET_MS = 280;

/** Minimum input level considered foreground speech during playback. */
const BARGE_IN_MIN_LEVEL = 0.18;

/** Back-off after a failed arm, so a broken mic can't spin the loop. */
const RETRY_MS = 1_500;

/**
 * Keep capture independent from network transcription, but bound the amount
 * of work a slow/offline connection can accumulate while somebody keeps
 * talking. The oldest pending clip is discarded when this limit is reached;
 * the microphone itself remains available for the newest utterance.
 */
const MAX_PENDING_UTTERANCES = 3;

/** Do not surface a queue warning more than once per minute. */
const QUEUE_WARNING_COOLDOWN_MS = 60_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useAlwaysListening({
  active,
  onUtterance,
  onError,
  onSpeechStart,
  speakerBusy = false,
  speakerLevel = 0,
}: {
  active: boolean;
  /** A captured clip is queued; the microphone loop does not wait for it. */
  onUtterance: (clip: VoiceClip) => void | Promise<void>;
  onError?: (message: string) => void;
  /** Called once when foreground speech crosses the onset gate. */
  onSpeechStart?: () => void;
  /** Whether EVE is currently playing audio (tightens the onset gate). */
  speakerBusy?: boolean;
  /** Normalised output envelope, used as an echo reference. */
  speakerLevel?: number;
}) {
  const recorder = useVoiceRecorder();
  const [phase, setPhase] = useState<ListenPhase>("off");
  const [appActive, setAppActive] = useState(AppState.currentState === "active");

  // Everything the loop reads goes through a ref. The effect is keyed on
  // `active` alone: re-running it because a callback or the recorder's own
  // state object changed identity would restart the microphone every tick.
  const recorderRef = useRef(recorder);
  const levelRef = useRef(0);
  const utteranceRef = useRef(onUtterance);
  const errorRef = useRef(onError);
  const speechStartRef = useRef(onSpeechStart);
  const speakerBusyRef = useRef(speakerBusy);
  const speakerLevelRef = useRef(speakerLevel);
  const aliveRef = useRef(false);
  const generationRef = useRef(0);
  const utteranceQueueRef = useRef<VoiceClip[]>([]);
  const drainingUtterancesRef = useRef(false);
  const lastQueueWarningRef = useRef(0);

  useEffect(() => {
    recorderRef.current = recorder;
    levelRef.current = recorder.level;
    utteranceRef.current = onUtterance;
    errorRef.current = onError;
    speechStartRef.current = onSpeechStart;
    speakerBusyRef.current = speakerBusy;
    speakerLevelRef.current = speakerLevel;
  });

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      setAppActive(next === "active");
    });
    return () => subscription.remove();
  }, []);

  /**
   * Watch one window. Resolves "spoke" when a complete utterance has been
   * captured and the recording should be stopped and sent, "quiet" when the
   * window expired with nothing in it.
   */
  const listen = useCallback((generation: number): Promise<"spoke" | "quiet"> => {
    return new Promise((resolve) => {
      const openedAt = Date.now();
      const calibrationEndsAt = openedAt + CALIBRATION_MS;
      let loudSince: number | null = null;
      let startedAt: number | null = null;
      let lastLoud = 0;
      // Learned separately for every recording window. A fan, road noise, or
      // air conditioner is usually steady; following its level lets the gate
      // ignore it without making quiet foreground speech impossible to hear.
      let noiseFloor = 0.015;

      const timer = setInterval(() => {
        const now = Date.now();
        if (!aliveRef.current || generationRef.current !== generation) {
          clearInterval(timer);
          resolve("quiet");
          return;
        }

        const level = levelRef.current;
        const baseSpeechOn = Math.min(MAX_SPEECH_ON, Math.max(MIN_SPEECH_ON, noiseFloor + NOISE_ON_MARGIN));
        const speechOff = Math.max(MIN_SPEECH_OFF, noiseFloor + NOISE_OFF_MARGIN);

        // During playback the communications input can still contain a little
        // speaker bleed. Require a higher foreground level and a longer onset;
        // Android's voice-communication source handles most of the echo, while
        // this gate handles the residual on less capable audio drivers.
        const outputLevel = Math.max(0, Math.min(1, speakerLevelRef.current));
        const bargeIn = speakerBusyRef.current;
        const echoFloor = bargeIn ? Math.max(BARGE_IN_MIN_LEVEL, outputLevel * 0.55) : 0;
        const speechOn = Math.max(baseSpeechOn, echoFloor);
        const onsetMs = bargeIn ? BARGE_IN_ONSET_MS : ONSET_MS;

        if (now < calibrationEndsAt) {
          const weight = level < noiseFloor ? 0.16 : 0.04;
          noiseFloor += (level - noiseFloor) * weight;
          loudSince = null;
          return;
        }

        if (startedAt === null) {
          if (level >= speechOn) {
            if (loudSince === null) {
              loudSince = now;
            } else if (now - loudSince >= onsetMs) {
              startedAt = now;
              lastLoud = now;
              setPhase("hearing");
              speechStartRef.current?.();
            }
          } else {
            // Has to be continuous. One loud frame in a quiet second is a noise.
            loudSince = null;
            // Slow EWMA: track persistent ambience, not a syllable that briefly
            // dipped below the onset line. Downward changes are allowed faster
            // so moving into a quieter room restores sensitivity quickly.
            const weight = level < noiseFloor ? 0.12 : 0.025;
            noiseFloor += (level - noiseFloor) * weight;
          }
          if (startedAt === null && now - openedAt >= WINDOW_MS) {
            clearInterval(timer);
            resolve("quiet");
          }
          return;
        }

        if (level >= speechOff) lastLoud = now;
        if (now - lastLoud >= HANGOVER_MS || now - startedAt >= MAX_UTTERANCE_MS) {
          clearInterval(timer);
          resolve("spoke");
        }
      }, TICK_MS);
    });
  }, []);

  /**
   * Transcription is deliberately decoupled from the recorder loop. A mobile
   * network request can take seconds (or never resolve while offline); waiting
   * for it here would create a deaf interval after every sentence.
   */
  const drainUtterances = useCallback(() => {
    if (drainingUtterancesRef.current) return;
    const clip = utteranceQueueRef.current.shift();
    if (!clip) return;
    drainingUtterancesRef.current = true;
    void Promise.resolve()
      .then(() => utteranceRef.current(clip))
      .catch((error) => {
        errorRef.current?.(error instanceof Error ? error.message : "EVE couldn't hear that.");
      })
      .finally(() => {
        drainingUtterancesRef.current = false;
        // A clip may have arrived while the previous one was in flight.
        drainUtterances();
      });
  }, []);

  const enqueueUtterance = useCallback(
    (clip: VoiceClip) => {
      if (utteranceQueueRef.current.length >= MAX_PENDING_UTTERANCES) {
        utteranceQueueRef.current.shift();
        const now = Date.now();
        if (now - lastQueueWarningRef.current >= QUEUE_WARNING_COOLDOWN_MS) {
          lastQueueWarningRef.current = now;
          errorRef.current?.("Voice is still processing the previous request.");
        }
      }
      utteranceQueueRef.current.push(clip);
      drainUtterances();
    },
    [drainUtterances],
  );

  useEffect(() => {
    if (!active || !appActive) {
      generationRef.current += 1;
      aliveRef.current = false;
      setPhase("off");
      return;
    }

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let alive = true;
    aliveRef.current = true;

    void (async () => {
      const current = () => alive && aliveRef.current && generationRef.current === generation;
      while (current()) {
        if (recorderRef.current.permission === "denied") {
          setPhase("blocked");
          return;
        }

        setPhase("waiting");
        // EVE's previous answer switches iOS out of play-and-record so speech
        // comes from the loudspeaker. Put the session back in record mode each
        // time the detector re-arms; without this, the first turn works and the
        // microphone can fail to reopen after EVE has spoken.
        try {
          await setAudioModeAsync({
            playsInSilentMode: true,
            allowsRecording: true,
            shouldRouteThroughEarpiece: false,
            interruptionMode: "doNotMix",
          });
        } catch (error) {
          errorRef.current?.(error instanceof Error ? error.message : "EVE couldn't open the microphone.");
          await delay(RETRY_MS);
          continue;
        }
        if (!current()) break;
        const armed = await recorderRef.current.start();
        if (!current()) break;

        // Read through a local: `start()` is where the permission prompt
        // happens, so this is the first place a refusal can be seen.
        const granted: string = recorderRef.current.permission;
        if (granted === "denied") {
          setPhase("blocked");
          return;
        }
        if (!armed) {
          await delay(RETRY_MS);
          continue;
        }

        const heard = await listen(generation);
        if (!current()) break;

        if (heard === "quiet") {
          await recorderRef.current.cancel();
          continue;
        }

        setPhase("working");
        const clip = await recorderRef.current.stop();
        if (!current()) break;

        if (clip && clip.durationMs >= MIN_UTTERANCE_MS) enqueueUtterance(clip);
        if (!current()) break;
        await delay(REARM_MS);
      }

      await recorderRef.current.cancel();
    })();

    return () => {
      alive = false;
      generationRef.current += 1;
      aliveRef.current = false;
      // Pending clips belong to the session that just ended. Do not carry
      // private audio into a later account/session; an already-running request
      // is allowed to settle, but it cannot make the recorder loop wait.
      utteranceQueueRef.current = [];
      setPhase("off");
      void recorderRef.current.cancel();
    };
    // Keyed on `active` alone, deliberately — see the ref block above.
  }, [active, appActive, enqueueUtterance, listen]);

  return {
    phase,
    /** Live input level, 0–1. Drives the field so you can see it hearing you. */
    level: recorder.level,
    permission: recorder.permission,
  };
}
