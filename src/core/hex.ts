/**
 * Pointy-top hex grid, odd-r offset storage, axial math.
 * World plane is XZ (three.js ground), +x right, +z toward camera-south.
 */
export const SQRT3 = Math.sqrt(3);

export function offsetToAxial(col: number, row: number): [number, number] {
  return [col - ((row - (row & 1)) >> 1), row];
}

export function axialToOffset(q: number, r: number): [number, number] {
  return [q + ((r - (r & 1)) >> 1), r];
}

export function axialRound(qf: number, rf: number): [number, number] {
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return [q, r];
}

export function hexDist(q1: number, r1: number, q2: number, r2: number): number {
  const dq = q1 - q2;
  const dr = r1 - r2;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/**
 * Rectangular hex map. Cells indexed by (col,row) offset coords; index = row*cols+col.
 * Centers the whole map around world origin.
 */
export class HexGrid {
  readonly cols: number;
  readonly rows: number;
  readonly size: number;
  /** center-to-center horizontal spacing */
  readonly step: number;
  private readonly cx: number;
  private readonly cz: number;
  /** world-space bounds of hex centers plus one hex of padding */
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;

  constructor(cols: number, rows: number, size: number) {
    this.cols = cols;
    this.rows = rows;
    this.size = size;
    this.step = SQRT3 * size;
    // raw (uncentered) extents of cell centers
    const rawMaxX = SQRT3 * size * (cols - 1 + 0.5);
    const rawMaxZ = 1.5 * size * (rows - 1);
    this.cx = rawMaxX / 2;
    this.cz = rawMaxZ / 2;
    this.minX = -this.cx - size * SQRT3;
    this.maxX = this.cx + size * SQRT3;
    this.minZ = -this.cz - size * 2;
    this.maxZ = this.cz + size * 2;
  }

  get count(): number {
    return this.cols * this.rows;
  }

  index(col: number, row: number): number {
    return row * this.cols + col;
  }

  inBounds(col: number, row: number): boolean {
    return col >= 0 && row >= 0 && col < this.cols && row < this.rows;
  }

  /** world position of cell center */
  cellWorld(col: number, row: number): [number, number] {
    const [q, r] = offsetToAxial(col, row);
    const x = this.size * SQRT3 * (q + r / 2) - this.cx;
    const z = this.size * 1.5 * r - this.cz;
    return [x, z];
  }

  /** nearest cell (may be out of bounds — check inBounds) */
  worldToCell(x: number, z: number): [number, number] {
    const wx = x + this.cx;
    const wz = z + this.cz;
    const qf = ((SQRT3 / 3) * wx - (1 / 3) * wz) / this.size;
    const rf = ((2 / 3) * wz) / this.size;
    const [q, r] = axialRound(qf, rf);
    return axialToOffset(q, r);
  }

  /** corner i (0..5) of a hex centered at world (x,z), pointy-top */
  static corner(x: number, z: number, size: number, i: number): [number, number] {
    const a = (Math.PI / 180) * (60 * i - 30);
    return [x + size * Math.cos(a), z + size * Math.sin(a)];
  }

  /** distance from map edge in cells (offset-rect metric, cheap) */
  edgeDistance(col: number, row: number): number {
    return Math.min(col, row, this.cols - 1 - col, this.rows - 1 - row);
  }
}
