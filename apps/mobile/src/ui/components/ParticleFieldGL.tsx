/**
 * The particle field — a sphere of points rendered as GPU point sprites.
 *
 * The View-based field next door is faithful in intent and wrong in layer. It
 * spends its frame budget compositing: eighteen motes, each a stack of up to
 * three translucent circles, is ~46 blended layers the GPU re-rasterises every
 * frame, which measured at 27ms/frame on the test device against a 16.7ms budget
 * at 60Hz. Nothing above the renderer fixes that — memoisation and hardware-layer
 * caching were both tried and moved the number not at all — because the cost is
 * the compositing itself.
 *
 * This draws the whole field as `gl.POINTS` in a single draw call. Every point is
 * one vertex; the fragment shader turns it into a soft glowing disc. The three
 * things the old field faked with stacked Views — the disc, its soft edge, and
 * the bokeh of a defocused point — are what a fragment shader does natively.
 *
 * ## Where the motion lives
 *
 * On the GPU, and as displacement fields rather than a flow. Points are placed
 * once on a sphere shell and the vertex shader moves them as pure functions of
 * the clock: the body spins, its surface heaves and slides, and regions of it
 * erupt outward in flares. Nothing is born, dies, or integrates — which is both
 * cheaper than the curl-noise advection this replaces and the reason the sphere
 * holds its shape instead of dissolving. See VERTEX for the three motions.
 *
 * The behaviour is adapted from `apps/orb-test/lib/orb1.ts`, a shader matched
 * quantitatively against `assets/particleorb1.jpeg`, cut down from its ~36
 * simplex samples per vertex to five for a mid-range phone GPU.
 *
 * Placement and the sprite itself come from a Three.js reference (9000 points,
 * `THREE.Points` with an additive CanvasTexture sprite, `mesh.rotation.y` per
 * frame). Three.js itself cannot run here — it needs a DOM canvas and a browser
 * WebGL context, neither of which exists under React Native — so the placement
 * and rotation were ported onto expo-gl directly. No new dependency: expo-gl was
 * already installed.
 *
 * ## Why it is safe to land before the dev client is rebuilt
 *
 * `expo-gl` ships native code. Until the dev client is rebuilt and reinstalled
 * the module is simply absent from the running app, so this file must never be
 * the thing that decides whether the app boots. `ParticleField` resolves it
 * through a `require` in a try/catch and falls back to the View field when it
 * throws — see `hasGL()` there. Nothing here is imported at module scope by
 * anything that runs before that check.
 */
import { useEffect, useMemo, useRef } from "react";
import { PixelRatio, View } from "react-native";

import { GLView, type ExpoWebGLRenderingContext } from "expo-gl";

import type { FieldState } from "./ParticleField";

/**
 * Vertex shader.
 *
 * Each vertex arrives as its fixed position on the sphere shell plus per-point
 * jitter. The shader spins the body, waves its surface, and erupts material off
 * it — all as functions of the clock, so the buffer is uploaded once at mount
 * and never touched again.
 *
 * ## The three motions, and why they are fields rather than integration
 *
 * Nothing here accumulates. A mote's position is a pure function of its base
 * position and the time, which is what keeps the sphere a sphere: an advection
 * loop integrates, so any bias in the flow compounds and the body slowly
 * dissolves or piles up. A displacement field cannot drift — every mote
 * oscillates about the place it was seeded.
 *
 *  - SPIN. `rotY(u_time)` turns the whole body, plus a fixed tilt and a slow Z
 *    wobble. This is the only rigid motion, and the slowest, so it reads as the
 *    object turning rather than as anything happening on it.
 *  - WAVE. A radial heave and a two-component tangential slide, both sampled on
 *    the mote's direction so neighbours move together and the surface undulates
 *    as a sheet instead of fizzing per-point.
 *  - ERUPTION. Longitudinal arcs decide WHERE material is active; a per-region
 *    flare envelope decides WHEN it fires. Where the two coincide, dust is
 *    thrown outward, brightened, and driven up the palette into the hot end.
 *
 * Fields are sampled in OBJECT space, before the spin, so the arcs and the wave
 * are attached to the body and turn with it. Sampling after the rotation would
 * hold the pattern still in screen space and the sphere would appear to slide
 * underneath its own features.
 *
 * ## Cost
 *
 * Five simplex samples per vertex — at 9000 points that is 45k, which is
 * nothing next to the fill rate this field already pays. The reference this is
 * adapted from (apps/orb-test/lib/orb1.ts, matched quantitatively against
 * assets/particleorb1.jpeg) spends 36 samples per vertex on two octaves of curl
 * noise, affordable at 900k points on a desktop GPU and not here. The
 * substitutions: a tangential slide instead of divergence-free curl, since on a
 * shell the only thing curl buys over a plain tangential field is that motes do
 * not pile into sinks, and a displacement field has no sinks; and one heave
 * octave instead of two.
 */
