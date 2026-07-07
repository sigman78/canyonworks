import type { CarveOp } from './carves';
import type { Crater, Fields } from './fields';
import type { GenParams } from './params';

/**
 * WASM dispatch for the generator. The mesh chain is ONE fused call
 * (`tryWasmGenerateMesh` -> Rust `generate_mesh`): volume fill -> carve ops
 * -> surface nets -> normals -> AO -> colorize all run wasm-side, so the
 * ~4MB density volume never crosses the JS/wasm boundary. The two fields
 * kernels (`tryWasmSignedDistance` / `tryWasmFieldsProfile`) stay per-stage
 * until layout/fields-glue moves in-crate (Stage B). Every dispatcher
 * returns null when `params.wasmGen === false`, the module isn't loaded, or
 * the wasm call throws (logged) — the CALLER falls back to the pure-JS
 * implementation.
 */

type WasmModule = typeof import('../../wasm/pkg/canyonworks_wasm');

let wasmModule: WasmModule | null = null;
let initPromise: Promise<void> | null = null;
let modPromise: Promise<WasmModule> | null = null;

/**
 * Lazy-load + instantiate the wasm module (no cost until first use). Lives
 * here in the dispatch layer — NOT in the dev harness (core/wasmGen.ts) — so
 * production code reaches the loader without statically pulling the entire
 * bench/parity harness into the main bundle; the harness imports this.
 */
export async function wasmGen(): Promise<WasmModule> {
  if (!modPromise) {
    modPromise = import('../../wasm/pkg/canyonworks_wasm').then(async (m) => {
      await m.default();
      return m;
    });
  }
  return modPromise;
}

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
 * A wasm trap (Rust panic/assert surfaces as a `WebAssembly.RuntimeError`) can
 * leave the module instance mid-mutation; per wasm-bindgen it must not be
 * reused, so drop the singleton and every later call stays on the JS fallback
 * for the rest of the session. A plain exception (e.g. a serde decode error)
 * is thrown before any wasm mutation and is recoverable — keep the module.
 */
function disableWasmOnTrap(err: unknown): void {
  if (err instanceof WebAssembly.RuntimeError) {
    console.error('[wasm] trap detected — disabling the wasm backend for this session (instance poisoned)');
    wasmModule = null;
  }
}

/** plain linear-space color triple (a THREE.Color snapshot: {r, g, b}) */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Per-call snapshot of the mesher's TERRAIN_PALETTE, serde-decoded by
 * wasm/src/params.rs `Palette`. Built by the CALLER (mesher.ts
 * `paletteSpec()` — the palette is local to the mesher, and this module
 * must never import the mesher: import cycle) and rebuilt per call, never
 * cached: the Palette panel mutates the live THREE.Color objects between
 * regenerates.
 */
export interface PaletteSpec {
  /** cliff strata bands, bottom to top (5 entries) */
  strata: Rgb[];
  floorA: Rgb;
  floorB: Rgb;
  cap: Rgb;
  crevice: Rgb;
  craterIn: Rgb;
  craterWall: Rgb;
  craterRim: Rgb;
  ejecta: Rgb;
  crackDeep: Rgb;
  crackLip: Rgb;
}

/** result of the fused wasm `generate_mesh` — final mesh buffers + stats */
export interface WasmMesh {
  positions: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
  ao: Float32Array;
  colors: Float32Array;
  facies: Float32Array;
  nbx: number;
  nby: number;
  nbz: number;
  mixedCount: number;
  solidCount: number;
  /** [volumeFill(+carve ops), surfaceNets, normals, aoBake, colorize] ms */
  stageMs: number[];
}

/**
 * Fused whole-chain dispatcher: ONE wasm call runs volume fill -> carve ops
 * -> surface nets -> normals -> AO -> colorize, so the ~4MB density volume
 * never crosses the JS/wasm boundary — only the five small 2D field rasters
 * go in and the final mesh buffers come out. Returns null when
 * `params.wasmGen === false`, the module hasn't finished loading, or the
 * wasm call throws (serde error etc — logged, then the CALLER falls back to
 * the full JS chain in ./mesher). Ops are serialized from their `shape`
 * payloads (carves.ts CarveShapeSpec — the sdf closures never cross the
 * boundary); params go over as the live object (serde ignores unknown
 * fields, defaults missing ones).
 */
