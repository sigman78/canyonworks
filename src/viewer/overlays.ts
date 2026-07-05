import * as THREE from 'three';
import { HexGrid } from '../core/hex';
import type { Fields } from '../gen/fields';

/** Hex outline grid draped over playable cells only — the game board. */
export function buildGridLines(
  grid: HexGrid,
  passable: Uint8Array,
  fields: Fields,
): THREE.LineSegments {
  const positions: number[] = [];
  const lift = 0.06;
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      if (!passable[grid.index(col, row)]) continue;
      const [cx, cz] = grid.cellWorld(col, row);
      for (let i = 0; i < 6; i++) {
        const [x1, z1] = HexGrid.corner(cx, cz, grid.size * 0.985, i);
        const [x2, z2] = HexGrid.corner(cx, cz, grid.size * 0.985, (i + 1) % 6);
        positions.push(
          x1, fields.sampleGround(x1, z1) + lift, z1,
          x2, fields.sampleGround(x2, z2) + lift, z2,
        );
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0x3a1c0c,
    transparent: true,
    opacity: 0.38,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.name = 'gridLines';
  return lines;
}

/**
 * Translucent per-hex passability tint: green = playable, orange =
 * decor-blocked, red = terrain-obstructed or unreachable pocket.
 */
export function buildPassabilityOverlay(
  grid: HexGrid,
  open: Uint8Array,
  blocked: Uint8Array,
  passable: Uint8Array,
  fields: Fields,
): THREE.InstancedMesh {
  const shape = new THREE.Shape();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    const x = Math.cos(a) * 0.92;
    const y = Math.sin(a) * 0.92;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  geo.scale(grid.size, 1, grid.size);

  let openCount = 0;
  for (let i = 0; i < open.length; i++) if (open[i]) openCount++;

  const mat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, openCount);
  mesh.name = 'passability';

  const m = new THREE.Matrix4();
  const cOpen = new THREE.Color(0x3fae5a);
  const cBlocked = new THREE.Color(0xe08a2e);
  const cObstructed = new THREE.Color(0xc23a2e);
  let k = 0;
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const idx = grid.index(col, row);
      if (!open[idx]) continue;
      const [x, z] = grid.cellWorld(col, row);
      m.makeTranslation(x, fields.sampleGround(x, z) + 0.1, z);
      mesh.setMatrixAt(k, m);
      mesh.setColorAt(k, passable[idx] ? cOpen : blocked[idx] ? cBlocked : cObstructed);
      k++;
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
    else if (mat) mat.dispose();
  });
}
