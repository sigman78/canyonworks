import * as THREE from 'three';
import { fbm2, type NoiseKit } from '../core/noise';
import type { Fields } from '../gen/fields';

/**
 * Decorative "fog of war": soft cloud blankets hovering over the large
 * impassable mesa islands, leaving the playable canyon floor clear. Purely
 * visual (View toggle) — a look test for hiding fly-only / unexplored
 * regions later.
 *
 * The alpha mask comes from the deep wall interior (wallMask > 0.6, so thin
 * ridges get no blanket), box-blurred for soft skirts and modulated by low
 * frequency fBm so the sheet reads as drifting cloud rather than a flat
 * cutout. Two stacked planes fake a little volume.
 */
export function buildMesaFog(fields: Fields, noise: NoiseKit): THREE.Group {
  const { nx, nz, voxel, originX, originZ, wallMask } = fields;
  const n = nx * nz;

  // wide coverage: any solid wall seeds fog, blurred well past the rims
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = wallMask[i] > 0.35 ? 1 : 0;
  const r = Math.max(4, Math.round(2.0 / voxel));
  boxBlur(a, nx, nz, r);
  boxBlur(a, nx, nz, r);
  boxBlur(a, nx, nz, r);

  // screen-space apron: the bake grid extends past the +x/+z edges (the
  // two directions that point toward the bottom of the screen in the fixed
  // iso view), so the high sheets visually curtain the diorama base that
  // would otherwise protrude from under the fog. No terrain intersection —
  // sheets stay above the terrain (low intersecting sheets looked ugly).
  const apron = 14; // world units past the +x/+z borders
  const pad = Math.round(apron / voxel);
  const mx = nx + pad;
  const mz = nz + pad;
  const m = mx * mz;

  const group = new THREE.Group();
  group.name = 'mesaFog';

  // sandstorm bank: a stack of sheets, each with its own puff pattern and
  // a dust tint that darkens toward the lower layers
  const LAYERS = [
    { y: fields.maxH + 2.2, freq: 0.1, off: 3.7, cap: 0.8, rgb: [240, 198, 146] },
    { y: fields.maxH + 1.3, freq: 0.14, off: 17.3, cap: 0.78, rgb: [234, 184, 126] },
    { y: fields.maxH + 0.4, freq: 0.19, off: 41.9, cap: 0.76, rgb: [226, 170, 110] },
    { y: fields.maxH - 0.5, freq: 0.25, off: 63.1, cap: 0.74, rgb: [219, 158, 97] },
    { y: fields.maxH - 1.3, freq: 0.32, off: 88.9, cap: 0.72, rgb: [212, 148, 86] },
  ];
  const puffBlurR = Math.max(2, Math.round(0.8 / voxel));

  for (const L of LAYERS) {
    // bake the layer's alpha field, then blur it so the billows melt into
    // each other instead of showing crisp noise contours
    const alphaF = new Float32Array(m);
    const puffF = new Float32Array(m);
    for (let jz = 0; jz < mz; jz++) {
      const z = originZ + jz * voxel;
      for (let jx = 0; jx < mx; jx++) {
        const j = jz * mx + jx;
        const x = originX + jx * voxel;
        // billowy puffs: shaped fBm with real gaps between the billows
        const p = fbm2(noise.n2, x * L.freq + L.off, z * L.freq - L.off * 2.3, 3);
        const puff = smoothstepf(-0.4, 0.55, p);
        puffF[j] = puff;
        // coverage: clamped border sample inside the apron, fading outward
        const ix = Math.min(jx, nx - 1);
        const iz = Math.min(jz, nz - 1);
        const dOut = Math.hypot(Math.max(0, jx - (nx - 1)), Math.max(0, jz - (nz - 1))) * voxel;
        const fade = 1 - smoothstepf(apron * 0.25, apron, dOut);
        const cover = Math.min(1, a[iz * nx + ix] * 1.5) * fade;
        alphaF[j] = Math.min(L.cap, cover * (0.22 + 0.78 * puff));
      }
    }
    boxBlur(alphaF, mx, mz, puffBlurR);
    boxBlur(alphaF, mx, mz, puffBlurR);

    const data = new Uint8Array(m * 4);
    for (let jz = 0; jz < mz; jz++) {
      for (let jx = 0; jx < mx; jx++) {
        const j = jz * mx + jx;
        // feather only toward the -x/-z borders (top of screen) — the
        // apron handles the +x/+z sides
        const edge = Math.min(jx, jz) * voxel;
        const rim = Math.min(1, edge / 1.6);
        // dense puff cores read slightly darker (thick dust)
        const shade = 1 - 0.16 * puffF[j];
        // texture v runs toward -z on the rotated plane -> flip rows
        const d = ((mz - 1 - jz) * mx + jx) * 4;
        data[d] = Math.round(L.rgb[0] * shade);
        data[d + 1] = Math.round(L.rgb[1] * shade);
        data[d + 2] = Math.round(L.rgb[2] * shade);
        data[d + 3] = Math.round(255 * Math.max(0, alphaF[j] * rim));
      }
    }
    const tex = new THREE.DataTexture(data, mx, mz, THREE.RGBAFormat);
    tex.needsUpdate = true;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;

    const width = (mx - 1) * voxel;
    const depth = (mz - 1) * voxel;
    const geo = new THREE.PlaneGeometry(width, depth);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(originX + width / 2, L.y, originZ + depth / 2);
    mesh.renderOrder = 10; // draw after the opaque terrain
    group.add(mesh);
  }
  return group;
}

function smoothstepf(e0: number, e1: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** separable box blur with clamped edges, in place */
function boxBlur(a: Float32Array, w: number, h: number, r: number): void {
  const tmp = new Float32Array(a.length);
  const div = 2 * r + 1;
  const cl = (v: number, max: number) => (v < 0 ? 0 : v > max ? max : v);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += a[row + cl(x, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / div;
      acc += a[row + cl(x + r + 1, w - 1)] - a[row + cl(x - r, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[cl(y, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      a[y * w + x] = acc / div;
      acc += tmp[cl(y + r + 1, h - 1) * w + x] - tmp[cl(y - r, h - 1) * w + x];
    }
  }
}
