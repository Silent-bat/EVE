/**
 * Convert the assistant's text-blob tool catalog into the OpenAPI-style
 * functionDeclarations shape Gemini's tool-calling expects.
 *
 * The existing catalog (see briefing/tools.mjs) describes args as plain
 * strings like "optional string — IANA tz". This helper parses that
 * convention into proper JSON-schema-ish parameter objects so the model
 * can fill them reliably.
 */

const TYPE_KEYWORDS = /** @type {const} */ ({
  string: "string",
  number: "number",
  integer: "integer",
  boolean: "boolean",
  bool: "boolean",
});

/**
 * @param {Array<{ name: string, description: string, args: Record<string, string> }>} catalog
 * @returns {Array<{ functionDeclarations: any[] }>}
 */
export function toGeminiTools(catalog) {
  const functionDeclarations = catalog.map((tool) => {
    /** @type {Record<string, any>} */
    const properties = {};
    /** @type {string[]} */
    const required = [];

    for (const [argName, blob] of Object.entries(tool.args || {})) {
      const { type, description, optional } = parseArgBlob(blob);
      properties[argName] = { type, description };
      if (!optional) required.push(argName);
    }

    return {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties,
        ...(required.length ? { required } : {}),
      },
    };
  });

  // Gemini Live takes tools as an array; each element may carry
  // functionDeclarations. We collapse everything into one element so the
  // catalog is presented as a single tool surface to the model.
  return [{ functionDeclarations }];
}

/**
 * Parse a string of the form "optional string — description here" into a
 * structured arg descriptor. The em-dash is the separator the existing
 * catalog uses.
 *
 * @param {string} blob
 */
function parseArgBlob(blob) {
  const value = String(blob || "").trim();
  // Split on em-dash, en-dash, or "--"
  const [head, ...rest] = value.split(/\s+[—–]\s+|\s+--\s+/);
  const description = rest.join(" — ").trim();
  const optional = /^optional\b/i.test(head);
  const cleanedHead = head.replace(/^optional\s+/i, "").trim().toLowerCase();
  const typeKey = /** @type {keyof typeof TYPE_KEYWORDS} */ (
    Object.keys(TYPE_KEYWORDS).find((k) => cleanedHead.startsWith(k)) || "string"
  );
  return {
    type: TYPE_KEYWORDS[typeKey],
    description: description || cleanedHead,
    optional,
  };
}
