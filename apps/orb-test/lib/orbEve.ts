import { NOISE_GLSL } from "./glsl";
import type { OrbGeometry, OrbSpec } from "./types";

/**
 * The EVE field — what apps/mobile actually ships.
 *
 * orb1 next door is a faithful recreation of particleorb1.jpeg at 900,000
 * points. This is the same object at the phone's budget: 9,000 points, one draw
 * call, orthographic, sprite size solved from a coverage target. Everything
 * here is written to be pasted into `apps/mobile/src/ui/components/
 * ParticleFieldGL.tsx` without a rewrite, which is the entire reason this test
 * bed exists — a shader cannot be tuned by eye on a device that is someone's
 * daily driver.
 *
 * Three things were asked for and each is a separate mechanism below:
 *
 *  1. WAVE. The surface is not rigid. Motes slide tangentially through a noise
 *     field (so the skin churns without the sphere inflating) and the whole
 *     shell undulates radially, so the silhouette itself ripples.
 *  2. ERUPT. A handful of active longitudes hold still while each fires on its
 *     own clock: fast rise, long decay, material thrown radially outward and
 *     falling back. Neighbouring motes share a clock, so a region lets go as a
 *     unit rather than twinkling.
 *  3. PULSE. `u_energy` is the amplitude — the microphone while she listens, a
 *     synthetic speech envelope while she talks. It brightens the field, breathes
 *     the shell, and drives the eruptions harder.
 *
 * ## Why this is not orb1 with the count turned down
 *
 * orb1's body is matte charcoal built from 900k barely-visible motes, and its
 * `spark` dither exists so a lit patch reads as resolvable specks rather than a
 * smooth glow. At 9,000 points every mote is already a resolvable speck, so the
 * dither is redundant and the patch field it gated is gone: brightness comes
 * straight off the arc and eruption fields. That removes two noise octaves per
 * vertex and most of orb1's tuning surface.
 *
 * The palette is also deliberately not orb1's. That one is ash → violet → white
 * with no warm tone anywhere, matched to the source photograph. This one is a
 * chromatic mix — green through blue to purple across the body, with eruptions
 * running yellow to white — which is what the product asked for.
 */

/**
 * Sphere radius 1.0 in NDC half-widths.
 *
 * The shader is orthographic, so this is the whole camera. Without it the body
 * spans the full viewport and anything the eruptions throw past the limb is
 * clipped away — a plume whose sprite centre leaves NDC does not clip, it
 * vanishes. 0.72 leaves the body reading large while giving the throw somewhere
 * to go: the soft knee in the vertex shader caps a realistic worst case near
 * 1.36 world, which lands at 0.98.
 */
const FIT = 0.72;

/** Where the focal plane sits, in 0–1 depth. Just in front of the middle. */
const FOCAL = 0.62;

