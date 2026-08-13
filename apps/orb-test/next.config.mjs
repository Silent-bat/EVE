import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // There is a stray pnpm-lock.yaml one directory above the repo, which makes
  // Next infer ~/Desktop as the workspace root. Pin it to the EVE repo.
  outputFileTracingRoot: resolve(here, "../.."),
};

export default nextConfig;
