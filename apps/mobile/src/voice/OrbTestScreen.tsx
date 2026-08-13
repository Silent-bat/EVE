import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ParticleField, type FieldState } from "../ui/components";
import { radius, spacing } from "../ui/theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../ui/ThemeContext";

const STATES: FieldState[] = ["idle", "listening", "thinking", "speaking"];

/** Development-only device harness for tuning the real voice orb without auth or audio. */
export function OrbTestScreen({ onClose }: { onClose: () => void }) {
  const { palette, scheme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [state, setState] = useState<FieldState>("idle");
  const [level, setLevel] = useState(0.2);

  // Simulate a live audio envelope so listening/speaking can be judged without
  // opening a voice connection or microphone session.
  useEffect(() => {
    if (state === "idle" || state === "thinking") {
      setLevel(state === "idle" ? 0.12 : 0.35);
      return;
    }

    let step = 0;
    const timer = setInterval(() => {
      step += 1;
      const carrier = state === "speaking" ? 0.58 : 0.42;
      const wave = Math.sin(step * 0.72) * 0.2 + Math.sin(step * 1.91) * 0.12;
      setLevel(Math.max(0.08, Math.min(1, carrier + wave)));
    }, 90);
    return () => clearInterval(timer);
  }, [state]);

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />

      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>DEVICE TEST</Text>
          <Text style={styles.title}>Particle orb</Text>
        </View>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close orb test"
          style={({ pressed }) => [styles.close, pressed ? styles.pressed : null]}
        >
          <Text style={styles.closeText}>Close</Text>
        </Pressable>
      </View>

      <View style={styles.stage}>
        <ParticleField
          state={state}
          level={level}
          size={300}
          count={30}
          backdrop={palette.surfaceInk}
        />
        <Text style={styles.state}>{state}</Text>
        <Text style={styles.level}>energy {level.toFixed(2)}</Text>
      </View>

      <View style={styles.controls}>
        {STATES.map((item) => {
          const active = item === state;
          return (
            <Pressable
              key={item}
              onPress={() => setState(item)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={({ pressed }) => [
                styles.control,
                active ? { backgroundColor: palette.ambient, borderColor: palette.ambient } : null,
                pressed ? styles.pressed : null,
              ]}
            >
              <Text style={[styles.controlText, active ? styles.controlTextActive : null]}>
                {item}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.note}>
        This is the same GPU particle field used by the voice screen. Open with eve://orb-test in a
        development build.
      </Text>
    </SafeAreaView>
  );
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: palette.background,
      paddingHorizontal: spacing.xl,
    },
    header: {
      minHeight: 88,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    eyebrow: {
      ...type.caption,
      color: palette.ambient,
      letterSpacing: 1.5,
    },
    title: {
      ...type.displayLg,
      marginTop: spacing.xs,
    },
    close: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: spacing.lg,
      borderRadius: radius.pill,
      backgroundColor: palette.surface,
      borderWidth: 1,
      borderColor: palette.border,
    },
    closeText: type.label,
    stage: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
      borderRadius: radius.xxl,
      backgroundColor: palette.surfaceInk,
      borderWidth: 1,
      borderColor: palette.borderStrong,
    },
    state: {
      marginTop: spacing.xl,
      color: palette.textInverse,
      fontSize: 18,
      fontWeight: "800",
      textTransform: "capitalize",
    },
    level: {
      marginTop: spacing.xs,
      color: palette.textMuted,
      fontSize: 12,
      fontWeight: "700",
      fontVariant: ["tabular-nums"],
    },
    controls: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing.sm,
      paddingVertical: spacing.xl,
    },
    control: {
      flexGrow: 1,
      minWidth: "46%",
      minHeight: 48,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: palette.borderStrong,
      backgroundColor: palette.surface,
    },
    controlText: {
      ...type.label,
      textTransform: "capitalize",
    },
    controlTextActive: {
      color: palette.textInverse,
    },
    pressed: {
      opacity: 0.72,
    },
    note: {
      ...type.caption,
      textAlign: "center",
      paddingBottom: spacing.lg,
    },
  });
}
