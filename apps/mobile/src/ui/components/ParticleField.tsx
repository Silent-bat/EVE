/**
 * The particle field — EVE's voice, made visible.
 *
 * A swirling cloud of motes carried by a curl-noise flow, drawn with a faked
 * depth of field. It drifts while she is idle, is thrown outward by the volume
 * of your voice while she listens, and pulses in time with her speech while she
 * talks.
 *
 * The previous version put every mote on a perfect circle. That is cheap, and it
 * reads as a necklace: concentric rings, visibly mechanical, every one of them
 * turning at the same rate. This one advects each mote through a divergence-free
 * velocity field instead, so the paths wander, braid, and eddy the way smoke
 * does, and no two are alike.
 *
 * ## How it still runs on the native driver
 *
 * Curl noise is not something the animation driver can evaluate — it cannot call
 * `Math.sin`, let alone integrate a flow. So none of it happens at frame time.
 * Each mote's streamline is integrated once, at build time, into a list of
 * points; at frame time a single shared `clock` walks 0→1 and `interpolate`
 * steps between those points. Thirty motes therefore cost one timer, and every
 * transform stays off the JS thread.
 *
 * A streamline does not return to where it began, so the clock's reset from 1
 * back to 0 would teleport the mote. Real particle systems answer this with a
 * lifetime: fade in on spawn, fade out on death, respawn elsewhere. So does this
 * one — the fade envelope reaches zero at both ends of the path, which is
 * exactly where the jump happens, and rolling each mote's phase keeps the
 * respawns from happening in unison.
 *
 * ## The fake depth of field
 *
 * Every mote gets a depth, which sets three things: its size (perspective), how
 * much of the cloud's movement it inherits (parallax), and its distance from the
 * focal plane. Anything off that plane is out of focus, and an out-of-focus
 * point of light is not a small hard dot but a wide soft disc — so those motes
 * render as a short stack of translucent circles instead of one opaque one.
 * That is the whole trick. No shader, no blur module, just the observation that
 * bokeh is a disc with a soft edge.
 *
 * Everything stops under reduce-motion. The field still draws — it just holds
 * still, so the screen keeps its shape and loses only the movement.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";

import { SoftRadial, withAlpha } from "../gradient";
import { radius } from "../theme";
import { useTheme } from "../ThemeContext";

export type FieldState = "idle" | "listening" | "thinking" | "speaking";

/**
 * Whether `expo-gl` is actually present in the running binary.
 *
 * The dependency is declared, but native code only exists in the app after the
 * dev client is rebuilt and reinstalled — until then `require` throws at runtime
 * on a device running the old APK. Resolved once, lazily, in a try/catch, so the
 * GL path is taken when it works and the View path when it doesn't. A static
 * `import` would not survive this: Metro resolves it at bundle time and the
 * throw would take the whole screen down rather than this one component.
 *
 * The consequence worth stating plainly: on the current APK this renders the old
 * field, and the frame cost measured in #39 stays until the rebuild lands.
 */
let glModule: typeof import("./ParticleFieldGL") | null | undefined;

function loadGL(): typeof import("./ParticleFieldGL") | null {
  if (glModule !== undefined) return glModule;
  try {
    require("expo-gl");
    glModule = require("./ParticleFieldGL") as typeof import("./ParticleFieldGL");
  } catch {
    glModule = null;
  }
  return glModule;
}

/**
 * Samples along one mote's life. This is the resolution of its curl path, so it
 * trades smoothness against the size of the interpolation tables handed to the
 * driver at mount. Much below 32 and the eddies visibly corner.
 */
const LIFE = 44;

/** Share of a life spent fading in, and again fading out. */
const BIRTH = 0.14;

/**
 * Decorative hues, deliberately not palette tokens — the field wants a pink and
 * a blue the rest of the product has no use for, and borrowing `danger` for pink
 * would mean a future change to the error colour silently restyles EVE.
 */
const HUES = ["#b9a0ff", "#ffa3d4", "#8fcdff", "#d9c8ff"] as const;

/** Seconds for one full life. Thinking is quick and tight; speaking is lively. */
const CYCLE_SECONDS: Record<FieldState, number> = {
  idle: 26,
  listening: 15,
  thinking: 7,
  speaking: 11,
};

/** How far amplitude throws the field outward, as a fraction of its radius. */
const SPREAD: Record<FieldState, number> = {
  idle: 0.04,
  listening: 0.3,
  thinking: 0.1,
  speaking: 0.22,
};

/**
 * Which depth is sharp. Sits just in front of the middle, so there is more haze
 * behind the focal plane than ahead of it — the same asymmetry a real lens has,
 * and the reason the cloud reads as having a front.
 */
