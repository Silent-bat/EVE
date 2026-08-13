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
 * `useVoiceRecorder` already reports a normalised input level against a -50dBFS
 * floor, which is a usable voice-activity signal without a native module. Two
 * thresholds rather than one, because a single one chatters on every dip
 * between syllables: speech has to cross the higher one to begin and fall below
 * the lower one to end. Onset needs a couple of hundred milliseconds above the
 * line, so a door closing doesn't start a turn, and the end needs most of a
 * second below it, so a breath mid-sentence doesn't cut you off.
 *
 * ## What the caller owns
 *
 * Nothing here decides when EVE should be listening — only how. The caller
 * passes `active` false while she is thinking or speaking, which is what stops
 * her from hearing her own voice and answering it. The loop tears down cleanly
 * at any await point, so flipping that flag mid-turn is safe.
 */
import { useCallback, useEffect, useRef, useState } from "react";
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

/** Back-off after a failed arm, so a broken mic can't spin the loop. */
const RETRY_MS = 1_500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useAlwaysListening({
  active,
  onUtterance,
  onError,
}: {
  active: boolean;
  /** Awaited — the loop stays quiet until the caller has dealt with the clip. */
  onUtterance: (clip: VoiceClip) => void | Promise<void>;
  onError?: (message: string) => void;
}) {
  const recorder = useVoiceRecorder();
  const [phase, setPhase] = useState<ListenPhase>("off");

  // Everything the loop reads goes through a ref. The effect is keyed on
  // `active` alone: re-running it because a callback or the recorder's own
  // state object changed identity would restart the microphone every tick.
  const recorderRef = useRef(recorder);
  const levelRef = useRef(0);
  const utteranceRef = useRef(onUtterance);
  const errorRef = useRef(onError);
  const aliveRef = useRef(false);

  useEffect(() => {
    recorderRef.current = recorder;
    levelRef.current = recorder.level;
    utteranceRef.current = onUtterance;
    errorRef.current = onError;
  });

  /**
   * Watch one window. Resolves "spoke" when a complete utterance has been
   * captured and the recording should be stopped and sent, "quiet" when the
   * window expired with nothing in it.
   */
  const listen = useCallback((): Promise<"spoke" | "quiet"> => {
    return new Promise((resolve) => {
      const openedAt = Date.now();
      let loudSince: number | null = null;
      let startedAt: number | null = null;
      let lastLoud = 0;
      // Learned separately for every recording window. A fan, road noise, or
      // air conditioner is usually steady; following its level lets the gate
      // ignore it without making quiet foreground speech impossible to hear.
      let noiseFloor = 0.015;

      const timer = setInterval(() => {
        const now = Date.now();
        if (!aliveRef.current) {
          clearInterval(timer);
          resolve("quiet");
          return;
        }

        const level = levelRef.current;
        const speechOn = Math.min(
          MAX_SPEECH_ON,
          Math.max(MIN_SPEECH_ON, noiseFloor + NOISE_ON_MARGIN),
        );
        const speechOff = Math.max(MIN_SPEECH_OFF, noiseFloor + NOISE_OFF_MARGIN);

        if (startedAt === null) {
          if (level >= speechOn) {
            if (loudSince === null) {
              loudSince = now;
            } else if (now - loudSince >= ONSET_MS) {
              startedAt = now;
              lastLoud = now;
              setPhase("hearing");
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

  useEffect(() => {
    if (!active) {
      aliveRef.current = false;
      setPhase("off");
      return;
    }

    let alive = true;
    aliveRef.current = true;

    void (async () => {
      while (alive) {
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
          });
        } catch (error) {
          errorRef.current?.(
            error instanceof Error ? error.message : "EVE couldn't open the microphone.",
          );
          await delay(RETRY_MS);
          continue;
        }
        if (!alive) break;
        const armed = await recorderRef.current.start();
        if (!alive) break;

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

        const heard = await listen();
        if (!alive) break;

        if (heard === "quiet") {
          await recorderRef.current.cancel();
          continue;
        }

        setPhase("working");
        const clip = await recorderRef.current.stop();
        if (!alive) break;

        if (clip && clip.durationMs >= MIN_UTTERANCE_MS) {
          try {
            await utteranceRef.current(clip);
          } catch (error) {
            errorRef.current?.(
              error instanceof Error ? error.message : "EVE couldn't hear that.",
            );
          }
        }
        if (!alive) break;
        await delay(REARM_MS);
      }

      await recorderRef.current.cancel();
    })();

    return () => {
      alive = false;
      aliveRef.current = false;
      setPhase("off");
      void recorderRef.current.cancel();
    };
    // Keyed on `active` alone, deliberately — see the ref block above.
  }, [active, listen]);

  return {
    phase,
    /** Live input level, 0–1. Drives the field so you can see it hearing you. */
    level: recorder.level,
    permission: recorder.permission,
  };
}
