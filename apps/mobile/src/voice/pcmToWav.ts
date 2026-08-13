/**
 * Take base64-encoded raw PCM chunks streamed back by Gemini Live (24kHz,
 * 16-bit, mono, little-endian) and produce a playable .wav file on disk, plus an
 * amplitude envelope for the UI.
 *
 * Why this exists: expo-audio's AudioPlayer plays from a URI. The model
 * sends raw PCM with no header — we wrap it in a 44-byte WAV header so
 * the OS audio decoder can play it without a native codec.
 *
 * Output rate is fixed at 24kHz mono / 16-bit because that's what
 * Gemini Live emits for the audio response modality.
 *
 * The envelope comes out of the same pass. expo-audio exposes no output level
 * while playing, so the only way to make anything on screen move with EVE's
 * voice is to measure the samples before they reach the player — and this is
 * already the one place they exist decoded. See envelopeOf.
 */
import * as FileSystem from "expo-file-system/legacy";

const OUTPUT_SAMPLE_RATE = 24000;
const OUTPUT_CHANNELS = 1;
const OUTPUT_BITS_PER_SAMPLE = 16;

/**
 * Milliseconds per envelope frame.
 *
 * 40ms is a syllable-scale window: long enough that the value tracks loudness
 * rather than the waveform itself — at 24kHz a 4ms window would straddle only a
 * couple of cycles of a low vowel and the "level" would mostly be measuring
 * where in the cycle it landed — and short enough that a plosive still reads as
 * a spike. It is also close to the microphone meter's own ~11Hz cadence, so the
 * listening and speaking states drive the field at a similar rate and the orb
 * does not visibly change character between them.
 */
const FRAME_MS = 40;

/** The turn's audio, and how loud it is over time. */
export type SpokenTurn = {
  /** Local file URI to play. */
  uri: string;
  /**
   * Normalised loudness per FRAME_MS of audio, 0–1, in playback order. Walk it
   * against playback position to drive anything that should move with the voice.
   */
  envelope: number[];
  /** How long each envelope entry covers. */
  frameMs: number;
};

/**
 * Concatenate the chunks (each base64 PCM), build a WAV file, write to
 * the cache directory, return the URI along with the turn's envelope. Caller is
 * responsible for deleting the file when done (or just let cache GC handle it).
 */
export async function writePcmChunksAsWav(chunksBase64: string[]): Promise<SpokenTurn | null> {
  if (chunksBase64.length === 0) return null;

  // Decode every chunk to bytes and concatenate. Doing it in one pass
  // keeps memory bounded — short voice replies are <1MB.
  const decoded = chunksBase64.map(decodeBase64);
  const totalBytes = decoded.reduce((sum, chunk) => sum + chunk.length, 0);
  if (totalBytes === 0) return null;
  const pcm = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of decoded) {
    pcm.set(chunk, offset);
    offset += chunk.length;
  }

  const envelope = envelopeOf(pcm);

  const wav = wrapInWavHeader(pcm);
  const path = `${FileSystem.cacheDirectory}eve-voice-${Date.now()}.wav`;
  await FileSystem.writeAsStringAsync(path, encodeBase64(wav), {
    encoding: FileSystem.EncodingType.Base64,
  });
  return { uri: path, envelope, frameMs: FRAME_MS };
}

/**
 * RMS loudness per FRAME_MS window, normalised against the turn's own peak.
 *
 * RMS and not peak-per-window: peak tracks the single loudest sample, so one
 * click pins a whole frame to 1.0 and the envelope reads as a square wave. RMS
 * is energy, which is what loudness actually is.
 *
 * Normalised per turn rather than against full scale (32768) because TTS output
 * is nowhere near it — a normal reply peaks around a third of full scale, so an
 * absolute scale would leave every frame in the bottom of the range and the orb
 * would barely move. Per-turn means the loudest moment of each answer reads as
 * full, which is the right behaviour for something whose job is to show the
 * shape of the speech rather than its absolute volume.
 *
 * The square root at the end is a perceptual curve, not part of the RMS: energy
 * in dB-like terms is roughly logarithmic, and a linear RMS spends most of a
 * quiet passage indistinguishably near zero. sqrt lifts the low end enough that
 * ordinary speech occupies most of the 0–1 range instead of the bottom fifth.
 */
function envelopeOf(pcm: Uint8Array): number[] {
  const samplesPerFrame = Math.round((OUTPUT_SAMPLE_RATE * FRAME_MS) / 1000);
  const bytesPerSample = OUTPUT_BITS_PER_SAMPLE / 8;
  // Odd trailing byte would make the last sample garbage; drop it.
  const samples = Math.floor(pcm.length / bytesPerSample);
  if (samples === 0) return [];

  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * bytesPerSample);
  const frames: number[] = [];
  let peak = 0;

  for (let start = 0; start < samples; start += samplesPerFrame) {
    const end = Math.min(samples, start + samplesPerFrame);
    let sumSq = 0;
    for (let i = start; i < end; i += 1) {
      // Signed 16-bit little-endian, as declared in the WAV header below.
      const s = view.getInt16(i * bytesPerSample, true) / 32768;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / (end - start));
    frames.push(rms);
    if (rms > peak) peak = rms;
  }

  // Silence, or near enough that normalising would amplify the noise floor into
  // a full-scale envelope. Better to report a flat quiet turn than a fake loud one.
  if (peak < 1e-4) return frames.map(() => 0);

  return frames.map((rms) => Math.min(1, Math.sqrt(rms / peak)));
}

function wrapInWavHeader(pcm: Uint8Array): Uint8Array {
  const dataSize = pcm.length;
  const byteRate = (OUTPUT_SAMPLE_RATE * OUTPUT_CHANNELS * OUTPUT_BITS_PER_SAMPLE) / 8;
  const blockAlign = (OUTPUT_CHANNELS * OUTPUT_BITS_PER_SAMPLE) / 8;
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);

  // RIFF chunk descriptor
  writeAscii(out, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(out, 8, "WAVE");

  // fmt subchunk
  writeAscii(out, 12, "fmt ");
  view.setUint32(16, 16, true);              // subchunk size for PCM
  view.setUint16(20, 1, true);               // audio format: PCM
  view.setUint16(22, OUTPUT_CHANNELS, true);
  view.setUint32(24, OUTPUT_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, OUTPUT_BITS_PER_SAMPLE, true);

  // data subchunk
  writeAscii(out, 36, "data");
  view.setUint32(40, dataSize, true);
  out.set(pcm, 44);

  return out;
}

function writeAscii(buf: Uint8Array, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) buf[offset + i] = str.charCodeAt(i);
}

function decodeBase64(b64: string): Uint8Array {
  // React Native and modern web both expose atob in the global scope.
  // Avoiding a Buffer polyfill keeps the bundle smaller.
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  // Chunked, because `apply` spreads the chunk into an argument list and a
  // large one overflows the stack. The size matters more than it looks: a
  // typical reply is ~120KB of PCM, and at 32768 Hermes was being handed an
  // argument list far past what it will take, which threw inside playback and
  // came out as EVE simply not speaking. 4096 is comfortably under any engine's
  // limit and the extra iterations are not measurable.
  let binary = "";
  const CHUNK = 4096;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(binary);
}
