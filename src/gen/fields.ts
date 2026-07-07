import { HexGrid } from '../core/hex';
import { mulberry32, randInt, randRange } from '../core/rng';
import { clamp01, fbm2, lerp, ridged2, smoothstep, type NoiseKit } from '../core/noise';
import { signedDistance } from './sdf2d';
import { hexNeighbors } from './layout';
import type { GenParams } from './params';

export interface Crater {
  x: number;
  z: number;
  r: number;
  depth: number;
}

/** fissure: jittered polyline through a chain of hex centers */
export interface Crack {
  /** w = local width multiplier (tapers to a point at both tips) */
  pts: { x: number; z: number; w: number }[];
  /** grid indices of every hex the walk passed through */
  hexes: number[];
}

/**
 * Per-column (XZ) scalar fields at voxel resolution. The 3D density used
 * for meshing is derived from these plus 3D noise on the wall band.
 */
export interface Fields {
  nx: number;
  nz: number;
  voxel: number;
  originX: number;
  originZ: number;
  /** signed distance to canyon boundary, world units, + inside open floor */
  s2: Float32Array;
  /** final ground surface height per column */
  groundH: Float32Array;
  /** 0 on floor, ->1 deep inside wall region (drives 3D roughness + color) */
  wallMask: Float32Array;
  /**
   * normalized distance to the nearest crater center (dist / radius):
   * 0 = center, 1 = rim edge, up to ~1.5 = ejecta ring; 9 = no crater.
   * Drives crater coloring (scorched bowl / rim crest / ejecta dust).
   */
  craterD: Float32Array;
  /**
   * normalized distance to the nearest fissure centerline (dist / local
   * half-width): <1 = inside the slot, ~1.1 = lip, 9 = no crack nearby.
   */
  crackD: Float32Array;
  /**
   * per-hex flag: 1 = flat game floor (passable candidate). Decided from
   * the SDF + crater/crack footprints BEFORE geometry; the ground is then
   * forced flat on these hexes so passability and visuals always agree.
   */
  hexFlat: Uint8Array;
  craters: Crater[];
  cracks: Crack[];
  maxH: number;
  sampleGround(x: number, z: number): number;
  sampleS2(x: number, z: number): number;
  sampleCrack(x: number, z: number): number;
}

