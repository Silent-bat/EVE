/**
 * useGeminiLive — mobile-side client for a DIRECT Gemini Live connection.
 *
 * The Node WebSocket relay is gone. The phone now:
 *   1. asks Convex (api.voice.mintLiveToken) for a short-lived ephemeral token
 *      — the token locks the model, system instruction, and tool catalog
 *      server-side, so none of that lives on the device;
 *   2. opens the Gemini Live WebSocket directly with that token; and
 *   3. when Gemini asks to run a tool, dispatches it back to Convex
 *      (api.voice.runVoiceTool) and returns the result as a tool_response.
 *
 * The public shape (status, errorMessage, turns, sendText, interrupt,
 * clearTurns) is unchanged, so VoiceScreen / VoiceDock keep working. The mic
 * path is unchanged too: callers still transcribe audio via Convex and feed
 * text in through sendText — only text turns go over this socket; Gemini's
 * audio reply comes back as base64 PCM chunks.
 *
 * State machine:
 *   idle       — connected, waiting for the user to do something
 *   thinking   — text submitted, Gemini hasn't started replying yet
 *   speaking   — receiving audio chunks (we also have transcript by now)
 *   connecting — minting a token / initial open before setup_complete
 *   error      — see errorMessage
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";

import { convex, api } from "../api/convexApi";
import { readCache, readLastUserID, writeCache } from "../storage/localCache";

export type LiveStatus = "connecting" | "idle" | "thinking" | "speaking" | "error";

/**
 * Gemini Live WebSocket endpoint for EPHEMERAL TOKENS. Two things differ from
 * a normal API-key connection: the method is `BidiGenerateContentConstrained`
 * (the token locks the setup), and the token rides in `?access_token=`. Auth
 * tokens are a v1alpha feature. Verified against the live API — a normal
 * `BidiGenerateContent` URL returns close 1008 "unregistered caller" for a
 * token.
 */
const GEMINI_LIVE_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";

/** First reconnect delay. Doubles per attempt, so a blip costs half a second. */
const BASE_BACKOFF_MS = 500;

/** Ceiling on the backoff, so a dead connection is retried without hammering it. */
const MAX_BACKOFF_MS = 15_000;

/**
 * Consecutive failures before the user is told. Gemini Live sessions end on
 * their own schedule and reconnect in well under a second, which is not worth a
 * banner; a connection that is actually down keeps failing and earns one.
 */
const MAX_QUIET_RETRIES = 3;

/** Do not leave a queued follow-up blocked forever if an ack never lands. */
const INTERRUPT_ACK_TIMEOUT_MS = 2_000;

/**
 * Decode a WebSocket frame to text. Gemini Live sends its JSON envelopes as
 * BINARY frames; with binaryType="arraybuffer" React Native hands us an
 * ArrayBuffer, which we decode as UTF-8. Plain string frames pass through.
 */
function decodeWsData(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    try {
      if (typeof TextDecoder !== "undefined") {
        return new TextDecoder("utf-8").decode(new Uint8Array(data));
      }
    } catch {
      // fall through to the manual decoder
    }
    return utf8FromBytes(new Uint8Array(data));
  }
  return "";
}

