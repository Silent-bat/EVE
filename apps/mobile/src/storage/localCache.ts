/**
 * Local on-device cache for instant cold-start rendering.
 *
 * The server-side Postgres is the source of truth — this layer only
 * exists so the UI shows the user's last-known briefing / audit /
 * preferences / voice conversation immediately on app open, instead of
 * waiting 3-5 seconds for loadV1 to settle.
 *
 * Every cache key is namespaced with the authenticated userID so a
 * different user signing in on the same device never sees the previous
 * user's data. clearAll() wipes the whole namespace and is called from
 * logout.
 *
 * Failures are swallowed and treated as cache-misses. The app must
 * always be functional with an empty cache (server reload re-fills it).
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import type {
  AssistantAnswer,
  AuditEntry,
  Briefing,
  DeviceNotification,
  Preferences,
  ProactiveThought,
} from "../types";
import type { LiveTurn } from "../voice/useGeminiLive";

const NAMESPACE = "eve.cache.v1";
const LAST_USER_ID_KEY = "eve.lastUserId";

/**
 * Remember which user this device most recently authenticated as so the
 * next cold start can hydrate cache values BEFORE /v1/session returns
 * the real userID. We never use this for auth — only to look up
 * already-stored cache entries.
 */
export async function rememberLastUserID(userID: string): Promise<void> {
  if (!userID) return;
  try {
    await AsyncStorage.setItem(LAST_USER_ID_KEY, userID);
  } catch {
    // best-effort
  }
}

export async function readLastUserID(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(LAST_USER_ID_KEY);
  } catch {
    return null;
  }
}

async function forgetLastUserID(): Promise<void> {
  try {
    await AsyncStorage.removeItem(LAST_USER_ID_KEY);
  } catch {
    // best-effort
  }
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
 * Read a single value. Returns null on miss, parse error, or transport
 * error — caller decides the fallback.
 */
export async function readCache<K extends CacheKey>(
  userID: string,
  name: K,
): Promise<CacheShape[K] | null> {
  if (!userID) return null;
  try {
    const raw = await AsyncStorage.getItem(key(userID, name));
    if (!raw) return null;
    return JSON.parse(raw) as CacheShape[K];
  } catch {
    return null;
  }
}

/**
 * Write a value. Silent failure — caching is a UX optimization, not a
 * correctness requirement. Skip writes for the local sentinel user so
 * we don't pollute the cache before auth.
 */
export async function writeCache<K extends CacheKey>(
  userID: string,
  name: K,
  value: CacheShape[K],
): Promise<void> {
  if (!userID) return;
  try {
    await AsyncStorage.setItem(key(userID, name), JSON.stringify(value));
  } catch {
    // best-effort
  }
}

/**
 * Drop every cached value for every user on this device. Used at
 * logout so the next person who signs in starts from a clean slate.
 */
export async function clearAllCache(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const ours = keys.filter((k) => k.startsWith(`${NAMESPACE}.`));
    if (ours.length > 0) await AsyncStorage.multiRemove(ours);
  } catch {
    // best-effort
  }
  await forgetLastUserID();
}
