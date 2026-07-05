import * as THREE from 'three';
import { HexGrid } from '../core/hex';
import { EDIT_FORCE_OPEN, EDIT_FORCE_WALL } from '../gen/layout';
import type { EditMode } from '../gen/params';
import type { IsoViewer } from '../viewer/viewer';

export interface EditorCallbacks {
  /** cheap: recompute layout + overlays only (during a stroke) */
  onQuickUpdate(): void;
  /** heavy: full regen (debounced / on stroke end) */
  onCommit(): void;
  getTerrain(): THREE.Object3D | null;
  getGroundHeight(x: number, z: number): number;
}

/**
 * Hex brush editor. Left-drag paints force-open (carve) or force-wall
 * into the persistent edit layer; view mode / other buttons pan.
 */
export class BrushEditor {
  mode: EditMode = 'view';
  brushRadius = 1.5; // world units

  editLayer: Uint8Array;
  private grid: HexGrid;
  private readonly viewer: IsoViewer;
  private readonly cb: EditorCallbacks;
  private readonly raycaster = new THREE.Raycaster();
  private readonly gizmo: THREE.Mesh;
  private painting = false;
  private panning = false;
  private lastX = 0;
  private lastY = 0;
  private strokeDirty = false;
  private undoStack: Uint8Array[] = [];

  constructor(grid: HexGrid, viewer: IsoViewer, cb: EditorCallbacks) {
    this.grid = grid;
    this.viewer = viewer;
    this.cb = cb;
    this.editLayer = new Uint8Array(grid.count);

    const ring = new THREE.RingGeometry(0.9, 1.0, 48);
    ring.rotateX(-Math.PI / 2);
    this.gizmo = new THREE.Mesh(
      ring,
      new THREE.MeshBasicMaterial({
        color: 0xffe08a,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
      }),
    );
    this.gizmo.renderOrder = 10;
    this.gizmo.visible = false;
    viewer.scene.add(this.gizmo);

    const el = viewer.renderer.domElement;
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('pointerleave', () => (this.gizmo.visible = false));
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      viewer.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** called when map dimensions change; edits are reset */
  rebind(grid: HexGrid): Uint8Array {
    if (grid.count !== this.editLayer.length) {
      this.grid = grid;
      this.editLayer = new Uint8Array(grid.count);
      this.undoStack = [];
      return this.editLayer;
    }
    this.grid = grid;
    return this.editLayer;
  }

  clearEdits(): void {
    this.pushUndo();
    this.editLayer.fill(0);
    this.cb.onCommit();
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.editLayer.set(prev);
    this.cb.onCommit();
  }

  setMode(mode: EditMode): void {
    this.mode = mode;
    this.gizmo.visible = false;
  }

  private pushUndo(): void {
    this.undoStack.push(this.editLayer.slice());
    if (this.undoStack.length > 40) this.undoStack.shift();
  }

  private groundHit(e: PointerEvent): THREE.Vector3 | null {
    const el = this.viewer.renderer.domElement;
    const rect = el.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.viewer.camera);
    const terrain = this.cb.getTerrain();
    if (terrain) {
      const hits = this.raycaster.intersectObject(terrain, false);
      if (hits.length > 0) return hits[0].point;
    }
    // fallback: flat plane at y=1
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -1);
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, p) ? p : null;
  }

  private onDown(e: PointerEvent): void {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const paintButton = e.button === 0 && this.mode !== 'view';
    if (paintButton) {
      this.painting = true;
      this.strokeDirty = false;
      this.pushUndo();
      this.paintAt(e);
    } else {
      this.panning = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    }
  }

  private onMove(e: PointerEvent): void {
    if (this.panning) {
      this.viewer.pan(e.clientX - this.lastX, e.clientY - this.lastY);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      return;
    }
    if (this.mode !== 'view') {
      const hit = this.groundHit(e);
      if (hit) {
        this.gizmo.visible = true;
        this.gizmo.position.set(hit.x, this.cb.getGroundHeight(hit.x, hit.z) + 0.15, hit.z);
        this.gizmo.scale.setScalar(this.brushRadius);
        (this.gizmo.material as THREE.MeshBasicMaterial).color.setHex(
          this.mode === 'carve' ? 0x7dff9a : 0xff9a5e,
        );
      } else {
        this.gizmo.visible = false;
      }
    }
    if (this.painting) this.paintAt(e);
  }

  private onUp(_e: PointerEvent): void {
    this.panning = false;
    if (this.painting) {
      this.painting = false;
      if (this.strokeDirty) this.cb.onCommit();
      else this.undoStack.pop(); // nothing changed, drop snapshot
    }
  }

  private paintAt(e: PointerEvent): void {
    const hit = this.groundHit(e);
    if (!hit) return;
    const value = this.mode === 'carve' ? EDIT_FORCE_OPEN : EDIT_FORCE_WALL;
    const r = this.brushRadius;
    const [cc, cr] = this.grid.worldToCell(hit.x, hit.z);
    const cellR = Math.ceil(r / this.grid.step) + 1;
    let changed = false;
    for (let dr = -cellR; dr <= cellR; dr++) {
      for (let dc = -cellR; dc <= cellR; dc++) {
        const col = cc + dc;
        const row = cr + dr;
        if (!this.grid.inBounds(col, row)) continue;
        const [hx, hz] = this.grid.cellWorld(col, row);
        if (Math.hypot(hx - hit.x, hz - hit.z) > r) continue;
        const idx = this.grid.index(col, row);
        if (this.editLayer[idx] !== value) {
          this.editLayer[idx] = value;
          changed = true;
        }
      }
    }
    if (changed) {
      this.strokeDirty = true;
      this.cb.onQuickUpdate();
    }
  }
}
