/**
 * Loads and saves the user profile — the structured "who you are" context the
 * backend splices into the ranking prompt.
 *
 * Same reason as `useProactivePrefs`: the settings index wants a completeness
 * summary ("4 of 6 filled") and the profile page wants the fields, and they
 * must agree.
 */
import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../api/client";
import type { UserProfile } from "../types";
import { fetchProfile, saveProfile } from "./api";

export type ProfileState = {
  profile: UserProfile | null;
  loading: boolean;
  saving: boolean;
  save: (patch: Partial<UserProfile>) => Promise<void>;
  reload: () => Promise<void>;
};

export function useProfile(onError: (message: string) => void): ProfileState {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setProfile(await fetchProfile());
    } catch (error) {
      onError(formatError(error, "Could not load your profile"));
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (patch: Partial<UserProfile>) => {
      setSaving(true);
      try {
        setProfile(await saveProfile(patch));
      } catch (error) {
        onError(formatError(error, "Could not save your profile"));
        await reload();
      } finally {
        setSaving(false);
      }
    },
    [onError, reload],
  );

  return { profile, loading, saving, save, reload };
}

/**
 * How much EVE actually knows. A count rather than a percentage: "4 of 6"
 * tells you there are two left to fill, which is the thing you'd act on.
 */
export function summarizeProfile(profile: UserProfile | null): string | undefined {
  if (!profile) return undefined;
  const values = Object.values(profile);
  const filled = values.filter((v) => typeof v === "string" && v.trim().length > 0).length;
  if (filled === 0) return "Empty";
  return `${filled} of ${values.length}`;
}

function formatError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}
