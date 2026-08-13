/**
 * Persistence for the guided first run.
 *
 * Onboarding has to survive the app being killed. Its middle step sends the
 * user to a browser for Google's consent screen, and Android is free to reclaim
 * the app while they're there — without this, they'd come back to the start of
 * the tour, or worse, be walked through it again after already finishing.
 *
 * The record is device-scoped with the owning user stored inside it rather than
 * in the key, because progress starts being written before /v1/session has told
 * us who the user is. A record whose userId disagrees with the signed-in user
 * belongs to whoever used the device last and is treated as a miss.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "eve.onboarding.v1";

export type OnboardingStepId = "welcome" | "value" | "access" | "connect" | "personalize" | "ready";

export type OnboardingProgress = {
  /** Owner of this record. Null until the session tells us the real id. */
  userId: string | null;
  step: OnboardingStepId;
  briefingTime: string;
  pushEnabled: boolean;
  completed: boolean;
};

export const DEFAULT_PROGRESS: OnboardingProgress = {
  userId: null,
  step: "welcome",
  briefingTime: "08:00",
  pushEnabled: true,
  completed: false,
};

/**
 * Read progress for this user. Returns null on a miss, on a record belonging to
 * a different account, or on any storage error — every caller treats that as
 * "start from the beginning", which is always safe.
 */
export async function readOnboardingProgress(userId: string | null): Promise<OnboardingProgress | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OnboardingProgress>;
    if (!isStepId(parsed.step)) return null;
    // An unclaimed record (written before we knew the user) is adopted by
    // whoever is signed in now; one claimed by somebody else is not ours.
    if (parsed.userId && userId && parsed.userId !== userId) return null;
    return {
      userId: parsed.userId ?? userId ?? null,
      step: parsed.step,
      briefingTime:
        typeof parsed.briefingTime === "string" && /^\d{2}:\d{2}$/.test(parsed.briefingTime)
          ? parsed.briefingTime
          : DEFAULT_PROGRESS.briefingTime,
      pushEnabled:
        typeof parsed.pushEnabled === "boolean" ? parsed.pushEnabled : DEFAULT_PROGRESS.pushEnabled,
      completed: parsed.completed === true,
    };
  } catch {
    return null;
  }
}

export async function writeOnboardingProgress(progress: OnboardingProgress): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Best-effort. Losing the record costs the user a repeated tour, which is
    // a far better failure than blocking the flow on a storage write.
  }
}

/** Mark the run finished so routing sends this user straight to the app. */
export async function completeOnboarding(userId: string | null): Promise<void> {
  const current = (await readOnboardingProgress(userId)) ?? DEFAULT_PROGRESS;
  await writeOnboardingProgress({ ...current, userId, step: "ready", completed: true });
}

/** Called from logout so the next account on this device gets its own run. */
export async function clearOnboardingProgress(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // best-effort
  }
}

function isStepId(value: unknown): value is OnboardingStepId {
  return (
    value === "welcome" ||
    value === "value" ||
    value === "access" ||
    value === "connect" ||
    value === "personalize" ||
    value === "ready"
  );
}
