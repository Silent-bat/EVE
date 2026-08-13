/**
 * Screenshot harness.
 *
 * Boots the production build, loads each orb frozen at a fixed u_time so the
 * capture is reproducible, and writes PNGs next to the reference images for a
 * side-by-side comparison.
 *
 * Usage: pnpm --filter @eve/orb-test capture
 */

import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { launchChromium } from "./browser.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "captures");
const PORT = Number(process.env.PORT ?? 3211);
const ORIGIN = `http://127.0.0.1:${PORT}`;

// Square viewport: both references are square, and a non-square canvas changes
// how much of the sphere the fov covers, which would make the diff meaningless.
const VIEWPORT = { width: 900, height: 900 };
// Overridable because orb1's fringe is time-varying: active regions erupt and
// subside on their own clocks, so any single frame is one sample of a
// distribution. Sweeping FREEZE is how you tell a real profile change from the
// frame you happened to catch. SUFFIX keeps a sweep's shots from overwriting
// each other, ONLY skips the orb you are not measuring.
const FREEZE = Number(process.env.FREEZE ?? 6);
const SUFFIX = process.env.SUFFIX ?? "";
const ONLY = process.env.ONLY;
// The EVE field's look depends on amplitude as much as on the clock: the whole
// point of the pulse is that the orb is a different object while she is talking.
// So the shot needs to say which state it is capturing.
const ENERGY = Number(process.env.ENERGY ?? 0.5);
const ERUPT = Number(process.env.ERUPT ?? 1);

const SHOTS = [
  {
    id: `eve${SUFFIX}`,
    path: `/eve?bare=1&freeze=${FREEZE}&energy=${ENERGY}&erupt=${ERUPT}`,
  },
  { id: `orb1${SUFFIX}`, path: `/orb1?bare=1&freeze=${FREEZE}` },
  { id: `orb2${SUFFIX}`, path: `/orb2?bare=1&freeze=${FREEZE}` },
].filter((s) => !ONLY || s.id.startsWith(ONLY));

async function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`server did not become ready at ${url}`);
}

async function main() {
  const { chromium } = await import("playwright");
  // A full run owns the directory and clears it, so stale shots can never be
  // mistaken for current ones. A sweep does not: it writes one suffixed frame per
  // invocation and every earlier frame is the point, so wiping would leave only
  // the last one.
  if (!ONLY && !SUFFIX) await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // The repo uses node-linker=hoisted, so there is no apps/orb-test/node_modules
  // and no local .bin. Resolve the CLI through node instead of guessing a path.
  const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
  const server = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", () => {});
  server.stderr.on("data", (d) => process.stderr.write(d));

  let browser;
  try {
    await waitForServer(ORIGIN);

    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });

    const problems = [];
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      // Browser-initiated favicon probes 404 on some paths and are not our bug.
      if (/favicon/i.test(msg.location()?.url ?? "")) return;
      problems.push(`${msg.text()} (${msg.location()?.url ?? "?"})`);
    });
    page.on("pageerror", (err) => problems.push(String(err)));

    for (const shot of SHOTS) {
      await page.goto(`${ORIGIN}${shot.path}`, { waitUntil: "networkidle" });
      await page.waitForSelector("canvas[data-orb-ready='1']", { timeout: 20000 });

      const shaderError = await page.locator(".orb-error").count();
      if (shaderError > 0) {
        throw new Error(`${shot.id}: ${await page.locator(".orb-error").innerText()}`);
      }

      // One extra rAF tick so the frozen draw has certainly landed in the
      // preserved drawing buffer before the screenshot reads it back.
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );

      const file = resolve(OUT, `${shot.id}.png`);
      await page.locator("canvas").screenshot({ path: file });

      // Guard against the classic silent failure: a black PNG that looks like a
      // successful capture. Sample the canvas and require real luminance.
      const stats = await page.evaluate(() => {
        const canvas = document.querySelector("canvas");
        const gl = canvas.getContext("webgl");
        const w = canvas.width;
        const h = canvas.height;
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

        let lit = 0;
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) {
          const l = (px[i] + px[i + 1] + px[i + 2]) / 3;
          sum += l;
          if (l > 24) lit++;
        }
        return { w, h, litFraction: lit / (w * h), meanLuma: sum / (w * h) };
      });

      console.log(
        `${shot.id}: ${stats.w}x${stats.h} lit=${(stats.litFraction * 100).toFixed(1)}% ` +
          `mean=${stats.meanLuma.toFixed(1)} -> captures/${shot.id}.png`,
      );

      if (stats.litFraction < 0.01) {
        throw new Error(`${shot.id}: canvas is effectively black (nothing rendered)`);
      }
    }

    if (problems.length) {
      throw new Error(`console errors:\n${problems.join("\n")}`);
    }
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
  }
}

await main();
