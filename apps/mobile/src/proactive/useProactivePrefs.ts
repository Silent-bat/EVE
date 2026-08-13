/**
 * Loads and mutates the proactive preferences.
 *
 * This lives in a hook rather than inside the settings section because two
 * screens now need the same data: the settings index shows a one-line summary
 * ("On · 4 of 5 categories"), and the proactive page shows the full controls.
 * Fetching twice would let the two disagree for a second after every edit.
 */
import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../api/client";
import type { ProactivePreferences } from "../types";
import { fetchProactivePrefs, updateProactivePrefs } from "./api";

export type ProactivePrefsState = {
  prefs: ProactivePreferences | null;
  loading: boolean;
  saving: boolean;
  /**
   * Applies `next` on the server. Pass `optimistic` — the full object as it
   * should look immediately — so a switch flips under the finger instead of
   * after the round trip. A failed save reloads, so the UI never keeps a value
   * the server rejected.
   */
  patch: (next: Partial<ProactivePreferences>, optimistic?: ProactivePreferences) => Promise<void>;
  reload: () => Promise<void>;
};

export function useProactivePrefs(onError: (message: string) => void): ProactivePrefsState {
  const [prefs, setPrefs] = useState<ProactivePreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setPrefs(await fetchProactivePrefs());
    } catch (error) {
      onError(formatError(error, "Could not load proactive settings"));
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const patch = useCallback(
    async (next: Partial<ProactivePreferences>, optimistic?: ProactivePreferences) => {
      if (optimistic) setPrefs(optimistic);
      setSaving(true);
      try {
        setPrefs(await updateProactivePrefs(next));
      } catch (error) {
        onError(formatError(error, "Could not save"));
        await reload();
      } finally {
        setSaving(false);
      }
    },
    [onError, reload],
  );

  return { prefs, loading, saving, patch, reload };
}

/**
 * "On · 4 of 5 on" — enough to answer "is EVE allowed to interrupt me?"
 * without opening the page.
 */
export function summarizeProactive(prefs: ProactivePreferences | null): string | undefined {
  if (!prefs) return undefined;
  if (!prefs.enabled) return "Off";
  const values = Object.values(prefs.categories);
  const on = values.filter((c) => c.enabled).length;
  return `On · ${on} of ${values.length}`;
}

function formatError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}
