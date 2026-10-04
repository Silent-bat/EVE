/**
 * Design tokens for the EVE mobile UI. Every color the app draws comes from
 * here — components read them through `useTheme()` so light and dark render
 * from one set of component styles.
 *
 * The system is anchored on an indigo/violet brand accent (the EVE orb colour),
 * over a soft off-white in light mode and a deep near-black navy in dark mode.
 * Semantic tones (success/warning/danger/info/ambient) carry the coloured
 * icon-chips and status accents used across cards.
 */

export type ColorScheme = "light" | "dark";

export const lightPalette = {
  background: "#f4f5fb",
  surface: "#ffffff",
  surfaceAlt: "#ecedf5",
  surfaceMuted: "#f0f1f9",
  surfaceInk: "#1c1e2b",
  border: "#e6e8f2",
  borderStrong: "#c9cce0",
  text: "#141625",
  textMuted: "#6b7186",
  textInverse: "#ffffff",
  // Brand accent (indigo/violet) — the EVE colour, used for primary actions.
  primary: "#6366f1",
  primaryDeep: "#4f46e5",
  primaryTint: "#ececfe",
  onPrimary: "#ffffff",
  gradientStart: "#6366f1",
  gradientEnd: "#8b5cf6",
  success: "#0f9d6c",
  successDeep: "#0a7a53",
  successTint: "#e4f6ee",
  warning: "#e08600",
  warningDeep: "#b56b00",
  warningTint: "#fbeed6",
  danger: "#e5484d",
  dangerDeep: "#c23a3f",
  dangerTint: "#fce8e8",
  info: "#3b82f6",
  infoDeep: "#2f6fe0",
  infoTint: "#e6effd",
  ambient: "#6366f1",
  ambientDeep: "#4f46e5",
  ambientTint: "#ececfe",
  scrim: "rgba(15, 17, 30, 0.48)",
};

export const darkPalette: typeof lightPalette = {
  background: "#0a0b12",
  surface: "#14161f",
  surfaceAlt: "#1e2130",
  surfaceMuted: "#1a1c27",
  surfaceInk: "#ffffff",
  border: "#262a3a",
  borderStrong: "#3b4054",
  text: "#f5f6fa",
  textMuted: "#9aa0b4",
  textInverse: "#0a0b12",
  primary: "#818cf8",
  primaryDeep: "#a5b4fc",
  primaryTint: "#20233a",
  onPrimary: "#0a0b12",
  gradientStart: "#6366f1",
  gradientEnd: "#8b5cf6",
  success: "#34d399",
  successDeep: "#6ee7b7",
  successTint: "#14231e",
  warning: "#fbbf24",
  warningDeep: "#fcd34d",
  warningTint: "#2a2114",
  danger: "#f87171",
  dangerDeep: "#fca5a5",
  dangerTint: "#2a1618",
  info: "#60a5fa",
  infoDeep: "#93c5fd",
  infoTint: "#161f2e",
  ambient: "#818cf8",
  ambientDeep: "#a5b4fc",
  ambientTint: "#20233a",
  scrim: "rgba(0, 0, 0, 0.6)",
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
