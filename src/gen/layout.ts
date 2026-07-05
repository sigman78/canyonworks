import { HexGrid } from '../core/hex';
import { mulberry32, randInt, randRange, type Rng } from '../core/rng';
import { fbm2, lerp, type NoiseKit } from '../core/noise';
import type { GenParams } from './params';

/** Manual brush overrides, persists across regenerations. */
export const EDIT_AUTO = 0;
export const EDIT_FORCE_OPEN = 1;
export const EDIT_FORCE_WALL = 2;

export interface LayoutResult {
  /** 1 = open canyon floor, 0 = bedrock wall; index = row*cols+col */
  open: Uint8Array;
  junctions: { col: number; row: number; radius: number }[];
  openFraction: number;
  /** open cells whose whole neighborhood is open (proxy for playable interior) */
  interiorFraction: number;
}

/** odd-r offset neighbors for pointy-top hexes */
export function hexNeighbors(col: number, row: number): [number, number][] {
  const odd = row & 1;
  return odd
    ? [[col + 1, row], [col - 1, row], [col + 1, row - 1], [col, row - 1], [col + 1, row + 1], [col, row + 1]]
    : [[col + 1, row], [col - 1, row], [col, row - 1], [col - 1, row - 1], [col, row + 1], [col - 1, row + 1]];
}

interface Pt {
  col: number;
  row: number;
  x: number;
  z: number;
}

/**
 * Carve the canyon network directly on the hex grid: junction arenas
 * connected by wandering corridors (MST + extra loops = intersections),
 * chokepoints as local narrowing. Guarantees connectivity by construction.
 */
export function generateLayout(
  grid: HexGrid,
  params: GenParams,
  noise: NoiseKit,
  edits: Uint8Array,
): LayoutResult {
  const rng = mulberry32(params.seed);
  const open = new Uint8Array(grid.count);

  const junctions = placeJunctions(grid, params, rng);
  const edges = buildGraph(junctions, params, rng);

  // pre-roll all randomness so re-carving at a different scale is stable
  const arenaSpecs = junctions.map((j, i) => ({
    j,
    radius: params.openingRadius * randRange(rng, 0.75, 1.25),
    seedOfs: i * 37.7,
  }));
  const corridorSpecs: CorridorSpec[] = edges.map(([a, b], e) => {
    const chokes: number[] = [];
    if (rng() < params.chokeChance) chokes.push(randRange(rng, 0.3, 0.7));
    return {
      a: junctions[a],
      b: junctions[b],
      chokes,
      wanderPhase: randRange(rng, 0, 100),
      seedOfs: e * 91.3,
      widthMul: 1,
    };
  });
  // canyon exits: corridors from border points to their nearest junction,
  // carved after the border seal so they punch through it
  const portalSpecs = placePortals(grid, params, rng, junctions);

  const carveAll = (scale: number): number => {
    open.fill(0);
    // arenas grow slower than corridors so the network keeps its shape
    const arenaScale = Math.sqrt(scale);
    for (const s of arenaSpecs) {
      carveArena(grid, open, params, noise, s.j, s.radius * arenaScale, s.seedOfs);
    }
    for (const s of corridorSpecs) {
      carveCorridor(grid, open, params, noise, s, scale);
    }
    sealBorder(grid, open, params.borderPad);
    for (const s of portalSpecs) {
      carveCorridor(grid, open, params, noise, s, scale);
    }
    return interiorFraction(grid, open);
  };

  // scale corridor widths / arena radii up until the playable-interior
  // target is met — preserves chokepoint contrast, unlike blind dilation
  let scale = 1;
  let frac = carveAll(scale);
  for (let iter = 0; iter < 5 && frac < params.targetOpenFrac * 0.95; iter++) {
    scale *= Math.min(1.4, Math.pow(params.targetOpenFrac / Math.max(frac, 0.02), 0.45));
    frac = carveAll(scale);
  }

  applyEdits(grid, open, edits, params.borderPad);

  let openCells = 0;
  for (let i = 0; i < open.length; i++) openCells += open[i];

  const arenas = arenaSpecs.map((s) => ({
    col: s.j.col,
    row: s.j.row,
    radius: s.radius * Math.sqrt(scale),
  }));
  return {
    open,
    junctions: arenas,
    openFraction: openCells / grid.count,
    interiorFraction: interiorFraction(grid, open),
  };
}

/** keep only the largest connected component of a hex mask (BFS) */
export function largestComponent(grid: HexGrid, mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length);
  const visited = new Uint8Array(mask.length);
  let bestCells: number[] = [];
  const queue: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    queue.length = 0;
    queue.push(start);
    visited[start] = 1;
    const cells: number[] = [start];
    while (queue.length > 0) {
      const i = queue.pop()!;
      const col = i % grid.cols;
      const row = (i / grid.cols) | 0;
      for (const [nc, nr] of hexNeighbors(col, row)) {
        if (!grid.inBounds(nc, nr)) continue;
        const ni = grid.index(nc, nr);
        if (mask[ni] && !visited[ni]) {
          visited[ni] = 1;
          queue.push(ni);
          cells.push(ni);
        }
      }
    }
    if (cells.length > bestCells.length) bestCells = cells;
  }
  for (const i of bestCells) out[i] = 1;
  return out;
}

