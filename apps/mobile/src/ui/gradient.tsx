/**
 * Gradients, without a gradient library.
 *
 * The design leans on soft lavender-to-pink blends, and the app ships no
 * gradient dependency. Rather than add a native module to a working build — and
 * rather than sprinkle stacks of half-transparent Views through every screen —
 * the blend is computed in JS and painted as a run of solid bands.
 *
 * At 18 bands across a phone-width element the seams land well under a pixel of
 * perceptual difference, so it reads as a gradient. It is not one, and two
 * things follow from that: bands are laid out with flex, so these components
 * need a bounded box to paint into, and a band count high enough to hide seams
 * on a 400pt-tall hero is wasted on a 44pt pill.
 *
 * Everything routes through `SoftGradient` and `SoftRadial` on purpose. If this
 * ever wants to become `expo-linear-gradient`, both bodies get replaced and no
 * call site changes.
 */
import { memo, useMemo } from "react";
import { View, type DimensionValue, type StyleProp, type ViewStyle } from "react-native";

type RGBA = { r: number; g: number; b: number; a: number };

/** Accepts `#abc`, `#aabbcc`, `#aabbccdd`, `rgb(…)` and `rgba(…)`. */
function parseColor(input: string): RGBA {
  const value = input.trim();
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    const full =
      hex.length === 3 || hex.length === 4
        ? hex
            .split("")
            .map((c) => c + c)
            .join("")
        : hex;
    return {
      r: parseInt(full.slice(0, 2), 16) || 0,
      g: parseInt(full.slice(2, 4), 16) || 0,
      b: parseInt(full.slice(4, 6), 16) || 0,
      a: full.length >= 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
    };
  }
  const parts = value
    .replace(/^rgba?\(/, "")
    .replace(/\)$/, "")
    .split(",")
    .map((p) => Number(p.trim()));
  return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts[3] ?? 1 };
}

function toCss({ r, g, b, a }: RGBA): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Number(a.toFixed(3))})`;
}

function mix(from: RGBA, to: RGBA, t: number): RGBA {
  return {
    r: from.r + (to.r - from.r) * t,
    g: from.g + (to.g - from.g) * t,
    b: from.b + (to.b - from.b) * t,
    a: from.a + (to.a - from.a) * t,
  };
}

/**
 * Re-alpha a colour from the palette. Preferable to the `color + "33"` hex-suffix
 * trick used elsewhere: that only works on 6-digit hex and silently produces
 * garbage for `#abc` or `rgb(…)`.
 */
export function withAlpha(color: string, alpha: number): string {
  return toCss({ ...parseColor(color), a: alpha });
}

/**
 * Sample `colors` into `count` evenly spaced bands. Stops are treated as
 * equidistant, which is all the design needs and keeps the signature small.
 */
function sampleBands(colors: string[], count: number): string[] {
  if (colors.length === 0) return [];
  if (colors.length === 1) return Array.from({ length: count }, () => colors[0]!);

  const stops = colors.map(parseColor);
  const segments = stops.length - 1;

  return Array.from({ length: count }, (_unused, i) => {
    // Sample band centres rather than edges, so the first and last bands sit
    // just inside the endpoint colours instead of overshooting them.
    const position = (i + 0.5) / count;
    const scaled = position * segments;
    const index = Math.min(segments - 1, Math.floor(scaled));
    return toCss(mix(stops[index]!, stops[index + 1]!, scaled - index));
  });
}

export type GradientDirection = "vertical" | "horizontal" | "diagonal";

type SoftGradientProps = {
  colors: string[];
  direction?: GradientDirection;
  /** More bands for large fills, fewer for small ones. */
  bands?: number;
  style?: StyleProp<ViewStyle>;
  /** Set when painting into a rounded parent that does not clip. */
  radius?: number;
};

/**
 * A linear blend filling its parent. Absolutely positioned and non-interactive,
 * so it drops into any bounded container as a background layer:
 *
 *   <View style={{ borderRadius: 24, overflow: "hidden" }}>
 *     <SoftGradient colors={[a, b]} />
 *     …content…
 *   </View>
 */
