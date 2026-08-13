/**
 * useVoiceRecorder — thin hook around expo-audio's recording API.
 *
 * Responsibilities:
 *   - Requesting microphone permission lazily (on first start)
 *   - Recording to a file in a format Gemini accepts (m4a / AAC)
 *   - Returning the recorded clip as base64 + mime type, ready to POST
 *
 * Stays unopinionated about UI state — the consumer manages the
 * idle/listening/processing/speaking machine. We only do audio I/O.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  type AudioRecorder,
} from "expo-audio";

export type VoiceClip = {
  /** Base64-encoded audio payload, ready for POST. */
  audio: string;
  /** Mime type Gemini expects for inline_data. */
  mimeType: string;
  /** Recorded duration in milliseconds. */
  durationMs: number;
};

export type RecorderState = "idle" | "preparing" | "recording" | "encoding" | "denied";

/** How often the input level is sampled while recording. */
const METER_INTERVAL_MS = 90;

/**
 * Quietest input we treat as signal, in dBFS. expo-audio reports roughly -160
 * (digital silence) to 0 (clipping), but ordinary room noise already sits near
 * -50, so anchoring the floor there keeps the visual response tied to speech
 * rather than to the noise floor.
 */
// Android's MediaRecorder reports a much quieter max-amplitude value on some
// handset microphones than iOS does. A -50 dB floor made ordinary speech land
// below the detector's start threshold, so the mic opened and cycled forever
// without ever recognizing a turn. Keep enough headroom for quiet rooms while
// still treating a real voice as signal.
const METER_FLOOR_DB = -60;

export function useVoiceRecorder() {
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    // Needed for `level`. Off by default, and the visualiser has nothing real
    // to animate from without it.
    isMeteringEnabled: true,
  });
  const [state, setState] = useState<RecorderState>("idle");
  const [permission, setPermission] = useState<"unknown" | "granted" | "denied">("unknown");
  const [level, setLevel] = useState(0);
  const startTime = useRef<number | null>(null);

  /**
   * The live value of `state`, for the callbacks below.
   *
   * `stop` and `cancel` decide whether there is anything to stop, and reading
   * that from the captured `state` was wrong in the one case that matters: the
   * always-listening loop reaches for whichever copy of these callbacks it last
   * saw, which during a teardown can be one render behind. A `cancel` that
   * believed it was idle skipped `recorder.stop()` and left the microphone open
   * — the OS kept showing the mic as in use with nothing reading it.
   */
  const stateRef = useRef<RecorderState>("idle");
  stateRef.current = state;

  // Sample the input level only while recording. The orb and waveform read this
  // to size themselves, so it has to be a real measurement — a synthesised
  // wobble would show movement while the mic was picking up nothing at all.
  useEffect(() => {
    if (state !== "recording") {
      setLevel(0);
      return;
    }

    const timer = setInterval(() => {
      try {
        const metering = recorder.getStatus().metering;
        if (typeof metering !== "number" || Number.isNaN(metering)) return;
        const span = Math.abs(METER_FLOOR_DB);
        const normalized = (metering + span) / span;
        setLevel(Math.max(0, Math.min(1, normalized)));
      } catch {
        // Metering is best-effort; a failed read just leaves the last value.
      }
    }, METER_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [recorder, state]);

  // Configure audio mode once: allow recording on iOS, route playback to
  // the speaker so TTS responses are audible even when in silent mode.
  useEffect(() => {
    void setAudioModeAsync({
      playsInSilentMode: true,
      allowsRecording: true,
    }).catch(() => undefined);
  }, []);

  const ensurePermission = useCallback(async (): Promise<boolean> => {
    if (permission === "granted") return true;
    try {
      const result = await AudioModule.requestRecordingPermissionsAsync();
      const granted = Boolean(result.granted);
      setPermission(granted ? "granted" : "denied");
      if (!granted) setState("denied");
      return granted;
    } catch {
      setPermission("denied");
      setState("denied");
      return false;
    }
  }, [permission]);

  const start = useCallback(async (): Promise<boolean> => {
    setState("preparing");
    const ok = await ensurePermission();
    if (!ok) return false;
    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
      startTime.current = Date.now();
      setState("recording");
      return true;
    } catch {
      setState("idle");
      return false;
    }
  }, [ensurePermission, recorder]);

  const stop = useCallback(async (): Promise<VoiceClip | null> => {
    if (stateRef.current !== "recording") return null;
    setState("encoding");
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) {
        setState("idle");
        return null;
      }
      const audio = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const durationMs = startTime.current ? Date.now() - startTime.current : 0;
      setState("idle");
      // expo-audio HIGH_QUALITY preset emits AAC inside an M4A container on
      // both iOS and Android. Gemini accepts audio/mp4 inline.
      return { audio, mimeType: mimeFromUri(uri), durationMs };
    } catch {
      setState("idle");
      return null;
    }
  }, [recorder]);

  /**
   * Release the microphone without keeping the clip.
   *
   * Asks the recorder itself whether it is running rather than trusting our
   * own bookkeeping. `prepareToRecordAsync` and `record` both open the device
   * before `state` catches up, so there is a window where we think we are idle
   * and the microphone is live; leaving it open there is what made the mic
   * indicator stay lit with EVE doing nothing.
   */
  const cancel = useCallback(async () => {
    let engaged = stateRef.current === "recording" || stateRef.current === "preparing";
    try {
      if (recorder.getStatus().isRecording) engaged = true;
    } catch {
      // Status is best-effort; fall back to our own bookkeeping.
    }
    if (engaged) {
      try {
        await recorder.stop();
      } catch {
        // best-effort
      }
    }
    startTime.current = null;
    setState("idle");
  }, [recorder]);

  return { state, permission, level, start, stop, cancel } satisfies {
    state: RecorderState;
    permission: typeof permission;
    /** Normalised 0–1 input level, sampled while recording. 0 when idle. */
    level: number;
    /** Resolves true only when the native recorder is actually running. */
    start: () => Promise<boolean>;
    stop: () => Promise<VoiceClip | null>;
    cancel: () => Promise<void>;
  } & { _recorder?: AudioRecorder };
}

function mimeFromUri(uri: string): string {
  const ext = uri.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "m4a":
    case "mp4":
      return "audio/mp4";
    case "aac":
      return "audio/aac";
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    case "caf":
      // Apple Core Audio Format — fall back to mp4 hinting since AAC
      // inside CAF behaves similarly. Gemini will reject if mismatched.
      return "audio/mp4";
    default:
      return Platform.OS === "ios" ? "audio/mp4" : "audio/aac";
  }
}
