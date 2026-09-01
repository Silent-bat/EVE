/**
 * useGeminiLive — mobile-side client for the /v1/voice/live WebSocket.
 *
 * Owns the WS lifecycle, accumulates streaming transcripts and audio
 * chunks, and emits a small state machine so VoiceScreen can render
 * status without caring about the wire format. Reuses the existing
 * tokenStore for auth and reconnects a dropped foreground session with bounded
 * backoff; disabling the session or backgrounding the app tears it down.
 *
 * State machine:
 *   idle       — connected, waiting for the user to do something
 *   thinking   — text submitted, Gemini hasn't started replying yet
 *   speaking   — receiving audio chunks (we also have transcript by now)
 *   connecting — initial open before the server says "ready"
 *   error      — see errorMessage
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";

import { assertSecureTransport, config } from "../config";
import { tokenStore } from "../api/client";
import { readCache, readLastUserID, writeCache } from "../storage/localCache";

export type LiveStatus = "connecting" | "idle" | "thinking" | "speaking" | "error";

/** First reconnect delay. Doubles per attempt, so a blip costs half a second. */
const BASE_BACKOFF_MS = 500;

/** Ceiling on the backoff, so a dead server is retried without hammering it. */
const MAX_BACKOFF_MS = 15_000;

/**
 * Consecutive failures before the user is told. Gemini Live sessions end on
 * their own schedule and reconnect in well under a second, which is not worth a
 * banner; a server that is actually down keeps failing and earns one.
 */
const MAX_QUIET_RETRIES = 3;

/** Do not leave a queued follow-up blocked forever if the bridge drops its ack. */
const INTERRUPT_ACK_TIMEOUT_MS = 2_000;

export type LiveTurn = {
  id: string;
  role: "user" | "agent";
  text: string;
};

type Props = {
  enabled: boolean;
  onError?: (message: string) => void;
  /**
   * Called when a turn completes and we have a buffer of PCM chunks ready
   * to be assembled and played. The buffer is in arrival order.
   */
  onAudioResponse?: (chunksBase64: string[]) => void;
  /** Called for each PCM chunk as it arrives, enabling low-latency playback. */
  onAudioChunk?: (chunkBase64: string) => void;
  /** Called when the current audio response is complete. */
  onAudioComplete?: () => void;
};