export function buildFields(
  grid: HexGrid,
  open: Uint8Array,
  params: GenParams,
  noise: NoiseKit,
): Fields {
  const voxel = params.voxelSize;
  const pad = params.wallThickness + 1.5;
  const originX = grid.minX - pad;
  const originZ = grid.minZ - pad;
  const nx = Math.ceil((grid.maxX + pad - originX) / voxel) + 1;
  const nz = Math.ceil((grid.maxZ + pad - originZ) / voxel) + 1;
  const n = nx * nz;

  // 1. rasterize hex passability at column resolution; outside the hex map
  // each column inherits its nearest border cell, so open portals keep
  // running to the volume edge instead of hitting an artificial wall
  const openRaster = new Uint8Array(n);
  for (let iz = 0; iz < nz; iz++) {
    const z = originZ + iz * voxel;
    for (let ix = 0; ix < nx; ix++) {
      const x = originX + ix * voxel;
      let [col, row] = grid.worldToCell(x, z);
      col = Math.max(0, Math.min(grid.cols - 1, col));
      row = Math.max(0, Math.min(grid.rows - 1, row));
      if (open[grid.index(col, row)]) openRaster[iz * nx + ix] = 1;
    }
  }

  // 2. signed 2D distance field (world units)
  const s2 = signedDistance(openRaster, nx, nz);
  for (let i = 0; i < n; i++) s2[i] *= voxel;

  // 3. craters on the open floor, fissures walked over the hex grid
  const craters = placeCraters(params, s2, nx, nz, originX, originZ, voxel);
  const { cracks, crackHex } = placeCracks(grid, open, params);
  const crackD = rasterizeCracks(cracks, params.crackWidth, nx, nz, originX, originZ, voxel);

  // 4. hex-level floor decision: a hex is flat game floor when it is open,
  // not clipped by the wall SDF at its center, and not inside a crater or
  // crack footprint. Geometry is forced to follow this (not the other way
  // around).
  const hexFlat = new Uint8Array(grid.count);
  const sdfMargin = 0.3 * grid.size;
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const i = grid.index(col, row);
      if (!open[i]) continue;
      if (crackHex[i]) continue;
      const [cx, cz] = grid.cellWorld(col, row);
      const ix = Math.max(0, Math.min(nx - 1, Math.round((cx - originX) / voxel)));
      const iz = Math.max(0, Math.min(nz - 1, Math.round((cz - originZ) / voxel)));
      if (s2[iz * nx + ix] < sdfMargin) continue;
      let inCrater = false;
      for (const c of craters) {
        if (Math.hypot(cx - c.x, cz - c.z) < c.r) {
          inCrater = true;
          break;
        }
      }
      if (!inCrater) hexFlat[i] = 1;
    }
  }

  // 5. flatten-weight raster: 1 over flat hexes, smoothly blended at their
  // boundary so walls/talus/craters get a short apron instead of a step.
  // flatRaw keeps the unblurred mask: crack carving is hard-clipped by it
  // so a slot can never punch a hole into a passable hex.
  const flattenW = new Float32Array(n);
  const flatRaw = new Uint8Array(n);
  for (let iz = 0; iz < nz; iz++) {
    const z = originZ + iz * voxel;
    for (let ix = 0; ix < nx; ix++) {
      const x = originX + ix * voxel;
      let [col, row] = grid.worldToCell(x, z);
      col = Math.max(0, Math.min(grid.cols - 1, col));
      row = Math.max(0, Math.min(grid.rows - 1, row));
      const f = hexFlat[grid.index(col, row)];
      flattenW[iz * nx + ix] = f;
      flatRaw[iz * nx + ix] = f;
    }
  }
  const blurR = Math.max(1, Math.round((0.25 * grid.step) / voxel));
  boxBlur(flattenW, nx, nz, blurR);
  boxBlur(flattenW, nx, nz, blurR);

  // 6. per-mesa level offsets: each connected wall region gets its own
  // altitude (in whole plateau-quantization steps) so mesas stop reading
  // as one uniform slab
  const mesaOff = mesaOffsets(openRaster, nx, nz, params);

  // 7. per-column ground profile
  const groundH = new Float32Array(n);
  const wallMask = new Float32Array(n);
  const craterD = new Float32Array(n).fill(9);
  let maxH = 0;

  const { n2 } = noise;
  for (let iz = 0; iz < nz; iz++) {
    const z = originZ + iz * voxel;
    for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix;
      const x = originX + ix * voxel;

      // perturb boundary for wavy walls / buttresses
      const ridge = fbm2(n2, x * params.ridgeFreq, z * params.ridgeFreq, 3) * params.ridgeAmp;
      const sd = s2[i] + ridge;

      // floor
      let floorH =
        params.floorBase + fbm2(n2, x * params.floorFreq, z * params.floorFreq, 4) * params.floorAmp;

      // craters dent the floor: compact bowl + tall rim crest placed well
      // inside the footprint so hex-flattening outside can't clip them
      let dMin = 9;
      for (const c of craters) {
        const dx = x - c.x;
        const dz = z - c.z;
        const dd = dx * dx + dz * dz;
        if (dd > c.r * c.r * 2.25) continue;
        const d = Math.sqrt(dd) / c.r;
        if (d < dMin) dMin = d;
        if (d < 0.8) floorH -= c.depth * (0.5 + 0.5 * Math.cos((Math.PI * d) / 0.8));
        if (d < 1.25) floorH += c.depth * 0.7 * Math.exp(-((d - 0.85) * (d - 0.85)) / 0.009);
      }
      craterD[i] = dMin;

      // talus rise near the wall base
      if (sd > 0) {
        floorH += params.talusAmp * Math.exp(-sd / params.talusFall);
      }

      let h: number;
      let w = 0;
      if (sd >= 0) {
        h = floorH;
      } else {
        const depth = -sd;
        w = smoothstep(0, params.wallThickness, depth);
        let wallH =
          params.wallHeight +
          fbm2(n2, x * params.wallFreq + 31.7, z * params.wallFreq - 17.3, 4) * params.wallVar;
        // plateau-ish tops: gentle quantization of the wall height itself
        wallH = lerp(wallH, terrace(wallH, params.terraceStep * 1.6), 0.5);
        // per-mesa altitude offset (quantized steps, constant per region)
        wallH += mesaOff[i];
        // doming: low-frequency swell over the mesa interior; fades toward
        // the rim so the silhouette edge stays crisp
        const dome = fbm2(n2, x * 0.045 + 11.0, z * 0.045 - 23.0, 3);
        wallH += dome * 0.8 * smoothstep(0.55, 0.95, w);

        h = lerp(floorH + params.talusAmp, wallH, easeWall(w));

        // terraced strata on the flank: flat treads, sharpness-controlled
        // risers, band phase undulated by low-freq noise so strata lines
        // wander instead of being ruler-straight contours
        if (params.terraceAmt > 0 && w > 0.02 && w < 0.98) {
          const riserHW = 0.35 - 0.29 * params.terraceSharp;
          const tj = fbm2(n2, x * 0.06 + 3.3, z * 0.06 - 6.1, 2) * params.terraceStep * 0.6;
          h = lerp(
            h,
            terrace(h + tj, params.terraceStep, riserHW) - tj,
            params.terraceAmt * stepWeight(w),
          );
        }
        // erosion gullies down the flank, continuing as drainage channels
        // across the top (same noise field -> channels notch the rim where
        // they run off the edge)
        const gully = ridged2(n2, x * 0.35 + 7.7, z * 0.35 - 3.1, 2);
        h -= gully * gully * (0.5 * bandWeight(w) + 0.55 * smoothstep(0.6, 0.95, w));
      }

      // enforce the hex-level floor decision: passable hexes are perfectly
      // flat, walls/talus/craters may not creep onto them
      const fw = flattenW[i];
      if (fw > 0.002) {
        h += (params.floorBase - h) * fw;
        w *= 1 - fw;
      }

      // fissures: narrow slot canyons cut AFTER flattening so a crack stays
      // continuous across hex boundaries; flat (passable) hexes clip it.
      // Crossing a wall carves a deeper notch through the ridge top.
      const ck = crackD[i];
      if (ck < 1.3 && !flatRaw[i]) {
        const cd = ck + fbm2(n2, x * 1.1 + 91.3, z * 1.1 - 37.7, 2) * 0.3;
        if (cd < 1) {
          const depth = params.crackDepth * (sd < -0.5 ? 1.8 : 1);
          h -= depth * Math.sqrt(Math.max(0, 1 - cd * cd));
        }
      }

      if (h < 0.15) h = 0.15;
      groundH[i] = h;
      wallMask[i] = w;
      if (h > maxH) maxH = h;
    }
  }

  const sample = (arr: Float32Array) => (x: number, z: number): number => {
    const fx = (x - originX) / voxel;
    const fz = (z - originZ) / voxel;
    const x0 = Math.max(0, Math.min(nx - 2, Math.floor(fx)));
    const z0 = Math.max(0, Math.min(nz - 2, Math.floor(fz)));
    const tx = clamp01(fx - x0);
    const tz = clamp01(fz - z0);
    const i00 = z0 * nx + x0;
    const a = arr[i00] + (arr[i00 + 1] - arr[i00]) * tx;
    const b = arr[i00 + nx] + (arr[i00 + nx + 1] - arr[i00 + nx]) * tx;
    return a + (b - a) * tz;
  };

  return {
    nx,
    nz,
    voxel,
    originX,
    originZ,
    s2,
    groundH,
    wallMask,
    craterD,
    crackD,
    hexFlat,
    craters,
    cracks,
    maxH,
    sampleGround: sample(groundH),
    sampleS2: sample(s2),
    sampleCrack: sample(crackD),
  };
}

