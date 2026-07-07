import { clamp01, fbm2, type NoiseKit } from '../core/noise';
import type { HexGrid } from '../core/hex';
import type { Fields } from './fields';
import type { GenParams } from './params';

/**
 * 3D carve ops: localized CSG applied to the density volume after the
 * column fill (research/voxel3d). `add` unions rock in, `cut` subtracts
 * air. The op array is ordered adds-first-then-cuts so vault/window
 * openings always win over added rock. Ops are culled per block: only
 * blocks whose padded voxel range intersects an op's bounds evaluate it,
 * and those blocks are forced MIXED so the block classification stays
 * exact.
 *
 * Features built from ops:
 * - Arch: a rock plug filling a narrow corridor throat wall-to-wall (add)
 *   with an arched vault cut through it along the corridor (cut) — the
 *   canyon walls meet overhead, the passage keeps its flat passable floor.
 * - Window: a hole punched through a thin high fin (cut only), well above
 *   the floor — pure aesthetics, no gameplay effect.
 */
export interface CarveOp {
  kind: 'add' | 'cut';
  /**
   * conservative world bounds of every point where sdf can be > 0.
   * INVARIANT: the sdf itself must be <= 0 everywhere outside these bounds
   * — ops evaluate wherever their block list reaches (whole blocks), so a
   * shape that "leaks" past its bounds creates phantom surfaces at block
   * boundaries and breaks the classification exactness contract.
   */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  /** inside-positive pseudo-SDF, world coordinates */
  sdf(x: number, y: number, z: number): number;
}

interface ArchSite {
  /** probe origin on the corridor floor */
  px: number;
  pz: number;
  /** unit directions, wall-face hit distances and abutment anchors */
  d0x: number;
  d0z: number;
  hit0: number;
  anchor0: number;
  d1x: number;
  d1z: number;
  hit1: number;
  anchor1: number;
  /** wall heights at the anchors */
  h0: number;
  h1: number;
  score: number;
}

const DIRS = 24; // radial probe directions
const STEP = 0.25; // probe march step, world units
const EMBED = 0.9; // extra rooting depth past the anchor point
const RIM_SINK = 0.1; // arch crown sits this fraction below the lower rim
const MIN_CAP = 0.45; // thinnest viable rock above the vault apex

/** All carve ops for the map: arches over throats + windows in fins. */
export function placeCarveOps(
  grid: HexGrid,
  fields: Fields,
  params: GenParams,
  noise: NoiseKit,
): CarveOp[] {
  const adds: CarveOp[] = [];
  const cuts: CarveOp[] = [];
  const sites = findArchSites(grid, fields, params);
  for (const s of sites) {
    const ops = makeArchOps(s, params, noise);
    adds.push(ops.plug);
    cuts.push(ops.vault);
  }
  const windows = placeWindows(fields, params, noise, sites);
  cuts.push(...windows);
  console.debug(
    `[carves] arches ${sites.length}/${Math.round(params.archCount)}` +
      sites.map((s) => ` @(${s.px.toFixed(1)},${s.pz.toFixed(1)})`).join('') +
      ` | windows ${windows.length}/${Math.round(params.windowCount)}`,
  );
  return [...adds, ...cuts];
}

// ---- arches ---------------------------------------------------------------

/**
 * Narrow corridor throats flanked by tall rock on both sides. From every
 * flat hex, probe radially in the 2D SDF for the nearest wall and a facing
 * wall within +-30 deg of opposite; anchor each side at the highest rock
 * within reach. Greedy pick by score (high rims / short span) with a
 * minimum separation. Fully deterministic from the fields — no RNG.
 */
