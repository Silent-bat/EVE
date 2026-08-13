import { CAMERA_GLSL, NOISE_GLSL } from "./glsl";
import type { OrbGeometry, OrbSpec } from "./types";

/**
 * Orb 2 -- particleorb2.jpg
 *
 * Monochrome and structured. The reference gives its construction away: dots
 * sit in visible ROWS and COLUMNS across the whole disc, with a bright seam on
 * the equator and a vertical seam on one meridian that juts out past the limb.
 * That is a lat/long lattice, pole crowding and all -- the artefacts are the
 * look, so unlike orb 1 this deliberately does not use even sphere sampling.
 *
 * Two things matter for the read, and both are easy to get wrong:
 *  - The grid must be COARSE. Individual dots have to be resolvable; a fine
 *    lattice collapses into moire and the structure disappears.
 *  - The face must be LIT ENOUGH TO SEE. The reference's interior dots are dim
 *    but clearly present. Crushing them to black leaves a hollow ring.
 *
 * Displacement is radial only -- lateral flow would shear the grid apart. High
 * frequency radial noise at the limb is what makes the rim look hairy, because
 * at the silhouette a radial offset is a screen-space offset.
 */

const VERT = /* glsl */ `
precision highp float;

attribute vec3 a_base;
attribute vec4 a_rand;

uniform vec2  u_resolution;
uniform float u_time;
uniform float u_camDist;
uniform float u_fov;
uniform float u_flow;
uniform float u_size;
uniform float u_energy;

varying float v_bright;
varying float v_hard;

${NOISE_GLSL}
${CAMERA_GLSL}

void main() {
  vec3 dir = normalize(a_base);
  float shell = length(a_base);
  float isHaze = step(0.5, a_rand.w);
  float seam = a_rand.x;

  // Radial displacement cannot change a particle's direction, so the rotated
  // direction is the surface normal and the rim term can be computed up front.
  mat3 rot = rotY(u_time * 0.055) * rotX(-0.10);
  vec3 n = rot * dir;
  float rim = pow(1.0 - abs(n.z), 3.0);

  // Low frequency lumps the outline; high frequency makes the limb hairy. The
  // hair is scaled by rim so it only erupts where it will read.
  float lump = snoise(dir * 1.7 + vec3(0.0, u_time * 0.05, 0.0));
  float hair = snoise(dir * 9.5 - vec3(u_time * 0.06, 0.0, 0.0));
  float push = (lump * 0.055 + hair * 0.055 * (0.25 + 1.5 * rim)) * u_flow;

  vec3 pos = n * (shell + push);

  // Halftone weighting: dot brightness varies over a smooth field, which is
  // what makes the lattice read as printed dots of uneven weight.
  float halftone = snoise(dir * 3.4 + vec3(0.0, 0.0, u_time * 0.06)) * 0.5 + 0.5;

  float depth = smoothstep(-1.0, 1.0, n.z);
  float backSide = mix(0.5, 1.0, depth);

  // Face stays visible; the rim runs several times hotter and clips to white.
  float bright = 0.16 + 2.6 * rim;
  bright *= mix(0.35, 1.15, halftone);
  bright *= backSide * a_rand.z;
  bright *= mix(1.0, 0.35 + 2.2 * rim, isHaze);
  bright *= 1.0 + seam * (1.4 + 2.0 * rim);
  v_bright = bright * (0.75 + 0.5 * u_energy);

  // Lattice dots stay crisp; haze motes get a softer edge.
  v_hard = 1.0 - isHaze;

  float size = u_size * a_rand.y * (0.9 + 0.5 * rim) * mix(1.0, 0.75, isHaze);
  size *= 1.0 + seam * 0.25;
  gl_PointSize = projectPoint(pos, size, u_resolution, u_camDist, u_fov);
}
`;

const FRAG = /* glsl */ `
precision mediump float;

varying float v_bright;
varying float v_hard;

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float d = length(uv);
  if (d > 1.0) discard;

  // Crisp disc for the lattice, soft falloff for the haze.
  float crisp = 1.0 - smoothstep(0.68, 1.0, d);
  float soft = 1.0 - smoothstep(0.0, 1.0, d);
  float alpha = mix(soft, crisp, v_hard) * v_bright;
  if (alpha < 0.004) discard;

  // Neutral, a hair cool. The reference is essentially greyscale.
  vec3 c = vec3(0.955, 0.965, 1.0);
  gl_FragColor = vec4(c * alpha, alpha);
}
`;

function build(targetCount: number): OrbGeometry {
  let s = 0x1f123bb5;
  const rnd = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Grid resolution is capped hard. Counting dots across the reference gives
  // roughly 100 rows; letting targetCount drive this past ~120 rows destroys
  // the halftone read, so extra budget goes to haze instead of a finer grid.
  const rows = Math.max(28, Math.min(104, Math.round(Math.sqrt(targetCount * 0.36))));
  const cols = rows * 2;
  const latticeCount = rows * cols;
  const count = Math.max(latticeCount, targetCount);

  const base = new Float32Array(count * 3);
  const rand = new Float32Array(count * 4);

  // Seam rows/columns: the bright equator and the vertical meridian.
  const equatorRow = Math.round((rows - 1) / 2);
  const meridianCol = 0;

  let i = 0;

  // -- lattice ------------------------------------------------------------
  for (let iy = 0; iy < rows; iy++) {
    const theta = (iy / (rows - 1)) * Math.PI;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);

    for (let ix = 0; ix < cols; ix++) {
      const phi = (ix / cols) * Math.PI * 2;
      const jitter = 1 + (rnd() - 0.5) * 0.01;

      base[i * 3 + 0] = sinT * Math.cos(phi) * jitter;
      base[i * 3 + 1] = cosT * jitter;
      base[i * 3 + 2] = sinT * Math.sin(phi) * jitter;

      const onSeam = iy === equatorRow || ix === meridianCol;
      rand[i * 4 + 0] = onSeam ? 1 : 0;
      rand[i * 4 + 1] = 0.85 + rnd() * 0.35;
      rand[i * 4 + 2] = rnd() < 0.01 ? 2.2 + rnd() * 1.8 : 0.7 + rnd() * 0.5;
      rand[i * 4 + 3] = 0; // lattice
      i++;
    }
  }

  // -- haze ---------------------------------------------------------------
  for (; i < count; i++) {
    const u = rnd() * 2 - 1;
    const phi = rnd() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    const shell = 1.0 + Math.pow(rnd(), 1.6) * 0.26;

    base[i * 3 + 0] = r * Math.cos(phi) * shell;
    base[i * 3 + 1] = u * shell;
    base[i * 3 + 2] = r * Math.sin(phi) * shell;

    rand[i * 4 + 0] = 0;
    rand[i * 4 + 1] = 0.45 + rnd() * 0.55;
    rand[i * 4 + 2] = 0.4 + rnd() * 0.9;
    rand[i * 4 + 3] = 1; // haze
  }

  return { base, rand, count };
}

export const ORB2: OrbSpec = {
  id: "orb2",
  label: "Orb 2 — halftone lattice",
  note: "Coarse lat/long grid with equator and meridian seams, radial noise only, hairy rim.",
  vert: VERT,
  frag: FRAG,
  defaultCount: 46000,
  camDist: 3.2,
  fov: 0.92,
  build,
};
