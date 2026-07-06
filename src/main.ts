import * as THREE from 'three';
import { HexGrid } from './core/hex';
import { makeNoise, type NoiseKit } from './core/noise';
import { buildDecor } from './gen/decor';
import { buildFields, computeObstructed, type Fields } from './gen/fields';
import { generateLayout, largestComponent, type LayoutResult } from './gen/layout';
import { buildTerrainGeometry } from './gen/mesher';
import { defaultParams, defaultRenderOptions, type EditMode, type GenParams, type RenderOptions } from './gen/params';
import { BrushEditor } from './edit/editor';
import { buildPanel } from './ui/panel';
import { buildGridLines, buildPassabilityOverlay, disposeObject } from './viewer/overlays';
import { buildMesaFog } from './viewer/mesaFog';
import {
  applyTriplanarDetail,
  loadDetailTextures,
  type DetailTextures,
  type DetailUniforms,
} from './viewer/terrainMaterial';
import { IsoViewer } from './viewer/viewer';

const STORAGE_KEY = 'canyonworks.params.v1';

class App {
  private params: GenParams;
  private readonly render: RenderOptions = defaultRenderOptions();
  private readonly viewer: IsoViewer;
  private readonly hud: HTMLElement;
  private grid: HexGrid;
  private editor: BrushEditor;
  private noise!: NoiseKit;

  private mapRoot = new THREE.Group();
  private terrainMesh: THREE.Mesh | null = null;
  private terrainMaterial: THREE.MeshStandardMaterial;
  private decorGroup: THREE.Group | null = null;
  private fogGroup: THREE.Group | null = null;
  private gridLines: THREE.Object3D | null = null;
  private passOverlay: THREE.Object3D | null = null;

  private readonly detailTex: DetailTextures = loadDetailTextures();
  private readonly detailU: DetailUniforms = {
    scale: { value: 0.22 },
    amount: { value: 0.75 },
    plateauY: { value: 3.2 },
    bump: { value: 0.5 },
    rough: { value: 0.5 },
    contrast: { value: 1 },
    hue: { value: 0.3 },
    macro: { value: 0.3 },
    ao: { value: 0.65 },
    maskDebug: { value: 0 },
    cloud: { value: 0.3 },
    cloudOffset: { value: new THREE.Vector2() },
  };

  private layout!: LayoutResult;
  private fields!: Fields;
  private blocked = new Uint8Array(0);
  private obstructed = new Uint8Array(0);
  private commitTimer: number | null = null;
  private stats = { genMs: 0, verts: 0, tris: 0, open: 0, playable: 0 };

