/**
 * GeminiLiveSession — bidirectional realtime voice/text bridge to the
 * Gemini Live API.
 *
 * Wraps the upstream WebSocket (wss://generativelanguage.googleapis.com)
 * so callers (typically the per-user WS proxy in server.mjs) can stream
 * 16kHz PCM mic chunks in and receive 24kHz PCM speech chunks out, plus
 * transcripts and tool calls. Tool execution is delegated to an
 * onToolCall(name, args) function the caller injects — usually a thin
 * wrapper around runTool() so the existing TOOL_CATALOG is reused.
 *
 * Wire format reference:
 *   https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket
 *
 * Events emitted:
 *   - open                  — Gemini accepted the setup, ready to send audio
 *   - audio (base64)        — 24kHz PCM speech chunk for the user's device
 *   - inputTranscript(text) — what Gemini heard the user say (deltas concatenate)
 *   - outputTranscript(text)— what Gemini is saying back (deltas concatenate)
 *   - turnComplete          — model finished a turn; OK to interrupt
 *   - interrupted           — model was interrupted by user audio
 *   - toolCallResult(payload)— after a tool ran (debugging / telemetry)
 *   - error(err)
 *   - close
 */
import EventEmitter from "node:events";
import { WebSocket } from "ws";
import { config } from "../config.mjs";
import { moduleLogger } from "../logger.mjs";

const log = moduleLogger("voice.live");

const ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

// gemini-3.1-flash-live-preview is the current Live-capable model
// (confirmed via ListModels: it's one of only a handful that lists
// bidiGenerateContent as a supported method). Override via
// GEMINI_LIVE_MODEL to test newer preview variants.
const DEFAULT_MODEL = process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview";
const MAX_ERROR_CHARS = 4_000;

/**
 * @typedef {Object} GeminiLiveOptions
 * @property {string} apiKey                          Google AI Studio key.
 * @property {string} userID                          For log scoping.
 * @property {string} [model]                         Override the default.
 * @property {string} [systemInstruction]             Prepended to every turn.
 * @property {any[]}  [tools]                         Gemini-shape tools array (see toolSchema.mjs).
 * @property {(name: string, args: any) => Promise<any>} [onToolCall]
 *   Resolves tool calls server-side. Return value is sent back as the
 *   functionResponse.result.
 */

export class GeminiLiveSession extends EventEmitter {
  /** @param {GeminiLiveOptions} options */
  constructor(options) {
    super();
    if (!options?.apiKey) throw new Error("GeminiLiveSession requires apiKey");
    this.apiKey = options.apiKey;
    this.userID = options.userID || "anon";
    this.model = options.model || DEFAULT_MODEL;
    this.systemInstruction = options.systemInstruction || "";
    this.tools = options.tools || [];
    this.onToolCall = options.onToolCall || null;
    /** @type {WebSocket | null} */
    this.ws = null;
    this.connected = false;
    this.setupReady = false;
    /** @type {(() => void) | null} */
    this.setupResolve = null;
    /** @type {((error: Error) => void) | null} */
    this.setupReject = null;
    this.closed = false;
  }