const FOCAL = 0.62;

/** Bokeh layers on the most defocused mote. Each is a View, so this is a budget. */
const BOKEH = 3;

/**
 * The flow field, as a stream function.
 *
 * Taking the curl of a scalar potential gives a velocity field that is
 * divergence-free by construction — nothing piles up and nothing thins out, so
 * the cloud keeps an even density instead of draining into a few attractors.
 * Three sine lobes at rising frequencies stand in for noise: the coarse one sets
 * the big eddies, the fine ones roughen the paths.
 *
 * Amplitudes and step size are eyeball-tuned. What they buy, at the numbers
 * below, is roughly half a turn of the cloud per life with about the same again
 * in wander, which is the point at which the motion reads as swirling rather
 * than as either rotating or milling about.
 */
const LOBES = [
  { f: 1.7, a: 0.26, px: 0.0, py: 1.1 },
  { f: 2.9, a: 0.13, px: 2.2, py: 0.4 },
  { f: 4.6, a: 0.07, px: 1.3, py: 3.0 },
] as const;

/** Rotation under the noise. Without it the cloud wanders but never turns. */
const SWIRL = 1.7;

/** Integration step, in field radii. */
const STEP = 0.042;

/** Velocity at a point, as the curl of the stream function above. */
function flow(x: number, y: number): { x: number; y: number } {
  let vx = -SWIRL * y;
  let vy = SWIRL * x;

  for (const lobe of LOBES) {
    const k = lobe.a * lobe.f;
    // ∂ψ/∂y and −∂ψ/∂x for ψ = a·sin(f·x + px)·cos(f·y + py), taken
    // analytically rather than by finite difference — it is both exact and
    // cheaper than sampling the potential four times.
    vx -= k * Math.sin(lobe.f * x + lobe.px) * Math.sin(lobe.f * y + lobe.py);
    vy -= k * Math.cos(lobe.f * x + lobe.px) * Math.cos(lobe.f * y + lobe.py);
  }

  return { x: vx, y: vy };
}

/** One mote's whole life, integrated through the flow. Unit coordinates. */
function streamline(seedX: number, seedY: number): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  let x = seedX;
  let y = seedY;

  for (let i = 0; i < LIFE; i += 1) {
    points.push({ x, y });

    // Midpoint rather than Euler. At this step size a first-order integrator
    // drifts outward on every curve, and the cloud slowly inflates.
    const k1 = flow(x, y);
    const k2 = flow(x + k1.x * STEP * 0.5, y + k1.y * STEP * 0.5);
    x += k2.x * STEP;
    y += k2.y * STEP;

    const r = Math.hypot(x, y);
    if (r > 1) {
      // Eased back rather than clamped: a hard clamp parks motes on the
      // boundary and draws a visible rim around the cloud.
      const pull = (1 + (r - 1) * 0.4) / r;
      x *= pull;
      y *= pull;
    }
  }

  return points;
}

/** Clock positions of the samples. Shared — every mote is sampled the same way. */
const INPUT = Array.from({ length: LIFE + 1 }, (_unused, i) => i / LIFE);

/**
 * Fade in on birth, fade out on death. Zero at both ends, which is what makes
 * the wrap from the last sample back to the first invisible.
 */
const ENVELOPE = Array.from({ length: LIFE }, (_unused, i) => {
  const t = i / (LIFE - 1);
  if (t < BIRTH) return t / BIRTH;
  if (t > 1 - BIRTH) return (1 - t) / BIRTH;
  return 1;
});

/**
 * Rotate a per-sample table so its cycle starts at `by`, and repeat the first
 * entry at the end so it spans the clock's full 0→1.
 *
 * This is how thirty motes get thirty different lifetimes out of one shared
 * clock. Rolling the position table and the opacity table by the same amount
 * moves the seam — the one place the path jumps — to a different moment for
 * each mote, and lands it exactly where that mote's envelope is zero.
 */
function ring(values: number[], by: number): number[] {
  const n = values.length;
  return Array.from({ length: n + 1 }, (_unused, i) => values[(i + by) % n] ?? 0);
}

type Disc = { size: number; color: string };

type Spec = {
  seedX: number;
  seedY: number;
  /** Where in the shared clock this mote's life begins, as a sample index. */
  roll: number;
  /** Share of the flow it inherits. Near motes travel further than far ones. */
  parallax: number;
  /** The stack of circles that draws it — one if sharp, more if defocused. */
  discs: Disc[];
  /** Box the discs are centred in, sized to the widest of them. */
  box: number;
  /** Slight per-mote variation in how far amplitude pushes it out. */
  reach: number;
  /** Base opacity, before the lifetime envelope and the energy brightening. */
  alpha: number;
};

