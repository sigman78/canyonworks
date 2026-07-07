/**
 * A/B verification for the block-sparse density volume (src/gen/volume.ts):
 * the classified volume must produce surface-nets geometry byte-identical
 * to the brute-force fill (forceAllMixed), and density signs must match at
 * every voxel (the AO bake reads signs only). Also reports timings.
 *
 * Run from repo root: npx tsx tools/verify-volume.ts
 */
import { HexGrid } from '../src/core/hex';
import { makeNoise } from '../src/core/noise';
import { placeCarveOps } from '../src/gen/carves';
import { buildFields } from '../src/gen/fields';
import { generateLayout } from '../src/gen/layout';
import { defaultParams } from '../src/gen/params';
import { surfaceNets } from '../src/gen/surfacenets';
import { buildDensityVolume } from '../src/gen/volume';

let failed = false;

for (const [seed, voxelSize] of [
  [1, 0.3], [7, 0.3], [42, 0.3], [777, 0.3], [12345, 0.3],
  [42, 0.2], [42, 0.15],
] as [number, number][]) {
  const params = defaultParams();
  params.seed = seed;
  params.voxelSize = voxelSize;
  const grid = new HexGrid(params.cols, params.rows, params.hexSize);
  const noise = makeNoise(seed);
  const edits = new Uint8Array(grid.count);
  const layout = generateLayout(grid, params, noise, edits);
  const fields = buildFields(grid, layout.open, params, noise);
  // exercise carve ops + basal wash in the exactness check
  params.archCount = 4;
  params.windowCount = 3;
  params.washCoverage = 0.7;
  params.washAmp = 1.0;
  const ops = placeCarveOps(grid, fields, params, noise);

  let t = performance.now();
  const dense = buildDensityVolume(fields, params, noise, ops, true);
  const denseFill = performance.now() - t;
  t = performance.now();
  const sparse = buildDensityVolume(fields, params, noise, ops);
  const sparseFill = performance.now() - t;

  t = performance.now();
  const netsA = surfaceNets(
    dense.data, dense.nx, dense.ny, dense.nz, dense.voxel, dense.originX, 0, dense.originZ,
  );
  const denseNets = performance.now() - t;
  t = performance.now();
  const netsB = surfaceNets(
    sparse.data, sparse.nx, sparse.ny, sparse.nz, sparse.voxel, sparse.originX, 0, sparse.originZ,
    sparse,
  );
  const sparseNets = performance.now() - t;

  // 1. geometry byte-identical
  let geomOk = true;
  if (netsA.positions.length !== netsB.positions.length) {
    geomOk = false;
    console.log(
      `  positions length ${netsA.positions.length} vs ${netsB.positions.length}`,
    );
  }
  if (netsA.indices.length !== netsB.indices.length) {
    geomOk = false;
    console.log(`  indices length ${netsA.indices.length} vs ${netsB.indices.length}`);
  }
  if (geomOk) {
    for (let i = 0; i < netsA.positions.length; i++) {
      if (netsA.positions[i] !== netsB.positions[i]) {
        geomOk = false;
        console.log(
          `  first position diff at ${i} (vert ${Math.floor(i / 3)}): ` +
            `${netsA.positions[i]} vs ${netsB.positions[i]} | vert A = (` +
            `${netsA.positions[i - (i % 3)]}, ${netsA.positions[i - (i % 3) + 1]}, ` +
            `${netsA.positions[i - (i % 3) + 2]})`,
        );
        break;
      }
    }
  }
  if (geomOk) {
    for (let i = 0; i < netsA.indices.length; i++) {
      if (netsA.indices[i] !== netsB.indices[i]) {
        geomOk = false;
        console.log(`  first index diff at ${i}: ${netsA.indices[i]} vs ${netsB.indices[i]}`);
        break;
      }
    }
  }

  // 2. density sign-identical everywhere (AO correctness)
  let signMismatch = 0;
  for (let i = 0; i < dense.data.length; i++) {
    if (dense.data[i] > 0 !== sparse.data[i] > 0) signMismatch++;
  }

  const nBlocks = sparse.nbx * sparse.nby * sparse.nbz;
  const mixedPct = Math.round((sparse.mixedCount / nBlocks) * 100);
  const ok = geomOk && signMismatch === 0;
  if (!ok) failed = true;
  console.log(
    `seed ${String(seed).padEnd(5)} vox ${voxelSize} ${ok ? 'OK  ' : 'FAIL'} ` +
      `verts ${netsA.positions.length / 3} tris ${netsA.indices.length / 3} | ` +
      `geom ${geomOk ? 'identical' : 'DIFFERS'}, sign mismatches ${signMismatch} | ` +
      `arches ${ops.length} | ` +
      `mixed ${sparse.mixedCount}/${nBlocks} (${mixedPct}%) | ` +
      `fill ${denseFill.toFixed(1)} -> ${sparseFill.toFixed(1)}ms, ` +
      `nets ${denseNets.toFixed(1)} -> ${sparseNets.toFixed(1)}ms`,
  );
}

process.exit(failed ? 1 : 0);
