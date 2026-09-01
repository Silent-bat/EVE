/*
 * Offline validator for ParticleFieldGL.
 *
 * There is no GLSL toolchain on this machine and no headless GL, so nothing here
 * compiles the shader — a driver rejection only ever shows on device. What this
 * does check is everything that can be checked by parsing the source and
 * replaying its JS-side arithmetic, which turns out to be most of the ways this
 * file has actually broken:
 *
 *  - a backtick inside a GLSL comment, which terminates the enclosing JS
 *    template literal and surfaces as a baffling TS1005 in the JavaScript
 *  - a varying written in one stage and not declared in the other (a link error)
 *  - a uniform renamed in the shader and left stale in the JS lookups
 *  - the attribute table drifting from the shader's own attribute list
 *  - the coverage solve and its JS mirror drifting apart, which silently changes
 *    how much ink lands on screen
 *
 * Run: node apps/mobile/scripts/check-orb.js
 *
 * The GLSL parser lives outside the repo (it is a checking tool, not a
 * dependency) — set ORB_CHECK_MODULES to a node_modules containing
 * glsl-tokenizer and glsl-parser to enable the parse checks. Everything else
 * runs regardless.
 */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src", "ui", "components", "ParticleFieldGL.tsx");
const src = fs.readFileSync(SRC, "utf8");

function extract(name) {
  const m = src.match(new RegExp("const " + name + " = `([\\s\\S]*?)`;"));
  if (!m) throw new Error("could not extract " + name);
  return m[1];
}

let failed = false;
const vertex = extract("VERTEX");
const fragment = extract("FRAGMENT");

function report(label, ok, detail) {
  if (!ok) failed = true;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (detail ? "  " + detail : ""));
}

// ---- parse ---------------------------------------------------------------
console.log("--- parse ---");
const MODULES = process.env.ORB_CHECK_MODULES;
if (MODULES) {
  const tokenizer = require(path.join(MODULES, "glsl-tokenizer"));
  const parser = require(path.join(MODULES, "glsl-parser/direct"));
  for (const [name, code] of [
    ["VERTEX", vertex],
    ["FRAGMENT", fragment],
  ]) {
    try {
      const tokens = tokenizer(code);
      const bad = tokens.filter((t) => t.type === "invalid");
      parser(tokens);
      report(
        name + " parses (" + tokens.length + " tokens, " + code.split("\n").length + " lines)",
        bad.length === 0,
        bad.length ? "invalid: " + bad.map((t) => t.data).join(", ") : "",
      );
    } catch (e) {
      report(name + " parses", false, e.message);
    }
  }
} else {
  console.log("  skip  GLSL parse (set ORB_CHECK_MODULES to enable)");
}

// ---- source-level invariants --------------------------------------------
console.log("\n--- shader plumbing ---");

/* The varyings the two stages must agree on. A varying written in one stage and
   not declared in the other is a link error the driver reports only on device,
   which is the whole reason this check exists. */
const VARYINGS = ["v_defocus", "v_alpha", "v_hue", "v_heat"];