/**
 * Obstructed = open but not flat game floor. Purely the hex-level decision
 * made in buildFields (SDF margin / crater footprint) — geometry was forced
 * to match it, so no fuzzy height sampling is needed.
 */
export function computeObstructed(
  grid: HexGrid,
  open: Uint8Array,
  fields: Fields,
  _params: GenParams,
): Uint8Array {
  const out = new Uint8Array(grid.count);
  for (let i = 0; i < grid.count; i++) {
    if (open[i] && !fields.hexFlat[i]) out[i] = 1;
  }
  return out;
}

/**
 * Flood-fill the closed (wall) columns into connected mesa regions and give
 * each region a random altitude offset in whole plateau-quantization steps.
 * Labels are dilated a few columns into the open fringe so the ridge-
 * perturbed wall boundary samples a consistent offset.
 */
function mesaOffsets(
  openRaster: Uint8Array,
  nx: number,
  nz: number,
  params: GenParams,
): Float32Array {
  const n = nx * nz;
  const rng = mulberry32(params.seed ^ 0x2545f491);
  const step = params.terraceStep * 1.6;
  const label = new Int32Array(n).fill(-1);
  const offsets: number[] = [];
  const stack: number[] = [];

  for (let start = 0; start < n; start++) {
    if (openRaster[start] || label[start] >= 0) continue;
    const id = offsets.length;
    // level pick: sunken / base / raised / towering
    const r = rng();
    offsets.push((r < 0.3 ? -1 : r < 0.6 ? 0 : r < 0.88 ? 1 : 2) * step);
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % nx;
      const push = (j: number) => {
        if (!openRaster[j] && label[j] < 0) {
          label[j] = id;
          stack.push(j);
        }
      };
      if (cx > 0) push(c - 1);
      if (cx < nx - 1) push(c + 1);
      if (c >= nx) push(c - nx);
      if (c < n - nx) push(c + nx);
    }
  }

  // dilate labels into unlabeled (open) columns — a handful of passes is
  // enough to cover the ridge-perturbation reach
  for (let pass = 0; pass < 5; pass++) {
    const prev = Int32Array.from(label);
    for (let i = 0; i < n; i++) {
      if (prev[i] >= 0) continue;
      const cx = i % nx;
      if (cx > 0 && prev[i - 1] >= 0) label[i] = prev[i - 1];
      else if (cx < nx - 1 && prev[i + 1] >= 0) label[i] = prev[i + 1];
      else if (i >= nx && prev[i - nx] >= 0) label[i] = prev[i - nx];
      else if (i < n - nx && prev[i + nx] >= 0) label[i] = prev[i + nx];
    }
  }

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = label[i] >= 0 ? offsets[label[i]] : 0;
  return out;
}

