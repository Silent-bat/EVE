import AsyncStorage from "@react-native-async-storage/async-storage";
import { config } from "../config";

/**
 * Holds the current auth token in memory + AsyncStorage. Replaces the
 * module-level mutable variable that lived in App.tsx. A single instance is
 * created at module scope and shared across the app; the `subscribe()` hook
 * lets React state listen for changes.
 */
class TokenStore {
  #token: string | null = null;
  #listeners = new Set<(token: string | null) => void>();

  /**
   * Hydrate from AsyncStorage. Resolves with the loaded token (or null) so
   * the caller can use it to decide initial UI state.
   */
  async hydrate(): Promise<string | null> {
    try {
      const stored = await AsyncStorage.getItem(config.auth.storageKey);
      this.#token = stored ?? null;
    } catch {
      this.#token = null;
    }
    this.#emit();
    return this.#token;
  }

  get current(): string | null {
    return this.#token;
  }

  async set(token: string): Promise<void> {
    this.#token = token;
    await AsyncStorage.setItem(config.auth.storageKey, token);
    this.#emit();
  }

  async clear(): Promise<void> {
    this.#token = null;
    try {
      await AsyncStorage.removeItem(config.auth.storageKey);
    } catch {
      // best-effort
    }
    this.#emit();
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
