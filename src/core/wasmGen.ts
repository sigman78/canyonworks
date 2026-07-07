import * as THREE from 'three';
import { fbm3, makeNoise, type NoiseKit } from './noise';
import { lastPerf } from './perf';
import type { HexGrid } from './hex';
import { placeCarveOps } from '../gen/carves';
import { buildFields, fieldsProfileJs, rasterizeOpen } from '../gen/fields';
import { colorizeJs, computeAoJs, paletteSpec } from '../gen/mesher';
import type { GenParams } from '../gen/params';
import { signedDistance } from '../gen/sdf2d';
import { surfaceNets } from '../gen/surfacenets';
import { buildDensityVolume } from '../gen/volume';
import {
  initWasmGen,
  tryWasmFieldsProfile,
  tryWasmGenerateMesh,
  tryWasmSignedDistance,
  wasmGen,
} from '../gen/volumeWasm';

/**
 * WASM generator harnesses (wasm/ crate, built by `npm run wasm:build`). This
 * module is DEV-ONLY: it is reached solely through main.ts's dynamic
 * `import('./core/wasmGen')` for the `__cwWasm` console hook, so bundlers keep
 * it (and its bench/parity code) out of the main chunk. The wasm loader
 * itself lives in gen/volumeWasm — importing it here does NOT drag the
 * harness back into production.
 *
 * - `parity()` / `bench()`: the noise kit — nearness to the JS simplex-noise
 *   (the wasm noise runs f32 since Gate 5) and a like-for-like fbm3
 *   grid-fill timing.
 * - `meshCompare()`: the fused `generate_mesh` chain vs the pure-JS chain
 *   on the running app's map, per-buffer diff report.
 * - `fieldsParity()`: the two still-per-stage fields kernels.
 * - `pipelineBench()`: whole-regenerate stage timings, wasm off vs on.
 *
 * Usage (dev console / Playwright): `await __cwWasm.meshCompare()`
 */

/** max |wasm - js| over a pseudo-random point cloud; 0 = bit-identical */
export async function parity(seed = 1337, points = 2000): Promise<{ n2: number; n3: number }> {
  const wasm = await wasmGen();
  const kit = new wasm.NoiseKit(seed);
  const js = makeNoise(seed);
  let d2 = 0;
  let d3 = 0;
  // deterministic sample cloud, mixed scales (unit cells to far field)
  let s = 12.9898;
  const next = () => {
    s = (s * 9301 + 49297) % 233280;
    return (s / 233280) * 200 - 100;
  };
  for (let i = 0; i < points; i++) {
    const x = next();
    const y = next();
    const z = next();
    d2 = Math.max(d2, Math.abs(kit.noise2(x, y) - js.n2(x, y)));
    d3 = Math.max(d3, Math.abs(kit.noise3(x, y, z) - js.n3(x, y, z)));
  }
  kit.free();
  return { n2: d2, n3: d3 };
}

/** time the same fbm3 grid fill in JS and WASM (volume-fill access pattern) */
export async function bench(
  seed = 1337,
  nx = 128,
  ny = 64,
  nz = 128,
  octaves = 3,
): Promise<{ jsMs: number; wasmMs: number; speedup: number; maxDiff: number; voxels: number }> {
  const voxel = 0.3;
  const freq = 0.55;
  const wasm = await wasmGen();
  const kit = new wasm.NoiseKit(seed);
  const js = makeNoise(seed);

  // warm-up both paths, then measure
  kit.fill_fbm3(8, 8, 8, voxel, freq, octaves);
  const t0 = performance.now();
  const wasmOut = kit.fill_fbm3(nx, ny, nz, voxel, freq, octaves);
  const wasmMs = performance.now() - t0;

  const jsOut = new Float32Array(nx * ny * nz);
  const t1 = performance.now();
  let idx = 0;
  for (let iz = 0; iz < nz; iz++) {
    const z = iz * voxel * freq;
    for (let iy = 0; iy < ny; iy++) {
      const y = iy * voxel * freq;
      for (let ix = 0; ix < nx; ix++) {
        jsOut[idx++] = fbm3(js.n3, ix * voxel * freq, y, z, octaves);
      }
    }
  }
  const jsMs = performance.now() - t1;

  let maxDiff = 0;
  for (let i = 0; i < jsOut.length; i++) {
    const d = Math.abs(jsOut[i] - wasmOut[i]);
    if (d > maxDiff) maxDiff = d;
  }
  kit.free();
  return {
    jsMs: Math.round(jsMs * 10) / 10,
    wasmMs: Math.round(wasmMs * 10) / 10,
    speedup: Math.round((jsMs / wasmMs) * 100) / 100,
    maxDiff,
    voxels: nx * ny * nz,
  };
}

