/**
 * Secret encryption/decryption utilities for Convex
 *
 * Ports the encryption logic from services/api-node/src/storage/index.mjs
 */

// Convex's default runtime exposes the standard Web Crypto API on the global
// object. Importing from node's "crypto" would force the node runtime and
// break the queries/mutations that transitively import this module.
const subtle = globalThis.crypto.subtle;

/**
 * Decrypt a secret using AES-GCM.
 */
export async function decryptSecret(encrypted: string, keyHex: string): Promise<string> {
  const parts = encrypted.split(":");
  if (parts.length !== 2) {
    throw new Error("Invalid encrypted format");
  }

  const ivHex = parts[0];
  const ciphertextHex = parts[1];
  if (ivHex === undefined || ciphertextHex === undefined) {
    throw new Error("Invalid encrypted format");
  }
  const iv = hexToBytes(ivHex);
  const ciphertext = hexToBytes(ciphertextHex);

  const key = await importKey(keyHex, ["decrypt"]);

  const plaintext = await subtle.decrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    ciphertext as unknown as BufferSource,
  );

  return new TextDecoder().decode(plaintext);
}

/**
 * Encrypt a secret using AES-GCM.
 */
export async function encryptSecret(plaintext: string, keyHex: string): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(keyHex, ["encrypt"]);

  const ciphertext = await subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );

  return bytesToHex(iv) + ":" + bytesToHex(new Uint8Array(ciphertext));
}

async function importKey(keyHex: string, keyUsages: KeyUsage[]) {
  const keyBytes = hexToBytes(keyHex);
  return subtle.importKey(
    "raw",
    keyBytes as unknown as BufferSource,
    { name: "AES-GCM" },
    false,
    keyUsages,
  );
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