  /**
   * Open the upstream connection and send the setup message. Resolves when
   * the WS reports open (NOT when Gemini acknowledges setup — that's
   * implicit by the first incoming serverContent).
   */
  async connect() {
    // Authenticate the upstream handshake with a header. Putting the API key
    // in the URL leaks it into WebSocket/proxy access logs and connection
    // diagnostics; `ws` preserves this header during the TLS upgrade.
    this.ws = new WebSocket(ENDPOINT, {
      headers: { "x-goog-api-key": this.apiKey },
    });
    this.closed = false;
    this.connected = false;
    this.setupReady = false;

    return new Promise((resolve, reject) => {
      const ws = /** @type {WebSocket} */ (this.ws);
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.off("open", onOpen);
        ws.off("error", onErrorBeforeOpen);
        this.setupResolve = null;
        this.setupReject = null;
        this.connected = false;
        try {
          /** @type {{ terminate?: () => void }} */ (/** @type {unknown} */ (ws)).terminate?.();
        } catch {
          /* best-effort */
        }
        reject(new Error("Gemini Live setup timed out"));
      }, config.outboundTimeoutMs);
      timeout.unref?.();
      const onOpen = () => {
        if (settled) return;
        ws.off("error", onErrorBeforeOpen);
        this.connected = true;
        // TCP open is not enough: Gemini may still reject or be parsing the
        // setup payload. Hold the client handshake until setup_complete.
        this.setupResolve = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.setupReady = true;
          this.setupResolve = null;
          this.setupReject = null;
          this.emit("open");
          resolve(undefined);
        };
        this.setupReject = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.connected = false;
          this.setupReady = false;
          this.setupResolve = null;
          this.setupReject = null;
          try {
            /** @type {{ terminate?: () => void }} */ (/** @type {unknown} */ (ws)).terminate?.();
          } catch {
            /* best-effort */
          }
          reject(error);
        };
        this.attachHandlers();
        this.sendSetup();
      };
      const onErrorBeforeOpen = (/** @type {unknown} */ err) => {
        if (settled) return;
        settled = true;
        ws.off("open", onOpen);
        this.connected = false;
        this.setupReady = false;
        this.setupResolve = null;
        this.setupReject = null;
        clearTimeout(timeout);
        const message = normalizeLiveError(err, "Gemini Live connection failed");
        log.warn({ userID: this.userID, err: message }, "gemini live connect failed");
        reject(new Error(message));
      };
      ws.once("open", onOpen);
      ws.once("error", onErrorBeforeOpen);
    });
  }

  sendSetup() {
    // v1beta uses protobuf snake_case field names on the wire (camelCase
    // is only for the JS SDK abstraction). Stick to snake_case here.
    /** @type {Record<string, unknown>} */
    const setup = {
      model: this.model.startsWith("models/") ? this.model : `models/${this.model}`,
      generation_config: { response_modalities: ["AUDIO"] },
      input_audio_transcription: {},
      output_audio_transcription: {},
    };
    if (this.systemInstruction) {
      setup.system_instruction = { parts: [{ text: this.systemInstruction }] };
    }
    if (this.tools.length) {
      setup.tools = this.tools;
    }
    this.send({ setup });
  }

  /**
   * Send a raw client message. Caller is responsible for shape; private
   * use only — most callers should use sendAudio / sendText.
   *
   * @param {Record<string, unknown>} message
   */
  send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.debug({ userID: this.userID }, "drop send: ws not open");
      return;
    }
    const bufferedAmount =
      /** @type {{ bufferedAmount?: number }} */ (/** @type {unknown} */ (this.ws)).bufferedAmount || 0;
    if (bufferedAmount > 1024 * 1024) {
      const error = new Error("Gemini Live upstream backpressure limit exceeded");
      log.warn({ userID: this.userID }, error.message);
      this.emit("error", error);
      this.close();
      return;
    }
    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      const message = normalizeLiveError(error, "Gemini Live send failed");
      log.warn({ userID: this.userID, err: message }, "gemini live send failed");
      this.emit("error", new Error(message));
    }
  }

  /**
   * Stream a single audio chunk to Gemini. Must be raw 16-bit PCM at
   * 16kHz, little-endian, base64-encoded. Chunk size in the 50-200ms
   * range gives the smoothest interaction.
   *
   * @param {string} base64
   */
  sendAudio(base64) {
    this.send({
      realtime_input: {
        audio: { data: base64, mime_type: "audio/pcm;rate=16000" },
      },
    });
  }

  /**
   * Send a text message as if the user typed it. Useful for dev tooling
   * and for typed follow-ups while voice is paused.
   *
   * @param {string} text
   */
  sendText(text) {
    if (!text.trim()) return;
    this.send({
      client_content: {
        turns: [{ role: "user", parts: [{ text }] }],
        turn_complete: true,
      },
    });
  }

  /**
   * Tell the model the user is done speaking (mic released). Useful when
   * the client doesn't rely on Gemini's server-side VAD.
   */
  endAudioInput() {
    this.send({ realtime_input: { audio_stream_end: true } });
  }

  /**
   * Ask Gemini to stop the current response. Live's wire protocol models an
   * interruption as a new realtime activity; an empty activity marker is
   * enough to cancel generation without manufacturing user text.
   */
  interrupt() {
    this.send({ realtime_input: { activity_start: {} } });
  }

  close() {
    this.closed = true;
    this.connected = false;
    this.setupReady = false;
    const rejectSetup = this.setupReject;
    this.setupResolve = null;
    this.setupReject = null;
    rejectSetup?.(new Error("Gemini Live session closed before setup completed"));
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      try {
        this.ws.close();
      } catch {
        // best-effort
      }
    }
  }

  attachHandlers() {
    const ws = /** @type {WebSocket} */ (this.ws);
    ws.on("message", (/** @type {any} */ raw) => {
      /** @type {any} */
      let msg;
      try {
        const text = typeof raw?.toString === "function" ? raw.toString() : "";
        msg = JSON.parse(text);
      } catch (err) {
        log.warn(
          { userID: this.userID, err: normalizeLiveError(err, "invalid provider message") },
          "non-JSON message from gemini",
        );
        return;
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
        log.warn({ userID: this.userID }, "invalid provider message shape");
        return;
      }
      this.handleServerMessage(msg);
    });
    ws.on("error", (/** @type {unknown} */ err) => {
      const message = normalizeLiveError(err, "Gemini Live websocket error");
      const normalized = new Error(message);
      log.warn({ userID: this.userID, err: message }, "gemini live ws error");
      this.setupReject?.(normalized);
      this.emit("error", normalized);
    });
    ws.on("close", (/** @type {number} */ code, /** @type {Buffer} */ reasonBuf) => {
      const reason = reasonBuf?.toString?.() || "";
      log.info({ userID: this.userID, code, reason }, "gemini live ws closed");
      this.connected = false;
      this.setupReady = false;
      this.setupReject?.(new Error(`Gemini Live closed during setup (${code})`));
      this.emit("close", { code, reason });
    });
  }

  /** @param {any} msg */
  handleServerMessage(msg) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    // Gemini's v1beta wire format is protobuf-derived: field names come
    // back as snake_case (setup_complete, server_content, tool_call,
    // model_turn, inline_data, mime_type, input_transcription, ...).
    // Some SDKs/clients see camelCase because they translate; we don't.
    // Read both shapes defensively so this survives future format flips.
    const setupComplete = msg.setup_complete || msg.setupComplete;
    if (setupComplete) {
      log.info({ userID: this.userID }, "gemini setup_complete");
      this.setupResolve?.();
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
          this.emit("audio", inline.data);
        } else if (typeof part.text === "string" && part.text) {
          this.emit("outputTranscript", part.text);
        }
      }
      const inputT = content.input_transcription || content.inputTranscription;
      if (typeof inputT?.text === "string" && inputT.text) this.emit("inputTranscript", inputT.text);

      const outputT = content.output_transcription || content.outputTranscription;
      if (typeof outputT?.text === "string" && outputT.text) this.emit("outputTranscript", outputT.text);

      if (content.turn_complete || content.turnComplete) this.emit("turnComplete");
      if (content.interrupted) this.emit("interrupted");
      return;
    }

    const toolCall = msg.tool_call || msg.toolCall;
    if (toolCall) {
      void this.handleToolCall(toolCall);
      return;
    }

    const goAway = msg.go_away || msg.goAway;
    if (goAway) {
      log.warn({ userID: this.userID, goAway }, "gemini live go_away");
      this.close();
      return;
    }
  }

  /**
   * @param {{ functionCalls?: any[], function_calls?: any[] }} toolCall
   */
  async handleToolCall(toolCall) {
    if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return;
    const calls = Array.isArray(toolCall.function_calls)
      ? toolCall.function_calls
      : Array.isArray(toolCall.functionCalls)
        ? toolCall.functionCalls
        : [];
    if (calls.length === 0) return;

    /** @type {Array<{ id: string, name: string, response: { result: any } }>} */
    const responses = [];
    for (const call of calls) {
      if (!call || typeof call !== "object" || Array.isArray(call)) {
        log.warn({ userID: this.userID }, "ignoring malformed Gemini tool call");
        continue;
      }
      const name = typeof call.name === "string" ? call.name.slice(0, 200) : "";
      const id = typeof call.id === "string" ? call.id.slice(0, 200) : "";
      if (!name || !id) {
        log.warn({ userID: this.userID }, "ignoring incomplete Gemini tool call");
        continue;
      }
      let result;
      try {
        if (this.onToolCall) {
          result = await this.onToolCall(name, call.args || {});
        } else {
          result = { error: "no tool dispatcher configured" };
        }
      } catch (err) {
        const message = normalizeLiveError(err, "tool dispatch failed");
        log.warn({ userID: this.userID, tool: name, err: message }, "tool dispatch failed");
        result = { error: message };
      }
      responses.push({
        id,
        name,
        response: { result: result ?? null },
      });
      this.emit("toolCallResult", { id, name, result });
    }

    this.send({ tool_response: { function_responses: responses } });
  }
}

/**
 * Convert arbitrary provider failures to a bounded, non-throwing message.
 * Provider adapters and EventEmitter test doubles are not required to emit
 * native `Error` instances, and hostile custom values can throw from coercion.
 *
 * @param {unknown} error
 * @param {string} fallback
 */
function normalizeLiveError(error, fallback) {
  try {
    if (error instanceof Error && error.message) return String(error.message).slice(0, MAX_ERROR_CHARS);
    if (typeof error === "string" && error.trim()) return error.trim().slice(0, MAX_ERROR_CHARS);
  } catch {
    // best-effort normalization only
  }
  return fallback;
}
