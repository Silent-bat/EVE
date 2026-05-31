/**
 * Sliding-window rate limiter for auth endpoints. Pure in-memory; resets on
 * process restart. Two independent limits per request:
 *
 *   - per source IP (slow brute-force attempts from one client)
 *   - per email     (slow brute-force attempts against one account)
 *
 * Counts are stored in a Map keyed by the limit subject. Each entry holds
 * timestamps within the window; entries are pruned lazily on each touch.
 */
import { config } from "../config.mjs";
import { httpError } from "../http/responses.mjs";

const ONE_MINUTE_MS = 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/**
 * @typedef {Object} Limiter
 * @property {number[]} timestamps
 */

/** @type {Map<string, Limiter>} */
const ipBuckets = new Map();
/** @type {Map<string, Limiter>} */
const emailBuckets = new Map();

/**
 * @param {Map<string, Limiter>} store
 * @param {string} key
 * @param {number} windowMs
 * @param {number} limit
 * @returns {{ blocked: boolean, retryAfterSeconds: number }}
 */
function touch(store, key, windowMs, limit) {
  const now = Date.now();
  const bucket = store.get(key) ?? { timestamps: [] };
  // prune anything outside the window
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);
  bucket.timestamps.push(now);
  store.set(key, bucket);
  if (bucket.timestamps.length <= limit) return { blocked: false, retryAfterSeconds: 0 };
  const oldest = bucket.timestamps[0] ?? now;
  return { blocked: true, retryAfterSeconds: Math.ceil((windowMs - (now - oldest)) / 1000) };
}

/**
 * Throw a 429 HttpError if either the per-IP or per-email limit is exceeded.
 * Call this in the request path BEFORE doing any expensive work.
 *
 * @param {string} ip
 * @param {string} email
 */
export function enforceAuthRateLimit(ip, email) {
  if (ip) {
    const result = touch(ipBuckets, ip, ONE_MINUTE_MS, config.rateLimit.authIpPerMin);
    if (result.blocked) {
      throw httpError(429, `too many requests; retry in ${result.retryAfterSeconds}s`);
    }
  }
  if (email) {
    const result = touch(
      emailBuckets,
      email.toLowerCase(),
      FIFTEEN_MINUTES_MS,
      config.rateLimit.authEmailPer15Min,
    );
    if (result.blocked) {
      throw httpError(429, `too many requests; retry in ${result.retryAfterSeconds}s`);
    }
  }
}

/**
 * Reset all counters. Test-only.
 */
export function resetForTests() {
  ipBuckets.clear();
  emailBuckets.clear();
}
