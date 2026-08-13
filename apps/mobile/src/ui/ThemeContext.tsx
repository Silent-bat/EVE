/**
 * Theme context. Resolves the active color scheme from the user's stored
 * appearance preference (or the OS when set to "system"), and exposes it
 * plus a memoized style factory.
 *
 * `useThemedStyles` memoizes per scheme, so a StyleSheet is built twice at
 * most for the life of the process rather than on every render.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AccessibilityInfo, useColorScheme } from "react-native";

import {
  paletteFor,
  typeScaleFor,
  toneAccentIn,
  toneInkIn,
  toneSurfaceIn,
  type ColorScheme,
  type Palette,
  type Tone,
} from "./theme";

export type AppearancePreference = "system" | "light" | "dark";

const STORAGE_KEY = "eve.appearance";

export type ThemeValue = {
  scheme: ColorScheme;
  palette: Palette;
  type: ReturnType<typeof typeScaleFor>;
  preference: AppearancePreference;
  setPreference: (next: AppearancePreference) => void;
  reduceMotion: boolean;
  toneSurface: (tone: Tone) => string;
  toneInk: (tone: Tone) => string;
  toneAccent: (tone: Tone) => string;
};

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<AppearancePreference>("system");
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    void AsyncStorage.getItem(STORAGE_KEY).then((stored) => {
      if (stored === "light" || stored === "dark" || stored === "system") {
        setPreferenceState(stored);
      }
    });
  }, []);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => sub.remove();
  }, []);

  const setPreference = useCallback((next: AppearancePreference) => {
    setPreferenceState(next);
    void AsyncStorage.setItem(STORAGE_KEY, next);
  }, []);

  const scheme: ColorScheme =
    preference === "system" ? (systemScheme === "dark" ? "dark" : "light") : preference;

  const value = useMemo<ThemeValue>(() => {
    const p = paletteFor(scheme);
    return {
      scheme,
      palette: p,
      type: typeScaleFor(p),
      preference,
      setPreference,
      reduceMotion,
      toneSurface: (tone) => toneSurfaceIn(p, tone),
      toneInk: (tone) => toneInkIn(p, tone),
      toneAccent: (tone) => toneAccentIn(p, tone),
    };
  }, [scheme, preference, setPreference, reduceMotion]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}

/**
 * Build a StyleSheet from the active palette, caching one result per scheme
 * so switching light↔dark doesn't rebuild on every render.
 */
export function useThemedStyles<T>(factory: (theme: ThemeValue) => T): T {
  const theme = useTheme();
  const cache = useRef(new Map<ColorScheme, T>());
  const cached = cache.current.get(theme.scheme);
  if (cached) return cached;
  const built = factory(theme);
  cache.current.set(theme.scheme, built);
  return built;
}