function findArchSites(grid: HexGrid, fields: Fields, params: GenParams): ArchSite[] {
  const want = Math.round(params.archCount);
  if (want <= 0) return [];
  const maxSpan = params.archMaxSpan;
  // a rim must leave room for clearance + minimal cap after the crown sink
  const minRim = params.floorBase + (params.archClearance + MIN_CAP) / (1 - RIM_SINK);

  const cands: ArchSite[] = [];
  const dist = new Float64Array(DIRS);

  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      if (!fields.hexFlat[grid.index(col, row)]) continue;
      const [px, pz] = grid.cellWorld(col, row);
      const s = fields.sampleS2(px, pz);
      if (s < 0.6 || s > maxSpan / 2) continue;

      // radial probe: distance to the nearest wall in each direction
      // (SDF property: no wall closer than s in any direction -> start at s)
      let best = -1;
      let bestDist = Infinity;
      for (let k = 0; k < DIRS; k++) {
        const a = (k / DIRS) * Math.PI * 2;
        const dx = Math.cos(a);
        const dz = Math.sin(a);
        let hit = maxSpan;
        for (let t = s; t <= maxSpan; t += STEP) {
          if (fields.sampleS2(px + dx * t, pz + dz * t) <= 0) {
            hit = t;
            break;
          }
        }
        dist[k] = hit;
        if (hit < bestDist) {
          bestDist = hit;
          best = k;
        }
      }
      if (bestDist >= maxSpan) continue;

      // facing wall: best hit within +-2 sectors of the opposite direction
      let oppK = -1;
      let oppDist = Infinity;
      for (let o = -2; o <= 2; o++) {
        const k = (best + DIRS / 2 + o + DIRS) % DIRS;
        if (dist[k] < oppDist) {
          oppDist = dist[k];
          oppK = k;
        }
      }
      if (oppDist >= maxSpan || bestDist + oppDist > maxSpan) continue;

      const a0 = (best / DIRS) * Math.PI * 2;
      const a1 = (oppK / DIRS) * Math.PI * 2;
      const d0x = Math.cos(a0);
      const d0z = Math.sin(a0);
      const d1x = Math.cos(a1);
      const d1z = Math.sin(a1);
      // walls ease up over wallThickness, so the face-hit point is a low
      // shoulder — march inward and anchor at the HIGHEST rock within
      // reach (chokepoint spurs are often low; grab the mesa behind them),
      // reject the side if even that can't clear the vault
      const maxEmbed = params.wallThickness + 1.5;
      const findAnchor = (dx: number, dz: number, hit: number): [number, number] | null => {
        let bestT = -1;
        let bestH = -Infinity;
        for (let t = hit; t <= hit + maxEmbed; t += STEP) {
          const h = fields.sampleGround(px + dx * t, pz + dz * t);
          if (h > bestH) {
            bestH = h;
            bestT = t;
          }
        }
        return bestH >= minRim ? [bestT, bestH] : null;
      };
      const anchor0 = findAnchor(d0x, d0z, bestDist);
      if (!anchor0) continue;
      const anchor1 = findAnchor(d1x, d1z, oppDist);
      if (!anchor1) continue;

      const rim = Math.min(anchor0[1], anchor1[1]);
      cands.push({
        px,
        pz,
        d0x,
        d0z,
        hit0: bestDist,
        anchor0: anchor0[0],
        d1x,
        d1z,
        hit1: oppDist,
        anchor1: anchor1[0],
        h0: anchor0[1],
        h1: anchor1[1],
        score: (rim - params.floorBase) / (bestDist + oppDist),
      });
    }
  }

  // greedy: best score first, keep sites apart so throats don't stack up
  cands.sort((a, b) => b.score - a.score);
  const chosen: ArchSite[] = [];
  for (const c of cands) {
    if (chosen.length >= want) break;
    if (chosen.some((o) => Math.hypot(o.px - c.px, o.pz - c.pz) < 6)) continue;
    chosen.push(c);
  }
  return chosen;
}

/**
 * Arch = plug + vault.
 *
 * Plug (add): a full-height rock mass filling the throat wall-to-wall,
 * rooted below the floor and into both abutments, with a saddle-dipped,
 * fBm-roughened crown — reads as the two canyon walls meeting overhead.
 *
 * Vault (cut): an arched slot pierced through the plug along the corridor —
 * vertical sides up to the spring line, semicircular crown, hugging the
 * wall faces so the passage keeps (nearly) its full width. Bottom is
 * clamped to floorBase so the flat passable floor is untouched.
 */
