import type { NoiseKit } from '../core/noise';
import { wasmGen } from '../core/wasmGen';
import type { CarveOp } from './carves';
import type { Fields } from './fields';
import type { GenParams } from './params';
import { BLOCK, buildDensityVolume, type DensityVolume } from './volume';

/**
 * WASM dispatch for the volume-fill kernel (stage 2). `fill_volume` (Rust,
 * `wasm/src/volume.rs`) does everything buildDensityVolume() does EXCEPT
 * carve-op SDF evaluation — op.sdf closures are JS-only, so after the wasm
 * fill returns we replay the carve-op post-pass here, exactly matching the
 * per-block op lists + fill-loop order in `./volume` (lines ~240-259 and the
 * MIXED-block fill loop) so results are byte-identical to the JS path.
 */

type WasmModule = Awaited<ReturnType<typeof wasmGen>>;

let wasmModule: WasmModule | null = null;
let initPromise: Promise<void> | null = null;

/** Kick off the wasm module load; safe to call multiple times, fire-and-forget. */
export function initWasmGen(): Promise<void> {
  if (!initPromise) {
    initPromise = wasmGen()
      .then((m) => {
        wasmModule = m;
      })
      .catch((err) => {
        console.warn('[wasm-vol] module init failed, staying on JS fallback', err);
      });
  }
  return initPromise;
}

/**
 * Synchronous dispatcher: uses the wasm fill when `params.wasmGen !== false`
 * AND the module has finished loading (cached in `wasmModule` once its
 * promise resolves), otherwise falls back to the JS `buildDensityVolume`.
 */
export function buildVolume(
  fields: Fields,
  params: GenParams,
  noise: NoiseKit,
  ops: readonly CarveOp[] = [],
  forceAllMixed = false,
): DensityVolume {
  const useWasm = params.wasmGen !== false && wasmModule !== null;
  const t0 = performance.now();
  const vol = useWasm
    ? buildVolumeWasm(wasmModule as WasmModule, fields, params, ops, forceAllMixed)
    : buildDensityVolume(fields, params, noise, ops, forceAllMixed);
  const ms = performance.now() - t0;
  console.debug(`[wasm-vol] fill ${ms.toFixed(1)}ms (${useWasm ? 'wasm' : 'js fallback'})`);
  return vol;
}

/** PARAMS vector order — MUST match wasm/src/volume.rs exactly (see ABI spec). */
function flattenParams(params: GenParams): Float64Array {
  return new Float64Array([
    params.wallNoiseAmp, // 0
    params.wallNoiseFreq, // 1
    params.ledgeAmp, // 2
    params.terraceStep, // 3
    params.floorBase, // 4
    params.washAmp, // 5
    params.washHeight, // 6
    params.washCoverage, // 7
    params.washScale, // 8
  ]);
}

function flattenOpBounds(ops: readonly CarveOp[]): Float64Array {
  const out = new Float64Array(ops.length * 6);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const b = i * 6;
    out[b] = op.minX;
    out[b + 1] = op.maxX;
    out[b + 2] = op.minY;
    out[b + 3] = op.maxY;
    out[b + 4] = op.minZ;
    out[b + 5] = op.maxZ;
  }
  return out;
}

function buildVolumeWasm(
  mod: WasmModule,
  fields: Fields,
  params: GenParams,
  ops: readonly CarveOp[],
  forceAllMixed: boolean,
): DensityVolume {
  const { nx, nz, voxel, originX, originZ, groundH, wallMask, s2 } = fields;
  // same formula as volume.ts line ~72; precomputed here, NOT re-derived in Rust
  const ny = Math.ceil((fields.maxH + 1.0) / voxel) + 1;

  const paramsVec = flattenParams(params);
  const opBounds = flattenOpBounds(ops);

  // The generated wasm-bindgen .d.ts lags fill_volume/VolumeResult (the Rust
  // side lands wasm/src/volume.rs in parallel with this file) — cast through
  // `any` at this one call + its result access, per the ABI spec.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (mod as any).fill_volume(
    params.seed >>> 0,
    nx >>> 0,
    ny >>> 0,
    nz >>> 0,
    voxel,
    originX,
    originZ,
    groundH,
    wallMask,
    s2,
    paramsVec,
    opBounds,
    forceAllMixed,
  );

  const vol: DensityVolume = {
    data: result.data as Float32Array,
    nx,
    ny,
    nz,
    voxel,
    originX,
    originZ,
    blockType: result.block_type as Uint8Array,
    nbx: result.nbx as number,
    nby: result.nby as number,
    nbz: result.nbz as number,
    mixedCount: result.mixed_count as number,
    solidCount: result.solid_count as number,
  };

  applyCarveOpsPostPass(vol, ops);
  return vol;
}

