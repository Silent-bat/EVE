/**
 * One style sheet for the whole entry flow — boot, auth, and the guided first
 * run. These screens share a single layout language (full-bleed lavender
 * backdrop, hero type at the top, one primary action pinned to the bottom), so
 * the sheet lives here instead of being re-derived per screen.
 *
 * Colors come from the lavender palette tokens. What changed versus the old
 * auth screens is scale and depth: bigger type, more breathing room, real
 * elevation, and 52pt actions instead of 48.
 */
import { StyleSheet } from "react-native";

import { MIN_TOUCH, elevation, radius, spacing } from "../ui/theme";
import { useThemedStyles, type ThemeValue } from "../ui/ThemeContext";

export function useEntryStyles() {
  return useThemedStyles(makeEntryStyles);
}

function makeEntryStyles({ palette, type }: ThemeValue) {
  return StyleSheet.create({
    // ---------- scaffold ----------
    screen: {
      flex: 1,
      backgroundColor: palette.background,
    },
    auraLayer: {
      ...StyleSheet.absoluteFillObject,
      overflow: "hidden",
    },
    blob: {
      position: "absolute",
      borderRadius: radius.pill,
    },
    topBar: {
      minHeight: MIN_TOUCH,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 24,
      paddingTop: spacing.xs,
    },
    scroll: {
      flexGrow: 1,
      paddingHorizontal: 24,
      paddingTop: spacing.lg,
      paddingBottom: spacing.xl,
      gap: spacing.md,
    },
    /**
     * The inset layer, nested inside `screen`. Transparent and unpainted so the
     * aura — which sits behind it, outside the insets — still bleeds under the
     * status and navigation bars while the content it wraps stays clear of them.
     */
    safe: {
      flex: 1,
    },
    centered: {
      flexGrow: 1,
      justifyContent: "center",
      paddingHorizontal: 24,
      gap: spacing.md,
    },
    footer: {
      paddingHorizontal: 24,
      paddingTop: spacing.md,
      paddingBottom: spacing.md,
      gap: spacing.sm,
    },
    spacer: {
      flex: 1,
      minHeight: spacing.lg,
    },

    // ---------- brand ----------
    markWrap: {
      alignItems: "center",
      justifyContent: "center",
      width: 96,
      height: 96,
    },
    markHalo: {
      position: "absolute",
      width: 96,
      height: 96,
      borderRadius: radius.pill,
      backgroundColor: palette.ambient,
    },
    /**
     * EVE's purple rather than the near-black ink the warm palette used. A
     * purple surface means "this is EVE" everywhere else in the app, and the
     * brand mark is the strongest case of that.
     */
    mark: {
      width: 62,
      height: 62,
      borderRadius: radius.lg,
      backgroundColor: palette.ambient,
      alignItems: "center",
      justifyContent: "center",
      ...elevation.md,
    },
    markImage: {
      width: 36,
      height: 36,
    },

    // ---------- type ----------
    eyebrow: {
      ...type.caption,
      color: palette.ambientDeep,
      textTransform: "uppercase",
    },
    hero: type.hero,
    heading: type.displayLg,
    lead: type.lead,
    body: type.body,
    bodyMuted: type.bodyMuted,

    // ---------- progress ----------
    dots: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    dot: {
      height: 6,
      width: 6,
      borderRadius: radius.pill,
      backgroundColor: palette.borderStrong,
    },
    dotActive: {
      width: 22,
      backgroundColor: palette.ambient,
    },
    dotDone: {
      backgroundColor: palette.textMuted,
    },

    // ---------- actions ----------
    /**
     * The primary CTA carries EVE's purple rather than the near-black ink the
     * warm palette used. In this design a purple surface means "EVE acts", and
     * the one button on each entry screen is exactly that.
     */
    primary: {
      minHeight: 52,
      borderRadius: radius.lg,
      backgroundColor: palette.ambient,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      ...elevation.sm,
    },
    primaryText: {
      color: palette.textInverse,
      fontSize: 15,
      fontWeight: "800",
    },
    secondary: {
      minHeight: 52,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: palette.borderStrong,
      backgroundColor: palette.surface,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
    },
    secondaryText: {
      color: palette.text,
      fontSize: 15,
      fontWeight: "800",
    },
    ghost: {
      minHeight: MIN_TOUCH,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingHorizontal: spacing.md,
    },
    ghostText: {
      color: palette.textMuted,
      fontSize: 14,
      fontWeight: "700",
    },
    disabled: {
      opacity: 0.45,
    },

    // ---------- content blocks ----------
    card: {
      backgroundColor: palette.surface,
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: radius.lg,
      padding: spacing.lg,
      gap: spacing.md,
      ...elevation.sm,
    },
    featureRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: spacing.md,
    },
    featureIcon: {
      width: 42,
      height: 42,
      borderRadius: radius.md,
      alignItems: "center",
      justifyContent: "center",
    },
    featureText: {
      flex: 1,
      gap: 2,
    },
    featureTitle: {
      color: palette.text,
      fontSize: 15,
      fontWeight: "800",
    },
    divider: {
      height: 1,
      backgroundColor: palette.border,
    },

    // ---------- choice chips ----------
    chipRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing.sm,
    },
    chip: {
      minHeight: MIN_TOUCH,
      paddingHorizontal: spacing.lg,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    chipActive: {
      backgroundColor: palette.ambient,
      borderColor: palette.ambient,
    },
    chipText: {
      color: palette.text,
      fontSize: 14,
      fontWeight: "800",
    },
    chipTextActive: {
      color: palette.textInverse,
    },

    // ---------- form ----------
    input: {
      minHeight: 52,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.surface,
      paddingHorizontal: spacing.lg,
      color: palette.text,
      fontSize: 15,
      fontWeight: "600",
    },
    inputFocused: {
      borderColor: palette.ambient,
    },
    switch: {
      flexDirection: "row",
      backgroundColor: palette.surfaceMuted,
      borderRadius: radius.pill,
      padding: 4,
    },
    switchButton: {
      flex: 1,
      minHeight: 40,
      borderRadius: radius.pill,
      alignItems: "center",
      justifyContent: "center",
    },
    switchActive: {
      backgroundColor: palette.surface,
      ...elevation.sm,
    },
    switchText: {
      color: palette.textMuted,
      fontSize: 14,
      fontWeight: "800",
    },
    switchTextActive: {
      color: palette.text,
    },
    toggleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: spacing.md,
      minHeight: MIN_TOUCH,
    },

    // ---------- "or" separator ----------
    orRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingVertical: spacing.xs,
    },
    orLine: {
      flex: 1,
      height: 1,
      backgroundColor: palette.border,
    },
    orText: {
      ...type.caption,
      textTransform: "uppercase",
    },

    /**
     * Diagnostic line. Only for the crash screen, where knowing which API the
     * app was pointed at is the difference between a useful report and "it
     * broke". Never used on a screen a healthy session reaches.
     */
    diagnostic: {
      color: palette.textMuted,
      fontSize: 12,
      lineHeight: 17,
    },
  });
}
