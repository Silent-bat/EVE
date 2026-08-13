/**
 * Design tokens for the EVE mobile UI. Every color the app draws comes from
 * here — components read them through `useTheme()` so light and dark render
 * from one set of component styles.
 *
 * The light scheme is a soft lavender: a tinted background with white cards
 * floating on it, and one purple that carries every AI action. The dark scheme
 * is not an inversion — it's a deep plum tuned so the semantic hierarchy
 * (mint=action, amber=warning, purple=agent) survives at low luminance, where
 * naive inversion turns pastel tints into mud.
 *
 * `ambient` is EVE's own colour. It marks the agent speaking or acting and is
 * deliberately the only saturated hue in the set, so a purple element always
 * means "this is EVE".
 */

export type ColorScheme = "light" | "dark";

export const lightPalette = {
  // Surfaces — the background is tinted and the cards are pure white, which is
  // what gives the palette its lift. Inverting that (white page, tinted cards)
  // reads as a form, not a premium surface.
  background: "#f3effa",
  surface: "#ffffff",
  surfaceAlt: "#ebe3f9",
  surfaceMuted: "#f7f4fc",
  surfaceInk: "#171432",
  border: "#e7dff6",
  borderStrong: "#d3c7ee",

  // Text — near-black carries a little violet so it sits in the same family as
  // the background instead of reading as a foreign grey.
  text: "#171432",
  textMuted: "#6e6a88",
  textInverse: "#ffffff",

  // Semantic — pastel faces with deep ink counterparts for text on tints.
  success: "#12a67c",
  successDeep: "#0a6b50",
  successTint: "#dcf5ec",
  warning: "#c98a12",
  warningDeep: "#7d5205",
  warningTint: "#fbeed6",
  danger: "#d4485f",
  dangerDeep: "#9d1f34",
  dangerTint: "#fbe2e7",
  info: "#4a7fd4",
  infoDeep: "#2a5599",
  infoTint: "#e3ecfb",

  // EVE's purple. Primary AI actions, the orb, the centre nav button.
  ambient: "#7c5ce6",
  ambientDeep: "#4a2fa8",
  ambientTint: "#ede6fd",

  // Modal backdrop. Violet-tinted rather than neutral black so sheets settle
  // into the palette instead of punching a grey hole in it.
  scrim: "rgba(23, 20, 50, 0.42)",
};

export const darkPalette: typeof lightPalette = {
  // Surfaces — plum-shifted rather than neutral charcoal, so the dark scheme
  // reads as the same product at night instead of a generic dark theme.
  background: "#141020",
  surface: "#1e1832",
  surfaceAlt: "#2a2145",
  surfaceMuted: "#241d3b",
  surfaceInk: "#f3f0fb",
  border: "#332a52",
  borderStrong: "#473b6b",

  // Text
  text: "#f3f0fb",
  textMuted: "#a09bbd",
  textInverse: "#141020",

  // Semantic — "deep" swaps to the lighter end in dark mode because it is
  // used as ink on top of tints, and tints are now dark.
  success: "#3fd3a4",
  successDeep: "#8ef0cd",
  successTint: "#0f3830",
  warning: "#e8b552",
  warningDeep: "#f5cd84",
  warningTint: "#3a2c12",
  danger: "#f0798f",
  dangerDeep: "#f8a8b7",
  dangerTint: "#3d1a25",
  info: "#7ba9f0",
  infoDeep: "#b3cffa",
  infoTint: "#1a2a4a",

  // Lifted well above the light value: at low luminance a mid purple loses its
  // identity against a plum background, so EVE's colour has to brighten to
  // stay recognisably EVE.
  ambient: "#a88cff",
  ambientDeep: "#c9b4ff",
  ambientTint: "#2b2150",

  scrim: "rgba(8, 5, 18, 0.7)",
};

/**
 * Corner radii. The scale runs larger than a typical app: `xl` is the card
 * radius and `lg` the floor for anything interactive, because a soft pastel
 * palette on tight corners reads as unfinished rather than calm.
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
 */
/**
 * Elevation. Android reads `elevation`, iOS reads the shadow* family, so each
 * level carries both — spreading one of these gets the same depth on either
 * platform without a Platform.select at every call site.
 *
 * Shadows are violet rather than black. A neutral shadow over a lavender
 * background greys the tint underneath it and the card looks dirty; tinting the
 * shadow toward the background keeps the lift without the grime.
 */
export const elevation = {
  none: {},
  sm: {
    elevation: 2,
    shadowColor: "#2a1f52",
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
  },
  md: {
    elevation: 5,
    shadowColor: "#2a1f52",
    shadowOpacity: 0.09,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
  },
  lg: {
    elevation: 10,
    shadowColor: "#2a1f52",
    shadowOpacity: 0.13,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 14 },
  },
  /** Reserved for the floating nav bar and the centre EVE button. */
  float: {
    elevation: 14,
    shadowColor: "#5b3fc4",
    shadowOpacity: 0.28,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
  },
} as const;

export function typeScaleFor(p: Palette) {
  return {
    // Hero sizes for first-run and the home greeting. Line heights are tight
    // relative to size — large pastel type needs less leading than the ratio
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