const VERTEX = `
precision highp float;

attribute vec3 a_pos;
attribute float a_size;
attribute float a_spark;
attribute float a_rand;

uniform float u_time;
uniform float u_clock;
uniform float u_energy;
uniform float u_spread;
uniform float u_flare;
uniform float u_maxPoint;
uniform float u_pointBase;

/* How much of NDC the sphere is allowed to fill, per axis.

   Two jobs in one uniform. A point sprite whose CENTRE leaves the clip volume
   does not clip — it vanishes whole — so writing p.xy straight into NDC deleted
   the limb, and deleted more of it the louder EVE spoke (measured: 4.5% of
   points at idle, 46% while speaking). And because it is a vec2 solved on the
   CPU from the drawing buffer, it also carries the aspect correction the old
   bare vec4(p.xy, ...) never had: the sphere was only round because both call
   sites happen to pass a square size. See solveFit. */
uniform vec2 u_fit;

varying float v_defocus;
varying float v_alpha;
varying float v_hue;
varying float v_heat;

const float TILT = 0.28;
const float WOBBLE = 0.04;
const float FOCAL = 0.62;

/* Wave amplitudes, as a fraction of the shell radius.

   The heave is deliberately small: it has to move the silhouette, which is the
   part the eye reads as waving, but the skin shell is only 3% thick and a heave
   much past 0.07 lets its near face swap places with its far face, at which
   point the body stops reading as solid. The slide is allowed to be larger
   because it moves motes ACROSS the surface, where it cannot break the
   silhouette at all. */
const float HEAVE = 0.062;
const float SLIDE = 0.09;

/* How far an erupting region throws its dust. This is the one term that leaves
   the shell, so it is what makes the outline ragged during a flare rather than
   merely brighter. Scaled per population below — loose fringe dust goes
   furthest, the skin barely lifts — so that an eruption reads as material
   leaving the surface rather than as the whole silhouette ballooning. */
const float THROW = 0.30;

/* How much larger a fully-lit flare mote draws.

   This is the one term that spends above the coverage budget TARGET_COVERAGE
   solves for, and it does so on purpose: an eruption is more light, not the
   same light rearranged. The excursion is bounded and small in aggregate
   because v_heat is the product of a lane window and a flare envelope, so only
   a few percent of motes carry a high value at any instant. Resting coverage —
   what the modulation RMS is measured against — is untouched, since v_heat is
   zero wherever nothing is erupting.

   It also has to ride OUTSIDE the calibrated modulation term rather than
   inside it, because that term is replayed in JS to measure its RMS and JS has
   no simplex noise. Same reason near is clamped rather than re-ranged. */
const float HEAT_SIZE = 1.1;

/* Ashima / Stefan Gustavson simplex noise, public domain. Inlined rather than
   interpolated in from a shared chunk so that the whole source the driver sees
   is one literal — which is also what the offline validator parses. */
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289(i);
  vec4 pm = permute(permute(permute(
              i.z + vec4(0.0, i1.z, i2.z, 1.0))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = pm - 49.0 * floor(pm * ns.z * ns.z);

  vec4 xf = floor(j * ns.z);
  vec4 yf = floor(j - 7.0 * xf);

  vec4 xg = xf * ns.x + ns.yyyy;
  vec4 yg = yf * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(xg) - abs(yg);

  vec4 b0 = vec4(xg.xy, yg.xy);
  vec4 b1 = vec4(xg.zw, yg.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

/* A vector-valued sample of the same field. Three evaluations, which is the
   whole reason the wave below uses a plain tangential projection rather than a
   proper curl: curl is 18 evaluations and buys divergence-free flow, which only
   matters when a path is INTEGRATED over many frames and cannot afford sinks.
   Here the displacement is evaluated fresh each frame from a fixed base
   position, so nothing accumulates and nothing can pile up. */
vec3 snoiseVec3(vec3 p) {
  return vec3(
    snoise(p),
    snoise(p + vec3(19.19, 33.71, 7.13)),
    snoise(p + vec3(-41.27, 11.53, 61.07))
  );
}

mat3 rotY(float a) {
  float s = sin(a);
  float c = cos(a);
  return mat3(c, 0.0, -s,
              0.0, 1.0, 0.0,
              s, 0.0, c);
}
mat3 rotX(float a) {
  float s = sin(a);
  float c = cos(a);
  return mat3(1.0, 0.0, 0.0,
              0.0, c, s,
              0.0, -s, c);
}

mat3 rotZ(float a) {
  float s = sin(a);
  float c = cos(a);
  return mat3(c, s, 0.0,
              -s, c, 0.0,
              0.0, 0.0, 1.0);
}

void main() {
  vec3 dir = normalize(a_pos);
  float shell = length(a_pos);

  /* Which population a mote belongs to, read off its radius rather than stored
     as a flag — the four shells barely overlap, so the radius already says it.
     Each one is lit and dimmed differently below; that is what stops the field
     being uniform dust. See buildVertices. */
  float haloness = smoothstep(0.982, 1.020, shell);
  float skinness = smoothstep(0.944, 0.958, shell) * (1.0 - smoothstep(0.986, 1.002, shell));
  float innerness = 1.0 - smoothstep(0.940, 0.958, shell);
  /* Core motes project onto the MIDDLE of the disc, where the projection
     already piles motes up, so they need their own dimming or they draw a
     bright structureless blob at the centre. */
  float coreness = 1.0 - smoothstep(0.40, 0.58, shell);

  /* WHERE the surface is awake: filaments, read as the ZERO CONTOUR of a signed
     field rather than as "wherever a field exceeds a threshold".

     That difference is the whole look, and it is the one trick this shader most
     depends on. Thresholding noise selects the tops of its hills, which are
     round blobs — which is exactly what the previous smoothstep drew. A contour
     of the same noise is a closed curve, so it comes out as long sweeping lanes
     that wander and reconnect as the field drifts, instead of swelling and
     shrinking in place.

     The 5-fold azimuthal term anchors how many lanes there are. Pure noise
     cannot hold a feature count — each frame draws its own realisation and the
     number wanders — so the periodic term fixes the count and the two noise
     octaves only decide where each lane goes and how ragged it gets.

     Sampled on dir, which is object space: the lanes rotate WITH the body
     rather than sliding across it, which is what makes them read as features on
     a turning sphere.

     atan is undefined when both arguments are zero, which is exactly the two
     poles. The epsilon costs nothing and removes a NaN that would otherwise
     propagate through everything below. */
  float az = atan(dir.z, dir.x + 1e-6);
  float lane = 0.62 * cos(5.0 * az + 1.3 - u_clock * 0.42)
             + 0.85 * snoise(dir * 1.35 + vec3(4.1, 2.7 - u_clock * 0.26, 8.9))
             + 0.30 * snoise(dir * 3.10 + vec3(1.7, -u_clock * 0.18, 5.3));

  /* Two widths off the one contour, because the sphere needs both: a broad
     shoulder that says this whole region is awake, and the narrow core inside
     it that actually throws material. Dividing by an explicit half-width keeps
     the two independent of the weights above — retune the field and the lanes
     stay the same thickness.

     The widths are MEASURED against this field, not guessed. Over 300k uniform
     points on the sphere it has std 0.726 and a mean tangential gradient of
     1.99 per radian, so a half-width w spans about w radians:
       0.34 -> 45% areal coverage, ~19 deg, the shoulder
       0.13 -> 20% areal coverage, ~7.5 deg, the lane
     Widths near the field's own std cover 88% and 52% of the sphere — a wash
     over the whole surface, which is why no filaments read at all. */
  float dist = abs(lane);
  float glow = clamp(1.0 - dist / 0.34, 0.0, 1.0);
  float band = clamp(1.0 - dist / 0.13, 0.0, 1.0);
  /* Squared, so both have genuinely dark edges rather than fading out over
     their whole width. That hard falloff is what reads as a filament. */
  float halo = glow * glow;
  float arc = band * band;

  /* WHEN each region fires. One clock per region, offset by a field at the SAME
     frequency (1.35) as the lane noise above. That matching matters: at a
     different frequency the eruption stamps its own harmonic across the lanes
     and the two interfere, so a lane fires in halves. Matched, each lane gets
     roughly one phase along its length and lets go as a unit. */
  float phase = snoise(dir * 1.35 + vec3(53.2, 17.8, 31.4));

  /* Fast rise, long decay — the shape of a flare, not a sine. fract supplies
     the cycle, the smoothstep gives the wrap a finite rise so it is not a
     visible pop, and the exponential is the decay. /0.81 normalises the peak to
     1 (the crest sits at cyc 0.125, where the rise has finished and the decay
     has barely started) so the consumers below, which are all mixes, interpolate
     rather than extrapolate past their calibrated ceilings. */
  float cyc = fract(u_clock * 0.13 + phase * 1.6);
  float surge = clamp(smoothstep(0.0, 0.11, cyc) * exp(-1.8 * cyc) / 0.81, 0.0, 1.0);

  /* Where and when together, plus how hard — which is the pulse. Amplitude
     makes her eruptions bigger while she talks; it does not create them, so the
     field still lives while she is silent. Keyed to the NARROW lane, so only the
     material that is genuinely on a filament is thrown. Clamped once, here, so
     every consumer downstream is bounded. */
  float erupt = clamp(u_flare * (0.75 + 0.85 * u_energy) * arc * surge, 0.0, 1.0);

  /* The wave. Two motions, doing different jobs.

     The tangential one slides motes ACROSS the skin. Projecting the noise onto
     the tangent plane is what lets the surface churn without the sphere
     breathing in and out, and it is why this needs no re-pinning step after.
     Renormalising rather than adding keeps every mote exactly on its own shell,
     so the populations above stay intact through the wave.

     The radial one moves the silhouette itself, which is the part the eye
     actually reads as waving — lateral churn alone on a sphere is nearly
     invisible at the limb. Two octaves, not one: a single low frequency moves
     the limb as a smooth ellipse, which reads as the sphere being slightly the
     wrong shape rather than as a surface in motion, while the second, faster and
     shallower, is what makes the outline ragged in a single frozen frame. */
  vec3 churn = snoiseVec3(dir * 1.7 + vec3(0.0, u_clock * 0.30, 0.0));
  vec3 tangent = churn - dir * dot(churn, dir);
  float swell = snoise(dir * 2.2 + vec3(0.0, -u_clock * 0.45, 0.0))
              + 0.45 * snoise(dir * 4.7 + vec3(6.2, -u_clock * 0.80, 1.4));

  vec3 slid = normalize(dir + tangent * (SLIDE + 0.13 * a_rand) * (0.65 + 0.6 * u_energy));

  float radius = shell
      /* The undulation. Deeper on the skin and fringe than through the body —
         the interior is what holds the sphere's shape, and rippling that too
         reads as the whole object wobbling rather than as a surface. */
      * (1.0 + HEAVE * swell * (0.45 + 0.85 * u_energy) * (1.0 - 0.55 * innerness))
      /* Amplitude breathes the shell outward. Zero under reduce-motion.

         Folded in HERE, inside the radius, rather than applied to p after the
         rotation as it used to be. That is what puts it under the knee below —
         outside it, the swell was free to push the sphere past the clip volume,
         which is precisely how the louder states came to delete half the orb. */
      * (1.0 + u_spread * u_energy)
      /* The throw. Fringe dust goes furthest because it is already loose; the
         skin lifts only slightly, so an eruption reads as material leaving the
         surface rather than as the silhouette ballooning. Per-mote reach gives
         each plume a gradient instead of a second shell. */
      + erupt * THROW * (0.23 + haloness + 0.17 * skinness) * (0.40 + 0.90 * a_size);

  /* Soft knee. Every maximum above is jointly improbable, but a sprite whose
     centre leaves NDC does not clip — it disappears — so the tip of a rare plume
     would blink out rather than run off the edge. Compresses only past 1.20 and
     stays monotonic, so nothing below the knee is touched. */
  radius -= smoothstep(1.20, 1.55, radius) * (radius - 1.20) * 0.55;

  vec3 p = slid * radius;

  /* Whole-body rotation, applied after the fields are sampled so they turn with
     it. u_time arrives as an accumulated ANGLE in radians, not seconds:
     accumulating on the CPU is what lets a state change alter the spin rate from
     that frame on, where deriving the angle from total elapsed time and the
     current rate would rescale the whole history and snap the sphere to a new
     orientation the instant the state changed. */
  p = rotZ(0.08 + sin(u_time * 0.4) * WOBBLE) * rotX(TILT) * rotY(u_time) * p;

  vec3 n = normalize(p);
  /* Distance from the SILHOUETTE, in projection. Under an orthographic view the
     sphere's outline is the great circle where the normal is perpendicular to
     the view axis — n.z = 0 — and that is true on both hemispheres, so the abs
     is what lets front and back skin crowd into the same projected annulus.
     That crowding is the rim. */
  float facing = abs(n.z);

  /* Orthographic: x/y are the screen position and z survives only as a depth
     cue. A perspective divide would need the reference's PerspectiveCamera, and
     in a field this small the difference does not survive to the pixel.

     Mapped to 0–1 over the span the geometry can actually reach after the knee.
     The window is deliberately NOT widened to cover the wave and the eruption on
     top: these constants set the statistics of near, and therefore the RMS the
     sprite size is calibrated against. Clamping instead leaves the resting
     distribution bit-for-bit what the JS mirror measures and only bounds the
     excursions. */
  float near = clamp((p.z + 1.36) / 2.72, 0.0, 1.0);
  v_defocus = abs(near - FOCAL) / max(FOCAL, 1.0 - FOCAL);

  /* ---- Brightness ---------------------------------------------------------

     The rim is a GEOMETRY feature, not a shading one. It is the projected
     pile-up of the skin shell at its own silhouette, with near-nothing outside
     it to fill the band beyond — which is why no exponent on any of these terms
     can substitute for the tight skin shell buildVertices lays down. A shading
     term can only redistribute what the projection already concentrated.

     There is no depth test under additive blending, so the far hemisphere has to
     be dimmed by hand or front and back accumulate identically and the sphere
     flattens into a disc. That flattening is exactly what the previous
     0.35 + 0.65 * near did NOT fix: brightening the near FACE puts the
     maximum in the middle of the disc, which is the signature of a flat blob. */
  float back = mix(0.42, 1.0, smoothstep(-1.0, 1.0, n.z));
  float key = 0.58 + 0.42 * dot(n, normalize(vec3(-0.45, 0.55, 0.40)));
  /* A shell's projected density diverges at its own silhouette, which draws the
     bright rim for free. The facing weight leans against that just enough to
     keep the face from emptying out — the exponent stays under 1 so brightness
     is still monotonic toward the limb. */
  float body = (0.34 + 0.66 * pow(facing, 0.55)) * key;

  /* Sparkle, as a DITHER against the lane rather than a fixed set of motes: a
     mote lights with probability proportional to how strongly its region is
     lit. That is what puts individual bright specks ALONG a filament instead of
     glowing the whole ribbon uniformly. */
  float spark = step(a_rand, halo * 0.52);

  /* Dust puffing off the limb. Gated on spark and not on the lane alone,
     because lifting every mote in a lit region inflates whole patches of the
     outline instead of throwing specks off it. */
  float rim = pow(1.0 - facing, 6.0);
  float limb = rim * (0.015 + 0.22 * halo * spark);
  float hot = spark * (0.55 + 0.95 * halo) + limb;

  /* Every population answers the same lane field, but differently. That is the
     fix for flat speckle: with body and core motes on a flat 1.0, a quarter of
     the field was unmodulated dust and the core shell — which projects straight
     onto the middle of the disc — put a bright structureless blob at the centre.
     Nothing is exempt now.

     ## These are gains ABOVE 1, not fractions of it

     The load-bearing detail, and the one this got wrong first time round. orb1's
     equivalent term is haloDim, and it is 1.0 on the body: it only ever dims
     the halo, so the filaments are drawn by the HUE ramp while every mote keeps
     its full body brightness. Writing the baseline as 0.30 instead divides the
     ordinary skin mote's brightness by 3.3, and the measured consequence is the
     whole visual problem in one number — cold body dust at 0.052 per mote
     against orb1's ~0.21, with a filament-to-dust brightness ratio of 6.6x
     against orb1's 1.9x. A dim body under bright specks IS the confetti look;
     the body has to carry its own weight and let colour carry the structure.

     So the floor is 1.0 everywhere and the lane adds on top. The overall gain in
     v_alpha comes down by roughly the same factor, which leaves the lane cores
     where they were and lifts everything else. */
  float surfaceLit = 1.0 + 0.30 * halo + 0.30 * arc;
  /* The fringe is thin material seen edge-on and genuinely near-binary — bright
     where a lane threw it, dark between — so this one does dip below 1. */
  float fringeLit = 0.45 + 0.60 * arc * mix(0.25, 1.0, surge);
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

  /* Per-mote alpha MUST stay well under 1 across the resting sphere. Additive
     blending clips a sprite's core to white the moment alpha reaches 1, which
     turns every colour in the palette into the same white speck — and a field of
     identical white specks is precisely the confetti this replaces.

     ## One gain outside both terms, not a gain on the body and a cap on the spark

     The body and the sparkle have to scale TOGETHER, which is why the gain sits
     outside the bracket exactly as it does in orb1. Written the other way — a
     gain on the body plus an absolute clamp on the spark — the two decouple, and
     the clamp then sets the top of the distribution on its own: at a 0.55 cap
     against a body median of 0.083 the sparks sat 6.6x above the body, owned the
     entire alpha tail, and pinned the body dim because any gain that lifted it
     pushed the tail past 1. Sweeping the pair is what showed this: the body
     median did not move across the whole grid, because the tail being measured
     was never the body's.

     Calibrated against orb1's own distribution, measured rather than estimated
     by replaying ITS expressions over ITS attribute distributions: cold body
     dust 0.194 per mote, p99.9 of 0.99 at rest, and — the figure that mattered
     most — 2.26% of motes over 1 at full energy with a p99.9/p50 width of 4.8x.
     A first pass held the tail to 1.35 and 0.6%, which is STRICTER than the
     reference, and that ceiling is what pinned the body dim: every gain that
     lifted the body pushed the tail past a limit orb1 itself does not respect.
     A heavy-tailed spark is not a defect to be clamped — orb1 draws the same
     1.2%-of-motes tail to 2.7 deliberately, because a few genuinely blown-out
     specks are what a dust field looks like.

     Matching per-mote alpha is the right comparison across a 100x difference in
     count because sprite size is solved to hold coverage constant, so equal
     per-mote alpha at equal coverage is equal accumulated ink.

     The energy ramp is flatter than the 0.90 + 1.05 it replaces. At the steeper
     ramp, speaking put 9.5% of the field over 1 against orb1's 2.26% — four
     times the reference — which is not a brighter orb, it is the same orb with
     its palette collapsing to white in the state that matters most. 0.70 + 0.35
     lands speaking at 2.09%. Solved as a pair with the gain, since the two only
     have meaning together.

     Only the lane cores are meant to reach 1, and by replay they are ~93% of the
     motes that do, with plain dust and sparks at 0%. Their clipping is wanted —
     a white-hot spine inside a coloured halo is what a filament looks like. */
  v_alpha = (body * litArc * depthDim + 0.20 * hot * a_spark)
            * back * (0.78 + 0.34 * u_energy) * 1.75;

  /* ---- Colour ------------------------------------------------------------

     Driven by hot rather than by latitude. The palette is one walk from ash
     through violet and blue to white, and where a mote sits along it is how lit
     it is — so colour and structure are the same signal and the filaments come
     out violet-to-white against a charcoal body, instead of the body carrying a
     rainbow the filaments have to compete with. The per-mote jitter is small,
     just enough that a region is not perfectly uniform. */
  /* A stable chromatic field across the rotating body. Object-space direction
     keeps the colours attached to the sphere instead of looking like a screen
     overlay, while a little lane heat pushes active regions toward purple. */
  v_hue = fract(0.52 + dir.x * 0.23 + dir.y * 0.17 + dir.z * 0.11
                + hot * 0.16 + a_rand * 0.035);
  v_heat = clamp(erupt * (1.05 + 0.55 * a_spark), 0.0, 1.0);

  gl_Position = vec4(p.xy * u_fit, 0.0, 1.0);

  /* Sprite size. The modulation term is the per-point variation only — bigger
     near the camera, bigger for a point that drew a large a_size, spread wider
     the further it sits from the focal plane because an out-of-focus point of
     light covers more screen than a sharp one, and fatter out in the fringe.

     haloFat is what makes the dust past the limb read as soft puffs rather
     than as more of the same specks. It has to be inside the calibrated term,
     not beside it: it is a static per-mote factor with a mean well above 1, so
     leaving it out of the RMS would put roughly 40% more ink on screen than the
     budget allows.

     The absolute scale is deliberately not here. It depends on the point count
     and the drawing buffer, both constant for the life of the context, so
     u_pointBase is solved once on the CPU from a coverage target instead of
     being rebuilt per vertex. Everything in modulation is mirrored verbatim in
     the JS modulation() so the two cannot drift — see TARGET_COVERAGE.

     Clamped to the driver's GL_ALIASED_POINT_SIZE_RANGE — a point sprite over
     the limit is silently dropped by some GL ES drivers, which would make the
     largest, nearest points vanish rather than merely clip, and the flare term
     is exactly what would push a sprite over that line. */
  float haloFat = 1.0 + 1.0 * smoothstep(0.980, 1.052, shell);
  float modulation = (1.5 + 2.6 * a_size)
                   * (0.62 + 0.72 * near)
                   * (1.0 + 1.3 * v_defocus)
                   * haloFat;
  float restSize = modulation * u_pointBase;
  gl_PointSize = min(restSize * (1.0 + HEAT_SIZE * v_heat), u_maxPoint);
}
`;

