/**
 * Appearance — the theme manager.
 *
 * A three-option segment told you the names of the themes but not what they
 * looked like, which is the one thing a theme picker is for. Each option here
 * carries a miniature of the page it produces — background, card, text, and
 * EVE's purple — drawn from the real palettes, so switching is a choice you
 * make by looking rather than by trying.
 *
 * "System" shows both halves, because that is honestly what it gives you: the
 * app follows the phone, and which one you get depends on the time of day.
 */
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";

import { SettingsGroup, SettingsRowItem } from "../rows";
import { SettingsPage } from "../PageShell";
import { PressableScale } from "../../ui/motion";
import {
  darkPalette,
  elevation,
  lightPalette,
  radius,
  spacing,
  type Palette,
} from "../../ui/theme";
import {
  useTheme,
  useThemedStyles,
  type AppearancePreference,
  type ThemeValue,
} from "../../ui/ThemeContext";

type Option = {
  value: AppearancePreference;
  label: string;
  description: string;
  /** Which palettes the swatch shows. Two for "system". */
  swatches: Palette[];
};

const OPTIONS: Option[] = [
  {
    value: "system",
    label: "Match my phone",
    description: "Light by day, dark at night — whatever Android is doing",
    swatches: [lightPalette, darkPalette],
  },
  {
    value: "light",
    label: "Lavender",
    description: "Soft light background, white cards",
    swatches: [lightPalette],
  },
  {
    value: "dark",
    label: "Midnight",
    description: "Deep plum, easier on the eyes after dark",
    swatches: [darkPalette],
  },
];

export function AppearancePage({ onBack }: { onBack: () => void }) {
  const { palette, preference, setPreference, reduceMotion } = useTheme();
  const styles = useThemedStyles(makeStyles);

  return (
    <SettingsPage
      title="Appearance"
      intro="How EVE looks on this device. The choice is stored on the phone, not your account."
      onBack={onBack}
    >
      <View style={styles.options} accessibilityRole="radiogroup">
        {OPTIONS.map((option) => {
          const selected = preference === option.value;
          return (
            <PressableScale
              key={option.value}
              onPress={() => setPreference(option.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={option.label}
              accessibilityHint={option.description}
              style={[
                styles.option,
                selected ? { borderColor: palette.ambient, borderWidth: 2 } : null,
              ]}
            >
              <View style={styles.swatchRow}>
                {option.swatches.map((swatch, index) => (
                  <ThemePreview key={index} palette={swatch} half={option.swatches.length > 1} />
                ))}
              </View>

              <View style={styles.optionText}>
                <Text style={styles.optionLabel}>{option.label}</Text>
                <Text style={styles.optionDescription}>{option.description}</Text>
              </View>

              <View
                style={[
                  styles.radio,
                  selected
                    ? { borderColor: palette.ambient, backgroundColor: palette.ambient }
                    : { borderColor: palette.borderStrong },
                ]}
              >
                {selected ? (
                  <Ionicons name="checkmark" size={14} color={palette.textInverse} />
                ) : null}
              </View>
            </PressableScale>
          );
        })}
      </View>

      <SettingsGroup
        title="Motion"
        footer="EVE follows the system setting — turn it on in Android's accessibility settings and animations here shorten or stop."
      >
        {/* A value, not a switch. This mirrors an OS setting and cannot be
            changed from here, and a disabled switch says that badly: it reads
            as a broken control rather than a reading, and its width pushed the
            subtitle explaining why into an ellipsis. */}
        <SettingsRowItem
          icon="accessibility-outline"
          title="Reduce motion"
          subtitle="Set on your phone, not here"
          value={reduceMotion ? "On" : "Off"}
        />
      </SettingsGroup>
    </SettingsPage>
  );
}

/**
 * A miniature of a page in the given palette. Not a colour chip — the point is
 * to show the *relationship* between background, card, and accent, which is
 * what actually differs between the two schemes.
 */
function ThemePreview({ palette, half }: { palette: Palette; half?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      style={[
        styles.preview,
        { backgroundColor: palette.background, borderColor: palette.border },
        half ? styles.previewHalf : null,
      ]}
      // Decorative: the option's own label already says which theme this is.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={[styles.previewCard, { backgroundColor: palette.surface }]}>
        <View style={[styles.previewLine, { backgroundColor: palette.text, width: "70%" }]} />
        <View style={[styles.previewLine, { backgroundColor: palette.textMuted, width: "45%" }]} />
      </View>
      <View style={[styles.previewPill, { backgroundColor: palette.ambient }]} />
    </View>
  );
}

function makeStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    options: { gap: spacing.md, marginBottom: spacing.xl },
    option: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      padding: spacing.md,
      borderRadius: radius.xl,
      backgroundColor: palette.surface,
      borderWidth: 1,
      borderColor: palette.border,
      ...elevation.sm,
    },
    swatchRow: { flexDirection: "row", gap: 3 },
    preview: {
      width: 54,
      height: 62,
      borderRadius: radius.sm,
      borderWidth: 1,
      padding: 6,
      gap: 5,
      justifyContent: "flex-start",
      overflow: "hidden",
    },
    // Two previews side by side have to fit the same slot as one.
    previewHalf: { width: 30 },
    previewCard: { borderRadius: 4, padding: 5, gap: 3 },
    previewLine: { height: 3, borderRadius: 2 },
    previewPill: { height: 8, width: 20, borderRadius: radius.pill },
    optionText: { flex: 1, gap: 3 },
    optionLabel: { ...type.label, fontSize: 15 },
    optionDescription: { ...type.caption, fontSize: 12, lineHeight: 17 },
    radio: {
      width: 24,
      height: 24,
      borderRadius: radius.pill,
      borderWidth: 2,
      alignItems: "center",
      justifyContent: "center",
    },
  });
}
