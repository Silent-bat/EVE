/**
 * Process-local cache for fast in-session rendering.
 *
 * The server-side Postgres is the source of truth — this layer only
 * It deliberately does not survive a restart: these values are private user
 * data and AsyncStorage is plaintext and included in device backups.
 *
 * Every cache key is namespaced with the authenticated userID so a
 * different user signing in on the same device never sees the previous
 * user's data. clearAll() wipes the whole namespace and is called from
 * logout.
 *
 * Failures are swallowed and treated as cache-misses. The app must
 * always be functional with an empty cache (server reload re-fills it).
 */
import type {
  AssistantAnswer,
  AuditEntry,
  Briefing,
  DeviceNotification,
  Preferences,
  ProactiveThought,
} from "../types";
import type { LiveTurn } from "../voice/useGeminiLive";

// Briefings, audit entries, notifications, and transcripts are private user
// data. Keep the cache process-local instead of writing it to AsyncStorage,
// which is plaintext and included in device backups. The server remains the
// source of truth and repopulates these values after a restart.
const NAMESPACE = "eve.cache.v1";
const memoryCache = new Map<string, unknown>();
let lastUserID: string | null = null;

/**
 * Remember which user this device most recently authenticated as so the
 * The value is process-local and is never used for authentication.
 */
export async function rememberLastUserID(userID: string): Promise<void> {
  if (!userID) return;
  lastUserID = userID;
}

export async function readLastUserID(): Promise<string | null> {
  return lastUserID;
}

// Keep this list small. Anything that grows unbounded (e.g. every
// briefing ever generated) doesn't belong here — store the latest only.
type CacheShape = {
  briefing: Briefing;
  audit: AuditEntry[];
  preferences: Preferences;
  deviceNotifications: DeviceNotification[];
  inboxThoughts: ProactiveThought[];
  inboxNewCount: number;
  assistantAnswer: AssistantAnswer | null;
  voiceTurns: LiveTurn[];
};

type CacheKey = keyof CacheShape;

function key(userID: string, name: CacheKey): string {
  return `${NAMESPACE}.${userID}.${name}`;
}

/**
 * Read a single value. Returns null on a miss.
 */
export async function readCache<K extends CacheKey>(userID: string, name: K): Promise<CacheShape[K] | null> {
  if (!userID) return null;
  return (memoryCache.get(key(userID, name)) as CacheShape[K] | undefined) ?? null;
}

/**
 * Write a value. Caching is a UX optimization, not a correctness requirement.
 */
export async function writeCache<K extends CacheKey>(
  userID: string,
  name: K,
  value: CacheShape[K],
): Promise<void> {
  if (!userID) return;
  memoryCache.set(key(userID, name), value);
}

/**
 * Drop every cached value for every user in this process. Used at logout.
 */
export async function clearAllCache(): Promise<void> {
  memoryCache.clear();
  lastUserID = null;
}