/**
 * Fragment shader.
 *
 * A point sprite is a square; this carves a glowing disc out of it and softens
 * the edge by how defocused the point is. In focus it is a small bright dot; far
 * from focus it is a wide, faint, soft-edged disc — which is what a real lens
 * does to a point of light, and what the stacked-circle trick was approximating.
 *
 * ## The palette
 *
 * One walk, ash -> violet -> blue -> white, driven by how LIT a mote is rather
 * than by where it sits. That is orb1's palette and orb1's structure: colour and
 * brightness are the same signal, so the filaments come out violet shading to
 * white against a charcoal body.
 *
 * The alternative — a spatial hue ramp — was what this shader did before, and it
 * fights the structure instead of carrying it: the body ends up wearing a
 * rainbow that the filaments then have to out-shout. Ash is a near-neutral
 * charcoal with a slight cool lean, so the unlit body reads as dust rather than
 * as a colour, which is the whole point of a dark body with bright ribbons.
 *
 * The warm end is separate and additive, gated on v_heat, which is only non-zero
 * inside an eruption. That is the physically right structure — a flare is hot,
 * the body it erupts from is not — and additive is load-bearing: a mix would
 * REPLACE the cool colour and punch a gold hole in the sphere, where adding lets
 * the heat sit on top of whatever that region already was, which reads as the
 * surface lighting up rather than changing material.
 */
