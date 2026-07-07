import { fbm2, fbm3, smoothstep, type NoiseKit } from '../core/noise';
import type { CarveOp } from './carves';
import type { Fields } from './fields';
import type { GenParams } from './params';

/**
 * Block-sparse density volume. The volume is partitioned into BLOCK^3 blocks
 * classified AIR / SOLID / MIXED from per-column surface bands; only MIXED
 * blocks get per-voxel density evaluation, and surface nets only traverses
 * them. Storage stays one dense Float32Array (a few MB at current scales) —
 * the sparsity is in *evaluation and traversal*, which is where the time
 * goes; homogeneous blocks are constant-filled (SOLID -> 1, AIR -> 0, sign
 * is all that matters there).
 */

/** Cubic block edge length, voxels. Must equal 1 << BLOCK_SHIFT. */
export const BLOCK = 4;
export const BLOCK_SHIFT = 2;

export const BLOCK_AIR = 0;
export const BLOCK_SOLID = 1;
export const BLOCK_MIXED = 2;

export interface DensityVolume {
  data: Float32Array;
  nx: number;
  ny: number;
  nz: number;
  voxel: number;
  originX: number;
  originZ: number;
  /** per-block classification, index = (bz * nby + by) * nbx + bx */
  blockType: Uint8Array;
  nbx: number;
  nby: number;
  nbz: number;
  mixedCount: number;
  solidCount: number;
}

/**
 * Sample the 3D density (column ground height + 3D roughness on the wall
 * band, which also yields mild overhangs) into a block-classified volume.
 *
 * Exactness argument: the true density can differ in sign from the column
 * base (groundH - y) only inside the per-column band [h - influence,
 * h + influence]. Blocks are classified against that band over a footprint
 * padded by 1 voxel in x/y/z, so every voxel that is a corner of a
 * sign-crossing cell edge — the only voxels whose *magnitude* the mesher
 * ever interpolates — is guaranteed to land in a MIXED block and receive
 * its true value. Homogeneous blocks are only ever read for their sign.
 * Result: geometry is bit-identical to the brute-force dense fill.
 *
 * Carve ops extend the argument: an op can only flip signs inside its
 * conservative bounds, so blocks whose padded range intersects those bounds
 * are forced MIXED and evaluate the op per voxel (per-block op lists); all
 * other blocks are untouched by it. Op lists are assigned from the bounds
 * alone — identical with and without classification — so the byte-identity
 * contract covers ops too.
 *
 * `forceAllMixed` disables classification (every block evaluated) — used to
 * A/B-verify that identity and as a fallback while debugging.
 */