/**
 * A stable pseudo-random in 0–1. Deterministic on purpose: `Math.random` would
 * re-scatter the field on every Fast Refresh, and a layout that jumps whenever
 * the file is saved is impossible to tune by eye.
 */
function hash(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * The out-of-focus disc. A point of light away from the focal plane spreads
 * into a wide circle with a soft edge, so the further a mote is from focus the
 * more it becomes a stack of faint rings rather than one crisp dot.
 */
function bokeh(size: number, defocus: number, hue: string): { discs: Disc[]; box: number } {
  const layers = 1 + Math.round(defocus * (BOKEH - 1));
  const outer = size * (1 + defocus * 2.4);

  const discs = Array.from({ length: layers }, (_unused, i) => {
    const t = layers === 1 ? 1 : i / (layers - 1);
    return {
      // Widest first, so the smaller and denser ones land on top of it.
      size: outer + (size - outer) * t,
      color: withAlpha(hue, layers === 1 ? 1 : 0.3 + 0.55 * t),
    };
  });

  return { discs, box: outer };
}

function buildSpecs(count: number): Spec[] {
  return Array.from({ length: count }, (_unused, i) => {
    const a = hash(i + 1);
    const b = hash(i + 97);
    const c = hash(i + 211);
    const depth = hash(i + 373);

    // Golden angle for the seed bearing and for the lifetime phase: both spread
    // evenly at any count, so motes never spawn — or die — in visible batches.
    const bearing = i * 2.399963229728653;
    // Floored well off the centre. Swirl velocity goes to zero there, so a mote
    // seeded at the middle barely travels at all and just sits behind the core.
    // The exponent biases the rest inward, where the light is.
    const r = 0.2 + 0.75 * Math.pow(a, 0.62);

    const defocus = Math.abs(depth - FOCAL) / Math.max(FOCAL, 1 - FOCAL);
    // Perspective: nearer is larger. The same depth then dims it, because a
    // defocused mote spreads the same light over a wider disc.
    const size = (2.2 + 5.2 * b) * (0.6 + 0.85 * depth);
    const hue = HUES[i % HUES.length] ?? HUES[0];
    const { discs, box } = bokeh(size, defocus, hue);

    return {
      seedX: r * Math.cos(bearing),
      seedY: r * Math.sin(bearing),
      roll: Math.floor(((i * 0.618033988749895) % 1) * LIFE),
      parallax: 0.55 + 0.75 * depth,
      discs,
      box,
      reach: 0.7 + c * 0.6,
      alpha: (0.4 + 0.5 * b) * (1 - 0.45 * defocus),
    };
  });
}

/** Props are identical across both implementations, so the wrapper can hand them straight through. */
type FieldProps = {
  state?: FieldState;
  /**
   * Normalised amplitude, 0–1. While listening this is the microphone; while
   * speaking it is EVE's own output, measured from her PCM before it plays,
   * because expo-audio exposes no live output level and the mic is closed for
   * her whole turn. Callers switch between the two on `state` — see useSpeaker.
   */
  level?: number;
  size?: number;
  count?: number;
  /** Background immediately behind the field, used to hide Android's GL surface. */
  backdrop?: string;
};

/**
 * Picks an implementation. This has to be a component of its own rather than an
 * early return inside the View field, because choosing between two sets of hooks
 * inside one component is a hooks-order violation — it happened to survive while
 * the choice was fixed for the life of the process, and stops surviving the
 * moment a shader failure can flip it at runtime. Here each field owns its hooks
 * and switching is an ordinary unmount.
 */
export function ParticleField(props: FieldProps) {
  const { palette, reduceMotion } = useTheme();

  // The reference — curl-noise point sprites on the GPU — and the View field it
  // is replacing. Loaded lazily and only when the native module exists, so a
  // dev client that predates the rebuild renders exactly what it did before.
  const gl = useMemo(() => loadGL(), []);

  /* A shader that fails to compile or link throws inside onContextCreate, which
     the require-time try/catch cannot see. Without this the field would redbox
     on a driver that rejects the GLSL, which is a worse outcome than the frame
     cost the shader exists to remove. */
  const [glBroken, setGLBroken] = useState(false);
  const onFailure = useCallback(() => setGLBroken(true), []);

  if (gl && !glBroken) {
    return (
      <gl.ParticleFieldGL
        state={props.state}
        level={props.level}
        size={props.size}
        count={props.count}
        tint={palette.ambient}
        backdrop={props.backdrop ?? palette.background}
        reduceMotion={reduceMotion}
        onFailure={onFailure}
      />
    );
  }

  return <ParticleFieldViews {...props} />;
}

function ParticleFieldViews({ state = "idle", level = 0, size = 240, count = 30 }: FieldProps) {
  const { palette, scheme, reduceMotion } = useTheme();

  const clock = useRef(new Animated.Value(0)).current;
  const energy = useRef(new Animated.Value(0)).current;
  const specs = useMemo(() => buildSpecs(count), [count]);
  const half = size / 2;

  // One looping clock for the whole field. Restarted when the state changes so
  // the new speed takes effect; the reset to 0 is invisible because each mote
  // has been rolled to a different point in its own life.
  useEffect(() => {
    if (reduceMotion) return;
    clock.setValue(0);
    const loop = Animated.loop(
      Animated.timing(clock, {
        toValue: 1,
        duration: CYCLE_SECONDS[state] * 1000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [clock, state, reduceMotion]);

  // Amplitude → outward push. Spring rather than timing so a hard consonant
  // overshoots slightly and settles, the way a real cloud of dust would.
  useEffect(() => {
    if (reduceMotion) return;
    const animation = Animated.spring(energy, {
      toValue: Math.max(0, Math.min(1, level)),
      useNativeDriver: true,
      speed: 18,
      bounciness: 8,
    });
    animation.start();
    return () => animation.stop();
  }, [energy, level, reduceMotion]);

  // While EVE talks the field should move even though there's no output meter
  // to read. A steady pulse under the amplitude keeps her visibly speaking.
  useEffect(() => {
    if (reduceMotion || state !== "speaking") return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(energy, {
          toValue: 0.75,
          duration: 420,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(energy, {
          toValue: 0.25,
          duration: 520,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [energy, state, reduceMotion]);

  const spread = SPREAD[state];
  const halo = size * 0.16;

  // Ring counts scaled to the box. Both glows are smooth gradients faked by
  // stacking translucent circles, and every ring is another layer the GPU blends
  // on every frame — a real cost here, where RenderThread is the bottleneck. The
  // counts were tuned for the 220pt voice screen; on the 76pt dock the same rings
  // land less than a pixel apart, so most of them are paying full price to be
  // invisible. Below ~120pt, half of them read identically.
  const dense = size >= 120;
  const haloRings = dense ? 8 : 4;
  const coreRings = dense ? 6 : 3;

  // Memoised for the same reason `Mote` is: this component re-renders on every
  // microphone tick, and all three of these are inputs the driver or a child
  // caches on by identity. A fresh colour array each tick defeats `SoftRadial`'s
  // own memo and repaints eight rings; a fresh `interpolate` swaps out a live
  // native node for an identical one.
  const haloColors = useMemo(
    () => [withAlpha(palette.ambient, 0), withAlpha(palette.ambient, 0.12)],
    [palette.ambient],
  );
  const coreColors = useMemo(
    () => [withAlpha(palette.ambient, 0.5), withAlpha(palette.ambient, 0)],
    [palette.ambient],
  );
  const coreScale = useMemo(
    () => energy.interpolate({ inputRange: [0, 1], outputRange: [1, 1.28] }),
    [energy],
  );

  return (
    <View
      // Decorative. The screen around it announces what EVE is doing in text,
      // and a screen reader has no use for "a cloud of purple dots".
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[styles.root, { width: size, height: size }]}
    >
      {/* The glow the motes appear to be lit by. Outside the field and
          unmoving, so the cloud reads as illuminated rather than self-lit. */}
      <SoftRadial
        colors={haloColors}
        rings={haloRings}
        style={{ left: -halo, right: -halo, top: -halo, bottom: -halo }}
      />

      {/* The core. Small, bright, and the thing the cloud turns around.
          Rasterised for the same reason the motes are — it scales every frame
          and holds six stacked translucent rings that never change. */}
      <Animated.View
        renderToHardwareTextureAndroid
        shouldRasterizeIOS
        style={[
          styles.core,
          {
            width: size * 0.3,
            height: size * 0.3,
            backgroundColor: withAlpha(palette.ambient, scheme === "dark" ? 0.3 : 0.18),
            transform: [{ scale: coreScale }],
          },
        ]}
      >
        <SoftRadial colors={coreColors} rings={coreRings} />
      </Animated.View>

      {specs.map((spec, i) => (
        <Mote
          key={i}
          spec={spec}
          clock={clock}
          energy={energy}
          half={half}
          spread={spread}
          dark={scheme === "dark"}
        />
      ))}
    </View>
  );
}

/**
 * One mote.
 *
 * Its whole path is integrated once here and handed to the driver as a lookup
 * table. At frame time the only work is stepping between two of those points and
 * multiplying by `push`, which grows with amplitude — so loud speech throws the
 * cloud outward and quiet lets it fall back in. Multiplying an interpolated path
 * by a second animated value is what keeps this on the native driver;
 * recomputing coordinates in JS would not be.
 *
 * Memoised, and not as a micro-optimisation. `level` arrives from the microphone
 * meter every 90ms for as long as the mic is armed, which — the field being on
 * the always-listening dock — is most of the time the app is open. Every one of
 * those re-rendered all eighteen motes, and each rebuilt five `interpolate` and
 * `multiply` nodes, so ~90 native animated nodes were detached and reattached
 * eleven times a second while nothing about them had changed. `level` reaches the
 * motes through `energy`, an `Animated.Value` whose identity is stable, so none
 * of that work was ever needed: the driver already had the new amplitude. Its
 * props are all primitives or the memoised `spec`, so the default comparison is
 * the right one.
 */
const Mote = memo(function Mote({
  spec,
  clock,
  energy,
  half,
  spread,
  dark,
}: {
  spec: Spec;
  clock: Animated.Value;
  energy: Animated.Value;
  half: number;
  spread: number;
  dark: boolean;
}) {
  const path = useMemo(() => {
    const line = streamline(spec.seedX, spec.seedY);
    // Parallax is folded in at build time rather than applied per frame: it is
    // constant per mote, and the spawn point stays where it was seeded so the
    // cloud keeps the distribution it was given.
    const xs = line.map((p) => (spec.seedX + (p.x - spec.seedX) * spec.parallax) * half);
    const ys = line.map((p) => (spec.seedY + (p.y - spec.seedY) * spec.parallax) * half);
    return {
      x: ring(xs, spec.roll),
      y: ring(ys, spec.roll),
      life: ring(ENVELOPE, spec.roll),
    };
  }, [spec, half]);

  const push = energy.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1 + spread * spec.reach],
  });

  const translateX = Animated.multiply(
    clock.interpolate({ inputRange: INPUT, outputRange: path.x }),
    push,
  );
  const translateY = Animated.multiply(
    clock.interpolate({ inputRange: INPUT, outputRange: path.y }),
    push,
  );

  // Two things dim a mote, and they multiply: where it is in its life, and how
  // much energy the field carries. The first makes it appear and disappear, the
  // second makes the whole cloud visibly react.
  const opacity = Animated.multiply(
    clock.interpolate({ inputRange: INPUT, outputRange: path.life }),
    energy.interpolate({
      inputRange: [0, 1],
      outputRange: [spec.alpha * (dark ? 0.85 : 0.7), Math.min(1, spec.alpha * 1.55)],
    }),
  );

  return (
    <Animated.View
      pointerEvents="none"
      // Cache this mote as a GPU texture. It is the fix for the real cost of
      // this component, which is not JS: measured on device, RenderThread ran at
      // ~53% and the UI thread at ~35% with the field merely idling, while the JS
      // thread did not register. A mote is a stack of up to three overlapping
      // translucent anti-aliased circles, and eighteen of them put ~46 blended
      // layers on the screen — all of which the GPU re-rasterised and re-blended
      // every frame, because a view whose transform and opacity are animating
      // cannot be flattened away. Rasterised once instead, a frame becomes a
      // textured quad blit at a new offset and alpha.
      //
      // Sound here only because the content is static: the discs never change,
      // just where they sit and how bright they are. A layer whose pixels changed
      // per frame would be re-uploaded each time and this would cost more than it
      // saves. Memory is negligible — a mote's box is tens of pixels square.
      renderToHardwareTextureAndroid
      shouldRasterizeIOS
      style={[
        styles.mote,
        {
          width: spec.box,
          height: spec.box,
          opacity,
          transform: [{ translateX }, { translateY }],
        },
      ]}
    >
      {spec.discs.map((disc, i) => (
        <View
          key={i}
          style={{
            position: "absolute",
            left: (spec.box - disc.size) / 2,
            top: (spec.box - disc.size) / 2,
            width: disc.size,
            height: disc.size,
            borderRadius: disc.size / 2,
            backgroundColor: disc.color,
          }}
        />
      ))}
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  root: { alignItems: "center", justifyContent: "center" },
  core: { position: "absolute", borderRadius: radius.pill, overflow: "hidden" },
  mote: { position: "absolute" },
});