export function tryWasmGenerateMesh(
  fields: Fields,
  params: GenParams,
  ops: readonly CarveOp[],
  palette: PaletteSpec,
): WasmMesh | null {
  const mod = wasmModule;
  if (params.wasmGen === false || mod === null) return null;
  const t0 = performance.now();
  try {
    const opSpecs = ops.map((o) => ({
      kind: o.kind,
      minX: o.minX,
      maxX: o.maxX,
      minY: o.minY,
      maxY: o.maxY,
      minZ: o.minZ,
      maxZ: o.maxZ,
      shape: o.shape,
    }));
    const res = mod.generate_mesh(
      fields.groundH,
      fields.wallMask,
      fields.s2,
      fields.crackD,
      fields.craterD,
      fields.nx >>> 0,
      fields.nz >>> 0,
      fields.voxel,
      fields.originX,
      fields.originZ,
      fields.maxH,
      opSpecs,
      params,
      palette,
      false, // forceAllMixed
    );
    const out: WasmMesh = {
      positions: res.positions,
      indices: res.indices,
      normals: res.normals,
      ao: res.ao,
      colors: res.colors,
      facies: res.facies,
      nbx: res.nbx,
      nby: res.nby,
      nbz: res.nbz,
      mixedCount: res.mixed_count,
      solidCount: res.solid_count,
      stageMs: Array.from(res.stage_ms),
    };
    res.free(); // getters copied out; drop the wasm-side buffers now
    console.debug(`[wasm-mesh] generate_mesh ${(performance.now() - t0).toFixed(1)}ms (wasm)`);
    return out;
  } catch (err) {
    console.error('[wasm-mesh] generate_mesh failed, falling back to the JS chain', err);
    disableWasmOnTrap(err);
    return null;
  }
}

/**
 * Signed-distance dispatcher (fields stage): wasm attempt only — returns
 * null when `params.wasmGen === false`, the module hasn't finished loading,
 * or the wasm call throws (a Rust assert panics as a JS exception — logged),
 * and the CALLER (buildFields step 2 in ./fields) falls back to the pure-JS
 * signedDistance in ./sdf2d. Returns CELL units exactly like sdf2d.ts — the
 * `* voxel` world-unit scaling stays in buildFields. Expected bit-identical
 * to the JS (the EDT stays f64 per the Gate-5 whitelist; IEEE sqrt).
 */
export function tryWasmSignedDistance(
  openRaster: Uint8Array,
  nx: number,
  nz: number,
  params: GenParams,
): Float32Array | null {
  const mod = wasmModule;
  if (params.wasmGen === false || mod === null) return null;
  const t0 = performance.now();
  try {
    const out = mod.signed_distance(openRaster, nx >>> 0, nz >>> 0);
    console.debug(`[wasm-fields] sdf ${(performance.now() - t0).toFixed(1)}ms (wasm)`);
    return out;
  } catch (err) {
    console.error('[wasm-fields] signed_distance failed, falling back to the JS EDT', err);
    disableWasmOnTrap(err);
    return null;
  }
}

/**
 * Ground-profile dispatcher (fields stage): wasm attempt only — returns null
 * when `params.wasmGen === false`, the module hasn't finished loading, or
 * the wasm call throws (serde error / Rust assert — logged), and the CALLER
 * (buildFields step 7 in ./fields) falls back to the pure-JS fieldsProfileJs
 * there. `s2` must be ALREADY voxel-scaled (world units); craters are
 * flattened 4-stride [x, z, r, depth]; params go over as the live object
 * (serde-decoded GenParams — seed derivation happens wasm-side).
 * NOT parity-exact: the wasm profile runs f32 (Gate 5) against the f64 JS
 * path — visually equivalent, not bitwise (see wasm/src/fields.rs; the
 * fieldsParity harness in core/wasmGen.ts measures the nearness).
 */
export function tryWasmFieldsProfile(
  nx: number,
  nz: number,
  voxel: number,
  originX: number,
  originZ: number,
  s2: Float32Array,
  crackD: Float32Array,
  flattenW: Float32Array,
  flatRaw: Uint8Array,
  mesaOff: Float32Array,
  craters: readonly Crater[],
  params: GenParams,
): { groundH: Float32Array; wallMask: Float32Array; craterD: Float32Array; maxH: number } | null {
  const mod = wasmModule;
  if (params.wasmGen === false || mod === null) return null;
  const t0 = performance.now();
  try {
    const cratersFlat = new Float64Array(craters.length * 4);
    for (let i = 0; i < craters.length; i++) {
      const c = craters[i];
      cratersFlat[i * 4] = c.x;
      cratersFlat[i * 4 + 1] = c.z;
      cratersFlat[i * 4 + 2] = c.r;
      cratersFlat[i * 4 + 3] = c.depth;
    }
    const res = mod.fields_profile(
      nx >>> 0,
      nz >>> 0,
      voxel,
      originX,
      originZ,
      s2,
      crackD,
      flattenW,
      flatRaw,
      mesaOff,
      cratersFlat,
      params,
    );
    const out = {
      groundH: res.ground_h,
      wallMask: res.wall_mask,
      craterD: res.crater_d,
      maxH: res.max_h,
    };
    res.free(); // getters copied out; drop the wasm-side buffers now
    console.debug(`[wasm-fields] profile ${(performance.now() - t0).toFixed(1)}ms (wasm)`);
    return out;
  } catch (err) {
    console.error('[wasm-fields] fields_profile failed, falling back to the JS profile', err);
    disableWasmOnTrap(err);
    return null;
  }
}