export function buildDensityVolume(
  fields: Fields,
  params: GenParams,
  noise: NoiseKit,
  ops: readonly CarveOp[] = [],
  forceAllMixed = false,
): DensityVolume {
  const { nx, nz, voxel, originX, originZ, groundH, wallMask } = fields;
  const ny = Math.ceil((fields.maxH + 1.0) / voxel) + 1;
  const data = new Float32Array(nx * ny * nz);

  const amp = params.wallNoiseAmp;
  const nf = params.wallNoiseFreq;
  const influence = amp * 1.6 + voxel;
  const { n3 } = noise;

  // ---- per-column roughness + surface band + basal wash -------------------
  // "washed foundation": a basal notch eroded into wall faces (deepest at
  // the floor, tapering up over washHeight) -> natural overhangs and
  // grottoes. Gated per column by a map-wide LARGE-SCALE noise mask (only
  // some regions of the map are washed) times a medium-scale detail that
  // scallops the mouths. Never cuts below floor level or outside walls.
  const { n2 } = noise;
  const s2 = fields.s2;
  const floor = params.floorBase;
  const washAmp = params.washAmp;
  const washH = params.washHeight;
  const washOn = washAmp > 0.01 && params.washCoverage > 0.01 && washH > 0.05;
  // mask threshold: coverage 0 -> nothing, 1 -> almost everywhere
  const washThresh = 1 - params.washCoverage;

  const nCol = nx * nz;
  const rough = new Float32Array(nCol);
  const bandLo = new Float32Array(nCol);
  const bandHi = new Float32Array(nCol);
  const washGate = washOn ? new Float32Array(nCol) : null;
  for (let iz = 0; iz < nz; iz++) {
    const z = originZ + iz * voxel;
    for (let ix = 0; ix < nx; ix++) {
      const col = iz * nx + ix;
      const w = wallMask[col];
      // roughness strongest on the cliff flank, none on open floor
      const r = amp * smoothstep(0.03, 0.25, w) * (1 - 0.6 * smoothstep(0.85, 1, w));
      rough[col] = r;
      const h = groundH[col];
      const inf = r > 0.001 ? influence : 0;
      let lo = h - inf;
      let hi = h + inf;

      if (washGate) {
        const sc = s2[col];
        // only columns near/inside a wall face can be washed
        if (sc < 0.15 && sc > -(washAmp + 0.3)) {
          const x = originX + ix * voxel;
          const mask = 0.5 + 0.5 * fbm2(n2, x * params.washScale + 5.3, z * params.washScale - 9.1, 3);
          const on = smoothstep(washThresh - 0.12, washThresh + 0.12, mask);
          if (on > 0.02) {
            const detail = 0.6 + 0.4 * (0.5 + 0.5 * fbm2(n2, x * 0.33 + 53.1, z * 0.33 - 27.7, 2));
            let g = washAmp * on * detail;
            // pierce guard: march inward along -grad(s2); the most-negative
            // s2 on the ray is this cross-section's half thickness (the ray
            // crosses the medial axis and exits the far side, so nearby
            // OTHER walls can't contaminate it). Clamp the notch depth to
            // keep a solid core — notches washed from opposite faces of a
            // thin wall must never meet, or real sunlight leaks through the
            // pierced base and reads as bright spots on shadowed ground.
            const ixm = Math.max(0, ix - 1);
            const ixp = Math.min(nx - 1, ix + 1);
            const izm = Math.max(0, iz - 1);
            const izp = Math.min(nz - 1, iz + 1);
            let gx = s2[iz * nx + ixp] - s2[iz * nx + ixm];
            let gz = s2[izp * nx + ix] - s2[izm * nx + ix];
            const gl = Math.hypot(gx, gz);
            if (gl > 1e-6) {
              gx /= gl;
              gz /= gl;
              let sMin = sc;
              // must march at least (depth + core) deep: a shorter reach
              // makes thick walls read thinner than they are and silently
              // shaves the wash depth everywhere
              const reach = g + 0.9;
              for (let t = voxel; t <= reach; t += voxel) {
                const sx = Math.max(0, Math.min(nx - 1, Math.round(ix - (gx * t) / voxel)));
                const sz = Math.max(0, Math.min(nz - 1, Math.round(iz - (gz * t) / voxel)));
                const sv = s2[sz * nx + sx];
                if (sv < sMin) sMin = sv;
              }
              g = Math.min(g, -sMin - 0.8);
            }
            if (g > 0.02) {
              washGate[col] = g;
              // the wash can flip signs anywhere in the basal band
              lo = Math.min(lo, floor);
              hi = Math.max(hi, floor + washH + 0.1);
            }
          }
        }
      }
      bandLo[col] = lo;
      bandHi[col] = hi;
    }
  }

  // ---- block classification ------------------------------------------------
  const nbx = Math.ceil(nx / BLOCK);
  const nby = Math.ceil(ny / BLOCK);
  const nbz = Math.ceil(nz / BLOCK);
  const blockType = new Uint8Array(nbx * nby * nbz);

  // band extremes per block column, over a footprint padded by 1 voxel
  const colLo = new Float32Array(nbx * nbz);
  const colHi = new Float32Array(nbx * nbz);
  for (let bz = 0; bz < nbz; bz++) {
    const z0 = Math.max(0, bz * BLOCK - 1);
    const z1 = Math.min(nz - 1, bz * BLOCK + BLOCK);
    for (let bx = 0; bx < nbx; bx++) {
      const x0 = Math.max(0, bx * BLOCK - 1);
      const x1 = Math.min(nx - 1, bx * BLOCK + BLOCK);
      let lo = Infinity;
      let hi = -Infinity;
      for (let iz = z0; iz <= z1; iz++) {
        const row = iz * nx;
        for (let ix = x0; ix <= x1; ix++) {
          if (bandLo[row + ix] < lo) lo = bandLo[row + ix];
          if (bandHi[row + ix] > hi) hi = bandHi[row + ix];
        }
      }
      colLo[bz * nbx + bx] = lo;
      colHi[bz * nbx + bx] = hi;
    }
  }

  for (let bz = 0; bz < nbz; bz++) {
    for (let by = 0; by < nby; by++) {
      // y range padded by 1 voxel, same reasoning as the footprint pad
      const yLo = (by * BLOCK - 1) * voxel;
      const yHi = (by * BLOCK + BLOCK) * voxel;
      for (let bx = 0; bx < nbx; bx++) {
        let t: number;
        if (forceAllMixed) {
          t = BLOCK_MIXED;
        } else {
          const lo = colLo[bz * nbx + bx];
          const hi = colHi[bz * nbx + bx];
          t = yLo > hi ? BLOCK_AIR : yHi < lo ? BLOCK_SOLID : BLOCK_MIXED;
          // The volume boundary is forced air (closed diorama skirt), which
          // the band doesn't know about. A would-be-solid block must be
          // evaluated per voxel if its PADDED range reaches the forced-air
          // shell — cells in a block's last row/column read corners one
          // voxel further, so testing "contains a boundary voxel" is not
          // enough (a 1-voxel-thin final block leaves the skirt crossings
          // based in its inner neighbor).
          if (
            t === BLOCK_SOLID &&
            (bx === 0 ||
              bx * BLOCK + BLOCK >= nx - 1 ||
              bz === 0 ||
              bz * BLOCK + BLOCK >= nz - 1 ||
              by * BLOCK + BLOCK >= ny - 1)
          ) {
            t = BLOCK_MIXED;
          }
        }
        blockType[(bz * nby + by) * nbx + bx] = t;
      }
    }
  }

  // ---- carve ops: force affected blocks MIXED + per-block op lists ---------
  // Assigned purely from op bounds (padded 1 voxel like the band test), NOT
  // from classification state, so classified and forceAllMixed volumes apply
  // exactly the same ops to exactly the same voxels.
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
          blockType[bi] = BLOCK_MIXED;
          let list = opLists.get(bi);
          if (!list) opLists.set(bi, (list = []));
          list.push(oi);
        }
      }
    }
  }

  let mixedCount = 0;
  let solidCount = 0;
  for (let i = 0; i < blockType.length; i++) {
    if (blockType[i] === BLOCK_MIXED) mixedCount++;
    else if (blockType[i] === BLOCK_SOLID) solidCount++;
  }

  // ---- fill ------------------------------------------------------------------
  const strideZ = nx * ny;
  for (let bz = 0; bz < nbz; bz++) {
    const z0 = bz * BLOCK;
    const zEnd = Math.min(z0 + BLOCK, nz);
    for (let by = 0; by < nby; by++) {
      const y0 = by * BLOCK;
      const yEnd = Math.min(y0 + BLOCK, ny);
      for (let bx = 0; bx < nbx; bx++) {
        const t = blockType[(bz * nby + by) * nbx + bx];
        if (t === BLOCK_AIR) continue; // zero-init reads as air
        const x0 = bx * BLOCK;
        const xEnd = Math.min(x0 + BLOCK, nx);
        if (t === BLOCK_SOLID) {
          for (let iz = z0; iz < zEnd; iz++) {
            for (let iy = y0; iy < yEnd; iy++) {
              const row = iy * nx + iz * strideZ;
              data.fill(1, row + x0, row + xEnd);
            }
          }
          continue;
        }
        // MIXED: true density, identical math to the classic dense fill
        const list = opLists.get((bz * nby + by) * nbx + bx);
        for (let iz = z0; iz < zEnd; iz++) {
          const z = originZ + iz * voxel;
          const edgeZ = iz === 0 || iz === nz - 1;
          for (let ix = x0; ix < xEnd; ix++) {
            const col = iz * nx + ix;
            const x = originX + ix * voxel;
            const h = groundH[col];
            const r = rough[col];
            const edge = edgeZ || ix === 0 || ix === nx - 1;
            for (let iy = y0; iy < yEnd; iy++) {
              const idx = ix + iy * nx + iz * strideZ;
              if (edge || iy === ny - 1) {
                data[idx] = -1; // force air at volume boundary -> closed skirt
                continue;
              }
              const y = iy * voxel;
              let d = h - y;
              if (r > 0.001 && Math.abs(d) < influence) {
                d += fbm3(n3, x * nf, y * nf * 0.7, z * nf, 3) * r;
              }
              if (washGate) {
                const g = washGate[col];
                if (g > 0.02 && y > floor && y < floor + washH) {
                  // sqrt profile: deepest at the floor, VERTICAL tangent at
                  // the top — the ceiling meets the wall face in a crisp
                  // lip. (A linear taper grazed the face and smeared a band
                  // of up-facing sliver triangles that picked up the pale
                  // mesa-cap color/texture: bright spots at shadowed wall
                  // bases.) The -0.04 erosion trims sub-voxel hairlines.
                  const fall = 1 - (y - floor) / washH;
                  // notch bottom sits exactly at floor level (no raised
                  // step at the mouth); passable hexes are protected by
                  // their SDF margin + the s2 gate, never by this term
                  const cut =
                    Math.min(
                      g * Math.sqrt(fall) + s2[col],
                      y - floor,
                      0.02 - s2[col],
                    ) - 0.04;
                  d = Math.min(d, -cut);
                }
              }
              if (list) {
                for (let k = 0; k < list.length; k++) {
                  const op = ops[list[k]];
                  const s = op.sdf(x, y, z);
                  d = op.kind === 'add' ? Math.max(d, s) : Math.min(d, -s);
                }
              }
              data[idx] = d;
            }
          }
        }
      }
    }
  }

  return {
    data,
    nx,
    ny,
    nz,
    voxel,
    originX,
    originZ,
    blockType,
    nbx,
    nby,
    nbz,
    mixedCount,
    solidCount,
  };
}
