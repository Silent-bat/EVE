import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const preview = process.argv.includes("--preview");
const framesDir = resolve(root, "out", preview ? "preview-frames" : "frames");
const output = resolve(root, "out", preview ? "eve-promo-preview.mp4" : "eve-promo-vertical.mp4");
const remotionCandidates = [
  resolve(root, "node_modules", ".bin", "remotion"),
  resolve(root, "..", "..", "node_modules", ".bin", "remotion"),
];
const remotion = remotionCandidates.find((candidate) => existsSync(candidate));
const audio = resolve(root, "public", "eve-promo-audio.m4a");

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

if (!remotion) {
  throw new Error("Remotion is not installed. Run `pnpm install` from the repository root.");
}

mkdirSync(resolve(root, "out"), { recursive: true });
rmSync(framesDir, { recursive: true, force: true });

const renderArgs = [
  "render",
  "src/index.ts",
  "EvePromoVertical",
  framesDir,
  "--sequence",
  "--image-format=jpeg",
  "--jpeg-quality=92",
  "--concurrency=2",
  '--props={"renderAudio":false}',
];

if (preview) {
  renderArgs.push("--scale=0.5");
}

run(remotion, renderArgs);

run("ffmpeg", [
  "-y",
  "-framerate",
  "30",
  "-start_number",
  "0",
  "-i",
  resolve(framesDir, "element-%04d.jpeg"),
  "-i",
  audio,
  "-c:v",
  "libx264",
  "-preset",
  "medium",
  "-crf",
  preview ? "24" : "18",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-b:a",
  "192k",
  "-shortest",
  "-movflags",
  "+faststart",
  output,
]);

rmSync(framesDir, { recursive: true, force: true });
console.log(`Created ${output}`);
