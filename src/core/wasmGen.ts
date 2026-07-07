import { fbm3, makeNoise } from './noise';
import { placeCarveOps } from '../gen/carves';
import { surfaceNets } from '../gen/surfacenets';
import { buildDensityVolume } from '../gen/volume';
import { buildVolume, initWasmGen } from '../gen/volumeWasm';

/**
 * WASM generator kernels (wasm/ crate, built by `npm run wasm:build`).
 *
 * Stage 1: deterministic noise kit + parity/bench harness. The wasm
 * NoiseKit mirrors makeNoise()'s seeding, and the Rust port is meant to
 * be bit-compatible with the JS simplex-noise — `parity()` verifies
 * that; `bench()` times the same fbm3 grid fill in both worlds.
 *
 * Usage (dev console / Playwright): `await __cwWasm.bench(1337)`
 */

type WasmModule = typeof import('../../wasm/pkg/canyonworks_wasm');

let modPromise: Promise<WasmModule> | null = null;

/** lazy-load + instantiate the wasm module (no cost until first use) */
export async function wasmGen(): Promise<WasmModule> {
  if (!modPromise) {
    modPromise = import('../../wasm/pkg/canyonworks_wasm').then(async (m) => {
      await m.default();
      return m;
    });
  }
  return modPromise;
}

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

/**
 * Volume-fill parity/bench: rebuilds the density volume both ways (JS
 * `buildDensityVolume` vs the wasm `fill_volume` path + carve-op post-pass
 * in `gen/volumeWasm.ts`) against the currently-running app's map, and
 * diffs the results. Bit-identical is expected (maxDiff 0 / diffCount 0);
 * a handful of diffs confined to wash columns is acceptable (see the ABI
 * spec's hypot-ULP note) but must be reported, not hidden.
 *
 * Usage (dev console / Playwright): `await __cwWasm.volParity()`
 */
export async function volParity(): Promise<{
  maxDiff: number;
  diffCount: number;
  blocksDiff: number;
  jsMs: number;
  wasmMs: number;
  voxels: number;
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
  if (!app) throw new Error('[wasm-vol] window.__cw not found — run inside the app');
  const { grid, fields, params, noise } = app;
  const ops = placeCarveOps(grid, fields, params, noise);

  const t0 = performance.now();
  const js = buildDensityVolume(fields, params, noise, ops);
  const jsMs = performance.now() - t0;

  const t1 = performance.now();
  const wasm = buildVolume(fields, { ...params, wasmGen: true }, noise, ops);
  const wasmMs = performance.now() - t1;

  let maxDiff = 0;
  let diffCount = 0;
  const n = Math.min(js.data.length, wasm.data.length);
  for (let i = 0; i < n; i++) {
    const d = Math.abs(js.data[i] - wasm.data[i]);
    if (d > 1e-6) {
      diffCount++;
      if (d > maxDiff) maxDiff = d;
    }
  }

  let blocksDiff = 0;
  const nb = Math.min(js.blockType.length, wasm.blockType.length);
  for (let i = 0; i < nb; i++) {
    if (js.blockType[i] !== wasm.blockType[i]) blocksDiff++;
  }

  return {
    maxDiff,
    diffCount,
    blocksDiff,
    jsMs: Math.round(jsMs * 10) / 10,
    wasmMs: Math.round(wasmMs * 10) / 10,
    voxels: n,
  };
}

/**
 * Surface-nets parity/bench: builds the FINAL density volume ONCE via the
 * pure-JS path (buildDensityVolume, carve ops included), then meshes that
 * SAME data/blockType with the JS surfaceNets and the wasm surface_nets and
 * byte-compares the streams. Both are expected exactly equal — positions
 * element-by-element on the Float32Array (the wasm builds in f64 and rounds
 * to f32 at the end, just like the JS number[] -> Float32Array), indices
 * element-by-element.
 *
 * Usage (dev console / Playwright): `await __cwWasm.netsParity()`
 */
export async function netsParity(): Promise<{
  vertsJs: number;
  vertsWasm: number;
  posDiffCount: number;
  idxDiffCount: number;
  jsMs: number;
  wasmMs: number;
}> {
  await initWasmGen();
  const wasm = await wasmGen();
  const app = (window as unknown as { __cw?: unknown }).__cw as
    | {
        grid: Parameters<typeof placeCarveOps>[0];
        fields: Parameters<typeof placeCarveOps>[1];
        params: Parameters<typeof placeCarveOps>[2];
        noise: Parameters<typeof placeCarveOps>[3];
      }
    | undefined;
  if (!app) throw new Error('[wasm-nets] window.__cw not found — run inside the app');
  const { grid, fields, params, noise } = app;
  const ops = placeCarveOps(grid, fields, params, noise);
  const vol = buildDensityVolume(fields, params, noise, ops);

  const t0 = performance.now();
  const js = surfaceNets(vol.data, vol.nx, vol.ny, vol.nz, vol.voxel, vol.originX, 0, vol.originZ, vol);
  const jsMs = performance.now() - t0;

  const t1 = performance.now();
  // .d.ts may lag surface_nets — cast through `any`, same as fill_volume
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = (wasm as any).surface_nets(
    vol.data,
    vol.blockType,
    vol.nx >>> 0,
    vol.ny >>> 0,
    vol.nz >>> 0,
    vol.voxel,
    vol.originX,
    0, // originY — same value the mesher passes
    vol.originZ,
    vol.nbx >>> 0,
    vol.nby >>> 0,
  );
  const wasmPos = res.positions as Float32Array;
  const wasmIdx = res.indices as Uint32Array;
  const wasmMs = performance.now() - t1;

  let posDiffCount = Math.abs(js.positions.length - wasmPos.length);
  const np = Math.min(js.positions.length, wasmPos.length);
  for (let i = 0; i < np; i++) {
    if (js.positions[i] !== wasmPos[i]) posDiffCount++;
  }

  let idxDiffCount = Math.abs(js.indices.length - wasmIdx.length);
  const ni = Math.min(js.indices.length, wasmIdx.length);
  for (let i = 0; i < ni; i++) {
    if (js.indices[i] !== wasmIdx[i]) idxDiffCount++;
  }

  return {
    vertsJs: js.positions.length / 3,
    vertsWasm: wasmPos.length / 3,
    posDiffCount,
    idxDiffCount,
    jsMs: Math.round(jsMs * 10) / 10,
    wasmMs: Math.round(wasmMs * 10) / 10,
  };
}

/**
 * Per-stage JS-vs-WASM pipeline comparison: runs full regenerates with
 * wasmGen off, then on, averaging the call-site stage timings (core/perf)
 * across runs. Also prints a ready-to-read console.table. Stages that have
 * no wasm path yet (layout, fields, ao, colorize, decor…) act as the
 * control group — their deltas should be noise.
 */
export async function pipelineBench(runs = 3): Promise<{
  stages: Record<string, { jsMs: number; wasmMs: number; speedup: number }>;
  totalJsMs: number;
  totalWasmMs: number;
}> {
  await initWasmGen();
  const { lastPerf } = await import('./perf');
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

  const js = measure(false);
  const wasm = measure(true);
  app.params.wasmGen = true;

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