/** separable box blur with clamped edges, in place */
function boxBlur(a: Float32Array, w: number, h: number, r: number): void {
  const tmp = new Float32Array(a.length);
  const div = 2 * r + 1;
  const cl = (v: number, max: number) => (v < 0 ? 0 : v > max ? max : v);
  // horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += a[row + cl(x, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / div;
      acc += a[row + cl(x + r + 1, w - 1)] - a[row + cl(x - r, w - 1)];
    }
  }
  // vertical
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[cl(y, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      a[y * w + x] = acc / div;
      acc += tmp[cl(y + r + 1, h - 1) * w + x] - tmp[cl(y - r, h - 1) * w + x];
    }
  }
}

/**
 * Terracing: quantize into flat treads with risers of half-width
 * `riserHW` (0.5 = pure smooth ramp, 0.06 = near-vertical staircase).
 */
function terrace(h: number, step: number, riserHW = 0.25): number {
  if (step <= 0.01) return h;
  const k = h / step;
  const f = Math.floor(k);
  const frac = k - f;
  const s = smoothstep(0.5 - riserHW, 0.5 + riserHW, frac);
  return (f + s) * step;
}

/** strongest terracing mid-flank, fades at floor contact and rim */
function bandWeight(w: number): number {
  return clamp01(4 * w * (1 - w));
}

/**
 * Wider flank window for the stepped look: full terracing across most of
 * the rise, fading only right at the talus contact and the rim shoulder
 * (the old parabolic bandWeight mushed the upper and lower steps away —
 * a big reason the terraces read "minimalistic").
 */
