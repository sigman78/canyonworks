import * as THREE from 'three';
import { registerTiledTexture } from './terrainMaterial';

/**
 * Normal-map supply for the tri-planar detail shader.
 *
 * Source preference per texture `name`:
 *  1. `textures/<name>_n.png` — an authored/GenAI normal map, if present
 *     (generate with tools/gen-normalmaps.mjs);
 *  2. otherwise baked at load from the albedo `textures/<name>.jpg`:
 *     luminance as height (mixed with a 1/8-scale copy so broad forms
 *     survive), Sobel with mirrored wrap.
 *
 * Accent-layer maps are PACKED two per RGBA texture (xy in RG, xy in BA) —
 * the UDN blend in the shader only ever needs xy, and packing keeps the
 * fragment-sampler count under the GL minimum of 16.
 */

const SIZE = 1024; // common working size for packing/resampling

/** flat (128,128,255) placeholder so materials can compile before baking */
export function neutralNormalTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

interface Pixels {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

function drawToPixels(img: CanvasImageSource, w: number, h: number): Pixels {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

// Calibration for the GenAI-authored maps: since texture set v2 the
// generator (tools/gen-normalmaps.mjs) writes CANONICAL handedness — it
// correlates each channel against the height-map gradient and flips
// inverted channels in the file itself. These stay as emergency knobs
// for hand-dropped maps; both false for a compliant set.
const AUTHORED_FLIP_R = false;
const AUTHORED_FLIP_G = false;

/** authored/GenAI normal map if the file exists, else null */
async function tryLoadAuthored(name: string): Promise<Pixels | null> {
  try {
    const res = await fetch(`textures/${name}_n.png`);
    if (!res.ok) return null;
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const px = drawToPixels(bmp, SIZE, SIZE);
    if (AUTHORED_FLIP_R || AUTHORED_FLIP_G) {
      const d = px.data;
      for (let i = 0; i < d.length; i += 4) {
        if (AUTHORED_FLIP_R) d[i] = 255 - d[i];
        if (AUTHORED_FLIP_G) d[i + 1] = 255 - d[i + 1];
      }
    }
    console.debug(`[normals] ${name}: using authored ${name}_n.png`);
    return px;
  } catch {
    return null;
  }
}

/** Sobel bake from the albedo texture's luminance */
async function bakeFromAlbedo(name: string, strength = 4.5): Promise<Pixels> {
  const img = await new THREE.ImageLoader().loadAsync(`textures/${name}.jpg`);
  const { data: px, w, h } = drawToPixels(img, SIZE, SIZE);

  // broad forms: the same image at 1/8 scale (canvas filtering = cheap blur)
  const sw = SIZE >> 3;
  const { data: spx } = drawToPixels(img, sw, sw);

  const height = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sw - 1, y >> 3);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255;
      const j = (sy * sw + Math.min(sw - 1, x >> 3)) * 4;
      const slum = (0.299 * spx[j] + 0.587 * spx[j + 1] + 0.114 * spx[j + 2]) / 255;
      height[y * w + x] = 0.7 * lum + 0.3 * slum;
    }
  }

  // central differences with mirrored edge handling (safe for either
  // wrap mode; only the 1-px border differs and it's filtered anyway)
  const at = (x: number, y: number): number => {
    const mx = x < 0 ? -x : x >= w ? 2 * w - 2 - x : x;
    const my = y < 0 ? -y : y >= h ? 2 * h - 2 - y : y;
    return height[my * w + mx];
  };
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const o = (y * w + x) * 4;
      // OpenGL convention, uploaded with flipY like the albedo: +v = image
      // top. Row index y grows DOWNWARD, so n_v = -dh/dv = +dy_rows —
      // green takes +dy (the original -dy lit every ledge from below)
      out[o] = (-dx * inv * 0.5 + 0.5) * 255;
      out[o + 1] = (dy * inv * 0.5 + 0.5) * 255;
      out[o + 2] = (inv * 0.5 + 0.5) * 255;
      out[o + 3] = 255;
    }
  }
  return { data: out, w, h };
}

async function normalPixels(name: string): Promise<Pixels> {
  return (await tryLoadAuthored(name)) ?? bakeFromAlbedo(name);
}