/** share of cells that are open with all six neighbors open */
function interiorFraction(grid: HexGrid, open: Uint8Array): number {
  let n = 0;
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      if (!open[grid.index(col, row)]) continue;
      let interior = true;
      for (const [nc, nr] of hexNeighbors(col, row)) {
        if (!grid.inBounds(nc, nr) || !open[grid.index(nc, nr)]) {
          interior = false;
          break;
        }
      }
      if (interior) n++;
    }
  }
  return n / grid.count;
}

/** border exit points, spread over different map sides */
function placePortals(
  grid: HexGrid,
  params: GenParams,
  rng: Rng,
  junctions: Pt[],
): CorridorSpec[] {
  const specs: CorridorSpec[] = [];
  if (params.edgePortals <= 0 || junctions.length === 0) return specs;
  const sides = [0, 1, 2, 3].sort(() => rng() - 0.5);
  for (let i = 0; i < params.edgePortals; i++) {
    const side = sides[i % 4];
    const t = randRange(rng, 0.2, 0.8);
    let col: number;
    let row: number;
    if (side === 0) { col = Math.round(t * (grid.cols - 1)); row = 0; }
    else if (side === 1) { col = grid.cols - 1; row = Math.round(t * (grid.rows - 1)); }
    else if (side === 2) { col = Math.round(t * (grid.cols - 1)); row = grid.rows - 1; }
    else { col = 0; row = Math.round(t * (grid.rows - 1)); }
    const [bx, bz] = grid.cellWorld(col, row);
    // extend the endpoint past the border so the mouth stays fully open
    const cx = 0;
    const cz = 0;
    const dl = Math.hypot(bx - cx, bz - cz) || 1;
    const px: Pt = {
      col,
      row,
      x: bx + ((bx - cx) / dl) * grid.step * 2,
      z: bz + ((bz - cz) / dl) * grid.step * 2,
    };
    // nearest junction
    let best = junctions[0];
    let bestD = Infinity;
    for (const j of junctions) {
      const d = Math.hypot(j.x - px.x, j.z - px.z);
      if (d < bestD) { bestD = d; best = j; }
    }
    const chokes: number[] = [];
    if (rng() < params.chokeChance * 0.7) chokes.push(randRange(rng, 0.35, 0.65));
    specs.push({
      a: best,
      b: px,
      chokes,
      wanderPhase: randRange(rng, 0, 100),
      seedOfs: 777.7 + i * 53.9,
      widthMul: 0.85,
    });
  }
  return specs;
}

interface CorridorSpec {
  a: Pt;
  b: Pt;
  chokes: number[];
  wanderPhase: number;
  seedOfs: number;
  widthMul: number;
}

function placeJunctions(grid: HexGrid, params: GenParams, rng: Rng): Pt[] {
  const pts: Pt[] = [];
  const margin = Math.ceil(params.openingRadius * 0.6) + params.borderPad + 1;
  const minDistW = grid.step * (params.openingRadius * 1.5 + params.corridorWidth);
  let tries = 0;
  while (pts.length < params.junctions && tries < 600) {
    tries++;
    const col = randInt(rng, margin, grid.cols - 1 - margin);
    const row = randInt(rng, margin, grid.rows - 1 - margin);
    const [x, z] = grid.cellWorld(col, row);
    let ok = true;
    for (const p of pts) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < minDistW) {
        ok = false;
        break;
      }
    }
    if (ok) pts.push({ col, row, x, z });
  }
  // fallback: if map too small for requested count, we just place fewer
  if (pts.length < 2) {
    // guarantee at least a diagonal pair
    const [x1, z1] = grid.cellWorld(margin, margin);
    const [x2, z2] = grid.cellWorld(grid.cols - 1 - margin, grid.rows - 1 - margin);
    pts.length = 0;
    pts.push({ col: margin, row: margin, x: x1, z: z1 });
    pts.push({ col: grid.cols - 1 - margin, row: grid.rows - 1 - margin, x: x2, z: z2 });
  }
  return pts;
}