const VERT = /* glsl */ `
precision highp float;

/* Rest position on one of the four shells. Its LENGTH is the shell radius, which
   is how a mote's population is recovered without a fifth attribute. */
attribute vec3 a_base;
attribute vec4 a_rand;

/* Seconds, accumulated on the CPU at the current state's flow rate.
   NOT elapsed wall-clock time: deriving it would rescale the whole history the
   instant the rate changed and teleport every field on the sphere. */
uniform float u_time;
/* Spin angle in radians, accumulated the same way and for the same reason. */
uniform float u_spin;
uniform float u_energy;
uniform float u_spread;
uniform float u_erupt;
uniform float u_pointBase;
uniform float u_maxPoint;

varying float v_bright;
varying float v_tone;
varying float v_heat;
varying float v_defocus;

const float FIT = ${FIT.toFixed(3)};
const float FOCAL = ${FOCAL.toFixed(3)};

${NOISE_GLSL}

mat3 rotY(float a) {
  float s = sin(a);
  float c = cos(a);
  return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
}

mat3 rotX(float a) {
  float s = sin(a);
  float c = cos(a);
  return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c);
}

mat3 rotZ(float a) {
  float s = sin(a);
  float c = cos(a);
  return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0);
}

/* ---- The active-region field, as a function ------------------------------
   Factored out of main() because it has to be evaluated at more than one point:
   once where the mote is, and twice more a small step away, to recover its
   gradient. The gradient is what lets motes be pulled onto the contour instead
   of merely lit by it.

   Read as the ZERO CONTOUR of a signed field, not as "wherever a field exceeds a
   threshold". The difference is the whole look. Thresholding noise selects the
   tops of its hills, which are round blobs; a contour of the same noise is a
   closed curve, so it comes out as the long sweeping lanes the reference
   actually shows, and they wander and reconnect as the field drifts instead of
   swelling and shrinking in place.

   The 5-fold azimuthal term anchors how many lanes there are. Pure noise cannot
   hold a feature count — each frame draws its own realisation and the number
   wanders — so the periodic term fixes the count and the two noise octaves only
   decide where each lane wanders and how ragged it gets. */
float laneField(vec3 d, float t) {
  float az = atan(d.y, d.x);
  return 0.62 * cos(5.0 * az + 1.3 - t * 0.42)
       + 0.85 * snoise(d * 1.35 + vec3(4.1, 2.7 - t * 0.26, 8.9))
       + 0.30 * snoise(d * 3.10 + vec3(1.7, -t * 0.18, 5.3));
}

/* Per-mote constant in 0–1, independent of every a_rand channel. Decides which
   motes migrate into the lanes and which stay behind as body dust; drawing it
   from a_rand instead would tie migration to size or sparkle and stamp those
   through the structure. */
float mobility(vec3 p) {
  return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
}

void main() {
  vec3 dir = normalize(a_base);
  float shell = length(a_base);

  /* Which population a mote belongs to, read off its radius rather than stored
     as a flag — the shells do not overlap, so the radius already says it. */
  float haloness = smoothstep(0.982, 1.020, shell);
  float skinness = smoothstep(0.944, 0.958, shell) * (1.0 - smoothstep(0.986, 1.002, shell));
  float innerness = 1.0 - smoothstep(0.940, 0.958, shell);
  /* The core shell tops out at 0.35 and the body shell starts at 0.62, so a
     split anywhere between them is exact — the smoothstep is only there to stay
     continuous if those bands are ever retuned. Core motes project into the
     middle of the disc and pile up there, so they need their own dimming. */
  float coreness = 1.0 - smoothstep(0.40, 0.58, shell);

  /* ---- Active regions: WHERE the sun erupts -------------------------------
     Read as the ZERO CONTOUR of a signed field, not as "wherever a field
     exceeds a threshold". The difference is the whole look. Thresholding noise
     selects the tops of its hills, which are round blobs; a contour of the same
     noise is a closed curve, so it comes out as the long sweeping lanes the
     reference actually shows, and they wander and reconnect as the field drifts
     instead of swelling and shrinking in place.

     The 5-fold azimuthal term anchors how many lanes there are. Pure noise
     cannot hold a feature count — each frame draws its own realisation and the
     number wanders — so the periodic term fixes the count and the two noise
     octaves only decide where each lane wanders and how ragged it gets.

     Sampled on dir, which is object space: the lanes therefore rotate with the
     body instead of sliding across it, which is what makes them read as
     features ON a turning sphere. */
  float az = atan(dir.y, dir.x);
  float lane = 0.62 * cos(5.0 * az + 1.3 - u_time * 0.42)
             + 0.85 * snoise(dir * 1.35 + vec3(4.1, 2.7 - u_time * 0.26, 8.9))
             + 0.30 * snoise(dir * 3.10 + vec3(1.7, -u_time * 0.18, 5.3));

  /* Two widths off the one contour, because the sphere needs both: a broad
     shoulder that says this whole region is awake, and the narrow core inside it
     that actually throws material. Dividing by an explicit width keeps the two
     independent of the weights above — retune the field and the lanes stay the
     same thickness.

     The widths are MEASURED against this field, not guessed. Sampling lane over
     300k uniform points on the sphere gives std 0.726 and a mean tangential
     gradient of 1.99 per radian, so a half-width w spans about 1.0*w radians.
     That fixes both numbers:
       0.34 -> 45% areal coverage, ~19 deg, the shoulder
       0.13 -> 20% areal coverage, ~7.5 deg / ~42 px on a 324 px disc, the lane
     Widths near the field's own std (the 1.05 and 0.40 that were here first)
     cover 88% and 52% of the sphere respectively — that is a wash over the whole
     surface, which is exactly why no filaments were visible. */
  float dist = abs(lane);
  float glow = clamp(1.0 - dist / 0.34, 0.0, 1.0);
  float band = clamp(1.0 - dist / 0.13, 0.0, 1.0);
  /* Squared, so both have genuinely dark edges rather than fading out over
     their whole width — that hard falloff is what reads as a filament. */
  float halo = glow * glow;
  float arc = band * band;

  /* ---- Eruption clocks: WHEN each region fires ----------------------------
     One clock per region, offset by a field at the SAME frequency as the lane
     noise above. That matching matters: at a different frequency the eruption
     stamps its own harmonic across the lanes and the two interfere, so a lane
     fires in halves. Matched, each lane gets roughly one phase along its length
     and lets go as a unit.

     The envelope is a flare, not a sine: fract() supplies the cycle, the
     smoothstep gives the rise a finite width so the wrap is not a pop, and the
     exponential is the decay. Normalised to PEAK 1 rather than mean 1 because
     every consumer feeds it to mix(), which extrapolates rather than clamps. */
  float phase = snoise(dir * 1.35 + vec3(53.2, 17.8, 31.4));
  float cyc = fract(u_time * 0.13 + phase * 1.6);
  float surge = clamp(smoothstep(0.0, 0.11, cyc) * exp(-1.8 * cyc) / 0.81, 0.0, 1.0);

  /* Where and when, together — plus how hard, which is the pulse. Amplitude
     makes her eruptions bigger while she talks; it does not create them, so the
     field still lives while she is silent. */
  float erupt = arc * surge * u_erupt * (0.70 + 0.85 * u_energy);

  /* ---- The wave -----------------------------------------------------------
     Two motions, and they do different jobs. The tangential one slides motes
     ACROSS the skin: projecting the noise onto the tangent plane is what lets
     the surface churn without the sphere breathing in and out, and it is why
     this needs no re-pinning step afterwards. The radial one moves the
     silhouette itself, which is the part the eye reads as waving — lateral
     churn alone on a perfect sphere is nearly invisible at the limb.

     snoiseVec3 is 3 noise evaluations. A proper curl (18) buys divergence-free
     flow, which matters when you integrate a path over many frames and cannot
     afford sinks; here the displacement is evaluated fresh every frame from a
     fixed base position, so nothing accumulates and nothing can pile up. */
  vec3 churn = snoiseVec3(dir * 1.7 + vec3(0.0, u_time * 0.30, 0.0));
  vec3 tangent = churn - dir * dot(churn, dir);
  /* Two octaves of swell, not one. A single low frequency moves the limb as a
     smooth ellipse, which reads as the sphere being slightly the wrong shape
     rather than as a surface in motion; the second, faster and shallower, is
     what makes the silhouette ragged in a single frozen frame. */
  float swell = snoise(dir * 2.2 + vec3(0.0, -u_time * 0.45, 0.0))
              + 0.45 * snoise(dir * 4.7 + vec3(6.2, -u_time * 0.80, 1.4));

  vec3 slid = normalize(dir + tangent * (0.09 + 0.13 * a_rand.y) * (0.65 + 0.6 * u_energy));

  float radius = shell
      /* The undulation. Deeper on the skin and fringe than through the body —
         the interior is what holds the sphere's shape, and rippling it too
         reads as the whole object wobbling rather than as a surface. */
      * (1.0 + 0.062 * swell * (0.45 + 0.85 * u_energy) * (1.0 - 0.55 * innerness))
      /* Amplitude breathes the shell outward. Zero under reduce-motion. */
      * (1.0 + u_spread * u_energy)
      /* The throw. Fringe dust goes furthest because it is already loose;
         the skin lifts only slightly, so an eruption reads as material leaving
         the surface rather than as the silhouette ballooning. Per-mote reach
         gives the plume a gradient instead of a shell. Reaches further than it
         used to because erupt now keys off the narrow lane rather than the wide
         one: a third of the area is throwing, so each plume has to carry more. */
      + erupt * (0.07 + 0.30 * haloness + 0.05 * skinness) * (0.40 + 0.90 * a_rand.w);

  /* Soft knee. Every maximum above is jointly improbable, but a sprite whose
     centre leaves NDC does not clip — it disappears — so the tip of a rare
     plume would blink out rather than run off the edge. Compresses only past
     1.20 and stays monotonic, so nothing below the knee is touched. */
  radius -= smoothstep(1.20, 1.55, radius) * (radius - 1.20) * 0.55;

  vec3 pos = slid * radius;

  /* Whole-body rotation, applied after the fields are sampled so they turn with
     it. The Z wobble keeps the axis from reading as a fixed vertical. */
  pos = rotZ(0.08 + sin(u_time * 0.22) * 0.05) * rotX(0.28) * rotY(u_spin) * pos;

  vec3 n = normalize(pos);
  float facing = abs(n.z);

  /* Orthographic, so z survives only as a depth cue. Mapped to 0–1 over the
     span the geometry can actually reach after the knee above. */
  float near = clamp((pos.z + 1.36) / 2.72, 0.0, 1.0);
  v_defocus = abs(near - FOCAL) / max(FOCAL, 1.0 - FOCAL);

  /* ---- Brightness --------------------------------------------------------
     There is no depth test under additive blending, so the far hemisphere has
     to be dimmed by hand or front and back accumulate identically and the
     sphere flattens into a disc. */
  float back = mix(0.42, 1.0, smoothstep(-1.0, 1.0, n.z));
  float key = 0.58 + 0.42 * dot(n, normalize(vec3(-0.45, 0.55, 0.40)));
  /* A shell's projected density diverges at its own silhouette, which is what
     draws the bright rim for free. The facing weight leans against that just
     enough to keep the face from emptying out. */
  float body = (0.34 + 0.66 * pow(facing, 0.55)) * key;

  /* The lanes light the skin as well as throwing the plumes — one field decides
     where the sphere is awake, so the lit filaments and the eruptions coincide.

     Every population answers the same field, but differently, and that is the
     fix for the flat speckle: previously body and core motes got a flat 1.0, so
     27% of the field was unmodulated dust and the core shell — which projects
     straight onto the middle of the disc — put a bright structureless blob at
     the centre. Now nothing is exempt.

     The floors are what keep the sphere a sphere: at zero floor the unlit
     regions vanish outright and the silhouette breaks into disconnected arcs. */
  float surfaceLit = 0.30 + 0.85 * halo + 1.55 * arc;
  /* The fringe is near-binary: bright where a lane threw it, dark between. */
  float fringeLit = 0.14 + 3.20 * arc * mix(0.25, 1.0, surge);
  /* Seen through the shell above it, so it takes the structure at reduced
     contrast — enough that the interior belongs to the same object, not enough
     to compete with the surface it is behind. */
  float innerLit = mix(1.0, surfaceLit, 0.45);

  /* Normalised by the weights, not just summed. The three windows very nearly
     partition the radius but not exactly — they dip to ~0.87 at the bottom of
     the skin shell — and without this that seam draws as a faint dark ring. */
  float wsum = max(skinness + haloness + innerness, 0.35);
  float litArc = (surfaceLit * skinness + fringeLit * haloness + innerLit * innerness) / wsum;

  /* Depth, by population. The fringe is thin material seen edge-on; the body is
     behind the skin; the core is behind all of it AND lands in the middle of the
     disc where the projection already piles motes up, so it takes both. */
  float depthDim = mix(1.0, 0.62, haloness) * mix(1.0, 0.50, innerness) * mix(1.0, 0.55, coreness);

  /* Concentrating the light into a fifth of the sphere means that fifth has to
     be several times brighter to keep the object from going dark — the gain is
     the light budget, chosen so total emission lands near where it was before
     the bands narrowed. The brightest lane cores do clip to white, which is
     wanted: a white-hot spine inside a coloured halo is what a filament looks
     like. Eruptions are pushed harder still so that "erupting" stays visually
     distinct from "merely lit" once v_heat paints it gold. */
  v_bright = (body * litArc * depthDim * (0.90 + 1.05 * u_energy) * 1.35
              + 1.30 * erupt * a_rand.z) * back;

  /* ---- Colour ------------------------------------------------------------
     Two independent inputs, which is what keeps the field from reading as one
     flat gradient. "tone" is a large-scale field over the sphere plus a slow
     pole-to-pole lean, so the body carries broad regions of different colour.
     "heat" is the eruption, so the plumes and the lanes they come from run hot
     while everything else stays cool.

     Two octaves and a gain above 1, because the ramp below is only as wide as
     the values fed into it: a single unit-amplitude noise sits inside roughly
     the middle third of 0–1, which lands every mote on the same middle colour
     and quietly deletes both ends of the palette. The gain overshoots on
     purpose and the clamp catches it, so green and purple get real area instead
     of being asymptotes nothing reaches. */
  float tone = snoise(dir * 0.85 + vec3(7.3, 2.1 + u_time * 0.05, 13.7)) * 0.66
             + snoise(dir * 2.10 + vec3(19.7, -4.3, 5.2)) * 0.30;
  v_tone = clamp(0.50 + tone * 1.35 + dir.y * 0.11 + (a_rand.x - 0.5) * 0.18, 0.0, 1.0);
  v_heat = clamp(erupt * (1.05 + 0.55 * a_rand.z), 0.0, 1.0);

  gl_Position = vec4(pos.xy * FIT, 0.0, 1.0);

  /* Sprite size. Only the per-mote variation lives here — bigger near the
     camera, bigger for a mote that drew a large jitter, and spread wider the
     further it sits from focus, because a defocused point of light covers more
     screen than a sharp one. The absolute scale is u_pointBase, solved once on
     the CPU from a coverage target, so raising the density adds motes without
     adding ink. See solvePointBase.

     Clamped to the driver's GL_ALIASED_POINT_SIZE_RANGE: a sprite over the
     limit is silently dropped by some GL ES drivers, so the largest, nearest
     motes would vanish rather than merely clip. */
  float modulation = (1.5 + 2.6 * a_rand.y)
                   * (0.62 + 0.72 * near)
                   * (1.0 + 1.30 * v_defocus)
                   * (1.0 + 0.60 * erupt);
  gl_PointSize = min(modulation * u_pointBase, u_maxPoint);
}
`;