const FRAGMENT = `
/* highp in a fragment shader is optional in GLSL ES 1.0 — the compiler defines
   this macro only where it exists. Mali supports it, but an unguarded highp is a
   compile error on the GPUs that don't, and this shader has no need of the
   range: everything here is a 0-1 coordinate or colour. */
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying float v_defocus;
varying float v_alpha;
varying float v_hue;
varying float v_heat;

uniform vec3 u_tint;

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float d = length(uv);
  if (d > 1.0) discard;

  /* The reference builds its glow as a CanvasTexture radial gradient with stops
     at 1.0 / 0.8 / 0.25 / 0.0 and samples it per fragment. Squaring a linear
     falloff lands close enough to be indistinguishable at these sizes, and costs
     no texture fetch, no upload, and no 64x64 canvas. */
  float core = 1.0 - smoothstep(0.0, 1.0, d);
  // A single linear falloff keeps enough luminous area to survive phone pixel
  // density and viewing distance. Squaring this value made all but the exact
  // centre of each 4px mote effectively black, so thousands of valid particles
  // still read as a sparse, dark cloud.
  float glow = core;

  /* Sharp points get a hard edge softened only by anti-aliasing; defocused ones
     get a wide falloff. */
  float edge = mix(0.06, 0.8, v_defocus);
  float disc = 1.0 - smoothstep(1.0 - edge, 1.0, d);

  float alpha = disc * glow * v_alpha;
  /* A sprite this faint cannot change the pixel it lands on, but it still costs
     a blend. At this density that is a measurable share of the fill, and fill is
     what this field is bound by on Mali. */
  if (alpha < 0.003) discard;

  /* Green -> cyan -> blue -> violet, distributed across the body.

     Blue between violet and white rather than a straight violet-to-white lerp,
     because that lerp desaturates through a flat lilac and the filament cores
     stop reading as hot. Adjacent smoothsteps deliberately overlap at their
     shared stop so the ramp is continuous — consecutive mixes sharing an exact
     edge give each transition a shoulder, which bands visibly. */
  vec3 green  = vec3(0.180, 0.900, 0.610);
  vec3 cyan   = vec3(0.180, 0.790, 1.000);
  vec3 blue   = vec3(0.320, 0.460, 1.000);
  vec3 violet = vec3(0.720, 0.360, 1.000);

  vec3 c = mix(green, cyan, smoothstep(0.05, 0.34, v_hue));
  c = mix(c, blue, smoothstep(0.30, 0.64, v_hue));
  c = mix(c, violet, smoothstep(0.60, 0.94, v_hue));

  /* The theme's ambient colour, at low weight and on the COLD dust only. Enough
     that the field belongs to the palette it sits in, and that light and dark
     mode differ at all, without flooding the charcoal body. Deliberately absent
     from the hot end, so an eruption is the same colour in either scheme. */
  c = mix(c, u_tint, 0.12 * (1.0 - v_heat));

  /* The warm end: gold, then toward white at the very peak, which is how a flare
     actually reads — the hot core blows out while its skirt stays gold. */
  vec3 gold = vec3(1.000, 0.760, 0.240);
  c += mix(gold, vec3(1.0, 0.980, 0.900), smoothstep(0.55, 1.0, v_heat)) * v_heat * 0.85;

  /* Premultiplied alpha preserves saturated colour on both pale and dark app
     surfaces. Pure additive blending can only brighten a pale pixel, so every
     green/blue/violet mote converges to white in light mode. */
  float opacity = clamp(alpha * (2.15 + 0.65 * v_heat), 0.0, 0.92);
  gl_FragColor = vec4(c * opacity, opacity);
}
`;