/** Minimal UTF-8 decoder fallback for runtimes without TextDecoder. */
function utf8FromBytes(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++] ?? 0;
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else if (b >= 0xc0 && b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | ((bytes[i++] ?? 0) & 0x3f));
    } else if (b >= 0xe0 && b < 0xf0) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | (((bytes[i++] ?? 0) & 0x3f) << 6) | ((bytes[i++] ?? 0) & 0x3f),
      );
    } else {
      const cp =
        ((b & 0x07) << 18) |
        (((bytes[i++] ?? 0) & 0x3f) << 12) |
        (((bytes[i++] ?? 0) & 0x3f) << 6) |
        ((bytes[i++] ?? 0) & 0x3f);
      const c = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    }
  }
  return out;
}

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
  /** Debounce timer for sustained-background detection (see AppState effect). */
  const bgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Consecutive failed connects, reset by a session that reaches setup_complete. */
  const attempt = useRef(0);
  // Capture callbacks in a ref so the effect doesn't re-run every render.
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
      if (next === "active") {
        // Back in foreground (or a flicker resolved) — cancel any pending
        // teardown and keep/restore the live session.
        if (bgTimerRef.current) {
          clearTimeout(bgTimerRef.current);
          bgTimerRef.current = null;
        }
        appActiveRef.current = true;
        setAppActive(true);
        return;
      }
      // Debounce backgrounding. Acquiring the microphone flips AppState to
      // "background" for a few hundred ms on some devices; tearing the socket
      // down on that flicker caused a connect→ready→close→reconnect loop. Only
      // a SUSTAINED background is a real teardown, so the session stays up while
      // the user is signed in and using voice.
      if (bgTimerRef.current) return;
      bgTimerRef.current = setTimeout(() => {
        bgTimerRef.current = null;
        appActiveRef.current = false;
        setAppActive(false);
      }, 1500);
    });
    return () => {
      subscription.remove();
      if (bgTimerRef.current) {
        clearTimeout(bgTimerRef.current);
        bgTimerRef.current = null;
      }
    };
  }, []);

  // Restore prior conversation turns from disk so the user sees their last
  // voice session as soon as the modal opens, before the socket even connects.
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

  // Open / tear down the connection based on `enabled` (typically: modal
  // visible) and foreground state. A Gemini Live session is not open-ended: it
  // ends on its own time limit and sends go_away first. Backgrounding, a
  // network change, or token expiry do the same. Reconnection with bounded
  // backoff is what keeps the always-listening dock working across all of that.
  useEffect(() => {
    // A backgrounded RN app must not hold or recreate a billable Gemini
    // session. AppState changes re-run this effect; its cleanup closes the
    // foreground socket before this guard is evaluated.
    if (!enabled || !appActive) return;
    if (Platform.OS === "web") {
      const message = "Voice mode is available in the mobile app only.";
      setStatus("error");
      setErrorMessage(message);
      callbacks.current.onError?.(message);
      return;
    }

    let cancelled = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const open = async () => {
      if (cancelled || !appActiveRef.current) return;
      setStatus("connecting");
      setErrorMessage(null);

      // Mint a fresh ephemeral token per connection. Tokens are single-use
      // (uses:1), so each (re)connect needs its own; the real API key stays on
      // Convex. A failure here (not signed in, no GEMINI_API_KEY) is terminal
      // for this attempt and flows into the normal retry/backoff path.
      let token: string;
      try {
        const minted = await convex.action(api.voice.mintLiveToken, {});
        token = minted.token;
      } catch (err) {
        if (cancelled || !appActiveRef.current) return;
        const message = err instanceof Error ? err.message : "Could not start voice.";
        // Not-signed-in is a hard stop, not a transient blip.
        if (/not authenticated/i.test(message)) {
          setStatus("error");
          setErrorMessage("Sign in before opening voice mode.");
          return;
        }
        retry();
        return;
      }
      if (cancelled || !appActiveRef.current) return;

      const url = `${GEMINI_LIVE_ENDPOINT}?access_token=${encodeURIComponent(token)}`;
      console.log("[voice] minted token len", token.length, "→ opening WS");
      const ws = new WebSocket(url);
      // Gemini Live sends its JSON envelopes as BINARY frames. React Native
      // delivers those as a Blob by default (which JSON.parse can't read);
      // ask for ArrayBuffers so we can decode them to text deterministically.
      (ws as unknown as { binaryType: string }).binaryType = "arraybuffer";
      socket = ws;
      wsRef.current = ws;

      ws.onopen = () => {
        // The ephemeral token locks the entire setup (model, system
        // instruction, tools, audio config) server-side, so the client sends
        // an EMPTY setup — sending a model here conflicts with the constrained
        // token. Status stays "connecting" until Gemini answers setup_complete.
        console.log("[voice] WS open → sending empty setup");
        try {
          ws.send(JSON.stringify({ setup: {} }));
        } catch (e) {
          console.warn("[voice] setup send failed", String(e));
          // close handler owns the retry
        }
      };

      ws.onmessage = (event: any) => {
        // close() is asynchronous on RN. Ignore a late event from a socket torn
        // down by a background transition or retry.
        if (cancelled || !appActiveRef.current || wsRef.current !== ws) return;
        const raw = decodeWsData(event?.data);
        if (!raw) return;
        let msg: any;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        handleServerMessage(msg, ws);
      };

      // An error is always followed by a close, so let close own the retry.
      ws.onerror = (e: any) => {
        console.warn("[voice] WS error", e?.message ?? String(e));
      };

      ws.onclose = (e: any) => {
        console.warn("[voice] WS close code", e?.code, "reason", e?.reason);
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        if (cancelled || !appActiveRef.current) return;
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
      if (attempt.current === MAX_QUIET_RETRIES) {
        setErrorMessage("Voice connection keeps dropping. Check your network.");
        callbacks.current.onError?.("Voice connection keeps dropping.");
      }
      const wait = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(attempt.current - 1, 6));
      setStatus("connecting");
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void open();
      }, wait);
    };

    void open();

    return () => {
      console.log("[voice] effect teardown (enabled/appActive changed or unmount)");
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
  }, [enabled, appActive, invalidateResponse]);

  /**
   * Translate a Gemini Live server message into transcript/audio/tool effects.
   * v1beta is protobuf-derived: field names arrive snake_case (setup_complete,
   * server_content, model_turn, inline_data, ...). Read both shapes defensively
   * so this survives a future camelCase flip.
   */
  function handleServerMessage(msg: any, ws: WebSocket) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;

    if (msg.setup_complete || msg.setupComplete) {
      // A session that got this far was a real one, so backoff starts fresh.
      console.log("[voice] setup_complete → ready");
      attempt.current = 0;
      setErrorMessage(null);
      setStatus("idle");
      return;
    }

    const content = msg.server_content || msg.serverContent;
    if (content) {
      const modelTurn = content.model_turn || content.modelTurn;
      const parts = Array.isArray(modelTurn?.parts) ? modelTurn.parts : [];
      for (const part of parts) {
        if (!part || typeof part !== "object" || Array.isArray(part)) continue;
        const inline = part.inline_data || part.inlineData;
        if (typeof inline?.data === "string" && inline.data) {
          handleAudioChunk(inline.data);
        } else if (typeof part.text === "string" && part.text) {
          appendAgentTranscript(part.text);
        }
      }

      const inputT = content.input_transcription || content.inputTranscription;
      if (typeof inputT?.text === "string" && inputT.text) appendUserTranscript(inputT.text);

      const outputT = content.output_transcription || content.outputTranscription;
      if (typeof outputT?.text === "string" && outputT.text) appendAgentTranscript(outputT.text);

      if (content.turn_complete || content.turnComplete) handleTurnComplete();
      if (content.interrupted) handleInterrupted();
      return;
    }

    const toolCall = msg.tool_call || msg.toolCall;
    if (toolCall) {
      void handleToolCall(toolCall, ws);
      return;
    }

    // go_away precedes a server-side close; let the socket close and reconnect.
    if (msg.go_away || msg.goAway) {
      try {
        ws.close();
      } catch {
        // best-effort
      }
      return;
    }
  }

  function appendUserTranscript(text: string) {
    if (droppingInterruptedResponseRef.current) return;
    setTurns((current) => {
      if (currentUserTurnId.current) {
        return current.map((t) =>
          t.id === currentUserTurnId.current ? { ...t, text: t.text + text } : t,
        );
      }
      const id = `u-${Date.now()}`;
      currentUserTurnId.current = id;
      return [...current, { id, role: "user", text }];
    });
  }

  function appendAgentTranscript(text: string) {
    if (droppingInterruptedResponseRef.current) return;
    setTurns((current) => {
      if (currentAgentTurnId.current) {
        return current.map((t) =>
          t.id === currentAgentTurnId.current ? { ...t, text: t.text + text } : t,
        );
      }
      const id = `a-${responseGenerationRef.current}-${Date.now()}`;
      currentAgentTurnId.current = id;
      return [...current, { id, role: "agent", text }];
    });
  }

  function handleAudioChunk(data: string) {
    // interrupt() invalidates the active response immediately, but frames
    // already in flight can still arrive. Never hand those to the speaker.
    if (droppingInterruptedResponseRef.current) return;
    if (
      typeof data === "string" &&
      data.length <= 256 * 1024 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(data) &&
      data.length % 4 !== 1
    ) {
      const generation = responseGenerationRef.current;
      if (activeAudioGenerationRef.current !== null && activeAudioGenerationRef.current !== generation) {
        return;
      }
      activeAudioGenerationRef.current = generation;
      audioBytes.current += Math.ceil((data.length * 3) / 4);
      if (audioBytes.current > 4 * 1024 * 1024) return;
      audioBuffer.current.push(data);
      callbacks.current.onAudioChunk?.(data);
      setStatus("speaking");
    }
  }

  function handleTurnComplete() {
    if (droppingInterruptedResponseRef.current) return;
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
    const uid = userIDRef.current;
    if (uid) {
      setTurns((current) => {
        void writeCache(uid, "voiceTurns", current);
        return current;
      });
    }
  }

  function handleInterrupted() {
    audioBuffer.current = [];
    audioBytes.current = 0;
    activeAudioGenerationRef.current = null;
    interruptionPendingRef.current = false;
    droppingInterruptedResponseRef.current = false;
    clearInterruptionTimer();
    setStatus(responsePendingRef.current ? "thinking" : "idle");
  }

  /**
   * Fulfil a Gemini tool_call by dispatching each function to Convex and
   * sending the results back as a tool_response over the same socket.
   */
  async function handleToolCall(toolCall: any, ws: WebSocket) {
    const calls = Array.isArray(toolCall.function_calls)
      ? toolCall.function_calls
      : Array.isArray(toolCall.functionCalls)
        ? toolCall.functionCalls
        : [];
    if (calls.length === 0) return;

    const responses: Array<{ id: string; name: string; response: { result: unknown } }> = [];
    for (const call of calls) {
      if (!call || typeof call !== "object") continue;
      const name = typeof call.name === "string" ? call.name.slice(0, 200) : "";
      const id = typeof call.id === "string" ? call.id.slice(0, 200) : "";
      if (!name || !id) continue;
      let result: unknown;
      try {
        result = await convex.action(api.voice.runVoiceTool, { name, args: call.args || {} });
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : "voice tool failed" };
      }
      responses.push({ id, name, response: { result: result ?? null } });
    }

    if (wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ tool_response: { function_responses: responses } }));
    } catch {
      // best-effort; a dropped socket reconnects on its own
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
    if (!interruptionPendingRef.current) droppingInterruptedResponseRef.current = false;
    audioBuffer.current = [];
    audioBytes.current = 0;
    currentAgentTurnId.current = null;
    setStatus("thinking");
    // Record the user's turn locally for transcript display; Gemini only emits
    // input_transcription for actual spoken audio, not for injected text.
    const id = `u-${Date.now()}`;
    setTurns((current) => [...current, { id, role: "user", text: trimmed }]);
    try {
      ws.send(
        JSON.stringify({
          client_content: {
            turns: [{ role: "user", parts: [{ text: trimmed }] }],
            turn_complete: true,
          },
        }),
      );
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
      // Live models an interruption as a new realtime activity; an empty
      // activity marker cancels generation without manufacturing user text.
      ws.send(JSON.stringify({ realtime_input: { activity_start: {} } }));
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