/** per-buffer diff report entry of meshCompare() */
interface BufferDiff {
  /** JS-reference buffer length (elements) */
  jsLen: number;
  /** wasm buffer length (elements) — may differ from jsLen (see meshCompare doc) */
  wasmLen: number;
  /** element-wise a[i] !== b[i] count over the overlapping prefix */
  mismatches: number;
  maxAbsDiff: number;
}

/**
 * Whole-chain mesh comparison: runs the full pure-JS chain
 * (buildDensityVolume + surfaceNets + THREE computeVertexNormals +
 * computeAoJs + colorizeJs — exactly the mesher's fallback path) and the
 * fused wasm generate_mesh (tryWasmGenerateMesh) on the SAME
 * fields/params/ops from the running app, and reports per-buffer
 * { jsLen, wasmLen, mismatches, maxAbsDiff }.
 *
 * Expected (Gate 5+): the JS chain is the f64 REFERENCE and the wasm kernels
 * run f32, so this is a nearness report, not a parity gate. Vertex/index
 * counts should agree within ~0.1% (an f32 density can flip a marginal
 * surface crossing, which shifts every buffer after it); when counts match,
 * maxAbsDiff should be small (budgets: positions <= 1e-2 world units,
 * normals <= 2e-2, ao/colors/facies <= 1e-2). 0 mismatches only happens when
 * both paths compute identical fields with identical math — true in the
 * all-f64 Gate 1-4 era, not since the f32 pass. `mismatches` covers the
 * overlapping prefix; a count drift shows up as jsLen !== wasmLen.
 *
 * Usage (dev console / Playwright): `await __cwWasm.meshCompare()`
 */
export async function meshCompare(): Promise<{
  verts: number;
  positions: BufferDiff;
  indices: BufferDiff;
  normals: BufferDiff;
  ao: BufferDiff;
  colors: BufferDiff;
  facies: BufferDiff;
}> {
  await initWasmGen();
  // the running app instance (main.ts dev hook); fields/params/noise/grid
  // are private on App but reachable here through `any`
  const app = (window as unknown as { __cw?: unknown }).__cw as
    | {
        grid: Parameters<typeof placeCarveOps>[0];
        fields: Parameters<typeof placeCarveOps>[1];
        params: Parameters<typeof placeCarveOps>[2];
        noise: Parameters<typeof placeCarveOps>[3];
      }
    | undefined;
  if (!app) throw new Error('[wasm-mesh] window.__cw not found — run inside the app');
  const { grid, fields, params, noise } = app;
  const ops = placeCarveOps(grid, fields, params, noise);

  // JS reference chain — stage for stage the mesher's fallback path
  const vol = buildDensityVolume(fields, params, noise, ops);
  const nets = surfaceNets(vol.data, vol.nx, vol.ny, vol.nz, vol.voxel, vol.originX, 0, vol.originZ, vol);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(nets.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(nets.indices, 1));
  geometry.computeVertexNormals();
  const normals = (geometry.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array;
  const ao = computeAoJs(
    nets.positions,
    normals,
    vol.data,
    vol.nx,
    vol.ny,
    vol.nz,
    vol.voxel,
    vol.originX,
    vol.originZ,
  );
  const col = colorizeJs(nets.positions, normals, fields, params, noise, vol);

  const wasm = tryWasmGenerateMesh(fields, { ...params, wasmGen: true }, ops, paletteSpec());
  geometry.dispose();
  if (!wasm) throw new Error('[wasm-mesh] wasm module not ready');

  const compare = (a: Float32Array | Uint32Array, b: Float32Array | Uint32Array): BufferDiff => {
    let mismatches = 0;
    let maxAbsDiff = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) {
        mismatches++;
        const d = Math.abs(a[i] - b[i]);
        if (d > maxAbsDiff) maxAbsDiff = d;
      }
    }
    return { jsLen: a.length, wasmLen: b.length, mismatches, maxAbsDiff };
  };

  return {
    verts: nets.positions.length / 3,
    positions: compare(nets.positions, wasm.positions),
    indices: compare(nets.indices, wasm.indices),
    normals: compare(normals, wasm.normals),
    ao: compare(ao, wasm.ao),
    colors: compare(col.colors, wasm.colors),
    facies: compare(col.facies, wasm.facies),
  };
}

