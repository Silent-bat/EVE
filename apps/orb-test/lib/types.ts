export type OrbGeometry = {
  /** vec3 per particle: base position, length encodes shell radius */
  base: Float32Array;
  /** vec4 per particle: x hue, y size, z brightness, w phase / population flag */
  rand: Float32Array;
  count: number;
};

export type OrbSpec = {
  id: string;
  label: string;
  note: string;
  vert: string;
  frag: string;
  /** Target particle count -- build may round to fit a lattice. */
  defaultCount: number;
  camDist: number;
  fov: number;
  build: (targetCount: number) => OrbGeometry;
  /**
   * Sprite size in physical pixels, solved from the geometry and the drawing
   * buffer rather than taken from the size slider.
   *
   * Only the specs that ship to apps/mobile implement this: there, point count
   * and point size are one visible quantity (how much of the frame is lit), so
   * size is derived from a coverage budget instead of being tuned beside the
   * count. A spec that provides this ignores u_size, and the slider along with
   * it. Returns u_pointBase; u_maxPoint comes from the driver.
   */
  solvePointBase?: (geometry: OrbGeometry, width: number, height: number) => number;
};
