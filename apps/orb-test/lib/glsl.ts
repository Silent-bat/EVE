/**
 * Shared GLSL chunks.
 *
 * Kept as plain string constants rather than .glsl files so they can be pasted
 * straight into apps/mobile ParticleFieldGL.tsx, which builds its sources the
 * same way. Note: never put a backtick inside these strings, including in a
 * comment -- it terminates the template literal and surfaces as a confusing
 * TS1005 in the JavaScript rather than a shader error.
 */

/** Ashima / Stefan Gustavson simplex noise (public domain), plus curl. */
export const NOISE_GLSL = /* glsl */ `
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
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

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

vec3 snoiseVec3(vec3 p) {
  return vec3(
    snoise(p),
    snoise(p + vec3(19.19, 33.71, 7.13)),
    snoise(p + vec3(-41.27, 11.53, 61.07))
  );
}

/**
 * Curl of a 3-component noise potential. Divergence-free, so the flow swirls
 * instead of piling particles into sinks -- that is the whole reason to use
 * curl noise rather than sampling noise as a displacement.
 */
vec3 curlNoise(vec3 p) {
  const float e = 0.28;
  vec3 dx = vec3(e, 0.0, 0.0);
  vec3 dy = vec3(0.0, e, 0.0);
  vec3 dz = vec3(0.0, 0.0, e);

  vec3 px0 = snoiseVec3(p - dx);
  vec3 px1 = snoiseVec3(p + dx);
  vec3 py0 = snoiseVec3(p - dy);
  vec3 py1 = snoiseVec3(p + dy);
  vec3 pz0 = snoiseVec3(p - dz);
  vec3 pz1 = snoiseVec3(p + dz);

  float cx = (py1.z - py0.z) - (pz1.y - pz0.y);
  float cy = (pz1.x - pz0.x) - (px1.z - px0.z);
  float cz = (px1.y - px0.y) - (py1.x - py0.x);

  vec3 c = vec3(cx, cy, cz);
  float len = length(c);
  return len > 1e-5 ? c / len : vec3(0.0);
}
`;

/** Rotation helpers and the perspective point-size projection. */
export const CAMERA_GLSL = /* glsl */ `
mat3 rotY(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
}

mat3 rotX(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c);
}

/**
 * Writes gl_Position and returns the point size in DEVICE pixels.
 * gl_PointSize is physical pixels, so u_resolution must already carry the
 * device pixel ratio -- passing CSS pixels here draws the cloud too small.
 */
float projectPoint(vec3 world, float worldSize, vec2 res, float camDist, float fov) {
  vec3 view = world - vec3(0.0, 0.0, camDist);
  float f = 1.0 / tan(fov * 0.5);
  float dist = max(-view.z, 0.05);
  float aspect = res.x / res.y;

  // Depth test is off (additive blending), so z can sit at 0 in NDC.
  gl_Position = vec4(view.x * f / aspect, view.y * f, 0.0, dist);

  return max(1.0, worldSize * (res.y * f * 0.5) / dist);
}
`;