/**
 * Radians per second of spin. Replaces the old CYCLE_SECONDS: a rotating body
 * has a rate, not a lifetime, because nothing is born or dies any more.
 */
const SPIN: Record<FieldState, number> = {
  idle: 0.24,
  listening: 0.5,
  thinking: 1.1,
  speaking: 0.7,
};

/** How far amplitude breathes the shell outward. Mirrors SPREAD. */
const SPREAD: Record<FieldState, number> = {
  idle: 0.04,
  listening: 0.3,
  thinking: 0.1,
  speaking: 0.22,
};

/**
 * How hard the surface erupts, per state.
 *
 * Never zero: the arcs and their flares are what give the sphere structure, so
 * killing them at rest would leave a featureless ball of dust and make the
 * transition into speech a change of object rather than of intensity. Idle is a
 * slow simmer at the threshold of noticeable; speaking is the peak, because that
 * is the state the ask is about. Thinking sits below listening on purpose —
 * thinking already spins fastest, and pairing the fastest spin with the hardest
 * eruption reads as agitation rather than concentration.
 */
const FLARE: Record<FieldState, number> = {
  idle: 0.22,
  listening: 0.55,
  thinking: 0.4,
  speaking: 1,
};

/** `#rrggbb` to the 0–1 triple GLSL wants. */
function rgb(hex: string): [number, number, number] {
  const v = hex.replace("#", "");
  const n = parseInt(v.length === 3 ? v.replace(/./g, (c) => c + c) : v, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Floats per vertex: pos(3) + size + spark + rand. */
const STRIDE_FLOATS = 6;

/**
 * GL points per View-field mote.
 *
 * `count` cannot mean the same absolute number on both implementations. On the
 * View field it is how many stacks of translucent circles to composite, and
 * eighteen of those already cost 27ms a frame. Here it is how many vertices go
 * through a single draw call — and eighteen of *those* is not a sphere, it is
 * eighteen dots.
 *
 * So the prop keeps its meaning as a density *hint* and each path scales it to
 * its own cost model. 300 puts the full-screen default of 30 at 9000 points,
 * which is the reference's own count.
 *
 * It is a hint in a second sense too: the product is capped by what the
 * container can hold at a legible sprite size, so a small field gets fewer
 * points rather than smaller ones. See MIN_SPRITE_PX — the dock's `count={18}`
 * asks for 5400 and is given ~1080, because 5400 over a 155px disc is not a
 * sparser field, it is a solid speckled one.
 *
 * This is affordable because it is one draw call with a static buffer: the cost
 * of a point is a handful of vertex ops plus its share of the coverage budget
 * below, and the budget is held constant as the count grows.
 */
const POINTS_PER_MOTE = 300;

/**
 * The focal plane, mirroring the vertex shader's own `const float FOCAL`.
 *
 * Two literals rather than one interpolated value, deliberately: the GLSL has to
 * stay a single unbroken template literal, because that is what the driver
 * receives and what the offline validator parses. Same contract as
 * `modulation()` below — if one changes, change both.
 */
const FOCAL = 0.62;

/**
 * How much of NDC's half-extent the sphere is allowed to reach.
 *
 * A point sprite whose CENTRE leaves the clip volume is not clipped — it
 * vanishes whole — so with `gl_Position = vec4(p.xy, 0, 1)` the clip boundary
 * sat at 1.0 while the resting shell already reached ~1.08 and the amplitude
 * swell multiplied on top of that. Replaying the vertex chain in JS measured
 * 4.5% of points deleted at idle, 35% while listening and 46% while speaking,
 * and what gets deleted is exactly the limb — which is the thing that makes a
 * point sphere read as a ball rather than as a flat disc of confetti. It was
 * also backwards from the intent: the louder EVE spoke, the more of her orb
 * disappeared.
 *
 * Sized against the largest excursion the geometry can still produce after the
 * soft knee, not against the resting shell, so a rare plume runs off toward the
 * edge of the field rather than blinking out. Verified by replay at every state
 * and both call sites.
 *
 * Changing this WITHOUT re-solving the coverage budget below multiplies the ink
 * density by 1/FIT^2 — the two are one adjustment. TARGET_COVERAGE is measured
 * against the disc FIT defines, which is what keeps them tied.
 */
const FIT = 0.68;

/**
 * How much of the sphere's own projected disc the field's ink should cover.
 *
 * Point size and point count are not independent knobs — together they are one
 * quantity, how much of the frame ends up lit, and that is what the eye reads.
 * So size is solved from the count rather than tuned beside it, which is why
 * raising the density adds motes without adding ink or fill rate.
 *
 * Measured against the DISC and not the frame rect. FIT decides how much of the
 * frame the sphere occupies, so a figure keyed to the frame would spread the
 * budget over area the orb never touches — the previous 0.7-of-the-rect was
 * already 4/pi too dense before FIT shrank the geometry on top.
 *
 * The net effect on fill is a large reduction even at this higher figure:
 * 0.72 * pi * (0.68/2)^2 = 0.26 of the frame against the old 0.70, so about 2.7x
 * less blended area per frame. That matters here specifically — the measured
 * bottleneck on this device is RenderThread fill, not vertex work.
 */
const TARGET_COVERAGE = 0.72;

/**
 * The smallest sprite diameter, in physical pixels, that still reads as dust.
 *
 * This is the constraint that makes `count` a ceiling rather than a promise, and
 * it exists because coverage alone does not pin down what the field looks like.
 * Holding the ink constant while raising the count shrinks every sprite, and
 * below about three pixels a sprite has no room left for the fragment shader's
 * falloff: `glow = core * core` and the `edge` ramp both need a radius to fall
 * off over, so a 1.8px mote is a hard aliased speck whatever alpha it carries.
 * Thousands of hard specks at constant coverage is precisely the flat confetti
 * this rewrite is trying to stop drawing.
 *
 * 4.0 is not a taste call — it is the diameter the full-screen path already
 * solves to at its calibrated 9000 points, so pinning the floor here makes every
 * other call site a proportional miniature of that same orb rather than a
 * different, denser object. The dock is where it bites: 76dp is 228px on this
 * device, a 155px disc, and 5400 points over that disc is 5.4x the full-screen
 * areal density — the dock was drawing 1.79px sprites and reading as speckle.
 * The cap takes it to ~1080 points at 4.0px, which is the full-screen sphere
 * scaled down by exactly its own linear ratio.
 *
 * Reducing the count for its own sake was tried before and rejected, correctly:
 * the reference defines the look. This is the opposite move — the count comes
 * down *because* the reference defines the look, and the same density is what
 * carrying that look across two sizes means. It happens to cost less fill too,
 * but that is a side effect and not the reason.
 */
const MIN_SPRITE_PX = 4.0;

/**
 * The most points a disc of `pixels` across can hold at MIN_SPRITE_PX.
 *
 * Inverts the coverage solve for the count instead of the diameter:
 * `count * (pi/4) * d^2 = TARGET_COVERAGE * pi * (FIT * pixels / 2)^2`
 * reduces to `TARGET_COVERAGE * (FIT * pixels)^2 / d^2` with the pi and the
 * quarter cancelling.
 *
 * Sized from the container in physical pixels rather than from
 * `gl.drawingBufferWidth`, because the count has to be known before the context
 * exists — it decides the buffer that gets uploaded in the first place, and the
 * component remounts GLView on it. The real buffer is used for the diameter
 * solve inside setupGL, where the exact figure matters and is available.
 */
function solveCountCeiling(pixels: number): number {
  return Math.max(
    1,
    Math.round((TARGET_COVERAGE * Math.pow(FIT * pixels, 2)) / Math.pow(MIN_SPRITE_PX, 2)),
  );
}

/**
 * The vertex shader's size modulation, in JS.
 *
 * Kept as a literal copy of the GLSL expression on purpose: u_pointBase is
 * solved by dividing out this term's RMS over the actual buffer, so the two
 * must not drift. Change the shader, change this.
 *
 * This replaces a hand-measured `RMS_MODULATION = 8.15`. Measuring it by hand is
 * how the previous version came out 1.46x too large: the attributes are not
 * uniform on 0..1, and a guess at their means is wrong in a way nothing catches.
 *
 * RMS and not the mean, because coverage sums AREAS: the budget solves
 * `count * (pi/4) * E[d^2] = coverage * area`, which needs E[modulation^2].
 *
 * `v_heat` is taken as 0 here, which is what makes TARGET_COVERAGE the RESTING
 * budget: the flare's size excursion is a deliberate transient above it, on the
 * few percent of motes lit at any instant. It also cannot be mirrored — it needs
 * simplex noise, which this function has no access to. Same reason `near` is
 * clamped in the shader rather than re-ranged.
 */
function modulation(z: number, sizeJitter: number, shell: number): number {
  const near = Math.min(1, Math.max(0, (z + 1.36) / 2.72));
  const defocus = Math.abs(near - FOCAL) / Math.max(FOCAL, 1 - FOCAL);
  const haloFat = 1 + smoothstep(0.98, 1.052, shell);
  return (1.5 + 2.6 * sizeJitter) * (0.62 + 0.72 * near) * (1 + 1.3 * defocus) * haloFat;
}

/** GLSL's smoothstep, for the JS mirrors above. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Solve the sprite diameter from the coverage budget and the point count.
 *
 * Both are fixed for the life of the GL context, so this is arithmetic done once
 * at setup rather than per vertex per frame. Works in PHYSICAL pixels because
 * gl_PointSize does — sizing in dp draws the field DPR-times too small, which is
 * a bug this component actually shipped once.
 *
 * The buffer's own z is used as the depth sample even though the shader sees a
 * ROTATED z. For a spherical shell the distribution of z is rotation-invariant,
 * so the two are statistically identical and this needs no camera.
 */
function solvePointBase(
  vertices: Float32Array,
  count: number,
  width: number,
  height: number,
): number {
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const o = i * STRIDE_FLOATS;
    const x = vertices[o] ?? 0;
    const y = vertices[o + 1] ?? 0;
    const z = vertices[o + 2] ?? 0;
    const m = modulation(z, vertices[o + 3] ?? 0, Math.sqrt(x * x + y * y + z * z));
    sum += m * m;
  }
  const rms = Math.sqrt(sum / Math.max(1, count));

  // The sphere's projected disc, not the frame rect. min() rather than either
  // axis so a non-square field still inscribes the orb.
  const disc = Math.PI * Math.pow(FIT * 0.5 * Math.min(width, height), 2);
  const diameter = Math.sqrt((4 * TARGET_COVERAGE * disc) / (Math.PI * count));
  return diameter / rms;
}

/**
 * FIT as a per-axis pair, which is also the aspect correction.
 *
 * `gl_Position` had no aspect term at all, so the sphere was round only because
 * both call sites happen to pass a square `size`; a non-square field would have
 * drawn an ellipse. Folding the correction into the same uniform costs nothing
 * per vertex and removes the latent bug — the shorter axis keeps the full FIT and
 * the longer one is scaled down to match it, so the orb stays circular and
 * inscribed whatever shape the container is.
 */
function solveFit(width: number, height: number): [number, number] {
  const short = Math.min(width, height);
  return [(FIT * short) / Math.max(1, width), (FIT * short) / Math.max(1, height)];
}

/** The attribute layout, kept next to STRIDE_FLOATS so the two cannot drift. */
const ATTRIBUTES: { name: string; elements: number; offset: number }[] = [
  { name: "a_pos", elements: 3, offset: 0 },
  { name: "a_size", elements: 1, offset: 12 },
  { name: "a_spark", elements: 1, offset: 16 },
  { name: "a_rand", elements: 1, offset: 20 },
];

/**
 * The interleaved vertex buffer: x, y, z, size, spark, rand.
 *
 * ## Four populations, because one shell cannot draw a rim
 *
 * This is the part that decides whether the field reads as a ball or as flat
 * confetti, and it is geometry rather than shading. A shell's projected density
 * diverges at its own silhouette, so a TIGHT shell piles up into a bright ring
 * at the edge of the disc for free — and no exponent in the shader can put that
 * maximum anywhere else. The previous single shell spanned 0.93..1.07, roughly
 * nine times too thick for the pile-up to concentrate into anything, which is why
 * there was no rim to see.
 *
 * What each population buys:
 *
 *  - SKIN, most of the budget, 3% thick. The surface that waves, carries the
 *    filaments, and draws the rim at its own silhouette.
 *  - BODY, a thick shell just inside it. Depth, so the sphere reads as a volume
 *    rather than a soap bubble. Bounded rather than filled to the centre: a
 *    volume fill puts a divergent integrand under the middle of the disc.
 *  - CORE, small and tight. The bright nucleus the rest turns around.
 *  - FRINGE, loose dust just past the limb. This is the population eruptions
 *    actually throw, so it is what makes a plume visible outside the body, and
 *    it is what leaves a starved halo band outside the rim instead of a hard
 *    edge.
 *
 * The radii are read back in the shader off `length(a_pos)` rather than stored as
 * a flag — the shells barely overlap, so the radius already says which is which.
 *
 * Built once and uploaded once. Everything that varies per frame is a uniform,
 * which is what keeps this to one draw call with no per-frame CPU work beyond
 * setting a handful of floats.
 */
function buildVertices(count: number): Float32Array {
  const data = new Float32Array(count * STRIDE_FLOATS);

  /* mulberry32, so a reload — or a Fast Refresh on the phone — reproduces the
     same cloud. Math.random would re-scatter the field on every save, and a
     layout that jumps whenever the file is written cannot be tuned by eye.

     A stream rather than the previous per-channel `hash(i + k)`: this build draws
     seven values per mote and juggling seven seed offsets is how a correlation
     gets in unnoticed. (The old sin-based hash was checked and was NOT
     correlated — this is for legibility, not a fix.) */
  let s = 0x9e3779b9;
  const rnd = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (let i = 0; i < count; i += 1) {
    /* Uniform in solid angle. Sampling the cosine of the polar angle directly is
       the same thing as the old acos(2u - 1) and skips the transcendental; the
       obvious theta = PI * u instead bunches motes visibly at the poles and
       leaves the equator bare. */
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
      /* Outward-biased. Only a shell whose own silhouette lies past a radius can
         put light there, so an inward bias starves the outer annulus the plumes
         are supposed to reach into. */
      shell = 0.986 + 0.062 * Math.pow(rnd(), 0.8);
    }

    const o = i * STRIDE_FLOATS;
    data[o] = ring * Math.cos(phi) * shell;
    data[o + 1] = u * shell;
    data[o + 2] = ring * Math.sin(phi) * shell;
    // Sprite size jitter, and how far this mote is thrown — so a plume has a
    // gradient rather than moving as a second shell.
    data[o + 3] = rnd();
    /* Sparkle magnitude. A hair over 1% burn much brighter, which is what puts
       individual bright specks along an erupting filament; at 3.5% the whole
       face turns to white speckle. Note this is only the MAGNITUDE — which motes
       spark is a dither against the lane field in the shader, so the specks land
       on the filaments rather than being scattered at random. */
    data[o + 4] = rnd() < 0.015 ? 1.5 + rnd() * 1.2 : 0.45 + rnd() * 0.45;
    // Generic per-mote random: the spark dither, the slide amount, hue jitter.
    data[o + 5] = rnd();
  }

  return data;
}

