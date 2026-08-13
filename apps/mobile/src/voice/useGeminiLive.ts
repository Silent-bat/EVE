/**
 * useGeminiLive — mobile-side client for the /v1/voice/live WebSocket.
 *
 * Owns the WS lifecycle, accumulates streaming transcripts and audio
 * chunks, and emits a small state machine so VoiceScreen can render
 * status without caring about the wire format. Reuses the existing
 * tokenStore for auth; reconnects are NOT automatic in v0 (a manual
 * close+reopen happens when the modal opens).
 *
 * State machine:
 *   idle       — connected, waiting for the user to do something
 *   thinking   — text submitted, Gemini hasn't started replying yet
 *   speaking   — receiving audio chunks (we also have transcript by now)
 *   connecting — initial open before the server says "ready"
 *   error      — see errorMessage
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { config } from "../config";
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
};

export function useGeminiLive({ enabled, onError, onAudioResponse }: Props) {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const userIDRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const currentAgentTurnId = useRef<string | null>(null);
  const currentUserTurnId = useRef<string | null>(null);
  const audioBuffer = useRef<string[]>([]);
  /** Consecutive failed connects, reset by a session that reaches "ready". */
  const attempt = useRef(0);
  // Capture onError/onAudioResponse in a ref so the effect doesn't
  // re-run every render. The connect cycle is heavy.
  const callbacks = useRef({ onError, onAudioResponse });
  useEffect(() => {
    callbacks.current = { onError, onAudioResponse };
  }, [onError, onAudioResponse]);

  // Restore prior conversation turns from disk so the user sees their
  // last voice session as soon as the modal opens, before the WS even
  // connects. Runs once per enabled cycle.
  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled]);

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
    if (!enabled) return;
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
      if (cancelled) return;
      setStatus("connecting");
      setErrorMessage(null);

      const ws = new WebSocket(buildLiveUrl(token));
      socket = ws;
      wsRef.current = ws;

      ws.onopen = () => {
        // Wait for the server's "ready" envelope before flipping state —
        // the Gemini handshake takes ~200-500ms after the socket opens.
      };

      ws.onmessage = (event) => {
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
        if (wsRef.current === ws) wsRef.current = null;
        if (cancelled) return;
        // A turn that was mid-flight is gone with the socket.
        audioBuffer.current = [];
        currentAgentTurnId.current = null;
        currentUserTurnId.current = null;
        retry();
      };
    };

    const retry = () => {
      attempt.current += 1;
      // Only complain once it has stopped looking like a blip.
      if (attempt.current === MAX_QUIET_RETRIES) {
        setErrorMessage("Voice connection keeps dropping. Check the API server.");
        callbacks.current.onError?.("Voice connection keeps dropping.");
      }
      const wait = Math.min(
        MAX_BACKOFF_MS,
        BASE_BACKOFF_MS * 2 ** Math.min(attempt.current - 1, 6),
      );
      setStatus("connecting");
      retryTimer = setTimeout(open, wait);
    };

    open();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      try {
        socket?.close();
      } catch {
        // best-effort
      }
      wsRef.current = null;
      audioBuffer.current = [];
      currentAgentTurnId.current = null;
      currentUserTurnId.current = null;
    };
    // Keyed on `enabled` alone: the socket's lifetime is the session's, and
    // re-running this on a changed callback identity would drop the connection
    // mid-conversation.
  }, [enabled]);

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
        if (typeof msg.text !== "string" || !msg.text) return;
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
        if (typeof msg.text !== "string" || !msg.text) return;
        setTurns((current) => {
          if (currentAgentTurnId.current) {
            return current.map((t) =>
              t.id === currentAgentTurnId.current ? { ...t, text: t.text + msg.text } : t,
            );
          }
          const id = `a-${Date.now()}`;
          currentAgentTurnId.current = id;
          return [...current, { id, role: "agent", text: msg.text }];
        });
        break;
      }
      case "audio":
        if (typeof msg.data === "string") {
          audioBuffer.current.push(msg.data);
          setStatus("speaking");
        }
        break;
      case "turn-complete": {
        const chunks = audioBuffer.current;
        audioBuffer.current = [];
        currentAgentTurnId.current = null;
        currentUserTurnId.current = null;
        if (chunks.length > 0) callbacks.current.onAudioResponse?.(chunks);
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
        setStatus("idle");
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
    audioBuffer.current = [];
    currentAgentTurnId.current = null;
    setStatus("thinking");
    // We record the user's turn locally for transcript display before
    // the model echoes it back via input-transcript (the model only
    // emits input-transcript for actual spoken audio, not for text).
    const id = `u-${Date.now()}`;
    setTurns((current) => [...current, { id, role: "user", text: trimmed }]);
    ws.send(JSON.stringify({ type: "text", text: trimmed }));
    return true;
  }, []);

  const clearTurns = useCallback(() => {
    setTurns([]);
    currentAgentTurnId.current = null;
    currentUserTurnId.current = null;
    const uid = userIDRef.current;
    if (uid) void writeCache(uid, "voiceTurns", []);
  }, []);

  return { status, errorMessage, turns, sendText, clearTurns };
}

function buildLiveUrl(token: string): string {
  // Replace http(s) with ws(s) — the API base may be http://127.0.0.1
  // (adb reverse) or https://<lan-ip>:8080.
  const base = config.apiBaseURL.replace(/^http/i, "ws");
  return `${base}/v1/voice/live?token=${encodeURIComponent(token)}`;
}