export function useGeminiLive({ enabled, onError, onAudioResponse, onAudioChunk, onAudioComplete }: Props) {
  const [status, setStatus] = useState<LiveStatus>(enabled ? "connecting" : "idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const userIDRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const currentAgentTurnId = useRef<string | null>(null);
  const currentUserTurnId = useRef<string | null>(null);
  const audioBuffer = useRef<string[]>([]);
  const audioBytes = useRef(0);
  /** Monotonic client-side response epoch used to invalidate barge-in audio. */
  const responseGenerationRef = useRef(0);
  const activeAudioGenerationRef = useRef<number | null>(null);
  const droppingInterruptedResponseRef = useRef(false);
  const interruptionPendingRef = useRef(false);
  const responsePendingRef = useRef(false);
  const interruptionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [appActive, setAppActive] = useState(AppState.currentState === "active");
  const appActiveRef = useRef(appActive);
  /** Consecutive failed connects, reset by a session that reaches "ready". */
  const attempt = useRef(0);
  // Capture onError/onAudioResponse in a ref so the effect doesn't
  // re-run every render. The connect cycle is heavy.
  const callbacks = useRef({ onError, onAudioResponse, onAudioChunk, onAudioComplete });
  useEffect(() => {
    callbacks.current = { onError, onAudioResponse, onAudioChunk, onAudioComplete };
  }, [onError, onAudioResponse, onAudioChunk, onAudioComplete]);

  const clearInterruptionTimer = useCallback(() => {
    if (interruptionTimerRef.current !== null) {
      clearTimeout(interruptionTimerRef.current);
      interruptionTimerRef.current = null;
    }
  }, []);

  const invalidateResponse = useCallback(() => {
    responseGenerationRef.current += 1;
    activeAudioGenerationRef.current = null;
    droppingInterruptedResponseRef.current = false;
    interruptionPendingRef.current = false;
    responsePendingRef.current = false;
    clearInterruptionTimer();
  }, [clearInterruptionTimer]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      const active = next === "active";
      // Update synchronously as well as through state. A native socket can
      // deliver one final event before React commits the AppState render.
      appActiveRef.current = active;
      setAppActive(active);
    });
    return () => subscription.remove();
  }, []);

  // Restore prior conversation turns from disk so the user sees their
  // last voice session as soon as the modal opens, before the WS even
  // connects. Runs once per enabled cycle.
  useEffect(() => {
    if (!enabled || !appActive) return;
    let active = true;
    void (async () => {
      const lastUserID = await readLastUserID();
      if (!lastUserID || !active) return;
      userIDRef.current = lastUserID;
      const cached = await readCache(lastUserID, "voiceTurns");
      if (cached && active && cached.length > 0) {
        setTurns((current) => (current.length > 0 ? current : cached));
      }
    })();
    return () => {
      active = false;
    };
  }, [enabled, appActive]);

  // Open / tear down the WS based on `enabled` (typically: modal visible).
  //
  // Reconnection is not a nicety here, it is what makes the always-listening
  // dock work at all. A Gemini Live session is not open-ended: it ends on its
  // own time limit, and sends `go_away` first, which the bridge turns into a
  // close. Backgrounding the app, a network change, or a Metro reload do the
  // same thing. Without this, the first such close was permanent — status went
  // to "error", the dock's mic gate never reopened, and EVE was silent until
  // the app restarted, while the header cheerfully claimed "Reconnecting".
  useEffect(() => {
    // A backgrounded React Native app must not hold or recreate a billable
    // Gemini session. AppState changes re-run this effect, so its cleanup
    // closes the foreground socket before this guard is evaluated.
    if (!enabled || !appActive) return;
    // Browser WebSocket deliberately does not expose an API for arbitrary
    // upgrade headers. The API accepts bearer auth only in that header, so a
    // web client cannot safely establish this session until a short-lived
    // ticket/cookie handshake exists. Fail explicitly instead of attempting an
    // unauthenticated socket or putting the long-lived token in the URL.
    if (Platform.OS === "web") {
      const message = "Voice mode is available in the mobile app only.";
      setStatus("error");
      setErrorMessage(message);
      callbacks.current.onError?.(message);
      return;
    }
    const token = tokenStore.current;
    if (!token) {
      setStatus("error");
      setErrorMessage("Sign in before opening voice mode.");
      return;
    }

    let cancelled = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      if (cancelled || !appActiveRef.current) return;
      setStatus("connecting");
      setErrorMessage(null);

      // Put the bearer token in the upgrade header rather than the URL. Query
      // strings are routinely copied into proxy/access logs and browser history.
      const WebSocketCtor = WebSocket as unknown as {
        new (
          url: string,
          protocols?: string | string[],
          options?: { headers?: Record<string, string> },
        ): WebSocket;
      };
      const ws = new WebSocketCtor(buildLiveUrl(), undefined, {
        headers: { Authorization: `Bearer ${token}` },
      });
      socket = ws;
      wsRef.current = ws;

      ws.onopen = () => {
        // Wait for the server's "ready" envelope before flipping state —
        // the Gemini handshake takes ~200-500ms after the socket opens.
      };

      ws.onmessage = (event) => {
        // `close()` is asynchronous on React Native. Ignore a late event from
        // a socket torn down by a background transition or retry.
        if (cancelled || !appActiveRef.current || wsRef.current !== ws) return;
        let msg: any;
        try {
          msg = JSON.parse(typeof event.data === "string" ? event.data : "");
        } catch {
          return;
        }
        handleMessage(msg);
      };

      // An error is always followed by a close, so let close own the retry.
      // Surfacing every transient drop to the user would turn an invisible
      // reconnect into a stream of banners.
      ws.onerror = () => {};

      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        if (cancelled || !appActiveRef.current) return;
        // A turn that was mid-flight is gone with the socket.
        invalidateResponse();
        audioBuffer.current = [];
        audioBytes.current = 0;
        currentAgentTurnId.current = null;
        currentUserTurnId.current = null;
        retry();
      };
    };

    const retry = () => {
      if (cancelled || !appActiveRef.current) return;
      attempt.current += 1;
      // Only complain once it has stopped looking like a blip.
      if (attempt.current === MAX_QUIET_RETRIES) {
        setErrorMessage("Voice connection keeps dropping. Check the API server.");
        callbacks.current.onError?.("Voice connection keeps dropping.");
      }
      const wait = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(attempt.current - 1, 6));
      setStatus("connecting");
      retryTimer = setTimeout(() => {
        retryTimer = null;
        open();
      }, wait);
    };

    open();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      invalidateResponse();
      try {
        socket?.close();
      } catch {
        // best-effort
      }
      wsRef.current = null;
      audioBuffer.current = [];
      audioBytes.current = 0;
      currentAgentTurnId.current = null;
      currentUserTurnId.current = null;
    };
    // Keyed on `enabled` and foreground state: the socket's lifetime is the
    // active session's, and callback identity changes must not drop it.
  }, [enabled, appActive, invalidateResponse]);

  function handleMessage(msg: any) {
    switch (msg.type) {
      case "ready":
        // A session that got this far was a real one, so the backoff starts
        // from scratch next time rather than compounding across the day.
        attempt.current = 0;
        setErrorMessage(null);
        setStatus("idle");
        break;
      case "input-transcript": {
        if (droppingInterruptedResponseRef.current || typeof msg.text !== "string" || !msg.text) return;
        // Gemini Live streams incremental transcript text. We append to
        // a single user turn that represents the current spoken input.
        setTurns((current) => {
          if (currentUserTurnId.current) {
            return current.map((t) =>
              t.id === currentUserTurnId.current ? { ...t, text: t.text + msg.text } : t,
            );
          }
          const id = `u-${Date.now()}`;
          currentUserTurnId.current = id;
          return [...current, { id, role: "user", text: msg.text }];
        });
        break;
      }
      case "output-transcript": {
        if (droppingInterruptedResponseRef.current || typeof msg.text !== "string" || !msg.text) return;
        setTurns((current) => {
          if (currentAgentTurnId.current) {
            return current.map((t) =>
              t.id === currentAgentTurnId.current ? { ...t, text: t.text + msg.text } : t,
            );
          }
          const id = `a-${responseGenerationRef.current}-${Date.now()}`;
          currentAgentTurnId.current = id;
          return [...current, { id, role: "agent", text: msg.text }];
        });
        break;
      }
      case "audio":
        // `interrupt()` invalidates the active response immediately, but the
        // bridge can still deliver frames already in flight until it emits its
        // acknowledgement. Never hand those frames to the speaker.
        if (droppingInterruptedResponseRef.current) break;
        if (
          typeof msg.data === "string" &&
          msg.data.length <= 256 * 1024 &&
          /^[A-Za-z0-9+/]*={0,2}$/.test(msg.data) &&
          msg.data.length % 4 !== 1
        ) {
          const generation = responseGenerationRef.current;
          if (activeAudioGenerationRef.current !== null && activeAudioGenerationRef.current !== generation) {
            break;
          }
          activeAudioGenerationRef.current = generation;
          audioBytes.current += Math.ceil((msg.data.length * 3) / 4);
          if (audioBytes.current > 4 * 1024 * 1024) return;
          audioBuffer.current.push(msg.data);
          callbacks.current.onAudioChunk?.(msg.data);
          setStatus("speaking");
        }
        break;
      case "turn-complete": {
        if (droppingInterruptedResponseRef.current) break;
        const chunks = audioBuffer.current;
        audioBuffer.current = [];
        audioBytes.current = 0;
        currentAgentTurnId.current = null;
        currentUserTurnId.current = null;
        activeAudioGenerationRef.current = null;
        responsePendingRef.current = false;
        if (chunks.length > 0) {
          if (callbacks.current.onAudioChunk || callbacks.current.onAudioComplete) {
            callbacks.current.onAudioComplete?.();
          } else {
            callbacks.current.onAudioResponse?.(chunks);
          }
        }
        setStatus("idle");
        // Persist after the turn settles — the in-progress deltas write
        // every keystroke otherwise, which is wasteful.
        const uid = userIDRef.current;
        if (uid) {
          setTurns((current) => {
            void writeCache(uid, "voiceTurns", current);
            return current;
          });
        }
        break;
      }
      case "interrupted":
        // User barge-in. Throw away any audio we hadn't flushed yet.
        audioBuffer.current = [];
        audioBytes.current = 0;
        activeAudioGenerationRef.current = null;
        interruptionPendingRef.current = false;
        droppingInterruptedResponseRef.current = false;
        clearInterruptionTimer();
        setStatus(responsePendingRef.current ? "thinking" : "idle");
        break;
      case "error":
        setStatus("error");
        setErrorMessage(typeof msg.message === "string" ? msg.message : "Voice error");
        callbacks.current.onError?.(typeof msg.message === "string" ? msg.message : "Voice error");
        break;
      default:
        // Forward-compatible — unknown types ignored.
        break;
    }
  }

  const sendText = useCallback((text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setStatus("error");
      setErrorMessage("Voice connection isn't ready.");
      return false;
    }
    const trimmed = text.trim();
    if (!trimmed) return false;
    // Reset accumulators — a new turn is starting.
    responseGenerationRef.current += 1;
    activeAudioGenerationRef.current = null;
    responsePendingRef.current = true;
    // If this follows an interrupt, keep dropping frames until the bridge's
    // acknowledgement arrives. Without this boundary, a late old frame can
    // be mistaken for the new answer and restart playback after barge-in.
    if (!interruptionPendingRef.current) droppingInterruptedResponseRef.current = false;
    audioBuffer.current = [];
    audioBytes.current = 0;
    currentAgentTurnId.current = null;
    setStatus("thinking");
    // We record the user's turn locally for transcript display before
    // the model echoes it back via input-transcript (the model only
    // emits input-transcript for actual spoken audio, not for text).
    const id = `u-${Date.now()}`;
    setTurns((current) => [...current, { id, role: "user", text: trimmed }]);
    try {
      ws.send(JSON.stringify({ type: "text", text: trimmed }));
    } catch {
      responsePendingRef.current = false;
      setStatus("error");
      setErrorMessage("Voice connection isn't ready.");
      return false;
    }
    return true;
  }, []);

  /** Stop the current model response when the user starts speaking. */
  const interrupt = useCallback(() => {
    const ws = wsRef.current;
    responseGenerationRef.current += 1;
    activeAudioGenerationRef.current = null;
    responsePendingRef.current = false;
    interruptionPendingRef.current = true;
    droppingInterruptedResponseRef.current = true;
    clearInterruptionTimer();
    interruptionTimerRef.current = setTimeout(() => {
      interruptionTimerRef.current = null;
      interruptionPendingRef.current = false;
      // Keep the old response quarantined until a follow-up turn is actually
      // requested. If no text is pending, clearing this here would let a very
      // late frame restart playback after the user had already interrupted.
      if (responsePendingRef.current) droppingInterruptedResponseRef.current = false;
    }, INTERRUPT_ACK_TIMEOUT_MS);
    audioBuffer.current = [];
    audioBytes.current = 0;
    currentAgentTurnId.current = null;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      interruptionPendingRef.current = false;
      droppingInterruptedResponseRef.current = false;
      clearInterruptionTimer();
      return false;
    }
    try {
      ws.send(JSON.stringify({ type: "interrupt" }));
      setStatus("idle");
      return true;
    } catch {
      interruptionPendingRef.current = false;
      droppingInterruptedResponseRef.current = false;
      clearInterruptionTimer();
      return false;
    }
  }, [clearInterruptionTimer]);

  const clearTurns = useCallback(() => {
    setTurns([]);
    currentAgentTurnId.current = null;
    currentUserTurnId.current = null;
    const uid = userIDRef.current;
    if (uid) void writeCache(uid, "voiceTurns", []);
  }, []);

  return { status, errorMessage, turns, sendText, interrupt, clearTurns };
}

function buildLiveUrl(): string {
  // Replace http(s) with ws(s) — the API base may be http://127.0.0.1 in a
  // debug build or https://... in preview/production.
  const base = config.apiBaseURL.replace(/^http/i, "ws");
  assertSecureTransport(config.apiBaseURL);
  return `${base}/v1/voice/live`;
}
