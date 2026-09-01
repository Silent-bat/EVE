import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const preview = process.argv.includes("--preview");
const scale = preview ? 0.5 : 1;
const outputDir = resolve(root, "out");
const videoOnly = resolve(
  outputDir,
  preview ? "eve-promo-preview-video-only.mp4" : "eve-promo-video-only.mp4",
);
const output = resolve(outputDir, preview ? "eve-promo-preview.mp4" : "eve-promo-vertical.mp4");
const audio = resolve(root, "public", "eve-promo-audio.m4a");
const wrapper = resolve(root, "scripts", "chrome-sandbox-wrapper.sh");
const pageUrl = `${pathToFileURL(resolve(root, "web-render", "index.html")).href}?mode=render&scale=${scale}`;

mkdirSync(outputDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: wrapper,
  args: ["--no-sandbox", "--disable-gpu"],
});

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.goto(pageUrl, { waitUntil: "load" });
  await page.click("#render-button");

  let lastStatus = "";
  const timeoutAt = Date.now() + 20 * 60 * 1000;
  while (Date.now() < timeoutAt) {
    const status = (await page.textContent("#render-status")) ?? "";
    if (status !== lastStatus) {
      console.log(status);
      lastStatus = status;
    }
    if (status === "Render complete") {
      break;
    }
    if (status.startsWith("Failed:") || status.startsWith("Cannot render:")) {
      throw new Error(status);
    }
    await page.waitForTimeout(1000);
  }

  if (lastStatus !== "Render complete") {
    throw new Error("Browser render timed out after 20 minutes");
  }

  const downloadPromise = page.waitForEvent("download");
  await page.click("#download-link");
  const download = await downloadPromise;
  await download.saveAs(videoOnly);
} finally {
  await browser.close();
}

const mux = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-i",
    videoOnly,
    "-i",
    audio,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    "-movflags",
    "+faststart",
    output,
  ],
  { cwd: root, stdio: "inherit" },
);

if (mux.error) {
  throw mux.error;
}
if (mux.status !== 0) {
  process.exit(mux.status ?? 1);
}

console.log(`Created ${output}`);
