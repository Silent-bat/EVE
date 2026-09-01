/**
 * Small, versioned AES-256-GCM envelope for values that contain credentials.
 * The key is supplied by the environment/secret manager and is never written
 * back to state. Development and tests may run without a key for compatibility
 * with the local fixture, but production configuration refuses to boot without
 * one (see config.mjs).
 */
import crypto from "node:crypto";
import { config } from "../config.mjs";

const VERSION = "eve:v1:";

function keyBytes() {
  const configured = config.stateEncryptionKey;
  if (!configured) return null;
  // Accept either a 32-byte hex/base64 key or a passphrase. Hashing the latter
  // keeps the on-disk format stable while allowing secret managers to expose a
  // normal opaque string.
  if (/^[0-9a-f]{64}$/i.test(configured)) return Buffer.from(configured, "hex");
  try {
    const decoded = Buffer.from(configured, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // Fall through to the passphrase derivation.
  }
  return crypto.createHash("sha256").update(configured, "utf8").digest();
}

/** @param {unknown} value */
export function encryptSecret(value) {
  if (value === undefined || value === null) return value;
  const key = keyBytes();
  if (!key) {
    if (config.isProduction) throw new Error("STATE_ENCRYPTION_KEY is required to persist secrets");
    return value;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

/** @param {unknown} value */
export function decryptSecret(value) {
  if (typeof value !== "string" || !value.startsWith(VERSION)) return value;
  const key = keyBytes();
  if (!key) throw new Error("STATE_ENCRYPTION_KEY is required to decrypt persisted secrets");
  const encoded = value.slice(VERSION.length).split(".");
  if (encoded.length !== 3) throw new Error("invalid encrypted secret envelope");
  const [ivText, tagText, cipherText] = encoded;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(cipherText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plain);
  } catch {
    throw new Error("persisted secret failed authentication");
  }
}

/** @param {unknown} tokens */
export function protectGoogleTokens(tokens) {
  return tokens ? encryptSecret(tokens) : tokens;
}

/** @param {unknown} value */
export function restoreGoogleTokens(value) {
  return value ? decryptSecret(value) : value;
}