/**
 * Fields parity/bench (stage 6): checks BOTH fields kernels against the
 * running app's map.
 *
 * 1. Signed distance: builds the raster via the shared rasterizeOpen (the
 *    same step-1 helper buildFields uses, not a copy) and runs the JS
 *    signedDistance vs the wasm signed_distance on the SAME raster, comparing
 *    in CELL units — BEFORE the `* voxel` scaling that buildFields applies
 *    afterwards. Expected exactly zero — the EDT is the one kernel still f64
 *    (Gate-5 whitelist, see wasm/src/fields.rs) and IEEE sqrt is exact.
 * 2. Ground profile: builds a reference Fields with wasmGen forced OFF
 *    (pure JS end to end), then re-runs the profile step on the SAME
 *    flattened inputs — buildFields keeps its intermediates (flattenW,
 *    flatRaw, mesaOff) on the returned Fields precisely for this, in dev
 *    builds only (import.meta.env.DEV; dropped in production) — via the
 *    JS fieldsProfileJs (timed) and the wasm fields_profile (timed), and
 *    diffs groundH/wallMask/craterD/maxH against the reference. NOT a
 *    parity gate since Gate 5: the wasm profile runs f32 against the f64 JS
 *    reference, so expect LARGE exactDiff counts (most cells differ in the
 *    low bits) with small maxDiff — nearness, not identity.
 *
 * Usage (dev console / Playwright): `await __cwWasm.fieldsParity()`
 */
export async function fieldsParity(): Promise<{
  cols: number;
  sdExactDiff: number;
  sdMaxDiff: number;
  groundExactDiff: number;
  groundMaxDiff: number;
  wallExactDiff: number;
  craterExactDiff: number;
  maxHDiff: number;
  jsMs: number;
  wasmMs: number;
}> {
  await initWasmGen();
  const app = (window as unknown as { __cw?: unknown }).__cw as
    | {
        grid: HexGrid;
        layout: { open: Uint8Array };
        params: GenParams;
        noise: NoiseKit;
      }
    | undefined;
  if (!app) throw new Error('[wasm-fields] window.__cw not found — run inside the app');
  const { grid, layout, params, noise } = app;
  const open = layout.open;

  // --- signed distance: build the EXACT raster buildFields uses (shared
  // rasterizeOpen, not a copy) so both EDTs see identical input ---
  const { openRaster, nx, nz } = rasterizeOpen(grid, open, params);
  const n = nx * nz;

  const jsSd = signedDistance(openRaster, nx, nz);
  const wasmSd = tryWasmSignedDistance(openRaster, nx, nz, { ...params, wasmGen: true });
  if (!wasmSd) throw new Error('[wasm-fields] wasm module not ready');

  const compare = (a: Float32Array, b: Float32Array): { exact: number; max: number } => {
    let exact = Math.abs(a.length - b.length);
    let max = 0;
    const m = Math.min(a.length, b.length);
    for (let i = 0; i < m; i++) {
      if (a[i] !== b[i]) {
        exact++;
        const d = Math.abs(a[i] - b[i]);
        if (d > max) max = d;
      }
    }
    return { exact, max };
  };
  const sd = compare(jsSd, wasmSd);

  // --- ground profile: reference Fields via the pure-JS path (wasmGen OFF),
  // then both profile kernels on the SAME intermediates it carries ---
  const ref = buildFields(grid, open, { ...params, wasmGen: false }, noise);

  const t0 = performance.now();
  fieldsProfileJs(
    ref.nx,
    ref.nz,
    ref.voxel,
    ref.originX,
    ref.originZ,
    ref.s2,
    ref.crackD,
    ref.flattenW,
    ref.flatRaw,
    ref.mesaOff,
    ref.craters,
    params,
    noise,
  );
  const jsMs = performance.now() - t0;

  const t1 = performance.now();
  const wasm = tryWasmFieldsProfile(
    ref.nx,
    ref.nz,
    ref.voxel,
    ref.originX,
    ref.originZ,
    ref.s2,
    ref.crackD,
    ref.flattenW,
    ref.flatRaw,
    ref.mesaOff,
    ref.craters,
    { ...params, wasmGen: true },
  );
  const wasmMs = performance.now() - t1;
  if (!wasm) throw new Error('[wasm-fields] wasm module not ready');

  const ground = compare(ref.groundH, wasm.groundH);
  const wall = compare(ref.wallMask, wasm.wallMask);
  const crater = compare(ref.craterD, wasm.craterD);

  return {
    cols: n,
    sdExactDiff: sd.exact,
    sdMaxDiff: sd.max,
    groundExactDiff: ground.exact,
    groundMaxDiff: ground.max,
    wallExactDiff: wall.exact,
    craterExactDiff: crater.exact,
    maxHDiff: Math.abs(ref.maxH - wasm.maxH),
    jsMs: Math.round(jsMs * 10) / 10,
    wasmMs: Math.round(wasmMs * 10) / 10,
  };
}

