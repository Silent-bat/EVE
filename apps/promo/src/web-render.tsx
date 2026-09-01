import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Player } from "@remotion/player";
import { canRenderMediaOnWeb, renderMediaOnWeb } from "@remotion/web-renderer";
import { EvePromo } from "./EvePromo";
import dashboard from "../public/eve-dashboard.png";
import icon from "../public/eve-icon.png";
import orb from "../public/eve-orb.jpg";

window.remotion_staticFiles = [
  { name: "eve-dashboard.png", src: dashboard, sizeInBytes: 0, lastModified: 0 },
  { name: "eve-icon.png", src: icon, sizeInBytes: 0, lastModified: 0 },
  { name: "eve-orb.jpg", src: orb, sizeInBytes: 0, lastModified: 0 },
];

const composition = {
  id: "EvePromoVertical",
  component: EvePromo,
  durationInFrames: 1620,
  fps: 30,
  width: 1080,
  height: 1920,
  defaultProps: { renderAudio: false },
};

const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") ?? "player";
const initialFrame = Number(params.get("frame") ?? 90);

const Renderer = () => {
  const [status, setStatus] = useState("Ready to render");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const scale = Number(params.get("scale") ?? 0.5);

  const render = async () => {
    try {
      setDownloadUrl(null);
      setStatus("Checking browser codecs...");
      const support = await canRenderMediaOnWeb({
        container: "mp4",
        videoCodec: "h264",
        audioCodec: null,
        muted: true,
        width: composition.width * scale,
        height: composition.height * scale,
      });

      if (!support.canRender) {
        setStatus(`Cannot render: ${support.issues.map((issue) => issue.message).join("; ")}`);
        return;
      }

      setStatus("Rendering 0%");
      const result = await renderMediaOnWeb({
        composition,
        inputProps: { renderAudio: false },
        container: "mp4",
        videoCodec: "h264",
        audioCodec: null,
        muted: true,
        scale,
        hardwareAcceleration: "prefer-software",
        videoBitrate: scale === 1 ? "very-high" : "high",
        onProgress: ({ progress }) => setStatus(`Rendering ${Math.round(progress * 100)}%`),
      });
      const blob = await result.getBlob();
      const url = URL.createObjectURL(blob);
      setDownloadUrl(url);
      setStatus("Render complete");
    } catch (error) {
      setStatus(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <main className="render-page">
      <h1>EVE browser render</h1>
      <p id="render-status">{status}</p>
      <button id="render-button" type="button" onClick={render}>
        Render video
      </button>
      {downloadUrl ? (
        <a
          id="download-link"
          href={downloadUrl}
          download={scale === 1 ? "eve-promo-video-only.mp4" : "eve-promo-preview-video-only.mp4"}
        >
          Download MP4
        </a>
      ) : null}
    </main>
  );
};

const Preview = () => (
  <main className="preview-page">
    <Player
      component={EvePromo}
      durationInFrames={1620}
      compositionWidth={1080}
      compositionHeight={1920}
      fps={30}
      inputProps={{ renderAudio: false }}
      initialFrame={initialFrame}
      controls={false}
      autoPlay={false}
      style={{ width: 540, height: 960 }}
    />
  </main>
);

const style = document.createElement("style");
style.textContent = `
  * { box-sizing: border-box; }
  html, body, #root { margin: 0; min-height: 100%; font-family: Inter, Arial, sans-serif; background: #111116; }
  .preview-page { width: 540px; height: 960px; overflow: hidden; }
  .render-page { min-height: 100vh; display: grid; place-content: center; gap: 20px; padding: 40px; color: white; text-align: center; }
  .render-page h1 { margin: 0; font-size: 34px; }
  .render-page p { margin: 0; color: #c7c5ce; font-size: 20px; }
  .render-page button, .render-page a { border: 0; padding: 18px 28px; background: #7656e8; color: white; font: inherit; font-weight: 800; text-decoration: none; cursor: pointer; }
`;
document.head.appendChild(style);

createRoot(document.getElementById("root")!).render(mode === "render" ? <Renderer /> : <Preview />);
