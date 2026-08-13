/**
 * The two input shapes settings needs that aren't a switch: a clock time and a
 * small integer.
 *
 * Both are deliberately not free text. A frequency cap typed on a number pad
 * means opening a keyboard, dismissing it, and hoping the blur committed —
 * for a value that realistically moves by one. A stepper is two taps and can't
 * produce an invalid number. The time field stays typed because a 24-hour
 * clock has 1,440 values and no picker ships with this build, but it repairs
 * what you type rather than rejecting it.
 */
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { PressableScale } from "../ui/motion";
import { HIT_SLOP, MIN_TOUCH, radius } from "../ui/theme";
import { useTheme, useThemedStyles, type ThemeValue } from "../ui/ThemeContext";

export function TimeField({
  value,
  onChange,
  label,
  width = 72,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
  /**
   * Narrow it where two fields share one row. "22:00" needs about 40dp of
   * glyph, so the default has room to spare and the quiet-hours pair can give
   * some of it back to the label rather than wrapping it onto a second line.
   */
  width?: number;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [draft, setDraft] = useState(value);

  // Follow the server when it answers with something different from what was
  // typed — including after a failed save, which reloads the old value.
  useEffect(() => setDraft(value), [value]);

  return (
    <TextInput
      value={draft}
      onChangeText={setDraft}
      onEndEditing={() => {
        const clean = normalizeTime(draft);
        setDraft(clean ?? value);
        if (clean && clean !== value) onChange(clean);
      }}
      style={[styles.timeInput, { width }]}
      placeholder="--:--"
      placeholderTextColor={palette.textMuted}
      maxLength={5}
      keyboardType="numbers-and-punctuation"
      accessibilityLabel={label}
      accessibilityHint="24 hour time, for example 22:00"
    />
  );
}

/**
 * Accepts "7", "730", "7:30", "07:30" and returns "07:30". Returns null when
 * there's no reading that lands on a real clock time, so the caller can put
 * the previous value back instead of saving nonsense.
 */
export function normalizeTime(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 0 || digits.length > 4) return null;

  const padded = digits.length <= 2 ? `${digits.padStart(2, "0")}00` : digits.padStart(4, "0");
  const hours = Number(padded.slice(0, 2));
  const minutes = Number(padded.slice(2));
  if (hours > 23 || minutes > 59) return null;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function Stepper({
  value,
  onChange,
  label,
  suffix,
  min = 0,
  max = 99,
}: {
  value: number;
  onChange: (next: number) => void;
  label: string;
  /** Unit shown after the number, e.g. "/hr". Kept short — the box is narrow. */
  suffix?: string;
  min?: number;
  max?: number;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));

  return (
    <View style={styles.stepper}>
      <StepButton
        icon="remove"
        label={`Decrease ${label}`}
        disabled={value <= min}
        onPress={() => onChange(clamp(value - 1))}
      />
      <View style={styles.stepperValue} accessible accessibilityLabel={`${label}, ${value}`}>
        <Text style={styles.stepperNumber}>{value}</Text>
        {suffix ? <Text style={styles.stepperSuffix}>{suffix}</Text> : null}
      </View>
      <StepButton
        icon="add"
        label={`Increase ${label}`}
        disabled={value >= max}
        onPress={() => onChange(clamp(value + 1))}
      />
      <View style={[styles.stepperEdge, { borderColor: palette.border }]} pointerEvents="none" />
    </View>
  );
}

function StepButton({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  disabled: boolean;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      hitSlop={HIT_SLOP}
      scaleTo={0.9}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={[styles.stepButton, disabled ? styles.stepButtonOff : null]}
    >
      <Ionicons name={icon} size={17} color={disabled ? palette.textMuted : palette.ambient} />
    </PressableScale>
  );
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    timeInput: {
      ...type.label,
      minHeight: MIN_TOUCH,
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: radius.md,
      backgroundColor: palette.surfaceMuted,
      color: palette.text,
      textAlign: "center",
      fontVariant: ["tabular-nums"],
    },
    stepper: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: palette.surfaceMuted,
      borderRadius: radius.pill,
      padding: 3,
    },
    // The hairline is a sibling overlay rather than a border on the track so
    // the rounded corners stay crisp against the card behind them.
    stepperEdge: {
      ...StyleSheet.absoluteFillObject,
      borderWidth: 1,
      borderRadius: radius.pill,
    },
    stepButton: {
      width: 32,
      height: 32,
      borderRadius: radius.pill,
      backgroundColor: palette.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    stepButtonOff: { backgroundColor: "transparent" },
    stepperValue: {
      minWidth: 52,
      flexDirection: "row",
      alignItems: "baseline",
      justifyContent: "center",
      gap: 1,
    },
    stepperNumber: {
      ...type.label,
      fontSize: 15,
      fontVariant: ["tabular-nums"],
    },
    stepperSuffix: { ...type.caption, fontSize: 11, fontWeight: "700" },
  });
}
