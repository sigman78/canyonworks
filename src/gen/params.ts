/** Everything that feeds the generator. Serializable. */
export interface GenParams {
  seed: number;

  // map footprint
  cols: number;
  rows: number;
  hexSize: number;

  // canyon network layout (units: hexes unless noted)
  junctions: number;
  extraLoops: number;
  corridorWidth: number; // corridor width in hexes-across
  corridorWander: number; // lateral wander amplitude, hexes
  chokeChance: number; // probability a corridor gets a chokepoint
  chokeWidth: number; // width multiplier at a chokepoint
  openingRadius: number; // junction arena radius, hexes
  openingJitter: number; // arena boundary noise 0..1
  borderPad: number; // sealed cells at map edge
  targetOpenFrac: number; // widen network until this fraction is interior floor
  edgePortals: number; // canyon exits running off the map edge

  // vertical profile (world units)
  floorBase: number;
  floorAmp: number;
  floorFreq: number;
  wallHeight: number;
  wallVar: number;
  wallFreq: number;
  wallThickness: number; // horizontal distance over which wall reaches full height
  ridgeAmp: number; // wall boundary perturbation (buttresses)
  ridgeFreq: number;
  terraceStep: number; // strata terrace height
  terraceAmt: number; // 0..1 blend of terracing on walls
  talusAmp: number; // debris slope height at wall base
  talusFall: number; // talus falloff distance
  wallNoiseAmp: number; // 3D roughness carved into cliff faces
  wallNoiseFreq: number;

  // craters (baked into floor heightfield, passable)
  craterCount: number;
  craterMinR: number;
  craterMaxR: number;
  craterDepth: number;

  // fissures (hex-aligned cracks; block crawlers, not flyers)
  crackCount: number;
  crackLenMin: number; // crack span in adjoining hexes
  crackLenMax: number;
  crackWidth: number; // half-width of the slot, world units
  crackDepth: number;

  // decor (instanced, non-SDF)
  boulderCount: number;
  boulderMinScale: number;
  boulderMaxScale: number;
  pillarCount: number;
  screeClusters: number;
  screeSize: number;

  // meshing
  voxelSize: number;
}

export interface RenderOptions {
  showGrid: boolean;
  showPassability: boolean;
  flatShading: boolean;
  showDecor: boolean;
  /** tri-planar detail texture strength (0 = vertex colors only) */
  texAmount: number;
  /** detail texture world-space frequency */
  texScale: number;
  /** normal perturbation strength derived from detail luminance */
  texBump: number;
  /** per-layer roughness variation (dune sheen, slickrock polish) */
  texRough: number;
  /** detail contrast around mid-gray (1 = as authored) */
  texContrast: number;
  /** texture hue bleed into the vertex palette (0 = pure luminance) */
  texHue: number;
  /** very-low-frequency macro tonal patchiness */
  texMacro: number;
}

export type EditMode = 'view' | 'carve' | 'wall';

export function defaultParams(): GenParams {
  return {
    seed: 1337,

    cols: 30,
    rows: 26,
    hexSize: 1,

    junctions: 7,
    extraLoops: 2,
    corridorWidth: 2.6,
    corridorWander: 1.6,
    chokeChance: 0.55,
    chokeWidth: 0.5,
    openingRadius: 2.4,
    openingJitter: 0.45,
    borderPad: 1,
    targetOpenFrac: 0.3,
    edgePortals: 3,

    floorBase: 1.2,
    floorAmp: 0.06,
    floorFreq: 0.08,
    wallHeight: 5.2,
    wallVar: 1.6,
    wallFreq: 0.05,
    wallThickness: 2.6,
    ridgeAmp: 0.9,
    ridgeFreq: 0.22,
    terraceStep: 1.15,
    terraceAmt: 0.75,
    talusAmp: 0.35,
    talusFall: 1.4,
    wallNoiseAmp: 0.35,
    wallNoiseFreq: 0.55,

    craterCount: 6,
    craterMinR: 1.2,
    craterMaxR: 2.6,
    craterDepth: 0.5,

    crackCount: 4,
    crackLenMin: 1,
    crackLenMax: 2,
    crackWidth: 0.35,
    crackDepth: 0.8,

    boulderCount: 26,
    boulderMinScale: 0.25,
    boulderMaxScale: 0.85,
    pillarCount: 3,
    screeClusters: 14,
    screeSize: 0.16,

    voxelSize: 0.3,
  };
}

export function defaultRenderOptions(): RenderOptions {
  return {
    showGrid: true,
    showPassability: false,
    flatShading: true,
    showDecor: true,
    texAmount: 0.75,
    texScale: 0.22,
    texBump: 0.5,
    texRough: 0.5,
    texContrast: 1,
    texHue: 0.3,
    texMacro: 0.3,
  };
}
