/**
 * useSpeaker — playing EVE's voice, wherever she's answering from.
 *
 * Gemini Live streams raw 24kHz PCM, which nothing on the device will play
 * directly, so each turn's chunks are wrapped in a WAV header and handed to a
 * player. Two details are load-bearing and were both learned the hard way:
 *
 * The audio session has to leave record mode before playback, or iOS routes the
 * answer to the earpiece and it sounds like the phone is broken. And the player
 * is constructed with its URI rather than told to `replace` an existing source —
 * `replace` resolves asynchronously and `play()` fired before it landed, which
 * produced silence roughly one turn in three.
 *
 * It also reports `level`, a 0–1 amplitude that tracks what EVE is saying, so
 * the particle field can pulse on her voice the way it pulses on the user's.
 * That is not free: expo-audio exposes no output level, and the microphone is
 * gated off for the whole of her turn, so there is nothing live to meter. The
 * envelope is measured from the PCM instead — see writePcmChunksAsWav — and
 * replayed here on a timer. Which works only because the whole turn's audio
 * arrives in one call before playback starts, so the shape of the speech is
 * known in advance.
 *
 * Lives in its own hook because there are now two places EVE speaks from: the
 * voice screen and the home dock. One copy of the fix, not two.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createAudioPlayer,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  type AudioPlayer,
} from "expo-audio";

import { writePcmChunksAsWav } from "./pcmToWav";

/**
 * How often the envelope is stepped, in milliseconds.
 *
 * Deliberately coarser than a frame. Each tick is a React state update, and at
 * 60Hz that is a re-render of everything holding this hook sixty times a second
 * for a value whose consumer — the field's `energy += (target - energy) * 0.12`
 * smoother — is designed to interpolate between sparse targets anyway. 60ms also
 * sits close to the envelope's own 40ms resolution and to the microphone meter's
 * ~11Hz, so the orb behaves the same whoever is talking.
 */
const TICK_MS = 60;

export function useSpeaker(onError?: (message: string) => void) {
  const playerRef = useRef<AudioPlayer | null>(null);
  const [playing, setPlaying] = useState(false);
  /**
   * True from the instant a turn's audio is handed over until it stops.
   *
   * `playing` cannot do this job alone: it only becomes true once the player
   * reports back, and getting there means switching the audio session and
   * writing a WAV to disk first. The caller flips the mic on whenever EVE is
   * neither thinking nor speaking, and for those few hundred milliseconds she
   * was recorded as being neither — so the mic re-armed just in time to hear
   * her open her mouth, then closed again. This closes that window.
   */
  const [pending, setPending] = useState(false);
  /** Loudness of what is coming out of the speaker right now, 0–1. */
  const [level, setLevel] = useState(0);

  /* The envelope walk. An interval rather than a listener on the player, because
     playbackStatusUpdate fires on its own schedule — roughly a few times a
     second, and not at all while nothing changes — which is far too coarse to
     drive motion from. The interval reads `currentTime` instead of counting its
     own ticks, so the level stays aligned to the audio even if a tick is late,
     which under a loaded JS thread they routinely are. */
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopEnvelope = useCallback(() => {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    setLevel(0);
  }, []);

  // Kept in a ref so `play` has a stable identity — it is passed straight into
  // useGeminiLive, whose connect cycle should not re-run on a changed callback.
  const errorRef = useRef(onError);
  useEffect(() => {
    errorRef.current = onError;
  }, [onError]);

  const release = useCallback(() => {
    stopEnvelope();
    const player = playerRef.current;
    playerRef.current = null;
    if (!player) return;
    try {
      player.pause();
    } catch {
      /* best-effort */
    }
    try {
      player.remove();
    } catch {
      /* best-effort */
    }
    setPlaying(false);
  }, [stopEnvelope]);

  const play = useCallback(
    async (chunks: string[]) => {
      if (chunks.length === 0) return;
      setPending(true);
      try {
        // `setIsAudioActiveAsync(false)` is global to expo-audio. A screen or
        // an app-state handler may have deactivated it earlier; on Android a
        // subsequent `player.play()` then returns silently without starting.
        // Re-arm the subsystem for every answer so a valid response cannot be
        // rendered in the transcript while its audio is discarded.
        await setIsAudioActiveAsync(true);

        // Out of playAndRecord, so the answer comes from the speaker rather
        // than the earpiece. `allowsRecording: false` is the part that matters.
        await setAudioModeAsync({
          playsInSilentMode: true,
          allowsRecording: false,
          shouldRouteThroughEarpiece: false,
        });

        const turn = await writePcmChunksAsWav(chunks);
        if (!turn) {
          setPending(false);
          return;
        }

        release();

        const player = createAudioPlayer(turn.uri);
        playerRef.current = player;
        const sub = player.addListener("playbackStatusUpdate", (status) => {
          setPlaying(Boolean(status?.playing));
          if (status?.didJustFinish) {
            try {
              sub.remove();
            } catch {
              /* best-effort */
            }
            try {
              player.remove();
            } catch {
              /* best-effort */
            }
            if (playerRef.current === player) playerRef.current = null;
            stopEnvelope();
            setPlaying(false);
            setPending(false);
          }
        });
        player.play();

        /* Started after play(), so the envelope and the audio begin together.
           Indexing off currentTime keeps them together: the alternative — one
           step per tick — drifts the moment the JS thread stalls, and it stalls
           most while the first frames of a new screen are rendering, which is
           exactly when a turn tends to start. */
        const { envelope, frameMs } = turn;
        if (envelope.length > 0) {
          tickRef.current = setInterval(() => {
            // A player removed mid-turn (barge-in, unmount) throws on access
            // rather than reporting a state.
            if (playerRef.current !== player) return;
            let position = 0;
            try {
              position = player.currentTime ?? 0;
            } catch {
              return;
            }
            const frame = Math.floor((position * 1000) / frameMs);
            /* Past the end means the file finished but didJustFinish has not
               landed yet. Reporting 0 rather than holding the last value lets the
               orb settle out of the speaking state on time. */
            setLevel(envelope[frame] ?? 0);
          }, TICK_MS);
        }
      } catch (error) {
        stopEnvelope();
        setPending(false);
        errorRef.current?.(error instanceof Error ? error.message : "Playback failed");
      }
    },
    [release, stopEnvelope],
  );

  /** Stop mid-sentence. Barge-in, or leaving the screen she's talking on. */
  const stop = useCallback(() => {
    stopEnvelope();
    setPending(false);
    const player = playerRef.current;
    if (!player) return;
    try {
      player.pause();
    } catch {
      /* best-effort */
    }
    setPlaying(false);
  }, [stopEnvelope]);

  useEffect(() => release, [release]);

  return {
    playing,
    /**
     * Speaking, or about to be. This is what a caller should gate the
     * microphone on — `playing` alone leaves a hole at the start of every turn.
     */
    busy: playing || pending,
    /**
     * How loud EVE is right now, 0–1, measured from the audio she is playing.
     * Pass this to the particle field while she speaks — the microphone is
     * closed for her whole turn, so its level is flat and the field would sit
     * still through the one moment it most obviously should not.
     */
    level,
    play,
    stop,
    release,
  };
}
