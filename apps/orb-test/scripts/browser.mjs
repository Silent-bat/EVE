/**
 * Shared browser launch.
 *
 * Two wrinkles on this machine:
 *  - Playwright refuses to download its bundled Chromium ("does not support
 *    chromium on mac13"), so we fall back to the installed Google Chrome.
 *  - Headless has no real GPU, so WebGL must be forced onto SwiftShader or the
 *    canvas comes back blank with no error.
 */

const GL_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

export async function launchChromium(chromium) {
  try {
    return await chromium.launch({ args: GL_ARGS });
  } catch {
    return await chromium.launch({ channel: "chrome", args: GL_ARGS });
  }
}