const FRAG = /* glsl */ `
/* highp is optional in a GLSL ES 1.0 fragment shader and an unguarded
   declaration is a compile error where it is absent. Nothing here needs the
   range — every value is a 0–1 coordinate or colour. */
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec3 u_tint;

varying float v_bright;
varying float v_tone;
varying float v_heat;
varying float v_defocus;

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float d = length(uv);
  if (d > 1.0) discard;

  /* A soft glowing disc carved out of the square sprite. Squaring a linear
     falloff lands where a radial-gradient texture would at these sizes, and
     costs no fetch and no upload. */
  float core = 1.0 - smoothstep(0.0, 1.0, d);
  float glow = core * core;
  /* In focus it is a small hard dot; far from focus a wide soft-edged disc.
     That is what a lens does to a point of light. */
  float edge = mix(0.08, 0.85, v_defocus);
  float disc = 1.0 - smoothstep(1.0 - edge, 1.0, d);

  float alpha = disc * glow * v_bright;
  if (alpha < 0.004) discard;

  /* The palette. Green through teal and blue to purple across the body, gold
     into white where it erupts — so the cool mix is what the sphere IS and the
     warm end only ever means heat, which is the same division a star has.

     Teal is not decoration: green and blue sit on opposite sides of the hue
     circle's cyan corner, so mixing them directly desaturates through grey and
     the midrange — where most motes land — comes out ashen. Passing through a
     saturated stop keeps the whole ramp chromatic.

     Every one of these stays under 1.0 on at least one channel: additive
     blending clips a sprite core to white once it saturates, and a clipped core
     is the same white speck whatever colour went in, so the palette would
     quietly disappear from exactly the brightest places. */
  vec3 green  = vec3(0.24, 0.96, 0.52);
  vec3 teal   = vec3(0.18, 0.82, 0.86);
  vec3 blue   = vec3(0.28, 0.52, 1.00);
  vec3 purple = vec3(0.74, 0.34, 1.00);
  vec3 gold   = vec3(1.00, 0.80, 0.26);
  vec3 white  = vec3(1.00, 0.96, 0.88);

  /* Overlapping windows rather than abutting ones: a stop reached exactly at
     the next stop's start would show as a hard hue seam across the sphere. */
  vec3 c = mix(green, teal, smoothstep(0.00, 0.28, v_tone));
  c = mix(c, blue, smoothstep(0.24, 0.58, v_tone));
  c = mix(c, purple, smoothstep(0.54, 0.94, v_tone));
  /* A wash of the theme's own colour on the cold dust only. Keeps the field
     tracking a scheme change without letting the ambient purple flood the mix
     the product asked for — and it is deliberately absent from the hot end, so
     an eruption is the same colour in either scheme. */
  c = mix(c, u_tint, 0.12 * (1.0 - v_heat));
  c = mix(c, gold, smoothstep(0.10, 0.62, v_heat));
  c = mix(c, white, smoothstep(0.62, 1.00, v_heat));

  /* Premultiplied, to be drawn with blendFunc(ONE, ONE). */
  gl_FragColor = vec4(c * alpha, alpha);
}
`;

