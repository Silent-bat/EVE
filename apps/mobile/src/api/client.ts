import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { assertSecureTransport, config } from "../config";

/**
 * Holds the current auth token in memory + the platform secure store. Replaces the
 * module-level mutable variable that lived in App.tsx. A single instance is
 * created at module scope and shared across the app; the `subscribe()` hook
 * lets React state listen for changes.
 */
class TokenStore {
  #token: string | null = null;
  #listeners = new Set<(token: string | null) => void>();
  /**
   * Changes the in-memory token synchronously, before the platform store
   * operation starts. Hydration and older async writes can then tell whether
   * their result is still allowed to become authoritative.
   */
  #mutationVersion = 0;
  /** Keep SecureStore and the legacy migration operations in call order. */
  #storageQueue: Promise<void> = Promise.resolve();

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#storageQueue.then(operation, operation);
    // A failed operation must not strand every later token operation behind a
    // rejected promise. The caller still receives the original failure.
    this.#storageQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Hydrate from SecureStore. Resolves with the loaded token (or null) so
   * the caller can use it to decide initial UI state.
   */
  async hydrate(): Promise<string | null> {
    // expo-secure-store has no browser implementation. Keep browser sessions
    // memory-only instead of falling back to localStorage, where an XSS can
    // read a long-lived bearer credential. A future web auth flow can replace
    // this with an HttpOnly cookie or another server-managed session.
    if (Platform.OS === "web") {
      this.#emit();
      return this.#token;
    }
    const version = this.#mutationVersion;
    return this.#enqueue(async () => {
      // A login/logout may have happened while an earlier hydrate was queued.
      // Do not even read stale storage in that case.
      if (version !== this.#mutationVersion) return this.#token;

      try {
        const stored = await SecureStore.getItemAsync(config.auth.storageKey);
        if (version !== this.#mutationVersion) return this.#token;
        this.#token = stored || null;

        // Migrate tokens written by versions before SecureStore was installed.
        // Read once, move into the keystore, and remove the plaintext copy even
        // when the secure-store write fails so it cannot linger indefinitely.
        if (!this.#token) {
          const legacy = await AsyncStorage.getItem(config.auth.storageKey);
          if (version !== this.#mutationVersion) return this.#token;
          if (legacy) {
            try {
              await SecureStore.setItemAsync(config.auth.storageKey, legacy, {
                keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
              });
              if (version !== this.#mutationVersion) return this.#token;
              this.#token = legacy;
            } finally {
              // The legacy value is no longer needed after this attempt. Keep
              // removing it even when the secure write fails so plaintext
              // credentials do not linger indefinitely.
              await AsyncStorage.removeItem(config.auth.storageKey).catch(() => undefined);
            }
          }
        }
      } catch {
        if (version !== this.#mutationVersion) return this.#token;
        this.#token = null;
      }
      if (version !== this.#mutationVersion) return this.#token;
      this.#emit();
      return this.#token;
    });
  }

  get current(): string | null {
    return this.#token;
  }

  async set(token: string): Promise<void> {
    const version = ++this.#mutationVersion;
    this.#token = token;
    if (Platform.OS === "web") {
      this.#emit();
      return;
    }
    await this.#enqueue(async () => {
      await SecureStore.setItemAsync(config.auth.storageKey, token, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
      });
      // Remove a value left by a pre-SecureStore build. This is harmless for a
      // newer token and prevents a later migration from seeing stale data.
      await AsyncStorage.removeItem(config.auth.storageKey).catch(() => undefined);
    });
    if (version === this.#mutationVersion) this.#emit();
  }

  async clear(): Promise<void> {
    const version = ++this.#mutationVersion;
    this.#token = null;
    if (Platform.OS === "web") {
      // Remove a token left by a pre-SecureStore browser build, but never
      // write a new bearer token to browser storage.
      await AsyncStorage.removeItem(config.auth.storageKey).catch(() => undefined);
      if (version === this.#mutationVersion) this.#emit();
      return;
    }
    await this.#enqueue(async () => {
      try {
        await SecureStore.deleteItemAsync(config.auth.storageKey);
        // Also remove a legacy value if an older build left one behind.
        await AsyncStorage.removeItem(config.auth.storageKey);
      } catch {
        // best-effort
      }
    });
    if (version === this.#mutationVersion) this.#emit();
  }

  subscribe(listener: (token: string | null) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener(this.#token);
  }
}

export const tokenStore = new TokenStore();

/**
 * Error type carrying the HTTP status from the server.
 */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Typed JSON fetch with timeout, bearer auth, and a friendly error class.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  token: string | null = tokenStore.current,
): Promise<T> {
  assertSecureTransport(config.apiBaseURL);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.auth.apiTimeoutMs);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const response = await fetch(`${config.apiBaseURL}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = text ? safeJSONParse(text) : null;
    if (!response.ok) {
      // A 401 on a request that carried a token means that token is dead —
      // expired, revoked, or issued by a database that has since been reset.
      // Leaving it in storage strands the app: every screen keeps retrying
      // with the same rejected credential and shows "authentication required"
      // with no route back to sign-in. Drop it so the app falls back to the
      // login screen. Requests without a token (login, signup) are excluded,
      // since a 401 there just means bad credentials.
      if (response.status === 401 && token) {
        void tokenStore.clear();
      }
      const errField =
        payload && typeof payload === "object" && "error" in payload
          ? (payload as { error?: unknown }).error
          : undefined;
      const message = typeof errField === "string" ? errField : `request failed (${response.status})`;
      throw new ApiError(response.status, message);
    }
    return payload as T;
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      throw new ApiError(0, "request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function safeJSONParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