function stepWeight(w: number): number {
  return smoothstep(0.02, 0.14, w) * (1 - smoothstep(0.86, 1, w));
}

/** wall rises steeply from the base then eases into the top */
function easeWall(w: number): number {
  return 1 - (1 - w) * (1 - w);
}

/**
 * Fissures: small cracks spanning crackLenMin..crackLenMax adjoining open
 * hexes (a short heading-directed walk). Every hex on the path becomes
 * impassable to crawlers (flyers pass). Long barrier chains that seal off
 * map regions are deliberately out of scope for now — raise crackLenMax if
 * you want them back.
 */
function placeCracks(
  grid: HexGrid,
  open: Uint8Array,
  params: GenParams,
): { cracks: Crack[]; crackHex: Uint8Array } {
  const cracks: Crack[] = [];
  const crackHex = new Uint8Array(grid.count);
  if (params.crackCount <= 0) return { cracks, crackHex };
  const rng = mulberry32(params.seed ^ 0x3c6ef372);
  const pad = Math.max(1, params.borderPad);

  // keep cracks apart: reject starts touching an existing crack hex
  const isFree = (col: number, row: number): boolean => {
    if (crackHex[grid.index(col, row)]) return false;
    for (const [nc, nr] of hexNeighbors(col, row)) {
      if (grid.inBounds(nc, nr) && crackHex[grid.index(nc, nr)]) return false;
    }
    return true;
  };

  let tries = 0;
  while (cracks.length < params.crackCount && tries < params.crackCount * 40) {
    tries++;
    const col = randInt(rng, pad + 1, grid.cols - pad - 2);
    const row = randInt(rng, pad + 1, grid.rows - pad - 2);
    if (!open[grid.index(col, row)] || !isFree(col, row)) continue;

    // walk up to `want` adjoining open hexes along a rough heading
    const want = randInt(rng, params.crackLenMin, params.crackLenMax);
    const heading = rng() * Math.PI * 2;
    const cells: [number, number][] = [[col, row]];
    let [cc, cr] = [col, row];
    while (cells.length < want) {
      const [cx, cz] = grid.cellWorld(cc, cr);
      let best: [number, number] | null = null;
      let bestScore = -Infinity;
      for (const [nc, nr] of hexNeighbors(cc, cr)) {
        if (nc < pad + 1 || nr < pad + 1 || nc > grid.cols - pad - 2 || nr > grid.rows - pad - 2)
          continue;
        const ni = grid.index(nc, nr);
        if (!open[ni] || crackHex[ni]) continue;
        if (cells.some(([qc, qr]) => qc === nc && qr === nr)) continue;
        const [nwx, nwz] = grid.cellWorld(nc, nr);
        const score = Math.cos(Math.atan2(nwz - cz, nwx - cx) - heading) + (rng() - 0.5) * 0.6;
        if (score > bestScore) {
          bestScore = score;
          best = [nc, nr];
        }
      }
      if (!best) break;
      cells.push(best);
      [cc, cr] = best;
    }

    // polyline through jittered centers: single-hex cracks get a short
    // segment along the heading, multi-hex ones extended tips + jittered
    // midpoints; everything stays inside the hex chain
    const centers = cells.map(([qc, qr]) => {
      const [x, z] = grid.cellWorld(qc, qr);
      return {
        x: x + (rng() - 0.5) * 0.25 * grid.size,
        z: z + (rng() - 0.5) * 0.25 * grid.size,
      };
    });
    const raw: { x: number; z: number }[] = [];
    if (centers.length === 1) {
      const c = centers[0];
      const ux = Math.cos(heading);
      const uz = Math.sin(heading);
      raw.push({ x: c.x - ux * 0.5 * grid.size, z: c.z - uz * 0.5 * grid.size });
      raw.push({ x: c.x + (rng() - 0.5) * 0.2 * grid.size, z: c.z + (rng() - 0.5) * 0.2 * grid.size });
      raw.push({ x: c.x + ux * 0.5 * grid.size, z: c.z + uz * 0.5 * grid.size });
    } else {
      const tip = (from: { x: number; z: number }, to: { x: number; z: number }) => {
        const l = Math.hypot(to.x - from.x, to.z - from.z) || 1;
        return {
          x: to.x + ((to.x - from.x) / l) * 0.35 * grid.size,
          z: to.z + ((to.z - from.z) / l) * 0.35 * grid.size,
        };
      };
      raw.push(tip(centers[1], centers[0]));
      for (let s = 0; s < centers.length; s++) {
        raw.push(centers[s]);
        if (s < centers.length - 1) {
          raw.push({
            x: (centers[s].x + centers[s + 1].x) / 2 + (rng() - 0.5) * 0.4 * grid.size,
            z: (centers[s].z + centers[s + 1].z) / 2 + (rng() - 0.5) * 0.4 * grid.size,
          });
        }
      }
      raw.push(tip(centers[centers.length - 2], centers[centers.length - 1]));
    }

    // width tapers to a point at both tips
    const last = raw.length - 1;
    const pts = raw.map((p, s) => ({
      ...p,
      w: Math.max(0.25, Math.pow(Math.sin((Math.PI * s) / last), 0.6)),
    }));

    const hexes: number[] = [];
    for (const [qc, qr] of cells) {
      const i = grid.index(qc, qr);
      hexes.push(i);
      crackHex[i] = 1;
    }
    cracks.push({ pts, hexes });
  }
  return { cracks, crackHex };
}