export function SoftGradient({
  colors,
  direction = "vertical",
  bands = 18,
  style,
  radius,
}: SoftGradientProps) {
  const swatches = useMemo(() => sampleBands(colors, bands), [colors, bands]);

  // A diagonal blend is a horizontal one inside a rotated box. The box is
  // oversized so its corners still cover the parent once turned.
  const rotated = direction === "diagonal";

  return (
    <View
      pointerEvents="none"
      style={[
        { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, overflow: "hidden" },
        radius === undefined ? null : { borderRadius: radius },
        style,
      ]}
    >
      <View
        style={[
          {
            flexDirection: direction === "vertical" ? "column" : "row",
          },
          rotated
            ? {
                position: "absolute",
                left: "-35%",
                right: "-35%",
                top: "-35%",
                bottom: "-35%",
                transform: [{ rotate: "45deg" }],
              }
            : { flex: 1 },
        ]}
      >
        {swatches.map((color, i) => (
          <View key={i} style={{ flex: 1, backgroundColor: color }} />
        ))}
      </View>
    </View>
  );
}

type SoftRadialProps = {
  /** Outermost colour first, centre last. */
  colors: string[];
  /** Concentric layers. 10 is smooth enough for an orb. */
  rings?: number;
  /** How far in the innermost ring reaches, as a share of the half-size. */
  falloff?: number;
  style?: StyleProp<ViewStyle>;
};

/**
 * A radial glow: concentric circles painted outside-in, each interpolated from
 * `colors`. Used for the EVE orb and the bloom behind the centre nav button —
 * anywhere the light needs to fall off from a point rather than along an axis.
 *
 * Two notes for call sites. The parent has to be square for the rings to read
 * as circles; a wide box produces stacked ellipses, which is occasionally what
 * you want but never by accident. And because the rings are stacked rather than
 * blended, translucent colours compound — the centre of a 10-ring glow at 0.1
 * alpha is far more opaque than 0.1. Keep per-ring alpha low and let the
 * compounding do the work, which is also what keeps this restrained.
 *
 * Memoised because one caller — the particle field — sits inside a component
 * that re-renders at the microphone's meter rate, and this paints eight to ten
 * absolutely-positioned rings that never change while it does. Pass `colors` as
 * a stable reference (hoist the array or `useMemo` it) or the memo cannot hold:
 * a fresh literal each render compares unequal and re-renders anyway.
 */
export const SoftRadial = memo(function SoftRadial({
  colors,
  rings = 10,
  falloff = 0.9,
  style,
}: SoftRadialProps) {
  const swatches = useMemo(() => sampleBands(colors, rings), [colors, rings]);

  return (
    <View
      pointerEvents="none"
      style={[{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }, style]}
    >
      {swatches.map((color, i) => {
        // Ring 0 fills the box; each subsequent one insets toward the centre.
        const inset: DimensionValue = `${(i / rings) * 50 * falloff}%`;
        return (
          <View
            key={i}
            style={{
              position: "absolute",
              left: inset,
              right: inset,
              top: inset,
              bottom: inset,
              borderRadius: 9999,
              backgroundColor: color,
            }}
          />
        );
      })}
    </View>
  );
});

/**
 * The blends the design actually uses, named so screens ask for a role rather
 * than a colour list. Keeping them here means a palette change is one edit, and
 * it stops six screens from each inventing their own purple.
 *
 * `backdrop` is deliberately the faintest of these: it tints a whole page, and
 * the brief asks for gradients to stay low rather than excessive.
 */
export function gradientsFor(p: {
  ambient: string;
  ambientDeep: string;
  ambientTint: string;
  background: string;
  surface: string;
}) {
  return {
    /** Primary AI actions — the send button, the centre nav button. */
    action: [p.ambient, p.ambientDeep],
    /** The listening orb. Lavender through to a pink-leaning highlight. */
    orb: [p.ambientDeep, p.ambient, p.ambientTint],
    /** Page-level wash. Barely there by design. */
    backdrop: [p.background, p.surface],
  } as const;
}