  constructor() {
    this.params = loadParams();
    this.hud = document.getElementById('hud')!;
    this.viewer = new IsoViewer(document.getElementById('app')!);
    this.viewer.scene.add(this.mapRoot);
    this.grid = new HexGrid(this.params.cols, this.params.rows, this.params.hexSize);
    this.terrainMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      flatShading: this.render.flatShading,
    });
    this.syncDetailUniforms();
    applyTriplanarDetail(this.terrainMaterial, this.detailTex.cliff, this.detailTex.sand, this.detailU, {
      layers: {
        dunes: this.detailTex.dunes,
        gravel: this.detailTex.gravel,
        mesa: this.detailTex.mesa,
        drift: this.detailTex.drift,
        rubble: this.detailTex.rubble,
        crater: this.detailTex.crater,
      },
      vertexAo: true, // terrain mesh carries the baked ao attribute
    });

    this.editor = new BrushEditor(this.grid, this.viewer, {
      onQuickUpdate: () => this.quickUpdate(),
      onCommit: () => this.regenerate(false),
      getTerrain: () => this.terrainMesh,
      getGroundHeight: (x, z) => (this.fields ? this.fields.sampleGround(x, z) : 1),
    });

    buildPanel(this.params, this.render, this.editor, {
      regenerate: () => this.regenerate(true),
      randomSeed: () => {
        this.params.seed = Math.floor(Math.random() * 100000);
        this.regenerate(true);
      },
      clearEdits: () => this.editor.clearEdits(),
      exportParams: () => downloadJson('canyon-params.json', this.params),
      importParams: () => this.importParams(),
      exportMap: () => this.exportMap(),
      onRenderOptionChanged: () => this.applyRenderOptions(),
      onEditModeChanged: (m) => this.editor.setMode(m),
      onBrushRadiusChanged: (r) => (this.editor.brushRadius = r),
    });

    this.bindKeys();
    this.regenerate(true);

    const loop = () => {
      requestAnimationFrame(loop);
      // slow cloud-shadow drift across the map
      const t = performance.now() * 0.001;
      this.detailU.cloudOffset.value.set(t * 0.55, t * 0.21);
      this.viewer.render();
    };
    loop();
  }

  /** Full pipeline: layout -> fields -> mesh -> decor -> overlays. */
  regenerate(fitView: boolean): void {
    const t0 = performance.now();
    saveParams(this.params);

    // map size may have changed
    if (this.grid.cols !== this.params.cols || this.grid.rows !== this.params.rows) {
      this.grid = new HexGrid(this.params.cols, this.params.rows, this.params.hexSize);
    }
    const edits = this.editor.rebind(this.grid);

    // plateau tops blend to the mesa detail layer above this height (low
    // enough to catch mesas sunk by the per-region altitude offsets)
    this.detailU.plateauY.value = this.params.wallHeight * 0.45;

    this.noise = makeNoise(this.params.seed);
    this.layout = generateLayout(this.grid, this.params, this.noise, edits);
    this.fields = buildFields(this.grid, this.layout.open, this.params, this.noise);

    const terrain = buildTerrainGeometry(this.fields, this.params, this.noise);

    // swap scene content
    if (this.terrainMesh) {
      this.mapRoot.remove(this.terrainMesh);
      this.terrainMesh.geometry.dispose();
    }
    this.terrainMesh = new THREE.Mesh(terrain.geometry, this.terrainMaterial);
    this.terrainMesh.castShadow = true;
    this.terrainMesh.receiveShadow = true;
    this.mapRoot.add(this.terrainMesh);

    if (this.decorGroup) {
      this.mapRoot.remove(this.decorGroup);
      disposeObject(this.decorGroup);
    }
    const decor = buildDecor(this.grid, this.fields, this.params, this.noise, {
      rock: this.detailTex.rock,
      uniforms: this.detailU,
    });
    this.decorGroup = decor.group;
    this.blocked = decor.blocked;
    this.obstructed = computeObstructed(this.grid, this.layout.open, this.fields, this.params);
    this.mapRoot.add(this.decorGroup);

    if (this.fogGroup) {
      this.mapRoot.remove(this.fogGroup);
      disposeObject(this.fogGroup);
    }
    this.fogGroup = buildMesaFog(this.fields, this.noise);
    this.mapRoot.add(this.fogGroup);

    this.rebuildOverlays();
    this.applyRenderOptions();

    const halfW = (this.grid.maxX - this.grid.minX) / 2;
    const halfD = (this.grid.maxZ - this.grid.minZ) / 2;
    this.viewer.fitSunTo(halfW, halfD);
    if (fitView) this.viewer.fitView(halfW, halfD);

    const passable = this.computePassable();
    let playable = 0;
    for (let i = 0; i < passable.length; i++) playable += passable[i];
    this.stats = {
      genMs: Math.round(performance.now() - t0),
      verts: terrain.vertexCount,
      tris: terrain.triangleCount,
      open: Math.round(this.layout.openFraction * 100),
      playable: Math.round((playable / this.grid.count) * 100),
    };
    this.updateHud();
  }

  /** playable = open, unblocked, flat, and connected to the main area */
  private computePassable(): Uint8Array {
    const raw = new Uint8Array(this.grid.count);
    for (let i = 0; i < this.grid.count; i++) {
      raw[i] =
        this.layout.open[i] && !(this.blocked[i] ?? 0) && !(this.obstructed[i] ?? 0) ? 1 : 0;
    }
    return largestComponent(this.grid, raw);
  }

  /** During a brush stroke: relayout + overlay refresh only (fast feedback). */
  private quickUpdate(): void {
    this.layout = generateLayout(this.grid, this.params, this.noise, this.editor.editLayer);
    this.rebuildOverlays();
    this.applyRenderOptions();
    // debounce the expensive mesh rebuild while dragging
    if (this.commitTimer !== null) window.clearTimeout(this.commitTimer);
    this.commitTimer = window.setTimeout(() => {
      this.commitTimer = null;
      this.regenerate(false);
    }, 500);
  }

  private rebuildOverlays(): void {
    if (this.gridLines) {
      this.mapRoot.remove(this.gridLines);
      disposeObject(this.gridLines);
    }
    if (this.passOverlay) {
      this.mapRoot.remove(this.passOverlay);
      disposeObject(this.passOverlay);
    }
    const passable = this.computePassable();
    this.gridLines = buildGridLines(this.grid, passable, this.fields);
    this.passOverlay = buildPassabilityOverlay(
      this.grid,
      this.layout.open,
      this.blocked,
      passable,
      this.fields,
    );
    this.mapRoot.add(this.gridLines, this.passOverlay);
  }

  private applyRenderOptions(): void {
    if (this.gridLines) this.gridLines.visible = this.render.showGrid;
    if (this.passOverlay) this.passOverlay.visible = this.render.showPassability;
    if (this.decorGroup) this.decorGroup.visible = this.render.showDecor;
    if (this.fogGroup) this.fogGroup.visible = this.render.showMesaFog;
    if (this.terrainMaterial.flatShading !== this.render.flatShading) {
      this.terrainMaterial.flatShading = this.render.flatShading;
      this.terrainMaterial.needsUpdate = true;
    }
    this.terrainMaterial.wireframe = this.render.wireframe;
    this.decorGroup?.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m?.isMeshStandardMaterial) m.wireframe = this.render.wireframe;
    });
    this.syncDetailUniforms();
    this.updateHud();
  }

  private syncDetailUniforms(): void {
    this.detailU.amount.value = this.render.texAmount;
    this.detailU.scale.value = this.render.texScale;
    this.detailU.bump.value = this.render.texBump;
    this.detailU.rough.value = this.render.texRough;
    this.detailU.contrast.value = this.render.texContrast;
    this.detailU.hue.value = this.render.texHue;
    this.detailU.macro.value = this.render.texMacro;
    this.detailU.ao.value = this.render.aoAmount;
    this.detailU.maskDebug.value = this.render.showTexMasks ? 1 : 0;
    // cloud shadows belong to the storm look — active only with mesa fog on
    this.detailU.cloud.value = this.render.showMesaFog ? this.render.cloudShadow : 0;
    this.viewer.setSun(this.render.sunAzimuth, this.render.sunElevation);
    this.viewer.sun.shadow.intensity = this.render.shadowStrength;
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      switch (e.key) {
        case '1': this.editor.setMode('view'); break;
        case '2': this.editor.setMode('carve'); break;
        case '3': this.editor.setMode('wall'); break;
        case '[': this.editor.brushRadius = Math.max(0.5, this.editor.brushRadius - 0.5); break;
        case ']': this.editor.brushRadius = Math.min(6, this.editor.brushRadius + 0.5); break;
        case 'r': case 'R': this.regenerate(false); break;
        case 'g': case 'G':
          this.render.showGrid = !this.render.showGrid;
          this.applyRenderOptions();
          break;
        case 'p': case 'P':
          this.render.showPassability = !this.render.showPassability;
          this.applyRenderOptions();
          break;
        case 'z': case 'Z':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            this.editor.undo();
          }
          break;
      }
      this.updateHud();
    });
  }

  private updateHud(): void {
    const modeNames: Record<EditMode, string> = {
      view: 'View / pan',
      carve: 'Carve brush',
      wall: 'Wall brush',
    };
    this.hud.innerHTML =
      `<b>${modeNames[this.editor.mode]}</b>  ·  open ${this.stats.open}% / playable ${this.stats.playable}%  ·  ` +
      `${this.stats.verts.toLocaleString()} verts / ${this.stats.tris.toLocaleString()} tris  ·  gen ${this.stats.genMs} ms\n` +
      `keys: 1 view · 2 carve · 3 wall · [ ] brush · R regen · G grid · P passability · Ctrl+Z undo\n` +
      `mouse: drag pan (left in view mode, middle/right always) · wheel zoom · left paint in brush modes`;
  }

  private importParams(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const incoming = JSON.parse(text) as Partial<GenParams>;
        Object.assign(this.params, incoming);
        this.regenerate(true);
      } catch (err) {
        console.error('Failed to import params', err);
      }
    };
    input.click();
  }

  /** Export hex passability + decor blockers for game-side consumption. */
  private exportMap(): void {
    const cells: {
      col: number;
      row: number;
      open: boolean;
      blocked: boolean;
      obstructed: boolean;
      passable: boolean;
    }[] = [];
    const passable = this.computePassable();
    for (let row = 0; row < this.grid.rows; row++) {
      for (let col = 0; col < this.grid.cols; col++) {
        const i = this.grid.index(col, row);
        cells.push({
          col,
          row,
          open: this.layout.open[i] === 1,
          blocked: this.blocked[i] === 1,
          obstructed: this.obstructed[i] === 1,
          passable: passable[i] === 1,
        });
      }
    }
    downloadJson('canyon-map.json', {
      version: 2,
      seed: this.params.seed,
      cols: this.grid.cols,
      rows: this.grid.rows,
      hexSize: this.grid.size,
      layout: 'odd-r pointy-top',
      cells,
      params: this.params,
    });
  }
}

function loadParams(): GenParams {
  const base = defaultParams();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(base, JSON.parse(raw));
  } catch {
    /* corrupted storage — use defaults */
  }
  return base;
}

function saveParams(p: GenParams): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

new App();
