/**
 * Naive Surface Nets over a scalar field sampled on a regular grid.
 * Convention: density > 0 is solid rock, <= 0 is air.
 * Emits one vertex per sign-crossing cell (centroid of edge intersections)
 * and quads (as triangle pairs) across every sign-changing grid edge.
 */

import { BLOCK, BLOCK_MIXED, BLOCK_SHIFT } from './volume';

export interface NetsResult {
  positions: Float32Array;
  indices: Uint32Array;
}

/** Block classification of the volume — only MIXED blocks contain crossings. */
export interface BlockInfo {
  blockType: Uint8Array;
  nbx: number;
  nby: number;
}

// 12 cube edges as corner-index pairs; corner i offset = (i&1, (i>>1)&1, (i>>2)&1)
const EDGES: [number, number][] = [
  [0, 1], [2, 3], [4, 5], [6, 7], // along x
  [0, 2], [1, 3], [4, 6], [5, 7], // along y
  [0, 4], [1, 5], [2, 6], [3, 7], // along z
];

export function surfaceNets(
  data: Float32Array,
  nx: number,
  ny: number,
  nz: number,
  voxel: number,
  originX: number,
  originY: number,
  originZ: number,
  blocks?: BlockInfo,
): NetsResult {
  const positions: number[] = [];
  const indices: number[] = [];
  const cellIdx = new Int32Array(nx * ny * nz).fill(-1);
  const g = new Float32Array(8);
  const strideY = nx;
  const strideZ = nx * ny;
  const steps = [1, strideY, strideZ];

  // Cells are visited in the same global z -> y -> x order with or without
  // block info; skipped runs are provably crossing-free, so the emitted
  // vertex/index streams are byte-identical either way.
  for (let z = 0; z < nz - 1; z++) {
    for (let y = 0; y < ny - 1; y++) {
      const blockRow = blocks
        ? ((z >> BLOCK_SHIFT) * blocks.nby + (y >> BLOCK_SHIFT)) * blocks.nbx
        : 0;
      for (let xRun = 0; xRun < nx - 1; xRun += BLOCK) {
      if (blocks && blocks.blockType[blockRow + (xRun >> BLOCK_SHIFT)] !== BLOCK_MIXED) {
        continue;
      }
      const xEnd = Math.min(xRun + BLOCK, nx - 1);
      for (let x = xRun; x < xEnd; x++) {
        const base = x + y * strideY + z * strideZ;
        let mask = 0;
        for (let i = 0; i < 8; i++) {
          const v = data[base + (i & 1) + ((i >> 1) & 1) * strideY + ((i >> 2) & 1) * strideZ];
          g[i] = v;
          if (v > 0) mask |= 1 << i;
        }
        if (mask === 0 || mask === 0xff) continue;

        // vertex = centroid of edge crossings, in cell-local [0,1]^3
        let vx = 0;
        let vy = 0;
        let vz = 0;
        let count = 0;
        for (let e = 0; e < 12; e++) {
          const [a, b] = EDGES[e];
          const inA = (mask >> a) & 1;
          const inB = (mask >> b) & 1;
          if (inA === inB) continue;
          const da = g[a];
          const db = g[b];
          let t = da / (da - db);
          if (!isFinite(t)) t = 0.5;
          const ax = a & 1;
          const ay = (a >> 1) & 1;
          const az = (a >> 2) & 1;
          const bx = b & 1;
          const by = (b >> 1) & 1;
          const bz = (b >> 2) & 1;
          vx += ax + (bx - ax) * t;
          vy += ay + (by - ay) * t;
          vz += az + (bz - az) * t;
          count++;
        }
        vx /= count;
        vy /= count;
        vz /= count;

        cellIdx[base] = positions.length / 3;
        positions.push(
          originX + (x + vx) * voxel,
          originY + (y + vy) * voxel,
          originZ + (z + vz) * voxel,
        );

        // faces: for each axis edge from corner 0, if sign changes,
        // connect the 4 cells sharing that edge (requires neighbors behind us)
        const c = [x, y, z];
        for (let d = 0; d < 3; d++) {
          const s0 = mask & 1;
          const s1 = (mask >> (1 << d)) & 1;
          if (s0 === s1) continue;
          const u = (d + 1) % 3;
          const w = (d + 2) % 3;
          if (c[u] === 0 || c[w] === 0) continue;
          const v0 = cellIdx[base];
          const v1 = cellIdx[base - steps[u]];
          const v2 = cellIdx[base - steps[u] - steps[w]];
          const v3 = cellIdx[base - steps[w]];
          if (v1 < 0 || v2 < 0 || v3 < 0) continue;
          // split the quad along its shorter diagonal and drop degenerate
          // slivers — avoids hairline triangles on near-flat regions
          if (diagSq(positions, v0, v2) <= diagSq(positions, v1, v3)) {
            if (s0) {
              pushTri(positions, indices, v0, v1, v2);
              pushTri(positions, indices, v0, v2, v3);
            } else {
              pushTri(positions, indices, v0, v3, v2);
              pushTri(positions, indices, v0, v2, v1);
            }
          } else {
            if (s0) {
              pushTri(positions, indices, v1, v2, v3);
              pushTri(positions, indices, v1, v3, v0);
            } else {
              pushTri(positions, indices, v1, v0, v3);
              pushTri(positions, indices, v1, v3, v2);
            }
          }
        }
      }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
}

function diagSq(pos: number[], a: number, b: number): number {
  const dx = pos[a * 3] - pos[b * 3];
  const dy = pos[a * 3 + 1] - pos[b * 3 + 1];
  const dz = pos[a * 3 + 2] - pos[b * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

/** emit a triangle unless it is (near-)degenerate */
function pushTri(pos: number[], indices: number[], a: number, b: number, c: number): void {
  if (a === b || b === c || a === c) return;
  const abx = pos[b * 3] - pos[a * 3];
  const aby = pos[b * 3 + 1] - pos[a * 3 + 1];
  const abz = pos[b * 3 + 2] - pos[a * 3 + 2];
  const acx = pos[c * 3] - pos[a * 3];
  const acy = pos[c * 3 + 1] - pos[a * 3 + 1];
  const acz = pos[c * 3 + 2] - pos[a * 3 + 2];
  const cx = aby * acz - abz * acy;
  const cy = abz * acx - abx * acz;
  const cz = abx * acy - aby * acx;
  if (cx * cx + cy * cy + cz * cz < 1e-10) return;
  indices.push(a, b, c);
}