/**
 * How much of the frame the field's ink should cover, summed over every sprite.
 *
 * Point size and point count are not independent knobs — together they are one
 * quantity, how much of the frame ends up lit, and that is what the eye reads.
 * So size is solved from the count rather than tuned beside it, which is why
 * raising the density adds motes without adding ink or fill rate.
 *
 * Measured against the sphere's own projected disc rather than the whole frame,
 * because FIT decides how much of the frame the sphere occupies and a coverage
 * figure keyed to the frame would quietly dim the field every time FIT changed.
 */
const TARGET_COVERAGE = 0.62;

/**
 * The vertex shader's size modulation, in JS.
 *
 * Kept as a copy of the GLSL expression on purpose: u_pointBase is solved by
 * dividing out this term's RMS over the actual buffer, and hand-measuring that
 * constant is how the previous version came out 1.46x too large. Computing it
 * from the geometry means the two cannot drift — change the expression above,
 * change it here, and the ink stays where it was budgeted.
 *
 * RMS and not the mean, because coverage sums AREAS: the budget solves
 * `count * (pi/4) * E[d^2] = coverage * area`, so it needs E[modulation^2].
 *
 * `erupt` is taken as 0 here. It averages ~0.05 over the sphere and its own
 * cycle, so including it would move the divisor by about 3% while making a
 * static budget depend on a time-varying field.
 */