function makeArchOps(
  c: ArchSite,
  params: GenParams,
  noise: NoiseKit,
): { plug: CarveOp; vault: CarveOp } {
  const { n2 } = noise;
  // abutment anchor points (deep in the walls) and wall-face hit points
  const ax = c.px + c.d0x * (c.anchor0 + EMBED);
  const az = c.pz + c.d0z * (c.anchor0 + EMBED);
  const bx = c.px + c.d1x * (c.anchor1 + EMBED);
  const bz = c.pz + c.d1z * (c.anchor1 + EMBED);
  const f0x = c.px + c.d0x * c.hit0;
  const f0z = c.pz + c.d0z * c.hit0;
  const f1x = c.px + c.d1x * c.hit1;
  const f1z = c.pz + c.d1z * c.hit1;

  const floor = params.floorBase;
  const rim = Math.min(c.h0, c.h1);
  const crown = rim - RIM_SINK * (rim - floor); // plug top at mid-span
  const usable = crown - floor;
  // rock above the apex thins to fit low walls; clearance is guaranteed
  const cap = Math.min(params.archThickness, Math.max(MIN_CAP, usable - params.archClearance));
  const apexY = crown - cap;

  const halfDepth = params.archDepth / 2; // along-corridor rock thickness
  const noiseAmp = 0.3;

  // ---- plug ----
  const abx = bx - ax;
  const abz = bz - az;
  const len2 = abx * abx + abz * abz;
  const saddle = 0.25;

  // crown blends from one (sunk) abutment height to the other
  const topA = c.h0 - RIM_SINK * (c.h0 - floor);
  const topB = c.h1 - RIM_SINK * (c.h1 - floor);

  const plugSdf = (x: number, y: number, z: number): number => {
    const u = clamp01(((x - ax) * abx + (z - az) * abz) / len2);
    const rx = x - (ax + abx * u);
    const rz = z - (az + abz * u);
    const r = Math.hypot(rx, rz);
    const w = 2 * u - 1;
    // crown dips mid-span (eroded saddle) and undulates
    const topN = fbm2(n2, x * 0.55 + 19.7, z * 0.55 - 31.1, 2);
    const top = topA + (topB - topA) * u - saddle * (1 - w * w) + topN * 0.25;
    const faceN = fbm2(n2, x * 0.7 + 41.3, z * 0.7 - 8.9, 2);
    return Math.min(halfDepth + faceN * noiseAmp - r, top - y, y - (floor - 1));
  };

  // ---- vault ----
  // across-passage axis between the wall-face points; the slot hugs the
  // faces (small inset) so no legs land on passable floor
  const mx = (f0x + f1x) / 2;
  const mz = (f0z + f1z) / 2;
  const span = Math.hypot(f1x - f0x, f1z - f0z);
  let vHalfW = Math.max(0.7, span / 2 - 0.2);
  // semicircular crown must spring above the floor
  vHalfW = Math.min(vHalfW, Math.max(0.7, apexY - floor - 0.3));
  const springY = apexY - vHalfW;
  const wx = (f1x - f0x) / span; // across-passage unit
  const wz = (f1z - f0z) / span;
  const cx = -wz; // passage direction unit (perp of across axis)
  const cz = wx;
  // slot length: pierce the plug cleanly and stop (ends land in open air)
  const vLen = halfDepth + noiseAmp + 1.2;

  const vaultSdf = (x: number, y: number, z: number): number => {
    const w = (x - mx) * wx + (z - mz) * wz;
    const v = (x - mx) * cx + (z - mz) * cz;
    const dy = Math.max(0, y - springY);
    // silhouette perturbation varies with height (uneven arch outline)
    const e = fbm2(n2, (x + y * 0.4) * 0.7 - 3.7, (z - y * 0.4) * 0.7 + 23.9, 2);
    const prof = vHalfW + e * noiseAmp - Math.hypot(w, dy);
    // bounded along the passage + never cut below the flat floor
    return Math.min(prof, vLen - Math.abs(v), y - floor);
  };

  const rPlug = halfDepth + noiseAmp + 0.1;
  const plug: CarveOp = {
    kind: 'add',
    minX: Math.min(ax, bx) - rPlug,
    maxX: Math.max(ax, bx) + rPlug,
    minY: floor - 1.1,
    maxY: Math.max(c.h0, c.h1) + 0.5,
    minZ: Math.min(az, bz) - rPlug,
    maxZ: Math.max(az, bz) + rPlug,
    sdf: plugSdf,
  };
  const exX = Math.abs(wx) * (vHalfW + noiseAmp) + Math.abs(cx) * vLen;
  const exZ = Math.abs(wz) * (vHalfW + noiseAmp) + Math.abs(cz) * vLen;
  const vault: CarveOp = {
    kind: 'cut',
    minX: mx - exX,
    maxX: mx + exX,
    minY: floor - 0.05,
    maxY: apexY + noiseAmp + 0.1,
    minZ: mz - exZ,
    maxZ: mz + exZ,
    sdf: vaultSdf,
  };
  return { plug, vault };
}

// ---- windows --------------------------------------------------------------

const WIN_STRIDE = 0.7; // fin-scan grid step, world units

