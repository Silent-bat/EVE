/**
 * Live audio waveform — a row of bars that rise and fall with input level.
 *
 * The recorder reports a single amplitude per tick, not a spectrum, so a literal
 * bar-per-frequency display isn't available. Instead each bar carries a fixed
 * weight and the current level scales all of them, which produces the familiar
 * ragged-but-coherent shape. It's an honest visualisation of one number, and it
 * moves the way a voice moves.
 */
import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";

import { radius } from "../theme";
import { useTheme } from "../ThemeContext";

/**
 * Per-bar weights. Hand-picked rather than random so the shape is stable across
 * renders — a random profile would reshuffle the silhouette on every remount and
 * read as a glitch.
 */
const WEIGHTS = [0.35, 0.62, 0.44, 0.88, 0.56, 1, 0.7, 0.92, 0.48, 0.76, 0.4, 0.6];

export function Waveform({
  /** Normalised amplitude, 0–1. */
  level = 0,
  active = true,
  height = 44,
  color,
}: {
  level?: number;
  active?: boolean;
  height?: number;
  color?: string;
}) {
  const { palette, reduceMotion } = useTheme();
  const amplitude = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const target = active ? Math.max(0, Math.min(1, level)) : 0;
    if (reduceMotion) {
      amplitude.setValue(target);
      return;
    }
    const animation = Animated.spring(amplitude, {
      toValue: target,
      useNativeDriver: false, // animating height, which the native driver can't take
      speed: 24,
      bounciness: 8,
    });
    animation.start();
    return () => animation.stop();
  }, [amplitude, level, active, reduceMotion]);

  const tint = color ?? palette.ambient;

  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[styles.row, { height }]}
    >
      {WEIGHTS.map((weight, i) => (
        <Animated.View
          key={i}
          style={[
            styles.bar,
            {
              backgroundColor: tint,
              // Floor of 4pt so the waveform stays visible in silence — a row
              // of zero-height bars looks like a broken component, not a quiet
              // room.
              height: amplitude.interpolate({
                inputRange: [0, 1],
                outputRange: [4, Math.max(4, height * weight)],
              }),
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4 },
  bar: { width: 4, borderRadius: radius.pill },
});
