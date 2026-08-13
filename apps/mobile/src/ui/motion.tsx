/**
 * Motion primitives built on the RN Animated API — no extra dependency.
 *
 * Every entrance here collapses to an instant appearance when the OS
 * reduce-motion switch is on, so the animation is a progressive enhancement
 * rather than something a user has to sit through.
 */
import { useEffect, useRef, type ReactNode } from "react";
import {
  Animated,
  Easing,
  Pressable,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { useTheme } from "./ThemeContext";

const DURATION = 220;

/** Fade + short upward slide. Used for tab bodies and cards. */
export function FadeSlideIn({
  children,
  delay = 0,
  offset = 8,
  style,
}: {
  children: ReactNode;
  delay?: number;
  offset?: number;
  style?: ViewStyle;
}) {
  const { reduceMotion } = useTheme();
  const progress = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;

  useEffect(() => {
    if (reduceMotion) {
      progress.setValue(1);
      return;
    }
    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: DURATION,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [progress, delay, reduceMotion]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [
            {
              translateY: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [offset, 0],
              }),
            },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

/**
 * Press feedback: scales down slightly while held. Returns handlers plus the
 * animated style so a caller can spread them onto any Pressable.
 */
export function usePressScale(scaleTo = 0.97) {
  const { reduceMotion } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;

  const animate = (toValue: number) => {
    if (reduceMotion) return;
    Animated.spring(scale, {
      toValue,
      useNativeDriver: true,
      speed: 40,
      bounciness: 0,
    }).start();
  };

  return {
    onPressIn: () => animate(scaleTo),
    onPressOut: () => animate(1),
    animatedStyle: { transform: [{ scale }] },
  };
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type PressableScaleProps = Omit<PressableProps, "style"> & {
  style?: StyleProp<ViewStyle>;
  scaleTo?: number;
};

/**
 * Pressable with scale feedback. Drop-in replacement for Pressable that adds
 * subtle press scaling, and stays still when reduce motion is on.
 */
export function PressableScale({
  children,
  style,
  onPressIn,
  onPressOut,
  scaleTo = 0.97,
  ...props
}: PressableScaleProps) {
  const { onPressIn: scaleIn, onPressOut: scaleOut, animatedStyle } = usePressScale(scaleTo);

  return (
    <AnimatedPressable
      {...props}
      style={[style, animatedStyle]}
      onPressIn={(event: GestureResponderEvent) => {
        scaleIn();
        onPressIn?.(event);
      }}
      onPressOut={(event: GestureResponderEvent) => {
        scaleOut();
        onPressOut?.(event);
      }}
    >
      {children}
    </AnimatedPressable>
  );
}