/**
 * Round-ish holes punched through thin, tall wall fins (open air on BOTH
 * sides), well above the floor — Sedona window rocks. Cut-only: no
 * passability impact. Deterministic scan of the wall raster.
 */
function placeWindows(
  fields: Fields,
  params: GenParams,
  noise: NoiseKit,
  archSites: readonly ArchSite[],
): CarveOp[] {
  const want = Math.round(params.windowCount);
  if (want <= 0) return [];
  const { n2 } = noise;
  const floor = params.floorBase;
  const R = params.windowRadius;

  interface WinCand {
    px: number;
    pz: number;
    nx: number;
    nz: number;
    halfThick: number;
    cy: number;
    r: number;
    score: number;
  }
  const cands: WinCand[] = [];

  const x0 = fields.originX + 1;
  const z0 = fields.originZ + 1;
  const x1 = fields.originX + (fields.nx - 2) * fields.voxel;
  const z1 = fields.originZ + (fields.nz - 2) * fields.voxel;
  for (let pz = z0; pz <= z1; pz += WIN_STRIDE) {
    for (let px = x0; px <= x1; px += WIN_STRIDE) {
      const s = fields.sampleS2(px, pz);
      // inside a wall, but a thin one (|s| = depth into the wall)
      if (s > -0.35 || s < -1.15) continue;
      const h = fields.sampleGround(px, pz);
      if (h < floor + 3.2) continue;
      // pierce direction: 2D SDF gradient (toward open air)
      const eps = 0.4;
      let gx = fields.sampleS2(px + eps, pz) - fields.sampleS2(px - eps, pz);
      let gz = fields.sampleS2(px, pz + eps) - fields.sampleS2(px, pz - eps);
      const gl = Math.hypot(gx, gz);
      if (gl < 1e-3) continue;
      gx /= gl;
      gz /= gl;
      // fin test: open air on BOTH sides within a short reach
      const reach = -s * 2 + 1.2;
      if (fields.sampleS2(px + gx * reach, pz + gz * reach) < 0.25) continue;
      if (fields.sampleS2(px - gx * reach, pz - gz * reach) < 0.25) continue;
      // hole must fit between floor headroom and the rim
      const yLo = floor + 1.5;
      const yHi = h - 0.9;
      const r = Math.min(R, (yHi - yLo) / 2);
      if (r < 0.45) continue;
      const cy = Math.min(yHi - r, Math.max(yLo + r, floor + 0.62 * (h - floor)));
      cands.push({ px, pz, nx: gx, nz: gz, halfThick: -s, cy, r, score: h - floor });
    }
  }

  cands.sort((a, b) => b.score - a.score);
  const chosen: WinCand[] = [];
  for (const c of cands) {
    if (chosen.length >= want) break;
    if (chosen.some((o) => Math.hypot(o.px - c.px, o.pz - c.pz) < 5)) continue;
    // keep windows away from arch sites (their plugs would swallow them)
    if (archSites.some((o) => Math.hypot(o.px - c.px, o.pz - c.pz) < 6)) continue;
    chosen.push(c);
  }

  return chosen.map((c) => {
    const half = c.halfThick + 1.4; // pierce clean through + flare
    const ex = c.px - c.nx * half;
    const ez = c.pz - c.nz * half;
    const fx = c.px + c.nx * half;
    const fz = c.pz + c.nz * half;
    const dxx = fx - ex;
    const dzz = fz - ez;
    const len2 = dxx * dxx + dzz * dzz;
    const noiseAmp = Math.min(0.35, c.r * 0.4);
    const sdf = (x: number, y: number, z: number): number => {
      const u = clamp01(((x - ex) * dxx + (z - ez) * dzz) / len2);
      const qx = x - (ex + dxx * u);
      const qy = y - c.cy;
      const qz = z - (ez + dzz * u);
      const e = fbm2(n2, (x + y * 0.5) * 0.9 + 7.1, (z - y * 0.5) * 0.9 - 15.3, 2);
      return c.r + e * noiseAmp - Math.hypot(qx, qy, qz);
    };
    const rr = c.r + noiseAmp + 0.1;
    return {
      kind: 'cut' as const,
      minX: Math.min(ex, fx) - rr,
      maxX: Math.max(ex, fx) + rr,
      minY: c.cy - rr,
      maxY: c.cy + rr,
      minZ: Math.min(ez, fz) - rr,
      maxZ: Math.max(ez, fz) + rr,
      sdf,
    };
  });
}