const checks = [
  /* This one has cost real time twice. A backtick anywhere in the GLSL ends the
     JS template literal early, and the error lands on a JS line, not a GLSL one. */
  ["no backtick inside GLSL", !vertex.includes("`") && !fragment.includes("`")],
  ["vertex declares highp (required in the vertex stage)", /precision\s+highp\s+float/.test(vertex)],
  [
    "fragment guards highp behind the ifdef",
    /#ifdef GL_FRAGMENT_PRECISION_HIGH[\s\S]*precision highp float[\s\S]*#else[\s\S]*precision mediump float[\s\S]*#endif/.test(
      fragment,
    ),
  ],
  [
    "no local shadowing step/mix/length",
    !/\b(float|int|vec\d|mat\d)\s+(step|mix|length)\s*[=;(]/.test(vertex + fragment),
  ],
  ["no while/unbounded loop (GLSL ES 1.0)", !/\bwhile\s*\(/.test(vertex + fragment)],
  ["every varying written in vertex", VARYINGS.every((v) => new RegExp(v + "\\s*=").test(vertex))],
  [
    "every varying declared in fragment",
    VARYINGS.every((v) => new RegExp("varying float " + v).test(fragment)),
  ],
  [
    "every varying declared in vertex too",
    VARYINGS.every((v) => new RegExp("varying float " + v).test(vertex)),
  ],
  [
    "no varying declared in fragment and never written in vertex",
    [...fragment.matchAll(/varying\s+\w+\s+(\w+)/g)]
      .map((m) => m[1])
      .every((v) => new RegExp(v + "\\s*=").test(vertex)),
  ],
  /* Names from earlier versions of this shader. Each was a real uniform or
     varying once; a leftover reference is dead code at best and a stale lookup
     at worst. */
  [
    "no stale u_hueA/u_hueB/u_hueC/u_cycle/u_resolution",
    !/u_hueA|u_hueB|u_hueC|u_cycle|u_resolution/.test(src),
  ],
  ["no stale v_shade/a_shade/a_depth", !/v_shade|a_shade|a_depth/.test(src)],
  [
    "no stale RMS_MODULATION declaration (it is measured now, not hardcoded)",
    !/const\s+RMS_MODULATION\s*=/.test(src),
  ],
  [
    "gl_PointSize is solved from u_pointBase and clamped",
    /gl_PointSize[\s\S]*u_maxPoint/.test(vertex) && /u_pointBase/.test(vertex),
  ],
  ["resolution is handled on the CPU, not in the shader", !/u_resolution/.test(vertex)],
];

// Vertex attributes must match the ATTRIBUTES table the JS side iterates.
const declared = [...vertex.matchAll(/attribute\s+\w+\s+(\w+)/g)].map((m) => m[1]).sort();
const wired = [...src.matchAll(/name:\s*"(a_\w+)"/g)].map((m) => m[1]).sort();
checks.push([
  "attributes match ATTRIBUTES (" + declared.join(",") + ")",
  JSON.stringify(declared) === JSON.stringify(wired),
]);

// Every uniform the shaders declare must be looked up somewhere in the JS.
const shaderSource = (vertex + "\n" + fragment).replace(/\/\*[\s\S]*?\*\//g, "");
const uniforms = [...shaderSource.matchAll(/uniform\s+\w+\s+(\w+)/g)].map((m) => m[1]);
const missingU = uniforms.filter((u) => !new RegExp('"' + u + '"').test(src));
checks.push([
  "every uniform is looked up in JS" + (missingU.length ? " — missing " + missingU.join(",") : ""),
  missingU.length === 0,
]);

// STRIDE_FLOATS must equal the largest offset/4 plus its element count.
const stride = Number(src.match(/STRIDE_FLOATS = (\d+)/)[1]);
const maxEnd = Math.max(
  ...[...src.matchAll(/elements:\s*(\d+),\s*offset:\s*(\d+)/g)].map((m) => Number(m[2]) / 4 + Number(m[1])),
);
checks.push(["STRIDE_FLOATS (" + stride + ") == packed size (" + maxEnd + ")", stride === maxEnd]);

console.log("\n--- structure (the reference's load-bearing properties) ---");

/* The arc count is set by an explicit cosine. A pure noise field cannot fix a
   harmonic mode — it only makes one likely — so if this degrades to noise alone
   the arcs wander frame to frame and the structure goes with them. */
checks.push([
  "arcs are anchored by an explicit cos(N*az), not left to noise",
  /cos\(\s*5\.0\s*\*\s*az/.test(vertex),
]);

// atan(0,0) is undefined, which is exactly both poles, and the NaN propagates
// into position, size and colour for those vertices.
checks.push(["azimuth guards atan against the poles", /atan\([^)]*1e-6\)/.test(vertex)]);

/* Filaments must be the ZERO CONTOUR of the lane field, not a threshold on it.
   smoothstep on a noise field lights hilltops, which are round blobs;
   1 - |lane|/w lights the level set, which is a sweeping ribbon. This is the
   single trick that makes the ribbons read as ribbons. */
checks.push([
  "filaments light the zero contour (1 - |lane|/w), not a threshold",
  /float dist = abs\(lane\)/.test(vertex) && /1\.0 - dist \/ [\d.]+/.test(vertex),
]);

/* The rim is geometry: a tight skin shell piling up at its own silhouette, read
   through abs(n.z) so the front and back faces crowd into the same projected
   annulus. No shading exponent can put a brightness maximum mid-disc, so if this
   becomes a signed facing term the ring stops existing. */
checks.push([
  "facing uses abs(n.z) so both faces pile into the limb",
  /float facing = abs\(n\.z\)/.test(vertex),
]);

/* The flare envelope must be normalised to PEAK 1, not mean 1: consumers feed it
   to mix(), which extrapolates past its endpoints rather than clamping.
   Recomputed here rather than trusted — changing a coefficient without the
   divisor is a silent overshoot. */
{
  const m = vertex.match(
    /smoothstep\(0\.0,\s*([\d.]+),\s*cyc\)\s*\*\s*exp\(-([\d.]+)\s*\*\s*cyc\)\s*\/\s*([\d.]+)/,
  );
  let ok = false;
  let detail = "(envelope not found)";
  if (m) {
    const [rise, decay, div] = [Number(m[1]), Number(m[2]), Number(m[3])];
    let peak = 0;
    for (let c = 0; c <= 1; c += 0.0005) {
      const t = Math.min(1, Math.max(0, c / rise));
      peak = Math.max(peak, t * t * (3 - 2 * t) * Math.exp(-decay * c));
    }
    ok = Math.abs(peak / div - 1) < 0.03;
    detail =
      "(peak " + peak.toFixed(3) + " / divisor " + div + " = " + (peak / div).toFixed(3) + ", want 1.0)";
  }
  checks.push(["flare envelope normalised to peak 1 " + detail, ok]);
}

/* Eruptions and lanes must share a frequency. At different scales the eruption
   field stamps its own harmonic across the ridge's, the two interfere, and the
   measured arc count collapses — not visually obvious until the structure is
   already gone. */
{
  const lane = vertex.match(/float lane =[\s\S]*?snoise\(dir \* ([\d.]+)/);
  const phase = vertex.match(/float phase = snoise\(dir \* ([\d.]+)/);
  checks.push([
    "eruption clock shares the lane field's frequency" +
      (lane && phase ? " (" + lane[1] + " / " + phase[1] + ")" : ""),
    Boolean(lane && phase) && lane[1] === phase[1],
  ]);
}

/* u_spread must act INSIDE the radius, before the soft knee. Applied after the
   rotation it sits outside every bound, which is exactly how the louder states
   used to push half the sphere out of the clip volume. */
checks.push([
  "u_spread is folded into radius, ahead of the knee",
  /float radius = shell[\s\S]{0,800}u_spread \* u_energy/.test(vertex) &&
    /radius -= smoothstep\([\d.]+, [\d.]+, radius\)/.test(vertex),
]);

/* Every flare consumer must be bounded, or an eruption at high energy pushes
   alpha and size past their budgets. */
checks.push(["eruption is clamped at the source", /float erupt = clamp\(/.test(vertex)]);

// The warm end must be ADDITIVE. A mix would replace the cool hue and punch a
// yellow hole in the sphere instead of lighting its surface up.
checks.push(["heat is added to the palette, not mixed into it", /c \+=[\s\S]{0,60}v_heat/.test(fragment)]);

// The product palette spans green/cyan/blue/violet. Losing a stop collapses the
// multicolor body into a two-tone wash, especially after premultiplied blending.
checks.push([
  "palette keeps all four stops",
  ["green", "cyan", "blue", "violet"].every((n) => new RegExp("vec3 " + n + "\\s*=").test(fragment)),
]);

// Premultiplied opacity must be bounded before it reaches the framebuffer.
checks.push([
  "fragment opacity is clamped and premultiplied",
  /float opacity = clamp\(/.test(fragment) && /gl_FragColor = vec4\(c \* opacity, opacity\)/.test(fragment),
]);

// Every FieldState must have a SPIN, SPREAD and FLARE entry or the shader gets NaN.
const states = ["idle", "listening", "thinking", "speaking"];
const spinBlock = src.match(/const SPIN[\s\S]*?\};/)[0];
const spreadBlock = src.match(/const SPREAD[\s\S]*?\};/)[0];
const flareBlock = src.match(/const FLARE[\s\S]*?\};/)[0];
checks.push([
  "SPIN, SPREAD and FLARE cover every FieldState",
  states.every(
    (s) => spinBlock.includes(s + ":") && spreadBlock.includes(s + ":") && flareBlock.includes(s + ":"),
  ),
]);

/* The arcs are structure, not decoration: at flare 0 the sphere is a featureless
   ball of dust, so entering speech would read as becoming a different object
   rather than the same one intensifying. Every state must simmer. */
{
  const values = [...flareBlock.matchAll(/(\w+): ([\d.]+)/g)].map((m) => [m[1], Number(m[2])]);
  checks.push([
    "every state keeps some eruption (" + values.map(([k, v]) => k + " " + v).join(", ") + ")",
    values.length === states.length && values.every(([, v]) => v > 0),
  ]);
  const speaking = values.find(([k]) => k === "speaking");
  checks.push([
    "speaking erupts hardest — it is the state the pulse is for",
    Boolean(speaking) && values.every(([k, v]) => k === "speaking" || v < speaking[1]),
  ]);
}

for (const [label, ok] of checks) report(label, ok);

// ---- geometry ------------------------------------------------------------
/* Run the repo's own buildVertices. The four populations are what draw the rim,
   so the check is that each one is actually present at its intended radius and
   weight — a shell that drifts wide stops piling up at its silhouette, and the
   ring it draws is the difference between a ball and a flat disc. */
console.log("\n--- geometry (the repo's own buildVertices) ---");
const buildSrc = src.match(/function buildVertices\([\s\S]*?\n\}/)[0];
const js = ("const STRIDE_FLOATS = " + stride + ";\n" + buildSrc)
  .replace(/:\s*Float32Array/g, "")
  .replace(/:\s*number/g, "");
const mod = { exports: {} };
new Function("module", js + "\nmodule.exports = { buildVertices };")(mod);
const { buildVertices } = mod.exports;

const N = 9000;
const data = buildVertices(N);

const POPS = [
  { name: "skin  ", lo: 0.952, hi: 0.982, want: 0.58 },
  { name: "body  ", lo: 0.62, hi: 0.93, want: 0.21 },
  { name: "core  ", lo: 0.05, hi: 0.35, want: 0.06 },
  { name: "fringe", lo: 0.986, hi: 1.048, want: 0.15 },
];
const hits = POPS.map(() => 0);
let minR = Infinity;
let maxR = -Infinity;
const bands = [0, 0, 0, 0];
const phiBands = [0, 0, 0, 0];
for (let i = 0; i < N; i++) {
  const o = i * stride;
  const x = data[o];
  const y = data[o + 1];
  const z = data[o + 2];
  const r = Math.hypot(x, y, z);
  minR = Math.min(minR, r);
  maxR = Math.max(maxR, r);
  POPS.forEach((p, k) => {
    if (r >= p.lo && r <= p.hi) hits[k] += 1;
  });
  bands[Math.min(3, Math.floor(((y / r) * 0.5 + 0.5) * 4))] += 1;
  phiBands[Math.min(3, Math.floor(((Math.atan2(z, x) + Math.PI) / (2 * Math.PI)) * 4))] += 1;
}

console.log("  radius range: " + minR.toFixed(3) + " .. " + maxR.toFixed(3));
report("nothing seeded past the fringe ceiling", maxR < 1.06, "(max " + maxR.toFixed(3) + ", ceiling 1.048)");
POPS.forEach((p, k) => {
  const got = hits[k] / N;
  report(
    "population " + p.name + " at " + (got * 100).toFixed(1) + "% (want ~" + (p.want * 100).toFixed(0) + "%)",
    Math.abs(got - p.want) < 0.03,
  );
});
/* The skin shell must stay THIN. It was 14% thick once and drew no rim at all:
   the pile-up at the silhouette is what the ring is, and a thick shell spreads
   that pile-up over an annulus wide enough to vanish into the body. */
report("skin shell stays thin enough to pile up (<= 4%)", 0.982 - 0.952 <= 0.04);

const expected = N / 4;
const dev = (a) => Math.max(...a.map((b) => Math.abs(b - expected) / expected));
console.log("  y-bands:   " + bands.join(" / ") + "  (expect ~" + expected + " each)");
report("uniform in solid angle", dev(bands) < 0.1, "max deviation " + (dev(bands) * 100).toFixed(1) + "%");
console.log("  phi-bands: " + phiBands.join(" / "));
report(
  "uniform in longitude",
  dev(phiBands) < 0.1,
  "max deviation " + (dev(phiBands) * 100).toFixed(1) + "%",
);

// Determinism: same count must give a byte-identical buffer, or Fast Refresh
// reshuffles the sphere on every edit.
report(
  "deterministic across rebuilds (Fast Refresh safe)",
  Buffer.compare(Buffer.from(data.buffer), Buffer.from(buildVertices(N).buffer)) === 0,
);

// The sparkle attribute needs its heavy tail — a uniform a_spark loses the few
// genuinely blown-out specks that make a dust field read as dust.
{
  const sparks = Array.from({ length: N }, (_, i) => data[i * stride + 4]);
  const tail = sparks.filter((s) => s > 1.4).length / N;
  report(
    "a_spark keeps its heavy tail (" + (tail * 100).toFixed(2) + "% over 1.4)",
    tail > 0.005 && tail < 0.03 && Math.max(...sparks) > 2.0,
  );
}

// Real call sites are small. Nothing may degenerate or go non-finite there.
for (const n of [100, 1100, 9000]) {
  const small = buildVertices(n);
  let ok = true;
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    for (let f = 0; f < stride; f += 1) if (!Number.isFinite(small[o + f])) ok = false;
    const r = Math.hypot(small[o], small[o + 1], small[o + 2]);
    if (!(r > 0.04 && r < 1.06)) ok = false;
  }
  report("count=" + n + " produces finite, in-range points", ok);
}

// ---- density / coverage --------------------------------------------------
/* Sprite size is solved from the count against a coverage target, so what needs
   checking is that the solve lands where it claims at every real call site — and
   that the JS mirror of the shader's modulation has not drifted from the GLSL,
   since u_pointBase is derived by dividing that term's RMS out. */
console.log("\n--- density / coverage ---");
const perMote = Number(src.match(/POINTS_PER_MOTE = (\d+)/)[1]);
const target = Number(src.match(/TARGET_COVERAGE = ([\d.]+)/)[1]);
const fit = Number(src.match(/const FIT = ([\d.]+)/)[1]);
const minSprite = Number(src.match(/MIN_SPRITE_PX = ([\d.]+)/)[1]);
console.log(
  "  POINTS_PER_MOTE=" +
    perMote +
    "  TARGET_COVERAGE=" +
    target +
    "  FIT=" +
    fit +
    "  MIN_SPRITE_PX=" +
    minSprite,
);

/* The GLSL modulation and its JS mirror must be the same expression. Compared by
   normalising both to a canonical form rather than by eye: they drifted once and
   the result was a field 1.46x too bright, which nothing else catches. */
{
  const glsl = vertex.match(/float modulation = ([^;]+);/)[1];
  const modulationFunction = src.match(/function modulation\([\s\S]*?\n\}/)?.[0] ?? "";
  const jsMirror = modulationFunction.match(/return\s+([\s\S]*?);/);
  const norm = (s) =>
    s
      .replace(/\s+/g, "")
      .replace(/haloFat/g, "(1+smoothstep(0.98,1.052,shell))")
      .replace(/1\.0\+smoothstep/g, "1+smoothstep")
      .replace(/v_defocus|defocus/g, "D")
      .replace(/a_size|sizeJitter/g, "S")
      .replace(/(\d)\.0(?![\d])/g, "$1");
  const canonical = (s) => norm(s).replace(/^\(|\)$/g, "");
  const ok = Boolean(jsMirror) && canonical(glsl) === canonical(jsMirror[1]);
  report(
    "JS modulation() mirrors the GLSL exactly",
    ok,
    ok
      ? ""
      : "\n         GLSL: " +
          norm(glsl) +
          "\n         JS:   " +
          (jsMirror ? norm(jsMirror[1]) : "(not found)"),
  );
}

/* The count ceiling is the fix for a small container: at a fixed coverage,
   more points means smaller sprites, and under ~3px a sprite has no room for the
   fragment shader's falloff and reads as an aliased speck. So the check is that
   every real call site lands at or above MIN_SPRITE_PX. The dock was at 1.79px
   before this existed. */
const FOCAL = Number(vertex.match(/FOCAL = ([\d.]+)/)[1]);
function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
function solveDiameter(count, px) {
  const buf = buildVertices(count);
  let sumSq = 0;
  for (let i = 0; i < count; i += 1) {
    const o = i * stride;
    const shell = Math.hypot(buf[o], buf[o + 1], buf[o + 2]);
    const near = Math.min(1, Math.max(0, (buf[o + 2] + 1.36) / 2.72));
    const defocus = Math.abs(near - FOCAL) / Math.max(FOCAL, 1 - FOCAL);
    const m =
      (1.5 + 2.6 * buf[o + 3]) *
      (0.62 + 0.72 * near) *
      (1 + 1.3 * defocus) *
      (1 + smoothstep(0.98, 1.052, shell));
    sumSq += m * m;
  }
  const rms = Math.sqrt(sumSq / count);
  const disc = Math.PI * Math.pow(fit * 0.5 * px, 2);
  return { d: Math.sqrt((4 * target * disc) / (Math.PI * count)), rms };
}
function resolveCount(motes, px) {
  const ceiling = Math.max(1, Math.round((target * Math.pow(fit * px, 2)) / Math.pow(minSprite, 2)));
  return Math.max(1, Math.round(Math.min(Math.round(motes * perMote), ceiling) / 100) * 100);
}

// The two real call sites, at the test device's 3x density.
for (const site of [
  { name: "home dock  ", motes: 18, dp: 76 },
  { name: "voice screen", motes: 30, dp: 220 },
]) {
  const px = site.dp * 3;
  const count = resolveCount(site.motes, px);
  const { d, rms } = solveDiameter(count, px);
  const coverage = (count * Math.PI * Math.pow(d / 2, 2)) / (Math.PI * Math.pow(fit * 0.5 * px, 2));
  console.log(
    "  " +
      site.name +
      " count=" +
      site.motes +
      " -> " +
      count +
      " points @ " +
      px +
      "px" +
      "  sprite=" +
      d.toFixed(2) +
      "px  rms=" +
      rms.toFixed(3) +
      "  coverage=" +
      coverage.toFixed(3),
  );
  report(site.name + " sprite is large enough to read as dust", d >= minSprite - 0.1);
  report(site.name + " coverage lands on TARGET_COVERAGE", Math.abs(coverage - target) < 0.02);
}

/* Areal density must MATCH across call sites — that is what makes the dock the
   same orb at a smaller size rather than a denser, different one. It was 5.4x
   the full-screen density before the ceiling existed. */
{
  const a = resolveCount(18, 228) / Math.pow(228, 2);
  const b = resolveCount(30, 660) / Math.pow(660, 2);
  report(
    "the two call sites draw the same areal density",
    Math.abs(a / b - 1) < 0.15,
    "(ratio " + (a / b).toFixed(2) + "x)",
  );
}

/* The flare's size excursion rides above the resting coverage budget on purpose,
   but has to stay bounded — a clamp that engages routinely would flatten the
   flare's own dynamic range. */
{
  const heat = Number(vertex.match(/HEAT_SIZE = ([\d.]+)/)[1]);
  report(
    "flare size excursion is bounded (x" + (1 + heat).toFixed(2) + " at full heat)",
    heat > 0 && 1 + heat < 3,
  );
}

console.log(failed ? "\nFAILED\n" : "\nall checks passed\n");
process.exit(failed ? 1 : 0);
