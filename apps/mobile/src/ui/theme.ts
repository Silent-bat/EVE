/**
 * Design tokens for the EVE mobile UI. Every color the app draws comes from
 * here — components read them through `useTheme()` so light and dark render
 * from one set of component styles.
 *
 * The product chrome is intentionally monochrome. Light mode is anchored in
 * pure white and black; dark mode is the exact inverse. Neutral steps preserve
 * hierarchy without tinting the interface. The particle orb owns the product's
 * colour and stays multicolor independently of these tokens.
 */

export type ColorScheme = "light" | "dark";

export const lightPalette = {
  background: "#ffffff",
  surface: "#ffffff",
  surfaceAlt: "#eeeeee",
  surfaceMuted: "#f6f6f6",
  surfaceInk: "#000000",
  border: "#dedede",
  borderStrong: "#a8a8a8",
  text: "#000000",
  textMuted: "#616161",
  textInverse: "#ffffff",
  success: "#111111",
  successDeep: "#000000",
  successTint: "#eeeeee",
  warning: "#333333",
  warningDeep: "#000000",
  warningTint: "#e4e4e4",
  danger: "#000000",
  dangerDeep: "#000000",
  dangerTint: "#dddddd",
  info: "#222222",
  infoDeep: "#000000",
  infoTint: "#eeeeee",
  ambient: "#000000",
  ambientDeep: "#292929",
  ambientTint: "#eeeeee",
  scrim: "rgba(0, 0, 0, 0.48)",
};

export const darkPalette: typeof lightPalette = {
  background: "#000000",
  surface: "#000000",
  surfaceAlt: "#242424",
  surfaceMuted: "#111111",
  surfaceInk: "#ffffff",
  border: "#292929",
  borderStrong: "#5c5c5c",
  text: "#ffffff",
  textMuted: "#a3a3a3",
  textInverse: "#000000",
  success: "#eeeeee",
  successDeep: "#ffffff",
  successTint: "#1c1c1c",
  warning: "#cfcfcf",
  warningDeep: "#ffffff",
  warningTint: "#242424",
  danger: "#ffffff",
  dangerDeep: "#ffffff",
  dangerTint: "#292929",
  info: "#dedede",
  infoDeep: "#ffffff",
  infoTint: "#1c1c1c",
  ambient: "#ffffff",
  ambientDeep: "#d6d6d6",
  ambientTint: "#1c1c1c",
  scrim: "rgba(255, 255, 255, 0.18)",
};

/**
 * Corner radii. The scale keeps surfaces soft while the monochrome palette
 * stays crisp and utilitarian.
 */
export const radius = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  xxl: 32,
  pill: 999,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  xxxl: 40,
} as const;

/**
 * Minimum hit target. iOS HIG says 44pt, Material says 48dp — 44 is the
 * floor we hold every interactive element to.
 */
export const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;
export const MIN_TOUCH = 44;

export type Palette = typeof lightPalette;

export function paletteFor(scheme: ColorScheme): Palette {
  return scheme === "dark" ? darkPalette : lightPalette;
}

/**
 * Elevation. Android reads `elevation`, iOS reads the shadow* family, so each
 * level carries both — spreading one of these gets the same depth on either
 * platform without a Platform.select at every call site.
 *
 * Shadows stay neutral so they do not introduce colour into the chrome.
 */
export const elevation = {
  none: {},
  sm: {
    elevation: 2,
    shadowColor: "#000000",
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
  },
  md: {
    elevation: 5,
    shadowColor: "#000000",
    shadowOpacity: 0.09,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
  },
  lg: {
    elevation: 10,
    shadowColor: "#000000",
    shadowOpacity: 0.13,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 14 },
  },
  /** Reserved for the floating nav bar and the centre EVE button. */
  float: {
    elevation: 14,
    shadowColor: "#000000",
    shadowOpacity: 0.2,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
  },
} as const;

export function typeScaleFor(p: Palette) {
  return {
    // Hero sizes for first-run and the home greeting. Line heights are tight
    // relative to size — large display type needs less leading than the ratio
    // that suits body copy, or the headline stops reading as one object.
    heroLg: { fontSize: 32, fontWeight: "800" as const, color: p.text, lineHeight: 38 },
    hero: { fontSize: 28, fontWeight: "800" as const, color: p.text, lineHeight: 34 },
    displayLg: { fontSize: 24, fontWeight: "800" as const, color: p.text, lineHeight: 30 },
    lead: {
      fontSize: 16,
      fontWeight: "500" as const,
      color: p.textMuted,
      lineHeight: 24,
    },
    display: { fontSize: 21, fontWeight: "800" as const, color: p.text },
    title: { fontSize: 17, fontWeight: "700" as const, color: p.text },
    body: { fontSize: 15, fontWeight: "500" as const, color: p.text, lineHeight: 22 },
    bodyMuted: {
      fontSize: 14,
      fontWeight: "500" as const,
      color: p.textMuted,
      lineHeight: 21,
    },
    label: { fontSize: 13, fontWeight: "700" as const, color: p.text },
    caption: {
      fontSize: 12,
      fontWeight: "600" as const,
      color: p.textMuted,
    },
  } as const;
}

// Tone → palette helpers. Used by primitives that take a tone prop so
// callers don't have to hand-pick hex codes.
export type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "ambient";

export function toneSurfaceIn(p: Palette, tone: Tone): string {
  switch (tone) {
    case "success":
      return p.successTint;
    case "warning":
      return p.warningTint;
    case "danger":
      return p.dangerTint;
    case "info":
      return p.infoTint;
    case "ambient":
      return p.ambientTint;
    default:
      return p.surfaceMuted;
  }
}

/**
 * Ink for text and icons sitting on `toneSurfaceIn` of the same tone. Every
 * tone resolves to its `*Deep` variant rather than its face colour — the face
 * colours are tuned to be legible on the page background, and a mid amber on
 * an amber tint lands around 2.5:1, well under WCAG AA.
 */
export function toneInkIn(p: Palette, tone: Tone): string {
  switch (tone) {
    case "success":
      return p.successDeep;
    case "warning":
      return p.warningDeep;
    case "danger":
      return p.dangerDeep;
    case "info":
      return p.infoDeep;
    case "ambient":
      return p.ambientDeep;
    default:
      return p.text;
  }
}

export function toneAccentIn(p: Palette, tone: Tone): string {
  switch (tone) {
    case "success":
      return p.success;
    case "warning":
      return p.warning;
    case "danger":
      return p.danger;
    case "info":
      return p.info;
    case "ambient":
      return p.ambient;
    default:
      return p.surfaceInk;
  }
}

// Static light-mode aliases. Only for modules that cannot use the hook
// (plain .ts helpers, notification channel colors).
export const palette = lightPalette;
export const type = typeScaleFor(lightPalette);
