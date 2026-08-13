/**
 * App start.
 *
 * This is the first frame of the app, shown while the stored session is
 * restored and the first load settles. It has one job — look like the app and
 * prove something is happening — so it is the brand mark, a breathing halo, and
 * a status line, nothing else.
 *
 * Two deliberate changes from the screen this replaces: the raw API base URL is
 * gone (it was rendered to every user, which is debug output, not product), and
 * the "reset session" escape hatch waits a beat before appearing so a normal
 * fast boot never flashes it.
 */
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
// The aura is painted outside this, on the bleeding parent, so the inset layer
// only ever moves content — never the backdrop.
import { SafeAreaView } from "react-native-safe-area-context";

import { FadeSlideIn } from "../ui/motion";
import { useTheme } from "../ui/ThemeContext";
import { Aura, EveMark, GhostAction } from "./chrome";
import { useEntryStyles } from "./styles";

/**
 * How long a boot may take before we offer a way out. Long enough that a
 * healthy start never shows it, short enough that a wedged one isn't a dead
 * end.
 */
const ESCAPE_HATCH_DELAY_MS = 2600;

type Props = {
  /** Whether the stored token has been read yet. Drives the status copy. */
  authChecked: boolean;
  onResetSession: () => void;
};

export function BootScreen({ authChecked, onResetSession }: Props) {
  const { scheme } = useTheme();
  const styles = useEntryStyles();
  const [showEscape, setShowEscape] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShowEscape(true), ESCAPE_HATCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  const status = authChecked ? "Getting your workspace ready" : "Restoring your session";

  return (
    <View style={styles.screen}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <Aura />

      <SafeAreaView style={styles.safe}>
        <View style={styles.centered}>
          <View style={bootLayout.stack}>
            <EveMark pulse />
            <FadeSlideIn delay={90}>
              <Text style={styles.hero} accessibilityRole="header">
                EVE
              </Text>
            </FadeSlideIn>
            <FadeSlideIn delay={180}>
              {/* Live region so a screen reader announces the phase change
                  rather than leaving the user on a silent screen. */}
              <Text style={styles.lead} accessibilityLiveRegion="polite">
                {status}
              </Text>
            </FadeSlideIn>
          </View>
        </View>

        <View style={styles.footer}>
          {showEscape ? (
            <FadeSlideIn>
              <GhostAction label="Taking too long? Sign in again" onPress={onResetSession} />
            </FadeSlideIn>
          ) : null}
        </View>
      </SafeAreaView>
    </View>
  );
}

const bootLayout = {
  stack: {
    alignItems: "center" as const,
    gap: 14,
  },
};
