/**
 * Shared chrome for the entry flow: the backdrop, the brand mark, the progress
 * indicator, the action buttons, and the screen scaffold every step is built
 * on.
 *
 * The backdrop is drawn from plain Views rather than a gradient library — the
 * app ships no gradient dependency, and three large blurred-by-opacity circles
 * of the lavender palette's own hues give the entry flow depth without adding
 * one.
 */
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, type ReactNode } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  Pressable,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { FadeSlideIn, PressableScale } from "../ui/motion";
import { HIT_SLOP } from "../ui/theme";
import { useTheme } from "../ui/ThemeContext";
import { useEntryStyles } from "./styles";

// ---------------------------------------------------------------- backdrop

/**
 * Soft off-screen colour fields behind the content. Sized off the viewport so
 * the composition holds on both a small phone and a tablet, and pinned behind
 * everything with pointerEvents="none" so it never eats a touch.
 */
export function Aura({ tone = "eve" }: { tone?: "eve" | "calm" }) {
  const { palette, scheme } = useTheme();
  const styles = useEntryStyles();
  const { width, height } = useWindowDimensions();
  const size = Math.max(width, height);

  // Dark mode needs weaker fields: the same alpha over a near-black background
  // reads as haze rather than light.
  const strong = scheme === "dark" ? 0.16 : 0.5;
  const soft = scheme === "dark" ? 0.12 : 0.38;

  // The lavender palette's own hues. "eve" leads with her purple, "calm" with
  // the pale blue; mint is the third field either way. Same low-alpha layering
  // the AI orb uses, so the entry flow and the agent read as one system.
  const primary = tone === "calm" ? palette.info : palette.ambient;
  const secondary = tone === "calm" ? palette.ambient : palette.info;

  return (
    <View style={styles.auraLayer} pointerEvents="none">
      <View
        style={[
          styles.blob,
          {
            width: size * 1.1,
            height: size * 1.1,
            top: -size * 0.62,
            left: -size * 0.28,
            backgroundColor: primary,
            opacity: strong * 0.4,
          },
        ]}
      />
      <View
        style={[
          styles.blob,
          {
            width: size * 0.9,
            height: size * 0.9,
            top: -size * 0.3,
            right: -size * 0.45,
            backgroundColor: secondary,
            opacity: soft * 0.35,
          },
        ]}
      />
      <View
        style={[
          styles.blob,
          {
            width: size * 0.8,
            height: size * 0.8,
            bottom: -size * 0.52,
            left: -size * 0.2,
            backgroundColor: palette.success,
            opacity: soft * 0.3,
          },
        ]}
      />
    </View>
  );
}

// -------------------------------------------------------------- brand mark

/**
 * The EVE mark. `pulse` adds a slow halo breath — used on the boot screen to
 * show the app is alive while it restores the session, which is the one place
 * the user is waiting on us with nothing to read.
 *
 * The logo is a single-colour shape with an alpha channel, so `tintColor`
 * recolours it from one asset instead of needing a light and a dark export.
 */
