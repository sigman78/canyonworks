import { fbm3, makeNoise } from './noise';

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