/**
 * Normalized distance to the nearest crack centerline (dist / local
 * half-width). Only columns inside each segment's bounding box are touched.
 */
function rasterizeCracks(
  cracks: Crack[],
  width: number,
  nx: number,
  nz: number,
  originX: number,
  originZ: number,
  voxel: number,
): Float32Array {
  const crackD = new Float32Array(nx * nz).fill(9);
  const reach = width * 1.6;
  for (const crack of cracks) {
    const pts = crack.pts;
    for (let s = 0; s < pts.length - 1; s++) {
      const a = pts[s];
      const b = pts[s + 1];
      const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach - originX) / voxel));
      const x1 = Math.min(nx - 1, Math.ceil((Math.max(a.x, b.x) + reach - originX) / voxel));
      const z0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - reach - originZ) / voxel));
      const z1 = Math.min(nz - 1, Math.ceil((Math.max(a.z, b.z) + reach - originZ) / voxel));
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz || 1;
      for (let iz = z0; iz <= z1; iz++) {
        const z = originZ + iz * voxel;
        for (let ix = x0; ix <= x1; ix++) {
          const x = originX + ix * voxel;
          let t = ((x - a.x) * dx + (z - a.z) * dz) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const w = width * (a.w + (b.w - a.w) * t);
          const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)) / w;
          const i = iz * nx + ix;
          if (d < crackD[i]) crackD[i] = d;
        }
      }
    }
  }
  return crackD;
}

function placeCraters(
  params: GenParams,
  s2: Float32Array,
  nx: number,
  nz: number,
  originX: number,
  originZ: number,
  voxel: number,
): Crater[] {
  const rng = mulberry32(params.seed ^ 0x9e3779b9);
  const craters: Crater[] = [];
  let tries = 0;
  while (craters.length < params.craterCount && tries < params.craterCount * 40) {
    tries++;
    const r = randRange(rng, params.craterMinR, params.craterMaxR);
    const ix = Math.floor(randRange(rng, 0, nx - 1));
    const iz = Math.floor(randRange(rng, 0, nz - 1));
    if (s2[iz * nx + ix] < r * 0.7) continue; // keep craters on open floor
    const x = originX + ix * voxel;
    const z = originZ + iz * voxel;
    let ok = true;
    for (const c of craters) {
      if (Math.hypot(c.x - x, c.z - z) < (c.r + r) * 0.9) {
        ok = false;
        break;
      }
    }
    if (ok) craters.push({ x, z, r, depth: params.craterDepth * randRange(rng, 0.7, 1.3) });
  }
  return craters;
}