export function EveMark({ pulse = false }: { pulse?: boolean }) {
  const { palette, reduceMotion } = useTheme();
  const styles = useEntryStyles();
  const breath = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!pulse || reduceMotion) {
      breath.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: 1,
          duration: 1400,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(breath, {
          toValue: 0,
          duration: 1400,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [breath, pulse, reduceMotion]);

  return (
    <View style={styles.markWrap}>
      <Animated.View
        style={[
          styles.markHalo,
          {
            opacity: breath.interpolate({ inputRange: [0, 1], outputRange: [0, 0.18] }),
            transform: [{ scale: breath.interpolate({ inputRange: [0, 1], outputRange: [0.75, 1] }) }],
          },
        ]}
      />
      <View style={styles.mark}>
        <Image
          source={require("../../assets/logo.png")}
          style={[styles.markImage, { tintColor: palette.textInverse }]}
          resizeMode="contain"
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
      </View>
    </View>
  );
}

// ----------------------------------------------------------------- progress

/**
 * Step indicator. The whole row is one accessibility node reading "Step 2 of
 * 6" — six separate dots would be six meaningless stops for a screen reader.
 */
export function ProgressDots({ total, index }: { total: number; index: number }) {
  const styles = useEntryStyles();
  return (
    <View
      style={styles.dots}
      accessibilityRole="progressbar"
      accessibilityLabel={`Step ${index + 1} of ${total}`}
      accessibilityValue={{ min: 1, max: total, now: index + 1 }}
    >
      {Array.from({ length: total }, (_unused, i) => (
        <View key={i} style={[styles.dot, i < index && styles.dotDone, i === index && styles.dotActive]} />
      ))}
    </View>
  );
}

// ------------------------------------------------------------------ actions

type ActionProps = {
  label: string;
  onPress: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  busy?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function PrimaryAction({ label, onPress, icon, busy, disabled, style }: ActionProps) {
  const { palette } = useTheme();
  const styles = useEntryStyles();
  const blocked = Boolean(busy || disabled);
  return (
    <PressableScale
      style={[styles.primary, blocked && styles.disabled, style]}
      onPress={onPress}
      disabled={blocked}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: blocked, busy: Boolean(busy) }}
    >
      {busy ? (
        <ActivityIndicator size="small" color={palette.textInverse} />
      ) : icon ? (
        <Ionicons name={icon} size={18} color={palette.textInverse} />
      ) : null}
      <Text style={styles.primaryText}>{label}</Text>
    </PressableScale>
  );
}

export function SecondaryAction({ label, onPress, icon, busy, disabled, style }: ActionProps) {
  const { palette } = useTheme();
  const styles = useEntryStyles();
  const blocked = Boolean(busy || disabled);
  return (
    <PressableScale
      style={[styles.secondary, blocked && styles.disabled, style]}
      onPress={onPress}
      disabled={blocked}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: blocked, busy: Boolean(busy) }}
    >
      {busy ? (
        <ActivityIndicator size="small" color={palette.text} />
      ) : icon ? (
        <Ionicons name={icon} size={18} color={palette.text} />
      ) : null}
      <Text style={styles.secondaryText}>{label}</Text>
    </PressableScale>
  );
}

export function GhostAction({
  label,
  onPress,
  icon,
  iconAfter,
}: {
  label: string;
  onPress: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  iconAfter?: boolean;
}) {
  const { palette } = useTheme();
  const styles = useEntryStyles();
  const glyph = icon ? <Ionicons name={icon} size={16} color={palette.textMuted} /> : null;
  return (
    <Pressable
      style={styles.ghost}
      onPress={onPress}
      hitSlop={HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {iconAfter ? null : glyph}
      <Text style={styles.ghostText}>{label}</Text>
      {iconAfter ? glyph : null}
    </Pressable>
  );
}

// ------------------------------------------------------------------ content

/**
 * One "here is a thing EVE does" row. Tone drives the icon chip colour so the
 * rows carry the same semantic colour coding as the rest of the app.
 */
export function FeatureRow({
  icon,
  title,
  body,
  tone = "neutral",
  delay = 0,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  body: string;
  tone?: Parameters<ReturnType<typeof useTheme>["toneSurface"]>[0];
  delay?: number;
}) {
  const { toneSurface, toneInk } = useTheme();
  const styles = useEntryStyles();
  return (
    <FadeSlideIn delay={delay}>
      <View style={styles.featureRow}>
        <View style={[styles.featureIcon, { backgroundColor: toneSurface(tone) }]}>
          <Ionicons name={icon} size={20} color={toneInk(tone)} />
        </View>
        <View style={styles.featureText}>
          <Text style={styles.featureTitle}>{title}</Text>
          <Text style={styles.bodyMuted}>{body}</Text>
        </View>
      </View>
    </FadeSlideIn>
  );
}

/** Small uppercase kicker above a heading. */
export function Eyebrow({ children }: { children: ReactNode }) {
  const styles = useEntryStyles();
  return <Text style={styles.eyebrow}>{children}</Text>;
}