function toTexture(data: Uint8Array, w: number, h: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  // match the albedo textures' orientation (TextureLoader flips Y)
  tex.flipY = true;
  // wrap mode follows the mirror-tiling toggle, same as the albedos
  registerTiledTexture(tex);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/**
 * grayscale height for a layer: authored `<name>_h.png` if present
 * (tools/gen-heightmaps.mjs), else albedo luminance as a rough proxy
 */
async function heightPixels(name: string): Promise<Uint8ClampedArray> {
  try {
    const res = await fetch(`textures/${name}_h.png`);
    if (res.ok) {
      const bmp = await createImageBitmap(await res.blob());
      const px = drawToPixels(bmp, SIZE, SIZE);
      const out = new Uint8ClampedArray(SIZE * SIZE);
      for (let i = 0; i < out.length; i++) out[i] = px.data[i * 4]; // grayscale: red is enough
      console.debug(`[normals] ${name}: using authored ${name}_h.png`);
      return meanCenter(out);
    }
  } catch {
    /* fall through to luminance */
  }
  const img = await new THREE.ImageLoader().loadAsync(`textures/${name}.jpg`);
  const px = drawToPixels(img, SIZE, SIZE);
  const out = new Uint8ClampedArray(SIZE * SIZE);
  for (let i = 0; i < out.length; i++) {
    out[i] = 0.299 * px.data[i * 4] + 0.587 * px.data[i * 4 + 1] + 0.114 * px.data[i * 4 + 2];
  }
  return meanCenter(out);
}

/**
 * Recenter a height map's mean to 128: GenAI (and luminance) heights carry
 * arbitrary global levels, and a level OFFSET between two layers shifts
 * their height-pick transition wholesale — visible as displaced hard
 * seams. Cross-layer comparisons need equal footing; only local relief
 * should decide.
 */
function meanCenter(h: Uint8ClampedArray): Uint8ClampedArray {
  let sum = 0;
  for (let i = 0; i < h.length; i++) sum += h[i];
  const shift = 128 - sum / h.length;
  for (let i = 0; i < h.length; i++) h[i] = h[i] + shift;
  return h;
}

/**
 * full RGBA normal map for one texture (authored file or Sobel bake);
 * with `heightInAlpha`, the same layer's height map rides in .a
 */
export async function makeNormalTexture(
  name: string,
  heightInAlpha = false,
): Promise<THREE.DataTexture> {
  const p = await normalPixels(name);
  const out = new Uint8Array(p.data.buffer.slice(0));
  if (heightInAlpha) {
    const h = await heightPixels(name);
    for (let i = 0; i < h.length; i++) out[i * 4 + 3] = h[i];
  }
  return toTexture(out, p.w, p.h);
}

/** two maps packed into one RGBA: A.xy -> RG, B.xy -> BA (UDN needs only xy) */
export async function makePackedNormalTexture(
  nameA: string,
  nameB: string,
): Promise<THREE.DataTexture> {
  const [a, b] = await Promise.all([normalPixels(nameA), normalPixels(nameB)]);
  const n = SIZE * SIZE;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = a.data[i * 4];
    out[i * 4 + 1] = a.data[i * 4 + 1];
    out[i * 4 + 2] = b.data[i * 4];
    out[i * 4 + 3] = b.data[i * 4 + 1];
  }
  return toTexture(out, SIZE, SIZE);
}

/** one map's normal xy in RG + the SAME layer's height in B (A spare) */
export async function makeNormalHeightTexture(name: string): Promise<THREE.DataTexture> {
  const [a, h] = await Promise.all([normalPixels(name), heightPixels(name)]);
  const n = SIZE * SIZE;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = a.data[i * 4];
    out[i * 4 + 1] = a.data[i * 4 + 1];
    out[i * 4 + 2] = h[i];
    out[i * 4 + 3] = 255;
  }
  return toTexture(out, SIZE, SIZE);
}

/** four layers' heights packed into RGBA */
export async function makePackedHeightTexture(
  names: [string, string, string, string],
): Promise<THREE.DataTexture> {
  const hs = await Promise.all(names.map((n) => heightPixels(n)));
  const n = SIZE * SIZE;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = hs[0][i];
    out[i * 4 + 1] = hs[1][i];
    out[i * 4 + 2] = hs[2][i];
    out[i * 4 + 3] = hs[3][i];
  }
  return toTexture(out, SIZE, SIZE);
}