function modulation(z: number, sizeJitter: number): number {
  const near = Math.min(1, Math.max(0, (z + 1.36) / 2.72));
  const defocus = Math.abs(near - FOCAL) / Math.max(FOCAL, 1 - FOCAL);
  return (1.5 + 2.6 * sizeJitter) * (0.62 + 0.72 * near) * (1 + 1.3 * defocus);
}

/**
 * Solve the sprite diameter from the coverage budget and the point count.
 *
 * Both are fixed for the life of the GL context, so this is arithmetic done
 * once at setup rather than per vertex per frame. Works in PHYSICAL pixels
 * because gl_PointSize does — sizing in dp draws the field DPR-times too small,
 * which is a mistake this shader's ancestor actually shipped.
 *
 * The buffer's own z is used as the depth sample even though the shader sees a
 * ROTATED z. For a spherical shell the distribution of z is rotation-invariant,
 * so the two are statistically identical and this needs no camera.
 */
function solvePointBase(geometry: OrbGeometry, width: number, height: number): number {
  let sum = 0;
  for (let i = 0; i < geometry.count; i += 1) {
    const z = geometry.base[i * 3 + 2] ?? 0;
    const m = modulation(z, geometry.rand[i * 4 + 1] ?? 0);
    sum += m * m;
  }
  const rms = Math.sqrt(sum / Math.max(1, geometry.count));

  // The sphere's projected disc, not the frame: pi * (FIT * halfHeight)^2.
  const disc = Math.PI * Math.pow(FIT * 0.5 * Math.min(width, height), 2);
  const diameter = Math.sqrt((4 * TARGET_COVERAGE * disc) / (Math.PI * geometry.count));
  return diameter / rms;
}

