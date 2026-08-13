/**
 * Minimal WebGL1 plumbing.
 *
 * WebGL1 / GLSL ES 1.00 on purpose: expo-gl targets WebGL1, so shaders written
 * here paste into apps/mobile without a rewrite. That is the whole point of
 * this test bed -- if it needed #version 300 es it would not be a test bed.
 */

export type Attrib = {
  buffer: WebGLBuffer;
  location: number;
  size: number;
};

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("createShader returned null");

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "unknown error";
    gl.deleteShader(shader);
    const kind = type === gl.VERTEX_SHADER ? "vertex" : "fragment";
    throw new Error(`${kind} shader failed to compile:\n${log}`);
  }

  return shader;
}

export function createProgram(
  gl: WebGLRenderingContext,
  vertSource: string,
  fragSource: string,
): WebGLProgram {
  const vert = compile(gl, gl.VERTEX_SHADER, vertSource);
  const frag = compile(gl, gl.FRAGMENT_SHADER, fragSource);

  const program = gl.createProgram();
  if (!program) throw new Error("createProgram returned null");

  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);

  // Safe to drop the shader objects now -- the linked program holds a reference.
  gl.deleteShader(vert);
  gl.deleteShader(frag);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "unknown error";
    gl.deleteProgram(program);
    throw new Error(`program failed to link:\n${log}`);
  }

  return program;
}

export function createAttrib(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  name: string,
  data: Float32Array,
  size: number,
): Attrib {
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error(`createBuffer returned null for ${name}`);

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

  // Geometry never changes after upload; every frame's motion is computed in
  // the vertex shader from u_time. No per-frame buffer traffic.
  return { buffer, location: gl.getAttribLocation(program, name), size };
}

export function bindAttrib(gl: WebGLRenderingContext, attrib: Attrib): void {
  if (attrib.location < 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, attrib.buffer);
  gl.enableVertexAttribArray(attrib.location);
  gl.vertexAttribPointer(attrib.location, attrib.size, gl.FLOAT, false, 0, 0);
}

/** Uniform locations looked up once at build time, not per frame. */
export function getUniforms<K extends string>(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  names: readonly K[],
): Record<K, WebGLUniformLocation | null> {
  const out = {} as Record<K, WebGLUniformLocation | null>;
  for (const name of names) out[name] = gl.getUniformLocation(program, name);
  return out;
}