/**
 * Per-stage JS-vs-WASM pipeline comparison: runs full regenerates with
 * wasmGen off, then on, averaging the call-site stage timings (core/perf)
 * across runs. Also prints a ready-to-read console.table. The mesh stages
 * (volumeFill..colorize) compare the fused wasm generate_mesh against the
 * JS chain; `fields` compares its wasm EDT + profile kernels against the JS
 * ones. Only the stages with no wasm path yet (layout, decor…) act as the
 * control group — their deltas should be noise.
 */
export async function pipelineBench(runs = 3): Promise<{
  stages: Record<string, { jsMs: number; wasmMs: number; speedup: number }>;
  totalJsMs: number;
  totalWasmMs: number;
}> {
  await initWasmGen();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = (window as any).__cw;
  if (!app) throw new Error('app not ready (__cw missing)');

  const measure = (useWasm: boolean): Record<string, number> => {
    const acc: Record<string, number> = {};
    app.params.wasmGen = useWasm;
    app.regenerate(false); // warm-up, not counted
    for (let i = 0; i < runs; i++) {
      app.regenerate(false);
      for (const [k, v] of Object.entries(lastPerf)) acc[k] = (acc[k] ?? 0) + v / runs;
    }
    return acc;
  };

  // remember and restore the user's backend choice: the bench flips wasmGen
  // to measure both paths, and each regenerate persists it via saveParams —
  // leaving it forced would silently clobber a deliberate opt-out (localStorage
  // + across reloads) while the GUI checkbox still shows the stale state
  const prevWasmGen = app.params.wasmGen;
  const js = measure(false);
  const wasm = measure(true);
  app.params.wasmGen = prevWasmGen;
  app.regenerate(false); // rebuild + persist on the user's selected backend

  const stages: Record<string, { jsMs: number; wasmMs: number; speedup: number }> = {};
  let totalJsMs = 0;
  let totalWasmMs = 0;
  for (const k of Object.keys(js)) {
    const j = Math.round(js[k] * 10) / 10;
    const w = Math.round((wasm[k] ?? 0) * 10) / 10;
    stages[k] = { jsMs: j, wasmMs: w, speedup: w > 0 ? Math.round((j / w) * 100) / 100 : 0 };
    totalJsMs += j;
    totalWasmMs += w;
  }
  console.table(stages);
  return {
    stages,
    totalJsMs: Math.round(totalJsMs * 10) / 10,
    totalWasmMs: Math.round(totalWasmMs * 10) / 10,
  };
}
