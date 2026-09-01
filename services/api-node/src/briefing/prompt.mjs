/**
 * Small helpers for constructing prompts from data that may be larger than the
 * model context (or may be controlled by an external provider).  Sections with
 * a higher priority are retained longer when the total cap is reached.
 */

export const DEFAULT_PROMPT_MAX_CHARS = 120_000;
const TRUNCATION_MARKER = " [truncated]";

/**
 * Resolve a configured prompt limit without allowing NaN, fractions, or a
 * non-positive value to disable the guard.
 *
 * @param {unknown} value
 * @param {number} [fallback]
 */
export function resolvePromptLimit(value, fallback = DEFAULT_PROMPT_MAX_CHARS) {
  const candidate = Number(value);
  if (Number.isSafeInteger(candidate) && candidate > 0) return candidate;
  return fallback;
}

/**
 * Truncate text while making the truncation visible to the model.
 *
 * @param {unknown} value
 * @param {number} maxChars
 */
export function truncatePromptText(value, maxChars) {
  const text = String(value ?? "");
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, maxChars);
  return `${text.slice(0, maxChars - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

/**
 * JSON.stringify can fail for an injected/cyclic value. Prompt construction
 * must degrade to a bounded diagnostic instead of taking down the request.
 *
 * @param {unknown} value
 */
export function stringifyPromptValue(value) {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? "null" : json;
  } catch {
    return JSON.stringify({ _unserializable: true });
  }
}

/**
 * Return a JSON-safe, bounded representation for a function response. Keeping
 * the wrapper an object means Gemini still receives a valid function result;
 * unlike slicing raw JSON, this cannot leave an unterminated document.
 *
 * @param {unknown} value
 * @param {number} maxChars
 */
export function boundedJSONValue(value, maxChars) {
  const limit = resolvePromptLimit(maxChars, 1);
  let original;
  let serializable = true;
  try {
    original = JSON.stringify(value);
    if (original === undefined) original = "null";
  } catch {
    serializable = false;
    original = JSON.stringify({ _unserializable: true });
  }
  if (serializable && original.length <= limit) return value;

  // Leave enough room for the wrapper and JSON escaping. Recalculate a few
  // times because quotes/newlines in the preview can expand when serialized.
  // JSON has no object representation shorter than two characters. These
  // values are only relevant for defensive tests/configuration mistakes; the
  // normal Live cap is thousands of characters.
  if (limit < 2) return 0;
  if (limit < 4) return "";
  if (limit < 32) return null;
  let previewLength = Math.max(0, limit - 48);
  let candidate = { _truncated: true, preview: truncatePromptText(original, previewLength) };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const serializedLength = stringifyPromptValue(candidate).length;
    if (serializedLength <= limit) return candidate;
    previewLength = Math.max(0, previewLength - (serializedLength - limit));
    candidate = { _truncated: true, preview: truncatePromptText(original, previewLength) };
  }
  return stringifyPromptValue(candidate).length <= limit ? candidate : null;
}

/**
 * Join labelled prompt sections under one hard character cap.
 *
 * A section may be a string or `{ text, priority }`. Larger priorities are
 * considered more important and are truncated only after lower-priority
 * sections. This keeps authenticated instructions and the current user turn
 * available when a provider-controlled context grows unexpectedly.
 *
 * @param {Array<string | { text?: unknown, priority?: number }>} sections
 * @param {number} [maxChars]
 */
export function buildBoundedPrompt(sections, maxChars = DEFAULT_PROMPT_MAX_CHARS) {
  const limit = resolvePromptLimit(maxChars);
  const entries = (Array.isArray(sections) ? sections : [])
    .map((section, index) => {
      if (typeof section === "string") return { text: section, priority: 0, index };
      return {
        text: String(section?.text ?? ""),
        priority: Number.isFinite(Number(section?.priority)) ? Number(section.priority) : 0,
        index,
      };
    })
    .filter((entry) => entry.text.length > 0);
  if (entries.length === 0) return "";

  const join = () => entries.map((entry) => entry.text).join("\n");
  if (join().length <= limit) return join();

  // Drop/truncate low-priority sections first. Recomputing the available room
  // after every section makes the final result deterministic and guarantees a
  // hard cap even when JSON escaping expands a preview.
  const order = [...entries].sort((a, b) => a.priority - b.priority || a.index - b.index);
  for (const entry of order) {
    const withoutEntry = entries
      .filter((candidate) => candidate !== entry)
      .map((candidate) => candidate.text)
      .join("\n");
    const separator = withoutEntry.length > 0 ? 1 : 0;
    const allowance = Math.max(0, limit - withoutEntry.length - separator);
    if (entry.text.length > allowance) entry.text = truncatePromptText(entry.text, allowance);
    if (join().length <= limit) return join();
  }

  // This only occurs when every section is larger than the configured cap. A
  // final bounded slice is preferable to allowing an oversized provider call.
  return truncatePromptText(join(), limit);
}