/** MST via Prim + extraLoops shortest non-tree edges. */
function buildGraph(pts: Pt[], params: GenParams, rng: Rng): [number, number][] {
  const n = pts.length;
  if (n < 2) return [];
  const dist = (a: number, b: number) => Math.hypot(pts[a].x - pts[b].x, pts[a].z - pts[b].z);

  const inTree = new Array<boolean>(n).fill(false);
  inTree[0] = true;
  const edges: [number, number][] = [];
  while (edges.length < n - 1) {
    let best = -1;
    let bestFrom = -1;
    let bestD = Infinity;
    for (let a = 0; a < n; a++) {
      if (!inTree[a]) continue;
      for (let b = 0; b < n; b++) {
        if (inTree[b]) continue;
        const d = dist(a, b);
        if (d < bestD) {
          bestD = d;
          best = b;
          bestFrom = a;
        }
      }
    }
    inTree[best] = true;
    edges.push([bestFrom, best]);
  }

  // candidate loop edges, shortest first
  const used = new Set(edges.map(([a, b]) => `${Math.min(a, b)},${Math.max(a, b)}`));
  const candidates: [number, number, number][] = [];
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      if (!used.has(`${a},${b}`)) candidates.push([a, b, dist(a, b)]);
    }
  }
  candidates.sort((p, q) => p[2] - q[2]);
  for (let i = 0; i < Math.min(params.extraLoops, candidates.length); i++) {
    edges.push([candidates[i][0], candidates[i][1]]);
  }
  return edges;
}

function carveArena(
  grid: HexGrid,
  open: Uint8Array,
  params: GenParams,
  noise: NoiseKit,
  center: Pt,
  radiusHexes: number,
  seedOfs: number,
): void {
  const radiusW = radiusHexes * grid.step;
  const maxR = radiusW * (1 + params.openingJitter);
  const cellR = Math.ceil(maxR / grid.step) + 1;
  for (let dr = -cellR; dr <= cellR; dr++) {
    for (let dc = -cellR; dc <= cellR; dc++) {
      const col = center.col + dc;
      const row = center.row + dr;
      if (!grid.inBounds(col, row)) continue;
      const [x, z] = grid.cellWorld(col, row);
      const dx = x - center.x;
      const dz = z - center.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-6) {
        open[grid.index(col, row)] = 1;
        continue;
      }
      const a = Math.atan2(dz, dx);
      const jitter =
        fbm2(noise.n2, Math.cos(a) * 1.4 + seedOfs, Math.sin(a) * 1.4 - seedOfs, 3) *
        params.openingJitter;
      if (d <= radiusW * (1 + jitter)) open[grid.index(col, row)] = 1;
    }
  }
}

function carveCorridor(
  grid: HexGrid,
  open: Uint8Array,
  params: GenParams,
  noise: NoiseKit,
  spec: CorridorSpec,
  scale: number,
): void {
  const { a, b, chokes, wanderPhase, seedOfs, widthMul } = spec;
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(2, Math.ceil(len / (grid.size * 0.5)));
  // perpendicular direction for wander
  const px = -(b.z - a.z) / len;
  const pz = (b.x - a.x) / len;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // wander fades to zero at endpoints so corridors meet arenas cleanly
    const envelope = Math.sin(Math.PI * t);
    const wander =
      fbm2(noise.n2, t * 3.1 + wanderPhase, seedOfs * 0.13, 3) *
      params.corridorWander *
      grid.step *
      envelope;
    const x = lerp(a.x, b.x, t) + px * wander;
    const z = lerp(a.z, b.z, t) + pz * wander;

    const baseWidth = params.corridorWidth * scale * widthMul;
    let width = baseWidth * (0.8 + 0.4 * (fbm2(noise.n2, t * 4.7 + seedOfs, wanderPhase, 2) * 0.5 + 0.5));
    for (const tc of chokes) {
      const w = Math.abs(t - tc);
      if (w < 0.1) {
        const k = 1 - w / 0.1;
        // chokepoints stay at their absolute width regardless of scale-up
        width = lerp(width, params.corridorWidth * params.chokeWidth, k * k * (3 - 2 * k));
      }
    }
    const radiusW = width * 0.5 * grid.step;

    const [cc, cr] = grid.worldToCell(x, z);
    const cellR = Math.ceil(radiusW / grid.step) + 1;
    for (let dr = -cellR; dr <= cellR; dr++) {
      for (let dc = -cellR; dc <= cellR; dc++) {
        const col = cc + dc;
        const row = cr + dr;
        if (!grid.inBounds(col, row)) continue;
        const [hx, hz] = grid.cellWorld(col, row);
        if (Math.hypot(hx - x, hz - z) <= radiusW) open[grid.index(col, row)] = 1;
      }
    }
  }
}

function sealBorder(grid: HexGrid, open: Uint8Array, pad: number): void {
  if (pad <= 0) return;
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      if (grid.edgeDistance(col, row) < pad) open[grid.index(col, row)] = 0;
    }
  }
}

function applyEdits(grid: HexGrid, open: Uint8Array, edits: Uint8Array, pad: number): void {
  for (let i = 0; i < edits.length; i++) {
    if (edits[i] === EDIT_FORCE_OPEN) {
      const col = i % grid.cols;
      const row = (i / grid.cols) | 0;
      if (grid.edgeDistance(col, row) >= Math.max(1, pad)) open[i] = 1;
    } else if (edits[i] === EDIT_FORCE_WALL) {
      open[i] = 0;
    }
  }
}
