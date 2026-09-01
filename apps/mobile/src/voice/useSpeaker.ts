/**
 * Playback for Gemini Live's raw 24 kHz PCM response.
 *
 * PCM arrives in small websocket frames, while expo-audio can only play a file.
 * We bridge those APIs with a bounded segment queue: the first segment starts
 * after a short buffer and later segments are queued in arrival order. Temporary
 * files are deleted as soon as their player is released.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as FileSystem from "expo-file-system/legacy";
import { createAudioPlayer, setAudioModeAsync, setIsAudioActiveAsync, type AudioPlayer } from "expo-audio";

import { writePcmChunksAsWav, type SpokenTurn } from "./pcmToWav";

const START_BYTES = 48 * 1024;
const SEGMENT_BYTES = 96 * 1024;
const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
const TICK_MS = 60;

export function useSpeaker(onError?: (message: string) => void) {
  const playerRef = useRef<AudioPlayer | null>(null);
  const fileRef = useRef<string | null>(null);
  const envelopeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingChunksRef = useRef<string[]>([]);
  const pendingBytesRef = useRef(0);
  const segmentQueueRef = useRef<string[][]>([]);
  const queuedBytesRef = useRef(0);
  const drainingRef = useRef(false);
  const drainRequestedRef = useRef(false);
  const playbackCancelRef = useRef<(() => void) | null>(null);
  const streamOpenRef = useRef(false);
  const generationRef = useRef(0);
  const errorRef = useRef(onError);

  const [playing, setPlaying] = useState(false);
  const [pending, setPending] = useState(false);
  const [level, setLevel] = useState(0);

  useEffect(() => {
    errorRef.current = onError;
  }, [onError]);

  const stopEnvelope = useCallback(() => {
    if (envelopeTimerRef.current !== null) {
      clearInterval(envelopeTimerRef.current);
      envelopeTimerRef.current = null;
    }
    setLevel(0);
  }, []);

  const removeCurrentPlayer = useCallback(() => {
    stopEnvelope();
    const player = playerRef.current;
    playerRef.current = null;
    if (player) {
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
    }
    const uri = fileRef.current;
    fileRef.current = null;
    void deleteAudioFile(uri);
    setPlaying(false);
  }, [stopEnvelope]);

  /** Cancel every queued/current segment (used for barge-in and unmount). */
  const release = useCallback(() => {
    generationRef.current += 1;
    streamOpenRef.current = false;
    drainRequestedRef.current = false;
    playbackCancelRef.current?.();
    playbackCancelRef.current = null;
    pendingChunksRef.current = [];
    pendingBytesRef.current = 0;
    segmentQueueRef.current = [];
    queuedBytesRef.current = 0;
    removeCurrentPlayer();
    setPending(false);
    void setIsAudioActiveAsync(false).catch(() => undefined);
  }, [removeCurrentPlayer]);

  const flushPending = useCallback(() => {
    if (pendingChunksRef.current.length === 0) return;
    const segment = pendingChunksRef.current;
    pendingChunksRef.current = [];
    queuedBytesRef.current += pendingBytesRef.current;
    pendingBytesRef.current = 0;
    segmentQueueRef.current.push(segment);
  }, []);

  const playSegment = useCallback(
    async (chunks: string[], generation: number): Promise<boolean> => {
      if (generation !== generationRef.current) return false;
      let turn: SpokenTurn | null = null;
      let settlePlayback: (() => void) | null = null;
      try {
        await setIsAudioActiveAsync(true);
        await setAudioModeAsync({
          playsInSilentMode: true,
          // Keep the communications input path open for barge-in. Android's
          // voice-communication source supplies hardware echo cancellation.
          allowsRecording: true,
          shouldRouteThroughEarpiece: false,
          interruptionMode: "doNotMix",
        });
        turn = await writePcmChunksAsWav(chunks);
        if (!turn || generation !== generationRef.current) return false;
        // Keep a non-null local reference for callbacks that outlive the guard.
        // TypeScript cannot carry the narrowing of the mutable `turn` variable
        // into the playback-status closure below.
        const activeTurn = turn;
        fileRef.current = activeTurn.uri;

        const player = createAudioPlayer(activeTurn.uri);
        playerRef.current = player;
        await new Promise<void>((resolve) => {
          let settled = false;
          let subscription: { remove: () => void } | null = null;
          let timeout: ReturnType<typeof setTimeout> | null = null;
          const settle = () => {
            if (settled) return;
            settled = true;
            if (timeout !== null) clearTimeout(timeout);
            try {
              subscription?.remove();
            } catch {
              /* best-effort */
            }
            resolve();
          };
          settlePlayback = settle;
          playbackCancelRef.current = settle;
          subscription = player.addListener("playbackStatusUpdate", (status) => {
            setPlaying(Boolean(status?.playing));
            if (status?.didJustFinish) settle();
          });
          player.play();
          const duration = Math.max(
            500,
            Math.ceil((activeTurn.envelope.length || 1) * (activeTurn.frameMs || 40) + 1000),
          );
          timeout = setTimeout(settle, duration);
          if (activeTurn.envelope.length > 0) {
            envelopeTimerRef.current = setInterval(() => {
              if (playerRef.current !== player) return;
              let position = 0;
              try {
                position = player.currentTime || 0;
              } catch {
                return;
              }
              const frame = Math.floor((position * 1000) / activeTurn.frameMs);
              setLevel(activeTurn.envelope[frame] || 0);
            }, TICK_MS);
          }
        });
        if (playerRef.current === player) playerRef.current = null;
        stopEnvelope();
        try {
          player.remove();
        } catch {
          /* best-effort */
        }
        if (fileRef.current === activeTurn.uri) fileRef.current = null;
        await deleteAudioFile(activeTurn.uri);
        setPlaying(false);
        return generation === generationRef.current;
      } catch (error) {
        stopEnvelope();
        setPlaying(false);
        errorRef.current?.(error instanceof Error ? error.message : "Playback failed");
        return false;
      } finally {
        const completedTurn = turn;
        if (completedTurn) {
          if (fileRef.current === completedTurn.uri) fileRef.current = null;
          await deleteAudioFile(completedTurn.uri);
        }
        if (playbackCancelRef.current === settlePlayback) playbackCancelRef.current = null;
      }
    },
    [stopEnvelope],
  );

  const drain = useCallback(
    async function drainQueue() {
      if (drainingRef.current) {
        drainRequestedRef.current = true;
        return;
      }
      drainingRef.current = true;
      drainRequestedRef.current = false;
      const generation = generationRef.current;
      try {
        while (segmentQueueRef.current.length > 0 && generation === generationRef.current) {
          const segment = segmentQueueRef.current.shift();
          if (!segment) continue;
          queuedBytesRef.current = Math.max(0, queuedBytesRef.current - estimateBytes(segment));
          const ok = await playSegment(segment, generation);
          if (!ok) break;
        }
      } finally {
        const shouldRestart = drainRequestedRef.current || segmentQueueRef.current.length > 0;
        drainRequestedRef.current = false;
        drainingRef.current = false;
        if (shouldRestart) {
          // A chunk can arrive in the small window after the while condition
          // checks the queue but before this finally block. Re-enter with the
          // current generation so it cannot strand the new segment.
          void drainQueue();
        } else if (
          generation === generationRef.current &&
          !streamOpenRef.current &&
          segmentQueueRef.current.length === 0 &&
          pendingChunksRef.current.length === 0
        ) {
          setPending(false);
          void setIsAudioActiveAsync(false).catch(() => undefined);
        }
      }
    },
    [playSegment],
  );

  const pushChunk = useCallback(
    (chunk: string) => {
      const bytes = Math.ceil((chunk.length * 3) / 4);
      if (
        !chunk ||
        bytes <= 0 ||
        bytes > SEGMENT_BYTES ||
        queuedBytesRef.current + pendingBytesRef.current + bytes > MAX_QUEUE_BYTES
      ) {
        return;
      }
      streamOpenRef.current = true;
      pendingChunksRef.current.push(chunk);
      pendingBytesRef.current += bytes;
      setPending(true);
      if (
        pendingBytesRef.current >= SEGMENT_BYTES ||
        (!playerRef.current && pendingBytesRef.current >= START_BYTES)
      ) {
        flushPending();
      }
      void drain();
    },
    [drain, flushPending],
  );

  const finish = useCallback(() => {
    streamOpenRef.current = false;
    flushPending();
    void drain();
  }, [drain, flushPending]);

  /** Compatibility path for a complete, already-buffered response. */
  const play = useCallback(
    (chunks: string[]) => {
      release();
      if (chunks.length === 0) return;
      for (const chunk of chunks) pushChunk(chunk);
      finish();
    },
    [finish, pushChunk, release],
  );

  const stop = useCallback(() => {
    release();
  }, [release]);

  useEffect(() => release, [release]);

  return {
    playing,
    busy: playing || pending,
    level,
    play,
    pushChunk,
    finish,
    stop,
    release,
  };
}

function estimateBytes(chunks: string[]): number {
  return chunks.reduce((sum, chunk) => sum + Math.ceil((chunk.length * 3) / 4), 0);
}

async function deleteAudioFile(uri: string | null): Promise<void> {
  if (!uri) return;
  await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
}