function compile(gl: ExpoWebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("could not create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader failed to compile: ${log}`);
  }
  return shader;
}

export function ParticleFieldGL({
  state = "idle",
  level = 0,
  size = 240,
  count = 30,
  tint,
  backdrop,
  reduceMotion = false,
  onFailure,
}: {
  state?: FieldState;
  level?: number;
  size?: number;
  /**
   * Density in View-field motes, not in GL points — the two paths multiply it
   * differently because their costs differ by about two orders of magnitude.
   * See POINTS_PER_MOTE. The default of 30 draws 9000 points, the same count as
   * the reference; sprite size follows from it via TARGET_COVERAGE, so this is
   * the one knob and turning it does not also change how much ink lands.
   */
  count?: number;
  /** Ambient colour from the theme, so the cloud tracks the palette. */
  tint: string;
  /** Exact colour behind this native GL surface. */
  backdrop: string;
  reduceMotion?: boolean;
  /**
   * Called when GL setup fails, so the caller can fall back to the View field.
   * Compile and link errors surface here and nowhere else: they happen inside
   * the context callback, long after the `require` that the caller's try/catch
   * guards, and a driver that rejects otherwise-valid GLSL is a real
   * possibility this component cannot rule out on its own.
   */
  onFailure?: () => void;
}) {
  // Read through refs inside the render loop: re-creating the GL context on
  // every microphone tick would be far worse than the problem this replaces.
  const stateRef = useRef(state);
  const levelRef = useRef(level);
  const motionRef = useRef(reduceMotion);
  const tintRef = useRef(tint);
  const backdropRef = useRef(backdrop);
  const aliveRef = useRef(true);
  /* One entry per GL context ever created by this component. GLView remounts on
     a density change, and each context runs its own draw loop with its own
     pending frame, so retiring the previous one needs a handle that outlives
     the callback that made it. */
  const contextsRef = useRef<{ current: boolean; frame: number | null }[]>([]);

  useEffect(() => {
    stateRef.current = state;
    levelRef.current = level;
    motionRef.current = reduceMotion;
    tintRef.current = tint;
    backdropRef.current = backdrop;
  });

  /* The actual vertex count, and the density knob for everything below. `count`
     is the caller's hint in View-field motes; this is what the GPU draws.

     Capped by what the container can hold as dust rather than as speckle — see
     MIN_SPRITE_PX. The full-screen field is unaffected (its ceiling is ~14000
     against the 9000 it asks for); the dock is cut from 5400 to ~1080, which is
     the same orb at the same areal density, one third the size. Rounded to 100s
     so a one-pixel layout difference cannot remount GLView and rebuild the
     buffer — `key={points}` makes every distinct value a new GL context. */
  const points = useMemo(() => {
    const ceiling = solveCountCeiling(PixelRatio.getPixelSizeForLayoutSize(size));
    const wanted = Math.max(1, Math.round(count * POINTS_PER_MOTE));
    return Math.max(1, Math.round(Math.min(wanted, ceiling) / 100) * 100);
  }, [count, size]);

  const vertices = useMemo(() => buildVertices(points), [points]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      // Stops the loop and stops it re-arming: cancelling the pending frame
      // alone leaves a draw already in flight free to schedule the next one.
      aliveRef.current = false;
      contextsRef.current.forEach((c) => {
        c.current = false;
        if (c.frame !== null) cancelAnimationFrame(c.frame);
      });
    };
  }, []);

  /**
   * Everything that can reject the shader happens in here, so the caller's
   * require-time try/catch is not enough on its own. The first `draw()` is inside
   * the guard too — a bad uniform or attribute only errors once it is used, not
   * when it is looked up.
   *
   * Frames after the first are not covered: they are scheduled from inside
   * `requestAnimationFrame`, past any try/catch here. That is the right trade —
   * a shader that drew one frame will draw the next, and wrapping every frame
   * would put a try/catch on the hot path this rewrite exists to keep clear.
   */
  function onContextCreate(gl: ExpoWebGLRenderingContext) {
    try {
      setupGL(gl);
    } catch (err) {
      console.warn("[ParticleField] GL setup failed, using the View field:", err);
      onFailure?.();
    }
  }

  function setupGL(gl: ExpoWebGLRenderingContext) {
    // A new context supersedes every earlier one; their loops stop here.
    contextsRef.current.forEach((c) => {
      c.current = false;
      if (c.frame !== null) cancelAnimationFrame(c.frame);
    });
    contextsRef.current = [];

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

    const program = gl.createProgram();
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program failed to link: ${gl.getProgramInfoLog(program)}`);
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    const stride = STRIDE_FLOATS * 4;
    const attrib = (name: string, elements: number, offset: number) => {
      const location = gl.getAttribLocation(program, name);
      /* -1 means the linker dropped the attribute as unused. Every one of these
         is read by the shader today, but a driver optimiser is free to decide
         otherwise, and enableVertexAttribArray(-1) is an INVALID_VALUE that
         would take down the whole field over a cosmetic term. */
      if (location < 0) return;
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, elements, gl.FLOAT, false, stride, offset);
    };
    ATTRIBUTES.forEach((a) => attrib(a.name, a.elements, a.offset));

    const uTime = gl.getUniformLocation(program, "u_time");
    const uClock = gl.getUniformLocation(program, "u_clock");
    const uEnergy = gl.getUniformLocation(program, "u_energy");
    const uSpread = gl.getUniformLocation(program, "u_spread");
    const uFlare = gl.getUniformLocation(program, "u_flare");

    /* The theme's ambient colour, folded into the palette at low weight in the
       fragment shader. It has to survive a scheme change: the context is created
       once and never again, so setting it here would leave the sphere carrying
       light-mode purple after a switch to dark. Sent per frame in the loop below,
       on change only. */
    const uTint = gl.getUniformLocation(program, "u_tint");

    /* Sprite size and the fit/aspect pair, both solved from the drawing buffer.
       Fixed for the life of the context, so this is arithmetic done once here
       rather than per vertex per frame.

       These two are ONE adjustment, not two: FIT decides how much of the frame
       the sphere occupies and the coverage budget is measured against exactly
       that disc, so shrinking the geometry without re-solving the size would
       multiply the ink density by 1/FIT^2. */
    gl.uniform1f(
      gl.getUniformLocation(program, "u_pointBase"),
      solvePointBase(vertices, points, gl.drawingBufferWidth, gl.drawingBufferHeight),
    );
    const fit = solveFit(gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform2f(gl.getUniformLocation(program, "u_fit"), fit[0], fit[1]);

    // Some GL ES drivers silently drop a point sprite larger than their
    // advertised maximum, which would make the nearest, largest points vanish
    // rather than merely clip. Clamp in the shader to whatever this GPU allows.
    const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as
      | Float32Array
      | [number, number]
      | null;
    const maxPoint = range && range[1] ? Number(range[1]) : 64;
    gl.uniform1f(gl.getUniformLocation(program, "u_maxPoint"), maxPoint);

    // Additive blending: overlapping points accumulate into a brighter core
    // instead of occluding one another.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const initialBackdrop = rgb(backdropRef.current);
    gl.clearColor(initialBackdrop[0], initialBackdrop[1], initialBackdrop[2], 1);

    /* Per-context, not per-component. `aliveRef` only flips on unmount, but
       GLView remounts on a density change while the component stays mounted —
       so keying the loop to the component would leave the previous context's
       draw() running forever against a dead surface, on top of the new one. */
    const contextAlive: { current: boolean; frame: number | null } = {
      current: true,
      frame: null,
    };
    contextsRef.current.push(contextAlive);

    let energy = 0;
    /* Spin angle in radians, accumulated rather than derived from a start
       timestamp. Deriving it would mean multiplying total elapsed seconds by the
       current rate, so changing state — idle's 0.24 rad/s to thinking's 1.1 —
       would rescale the entire history and snap the sphere to a new orientation.
       Integrating the rate instead makes a state change alter only what happens
       next. */
    let angle = 0;
    /* Elapsed animation seconds, driving the wave and the eruptions. Separate
       from `angle` because those are not rate-scaled by state — a flare takes the
       same time to rise and fall whichever state the field is in, and what
       changes is only how hard it throws. Feeding them the spin angle instead
       would make the eruption cycle speed up with the rotation and the two
       motions would lock together.

       Not wrapped, unlike `angle`: the noise fields advance along an axis rather
       than around a circle, so any wrap is a visible jump. It accumulates only
       while frames actually draw — requestAnimationFrame stops when the app is
       backgrounded — and float32 keeps sub-frame resolution on the fastest term
       here out past a full day of continuous foreground animation. */
    let clock = 0;
    let last = Date.now();
    let sentTint: string | null = null;
    let sentBackdrop: string | null = null;

    const draw = () => {
      // The GL context outlives this component's mount if the loop is left
      // running — it keeps drawing into a dead surface and holds the buffer.
      if (!aliveRef.current || !contextAlive.current) return;

      const current = stateRef.current;
      // Smoothed rather than stepped, so a hard consonant swells the sphere
      // instead of snapping it.
      const target = Math.max(0, Math.min(1, levelRef.current));
      energy += (target - energy) * 0.12;

      const now = Date.now();
      /* Clamped because the wall clock keeps running while the app is
         backgrounded: without this, coming back after a minute spins the sphere
         through several whole turns in one frame. */
      const delta = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;

      // Reduce-motion holds the sphere still — the spin, the wave, and the
      // eruptions all stop. It still draws, so the screen keeps its shape and
      // loses only the movement, same contract as the View field. The arcs stay
      // visible, frozen mid-flare, rather than flattening into a plain ball.
      if (!motionRef.current) {
        angle += delta * SPIN[current];
        clock += delta;
      }
      /* Wrapped to a full turn. sin/cos in the shader are periodic so only the
         remainder matters, and a float32 uniform loses its low bits once the
         integer part grows — an hour at idle would otherwise visibly quantise
         the rotation. */
      angle %= Math.PI * 2;

      if (backdropRef.current !== sentBackdrop) {
        sentBackdrop = backdropRef.current;
        const [br, bg, bb] = rgb(sentBackdrop);
        gl.clearColor(br, bg, bb, 1);
      }
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uTime, angle);
      gl.uniform1f(uClock, clock);
      gl.uniform1f(uEnergy, motionRef.current ? 0 : energy);
      gl.uniform1f(uSpread, SPREAD[current]);
      gl.uniform1f(uFlare, FLARE[current]);
      /* Only on change: rgb() parses a string and allocates a tuple, and doing
         that 60 times a second to send three bytes that alter twice a day is
         exactly the kind of per-frame garbage this rewrite exists to remove. */
      if (tintRef.current !== sentTint) {
        sentTint = tintRef.current;
        const [cr, cg, cb] = rgb(sentTint);
        gl.uniform3f(uTint, cr, cg, cb);
      }
      gl.drawArrays(gl.POINTS, 0, points);
      gl.endFrameEXP();

      contextAlive.frame = requestAnimationFrame(draw);
    };

    draw();
  }

  return (
    <View
      // Decorative, exactly as the View field: the screen around it says what
      // EVE is doing in text, and a screen reader has no use for a sphere of dots.
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: "hidden",
        backgroundColor: backdrop,
      }}
    >
      <GLView
        /* onContextCreate fires once per context, and the vertex buffer is
           uploaded there from a `points`-sized array. Remounting on a density
           change is what makes the prop actually mean something — without the
           key it would silently keep drawing the old sphere. Keyed on `points`
           rather than `count` because u_pointBase is solved from `points` at
           setup time too, so both the buffer and the sizing go stale together. */
        key={points}
        style={{ width: size, height: size }}
        onContextCreate={onContextCreate}
      />
    </View>
  );
}