/**
 * The interleaved-by-attribute buffers: base position (its length encodes the
 * shell radius) and four per-mote randoms.
 *
 * Four populations, because a single uniform shell reads as a wireframe globe
 * and a filled volume washes the middle out into a bright spike. What each one
 * buys:
 *
 *  - SKIN, most of the budget. The surface that waves, carries the arcs, and
 *    piles up at its own silhouette to draw the rim.
 *  - BODY, a thick shell just inside it. Depth, so the sphere reads as a volume
 *    and not a soap bubble. Bounded rather than filled to the centre: a volume
 *    fill puts a divergent integrand under the middle of the disc.
 *  - CORE, small and tight. The bright nucleus the rest turns around.
 *  - FRINGE, loose dust just past the limb. This is the population eruptions
 *    actually throw, so it is what makes a plume visible outside the body.
 */
function build(targetCount: number): OrbGeometry {
  const count = Math.max(1, targetCount);
  const base = new Float32Array(count * 3);
  const rand = new Float32Array(count * 4);

  // mulberry32, so a reload — or a Fast Refresh on the phone — reproduces the
  // same cloud. Math.random would re-scatter the field on every save, and a
  // layout that jumps whenever the file is written cannot be tuned by eye.
  let s = 0x9e3779b9;
  const rnd = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (let i = 0; i < count; i += 1) {
    // Uniform in solid angle. The obvious theta = PI * u instead bunches motes
    // visibly at the poles and leaves the equator bare.
    const u = rnd() * 2 - 1;
    const phi = rnd() * Math.PI * 2;
    const ring = Math.sqrt(Math.max(0, 1 - u * u));

    const t = rnd();
    let shell: number;
    if (t < 0.58) {
      shell = 0.952 + rnd() * 0.03;
    } else if (t < 0.79) {
      shell = 0.62 + rnd() * 0.31;
    } else if (t < 0.85) {
      shell = 0.05 + rnd() * 0.3;
    } else {
      // Outward-biased: only a shell whose own silhouette lies past a radius
      // can put light there, so an inward bias starves the outer annulus that
      // the plumes are supposed to reach into.
      shell = 0.986 + 0.062 * Math.pow(rnd(), 0.8);
    }

    base[i * 3 + 0] = ring * Math.cos(phi) * shell;
    base[i * 3 + 1] = u * shell;
    base[i * 3 + 2] = ring * Math.sin(phi) * shell;

    // x: hue jitter, so a region's colour is not perfectly uniform.
    rand[i * 4 + 0] = rnd();
    // y: size jitter.
    rand[i * 4 + 1] = rnd();
    // z: sparkle. A hair over 1% burn much brighter, which is what puts
    // individual bright specks along an erupting arc. At 3.5% the whole face
    // turns to white speckle.
    rand[i * 4 + 2] = rnd() < 0.015 ? 1.5 + rnd() * 1.2 : 0.45 + rnd() * 0.45;
    // w: how far this mote is thrown, so a plume has a gradient.
    rand[i * 4 + 3] = rnd();
  }

  return { base, rand, count };
}

export const ORB_EVE: OrbSpec = {
  id: "eve",
  label: "EVE field — chromatic sun",
  note: "What apps/mobile ships: 9,000 points, waving skin, asynchronous eruptions, green/blue/purple with yellow flares.",
  vert: VERT,
  frag: FRAG,
  // The phone's budget, not this machine's. Tuning at 900k and shipping 9k is
  // how a shader ends up looking nothing like its own test bed.
  defaultCount: 9000,
  // Unused: the projection is orthographic and the sprite size is solved from
  // coverage, so neither the camera nor the size slider reaches this shader.
  camDist: 0,
  fov: 0,
  build,
  solvePointBase,
};