/**
 * Carve-op post-pass: rebuild per-block op lists purely from op bounds
 * (identical math to volume.ts lines ~240-259 — block forcing to MIXED
 * already happened on the wasm side, so only the list-building matters
 * here), then apply the ops voxel-by-voxel over exactly those blocks' voxel
 * ranges, iz outer -> ix -> iy inner (same nested order as volume.ts's fill
 * loop, so per-voxel op application order is identical). Edge voxels
 * (ix/iz == 0 or n-1, iy == ny-1) are forced -1 air by the wasm fill and are
 * skipped BEFORE op evaluation, exactly like the JS `continue` — ops never
 * touch the closed diorama skirt.
 */
function applyCarveOpsPostPass(vol: DensityVolume, ops: readonly CarveOp[]): void {
  if (ops.length === 0) return;
  const { data, nx, ny, nz, voxel, originX, originZ, nbx, nby, nbz } = vol;

  const opLists = new Map<number, number[]>();
  for (let oi = 0; oi < ops.length; oi++) {
    const op = ops[oi];
    const bx0 = Math.max(0, Math.ceil(((op.minX - originX) / voxel - BLOCK) / BLOCK));
    const bx1 = Math.min(nbx - 1, Math.floor(((op.maxX - originX) / voxel + 1) / BLOCK));
    const by0 = Math.max(0, Math.ceil((op.minY / voxel - BLOCK) / BLOCK));
    const by1 = Math.min(nby - 1, Math.floor((op.maxY / voxel + 1) / BLOCK));
    const bz0 = Math.max(0, Math.ceil(((op.minZ - originZ) / voxel - BLOCK) / BLOCK));
    const bz1 = Math.min(nbz - 1, Math.floor(((op.maxZ - originZ) / voxel + 1) / BLOCK));
    for (let bz = bz0; bz <= bz1; bz++) {
      for (let by = by0; by <= by1; by++) {
        for (let bx = bx0; bx <= bx1; bx++) {
          const bi = (bz * nby + by) * nbx + bx;
          let list = opLists.get(bi);
          if (!list) opLists.set(bi, (list = []));
          list.push(oi);
        }
      }
    }
  }
  if (opLists.size === 0) return;

  const strideZ = nx * ny;
  for (const [bi, list] of opLists) {
    const bx = bi % nbx;
    const by = Math.floor(bi / nbx) % nby;
    const bz = Math.floor(bi / (nbx * nby));
    const x0 = bx * BLOCK;
    const xEnd = Math.min(x0 + BLOCK, nx);
    const y0 = by * BLOCK;
    const yEnd = Math.min(y0 + BLOCK, ny);
    const z0 = bz * BLOCK;
    const zEnd = Math.min(z0 + BLOCK, nz);

    for (let iz = z0; iz < zEnd; iz++) {
      const z = originZ + iz * voxel;
      const edgeZ = iz === 0 || iz === nz - 1;
      for (let ix = x0; ix < xEnd; ix++) {
        const edge = edgeZ || ix === 0 || ix === nx - 1;
        if (edge) continue; // forced -1 air at the volume boundary; ops never see it
        const x = originX + ix * voxel;
        for (let iy = y0; iy < yEnd; iy++) {
          if (iy === ny - 1) continue; // top boundary voxel, same forced -1
          const y = iy * voxel;
          const idx = ix + iy * nx + iz * strideZ;
          let d = data[idx];
          for (let k = 0; k < list.length; k++) {
            const op = ops[list[k]];
            const s = op.sdf(x, y, z);
            d = op.kind === 'add' ? Math.max(d, s) : Math.min(d, -s);
          }
          data[idx] = d;
        }
      }
    }
  }
}
