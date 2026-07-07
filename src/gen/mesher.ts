import * as THREE from 'three';
import { clamp01, fbm2, fbm3, ridged2, smoothstep, type NoiseKit } from '../core/noise';
import { lastPerf, perfMark } from '../core/perf';
import type { Fields } from './fields';
import type { GenParams } from './params';
import type { CarveOp } from './carves';
import { BLOCK, type DensityVolume } from './volume';
import { buildNets, buildVolume, tryWasmAo } from './volumeWasm';

export interface TerrainResult {
  geometry: THREE.BufferGeometry;
  vertexCount: number;
  triangleCount: number;
  /** dense volume footprint vs what true block-sparse storage would hold */
  voxRawKb: number;
  voxSparseKb: number;
}

/**
 * Sample the 3D density (column ground height + 3D roughness on the wall
 * band, which also yields mild overhangs) into a block-sparse volume and
 * mesh it with surface nets.
 */
export function buildTerrainGeometry(
  fields: Fields,
  params: GenParams,
  noise: NoiseKit,
  ops: readonly CarveOp[] = [],
): TerrainResult {
  const vol = buildVolume(fields, params, noise, ops);
  const { data, nx, ny, nz, voxel, originX, originZ } = vol;
  perfMark('volumeFill');

  const nets = buildNets(vol, params);
  perfMark('surfaceNets');

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(nets.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(nets.indices, 1));
  geometry.computeVertexNormals();
  perfMark('normals');

  const nrm = (geometry.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array;
  const aoArr =
    tryWasmAo(nets.positions, nrm, data, nx, ny, nz, voxel, originX, originZ, params) ??
    computeAoJs(nets.positions, nrm, data, nx, ny, nz, voxel, originX, originZ);
  geometry.setAttribute('ao', new THREE.BufferAttribute(aoArr, 1));
  perfMark('aoBake');
  colorize(geometry, fields, params, noise, vol);
  perfMark('colorize');

  const nBlocks = vol.nbx * vol.nby * vol.nbz;
  console.debug(
    `[mesher] ${nx}x${ny}x${nz} vox, blocks ${nBlocks} ` +
      `(mixed ${vol.mixedCount} = ${Math.round((vol.mixedCount / nBlocks) * 100)}%, ` +
      `solid ${vol.solidCount}) | fill ${(lastPerf.volumeFill ?? 0).toFixed(1)}ms, ` +
      `nets ${(lastPerf.surfaceNets ?? 0).toFixed(1)}ms, ` +
      `normals ${(lastPerf.normals ?? 0).toFixed(1)}ms, ` +
      `ao ${(lastPerf.aoBake ?? 0).toFixed(1)}ms, ` +
      `color ${(lastPerf.colorize ?? 0).toFixed(1)}ms`,
  );

  return {
    geometry,
    vertexCount: nets.positions.length / 3,
    triangleCount: nets.indices.length / 3,
    voxRawKb: Math.round((nx * ny * nz * 4) / 1024),
    // mixed blocks store voxels; homogeneous ones just their type byte
    voxSparseKb: Math.round((vol.mixedCount * BLOCK * BLOCK * BLOCK * 4 + nBlocks) / 1024),
  };
}

// ---- baked ambient occlusion ---------------------------------------------

/** ray fan: 8 cube corners + 4 horizontal compass dirs (bent toward the normal) */
const AO_DIRS: ReadonlyArray<readonly [number, number, number]> = (() => {
  const s = 1 / Math.sqrt(3);
  const dirs: [number, number, number][] = [];
  for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (const dz of [-1, 1]) {
    dirs.push([dx * s, dy * s, dz * s]);
  }
  dirs.push([1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]);
  return dirs;
})();
/** march distances (world units) and how much a first hit there occludes */
const AO_RADII = [0.5, 1.1, 2.2, 4.0];
const AO_HIT = [1.0, 0.7, 0.45, 0.25];

/**
 * Per-vertex AO sampled straight from the density volume: short rays fanned
 * around the vertex normal, first solid hit occludes by distance weight.
 * Pure JS fallback for the wasm `bake_ao` (dispatched via tryWasmAo in
 * ./volumeWasm); the result is stored as an `ao` attribute at the call site
 * and applied in the shader by a live uniform, so the amount slider needs
 * no rebake. Reads the raw Float32Arrays — identical values to the old
 * BufferAttribute getters (attribute .array IS the raw Float32Array).
 */
export function computeAoJs(
  positions: Float32Array,
  normals: Float32Array,
  data: Float32Array,
  nx: number,
  ny: number,
  nz: number,
  voxel: number,
  originX: number,
  originZ: number,
): Float32Array {
  const count = positions.length / 3;
  const ao = new Float32Array(count);
  const inv = 1 / voxel;

  const solid = (x: number, y: number, z: number): boolean => {
    const ix = Math.round((x - originX) * inv);
    if (ix < 0 || ix >= nx) return false;
    const iy = Math.round(y * inv);
    if (iy < 0 || iy >= ny) return false;
    const iz = Math.round((z - originZ) * inv);
    if (iz < 0 || iz >= nz) return false;
    return data[ix + iy * nx + iz * nx * ny] > 0;
  };

  for (let i = 0; i < count; i++) {
    const vnx = normals[i * 3];
    const vny = normals[i * 3 + 1];
    const vnz = normals[i * 3 + 2];
    // start just off the surface so rays don't self-intersect
    const px = positions[i * 3] + vnx * voxel * 0.8;
    const py = positions[i * 3 + 1] + vny * voxel * 0.8;
    const pz = positions[i * 3 + 2] + vnz * voxel * 0.8;

    let occ = 0;
    for (const d of AO_DIRS) {
      // bend the fan only mildly toward the normal: rays hug the surface,
      // so nearby walls / pit sides actually get hit (a strongly biased
      // fan escapes upward and bakes ~1 everywhere)
      let dx = d[0] + vnx * 0.6;
      let dy = d[1] + vny * 0.6;
      let dz = d[2] + vnz * 0.6;
      const il = 1 / Math.hypot(dx, dy, dz);
      dx *= il; dy *= il; dz *= il;
      for (let r = 0; r < AO_RADII.length; r++) {
        const rr = AO_RADII[r];
        if (solid(px + dx * rr, py + dy * rr, pz + dz * rr)) {
          occ += AO_HIT[r];
          break;
        }
      }
    }
    ao[i] = 1 - occ / AO_DIRS.length;
  }

  return ao;
}

// ---- Sedona palette -------------------------------------------------------

const C = (hex: number) => new THREE.Color(hex);

/**
 * Sedona palette, baked into vertex colors by colorize(). EXPORTED LIVE
 * OBJECTS: the Palette panel (ui/palettePanel.ts) mutates these Colors
 * and triggers a regenerate — colorize() reads them fresh each run.
 */
export const TERRAIN_PALETTE = {
  /** cliff strata bands, bottom to top */
  strata: [C(0x83341a), C(0xb04a20), C(0x9c3f1e), C(0xc9662f), C(0xd57d3e)],
  floorA: C(0xdb9d5c), // warm sand
  floorB: C(0xbd7a44), // rustier dust
  cap: C(0xedc79a), // pale plateau cap (pillar butte tops share this)
  crevice: C(0x54240f), // deep shade at wall contact
  craterIn: C(0x9c6a54), // dusty ash-taupe bowl (cooler than rust walls)
  craterWall: C(0xc08a5f), // tan inner slope
  craterRim: C(0xf2d4a6), // sun-bleached rim crest
  ejecta: C(0xe7ba8a), // pale ejecta dust ring
  crackDeep: C(0x2b1208), // fissure slot interior, falls to near-black
  crackLip: C(0xecc9a0), // pale weathered lip along the fissure edge
};

const STRATA = TERRAIN_PALETTE.strata;
const FLOOR_A = TERRAIN_PALETTE.floorA;
const FLOOR_B = TERRAIN_PALETTE.floorB;
const CAP = TERRAIN_PALETTE.cap;
const CREVICE = TERRAIN_PALETTE.crevice;
const CRATER_IN = TERRAIN_PALETTE.craterIn;
const CRATER_WALL = TERRAIN_PALETTE.craterWall;
const CRATER_RIM = TERRAIN_PALETTE.craterRim;
const EJECTA = TERRAIN_PALETTE.ejecta;
const CRACK_DEEP = TERRAIN_PALETTE.crackDeep;
const CRACK_LIP = TERRAIN_PALETTE.crackLip;

function colorize(
  geometry: THREE.BufferGeometry,
  fields: Fields,
  params: GenParams,
  noise: NoiseKit,
  vol: DensityVolume,
): void {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geometry.getAttribute('normal') as THREE.BufferAttribute;
  const count = pos.count;
  const colors = new Float32Array(count * 3);

  // rock-overhead probe (grotto/notch interiors): vertical samples into the
  // density volume, like the AO bake but sky-only
  const inv = 1 / vol.voxel;
  const solidAbove = (x: number, y: number, z: number): boolean => {
    const ix = Math.round((x - vol.originX) * inv);
    if (ix < 0 || ix >= vol.nx) return false;
    const iy = Math.round(y * inv);
    if (iy < 0 || iy >= vol.ny) return false;
    const iz = Math.round((z - vol.originZ) * inv);
    if (iz < 0 || iz >= vol.nz) return false;
    return vol.data[ix + iy * vol.nx + iz * vol.nx * vol.ny] > 0;
  };
  const CAVE_STEPS = [0.55, 1.0, 1.6, 2.4];
  // morphology channels for the shader: x = dome hollow (same field as the
  // mesa-top swell in fields.ts) -> drift sand pools there; y = crater
  // interior weight (1 in the bowl, fading out at the rim crest); z =
  // plateau-cap weight (gates the pale mesa texture layer)
  const facies = new Float32Array(count * 3);
  const { n2 } = noise;
  const tmp = new THREE.Color();
  const strataStep = Math.max(0.4, params.terraceStep);

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nY = nrm.getY(i);
    const s2 = fields.sampleS2(x, z);

    const dither = fbm3(noise.n3, x * 0.35, y * 0.5, z * 0.35, 2);
    const dome = fbm2(n2, x * 0.045 + 11.0, z * 0.045 - 23.0, 3);
    const craterDist = sampleCraterD(fields, x, z);
    const capW = plateauWeight(fields, params, x, y, z);
    facies[i * 3] = clamp01((-dome - 0.05) / 0.55);
    facies[i * 3 + 1] = 1 - smoothstep(0.8, 1.02, craterDist);
    facies[i * 3 + 2] = capW;

    if (nY < 0.65) {
      // cliff face: quantized strata bands. The index CLAMPS at the top of
      // the authored dark->light sequence — cycling it wrapped the darkest
      // bottom stratum back in as a near-black ring on tall (per-mesa
      // offset) walls.
      const band = Math.floor((y + dither * 0.35) / strataStep);
      const bi = Math.min(Math.max(band, 0), STRATA.length - 1);
      tmp.copy(STRATA[bi]);
      if (band > STRATA.length - 1) {
        // above the sequence: stay in the light family, subtle per-band
        // shade jitter keeps the banding readable
        const j = Math.sin(band * 12.9898) * 43758.5453;
        tmp.multiplyScalar(0.92 + (j - Math.floor(j)) * 0.12);
      }
      // slight vertical gradient: darker at base
      const baseDark = clamp01(1 - y / (params.wallHeight + params.wallVar));
      tmp.multiplyScalar(0.95 - baseDark * 0.15 + dither * 0.04);
    } else if (capW > 0.4) {
      // plateau top — see plateauWeight() for what qualifies (and what the
      // old bare y-threshold got wrong)
      tmp.copy(CAP).lerp(STRATA[4], clamp01(0.3 + dither * 0.4));
      // sand pockets collect in the dome hollows (same field as the swell)
      if (dome < -0.12) tmp.lerp(FLOOR_A, smoothstep(0.12, 0.5, -dome) * 0.6);
      // drainage lines read darker (desert varnish in the channels)
      const g = ridged2(n2, x * 0.35 + 7.7, z * 0.35 - 3.1, 2);
      tmp.multiplyScalar(1 - g * g * 0.22 + dither * 0.04);
    } else {
      // canyon floor
      const t = clamp01(0.5 + fbm2Cheap(n2, x, z) * 0.7);
      tmp.copy(FLOOR_A).lerp(FLOOR_B, t);

      // crater bands: scorched bowl -> rust inner slope -> bleached rim
      // crest -> pale ejecta dust fading out (edges broken up by dither)
      const cd = craterDist;
      if (cd < 1.5) {
        const ring = cd + dither * 0.08;
        if (ring < 0.85) {
          const wallT = smoothstep(0.2, 0.8, ring); // bowl slope band
          const bowl = new THREE.Color().copy(CRATER_IN).lerp(CRATER_WALL, wallT);
          tmp.lerp(bowl, smoothstep(0.85, 0.45, ring) * 0.8);
        }
        const crest = Math.exp(-((ring - 0.92) * (ring - 0.92)) / 0.016);
        tmp.lerp(CRATER_RIM, crest * 0.75);
        if (ring > 1.02) tmp.lerp(EJECTA, smoothstep(1.5, 1.05, ring) * 0.3);
      }

      // contact shading at wall bases; up-facing surfaces ON the wall
      // footprint itself (s2 < 0 — wash lips, basal knobs demoted from the
      // cap branch) darken further toward rock shelf so bright sand never
      // pops inside a shadowed wall base
      const contact = clamp01(1 - s2 / 1.6);
      if (contact > 0) tmp.lerp(CREVICE, contact * 0.28 + smoothstep(0, 0.8, -s2) * 0.25);
      tmp.multiplyScalar(1 + dither * 0.05);
    }

    // interior surfaces under overhanging rock — wash grottoes, notch
    // floors, vault backs — have no sky above; pull them hard toward the
    // crevice shade. Without this, up-facing surfaces inside a hollow get
    // classified as bright sand floor, which pops inside a shadowed wall
    // base and reads like light leaking through the rock.
    {
      const px = x + nrm.getX(i) * vol.voxel * 0.8;
      const py = y + nY * vol.voxel * 0.8;
      const pz = z + nrm.getZ(i) * vol.voxel * 0.8;
      let hits = 0;
      for (const s of CAVE_STEPS) {
        if (solidAbove(px, py + s, pz)) hits++;
      }
      if (hits > 0) tmp.lerp(CREVICE, (hits / CAVE_STEPS.length) * 0.62);
    }

    // fissure shading (applies on floor AND across ridge tops): slot
    // interior falls to near-black, pale weathered lip just outside. Also
    // tints spots where the carve was clipped at flat hexes, so the crack
    // reads continuous over passable corners.
    const ck = fields.sampleCrack(x, z);
    if (ck < 1.35) {
      const cr = ck + dither * 0.12;
      tmp.lerp(CRACK_DEEP, smoothstep(1.05, 0.3, cr) * 0.88);
      const lip = Math.exp(-((cr - 1.12) * (cr - 1.12)) / 0.012);
      tmp.lerp(CRACK_LIP, lip * 0.3);
    }

    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('facies', new THREE.BufferAttribute(facies, 3));
}

/**
 * How much an up-facing surface reads as pale plateau cap, 0..1.
 * A genuine cap must be (a) at/near its own column's top — 3D-carved
 * ledges, wash lips and grotto floors sit far below their column's
 * groundH — and (b) either deep inside a wall region (a true mesa top,
 * however sunken by the per-region offsets) or genuinely tall (full-height
 * rims). Low rounded knobs at wall BASES fail both: previously they crossed
 * a bare y threshold and glowed bleached-cream inside shadowed bases,
 * reading as light leaking through the rock.
 */
function plateauWeight(
  fields: Fields,
  params: GenParams,
  x: number,
  y: number,
  z: number,
): number {
  const hEff = Math.max(fields.sampleGround(x, z), y);
  const top = smoothstep(hEff - 1.7, hEff - 1.1, y);
  if (top <= 0) return 0;
  const interior = smoothstep(1.1, 1.7, -fields.sampleS2(x, z));
  const tall = smoothstep(params.wallHeight * 0.6, params.wallHeight * 0.8, y);
  const high = Math.max(interior, tall) * smoothstep(params.wallHeight * 0.35, params.wallHeight * 0.5, hEff);
  return top * high;
}

function fbm2Cheap(n2: NoiseKit['n2'], x: number, z: number): number {
  return n2(x * 0.13, z * 0.13) * 0.65 + n2(x * 0.47, z * 0.47) * 0.35;
}

function sampleCraterD(fields: Fields, x: number, z: number): number {
  const fx = (x - fields.originX) / fields.voxel;
  const fz = (z - fields.originZ) / fields.voxel;
  const ix = Math.max(0, Math.min(fields.nx - 1, Math.round(fx)));
  const iz = Math.max(0, Math.min(fields.nz - 1, Math.round(fz)));
  return fields.craterD[iz * fields.nx + ix];
}
