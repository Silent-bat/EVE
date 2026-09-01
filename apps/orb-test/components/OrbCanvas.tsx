"use client";

import { useEffect, useRef, useState } from "react";

import { bindAttrib, createAttrib, createProgram, getUniforms } from "@/lib/webgl";
import type { OrbSpec } from "@/lib/types";

const UNIFORM_NAMES = [
  "u_resolution",
  "u_time",
  "u_camDist",
  "u_fov",
  "u_flow",
  "u_size",
  "u_energy",
  // The mobile-bound specs only. A shader that does not declare one gets a null
  // location, and WebGL ignores a uniform write to null, so the whole list can
  // be set unconditionally.
  "u_spin",
  "u_spread",
  "u_erupt",
  "u_tint",
  "u_pointBase",
  "u_maxPoint",
] as const;

/**
 * Preview spin rate, radians per second.
 *
 * apps/mobile accumulates this on the CPU so a state change alters the rate
 * from that frame on rather than rescaling the whole history. Nothing here
 * changes state, so a constant rate times the clock is the same thing.
 */
const PREVIEW_SPIN = 0.3;

/** Preview value for the shell breathing. Mirrors the mobile idle/listening range. */
const PREVIEW_SPREAD = 0.1;

/** EVE's ambient purple, the theme colour the field washes its cold dust with. */
const PREVIEW_TINT = [0.659, 0.549, 1.0] as const;

/** DPR above 2 buys nothing visible here and costs fill rate quadratically. */
const MAX_DPR = 2;

export type OrbCanvasProps = {
  spec: OrbSpec;
  count: number;
  flow: number;
  size: number;
  energy: number;
  /**
   * Render exactly one frame at this u_time and stop. Used by the screenshot
   * harness so a capture is reproducible; leave undefined to animate.
   */
  freeze?: number;
  className?: string;
};

export function OrbCanvas({ spec, count, flow, size, energy, freeze, className }: OrbCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Live values for the animated uniforms, so dragging a slider updates the
  // running loop instead of tearing down and rebuilding 90k particles.
  const live = useRef({ flow, size, energy });
  live.current = { flow, size, energy };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      premultipliedAlpha: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true, // so toDataURL / screenshots capture the frame
    });

    if (!gl) {
      setError("WebGL is not available in this browser.");
      return;
    }

    let program: WebGLProgram;
    try {
      program = createProgram(gl, spec.vert, spec.frag);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    const geometry = spec.build(count);
    const aBase = createAttrib(gl, program, "a_base", geometry.base, 3);
    const aRand = createAttrib(gl, program, "a_rand", geometry.rand, 4);
    const uniforms = getUniforms(gl, program, UNIFORM_NAMES);

    gl.useProgram(program);
    bindAttrib(gl, aBase);
    bindAttrib(gl, aRand);

    // Additive, premultiplied. Overlapping motes accumulate into the glow --
    // that is what builds the bright limb out of individually dim particles.
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.clearColor(0.016, 0.016, 0.027, 1);

    let width = 0;
    let height = 0;
    /* Solved from the point count and the drawing buffer, so it has to be
       recomputed whenever the buffer resizes. -1 means "not solved yet". */
    let pointBase = -1;
    const maxPoint = (() => {
      const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | null;
      return range && range[1] ? Number(range[1]) : 64;
    })();

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (w === width && h === height) return false;

      width = w;
      height = h;
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      pointBase = spec.solvePointBase ? spec.solvePointBase(geometry, w, h) : -1;
      return true;
    };

    const draw = (time: number) => {
      resize();
      gl.clear(gl.COLOR_BUFFER_BIT);

      // u_resolution is in PHYSICAL pixels because gl_PointSize is. Passing CSS
      // pixels here draws the cloud about DPR-times too small.
      gl.uniform2f(uniforms.u_resolution, width, height);
      gl.uniform1f(uniforms.u_time, time);
      gl.uniform1f(uniforms.u_camDist, spec.camDist);
      gl.uniform1f(uniforms.u_fov, spec.fov);
      gl.uniform1f(uniforms.u_flow, live.current.flow);
      gl.uniform1f(uniforms.u_size, live.current.size);
      gl.uniform1f(uniforms.u_energy, live.current.energy);

      // Mobile-bound specs. `flow` doubles as the eruption strength here so the
      // slider still means something on the /eve page.
      gl.uniform1f(uniforms.u_spin, time * PREVIEW_SPIN);
      gl.uniform1f(uniforms.u_spread, PREVIEW_SPREAD);
      gl.uniform1f(uniforms.u_erupt, live.current.flow);
      gl.uniform3f(uniforms.u_tint, PREVIEW_TINT[0], PREVIEW_TINT[1], PREVIEW_TINT[2]);
      if (pointBase > 0) {
        gl.uniform1f(uniforms.u_pointBase, pointBase);
        gl.uniform1f(uniforms.u_maxPoint, maxPoint);
      }

      gl.drawArrays(gl.POINTS, 0, geometry.count);
    };

    let frame = 0;
    let cancelled = false;

    if (freeze !== undefined) {
      draw(freeze);
      canvas.dataset.orbReady = "1";
    } else {
      const start = performance.now();
      const loop = () => {
        // Checked before re-arming as well as before drawing: a loop that
        // re-arms after unmount keeps a dead GL context alive forever.
        if (cancelled) return;
        draw((performance.now() - start) / 1000);
        frame = requestAnimationFrame(loop);
      };
      frame = requestAnimationFrame(loop);
      canvas.dataset.orbReady = "1";
    }

    const observer = new ResizeObserver(() => {
      if (freeze !== undefined && !cancelled) draw(freeze);
    });
    observer.observe(canvas);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      delete canvas.dataset.orbReady;

      gl.deleteBuffer(aBase.buffer);
      gl.deleteBuffer(aRand.buffer);
      gl.deleteProgram(program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
    // flow/size/energy deliberately excluded -- they flow through `live`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, count, freeze]);

  return (
    <div className={className}>
      <canvas ref={canvasRef} className="orb-canvas" />
      {error ? <pre className="orb-error">{error}</pre> : null}
    </div>
  );
}
