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

  // 3D carve ops (research/voxel3d)
  archCount: number; // arches: rock plug + vault cut over corridor throats
  archDepth: number; // along-corridor rock thickness of the arch, world units
  archThickness: number; // rock above the vault apex (cap), world units
  archClearance: number; // min vault apex height over the floor, world units
  archMaxSpan: number; // max wall-to-wall span, world units
  windowCount: number; // holes punched through thin high fins
  windowRadius: number; // window hole radius, world units

  // basal wash: erosion notch at wall bases -> overhangs & grottoes,
  // gated by a map-wide large-scale noise mask (patchy, not everywhere)
  washAmp: number; // max notch depth into the wall, world units
  washHeight: number; // notch band height above the floor, world units
  washCoverage: number; // 0..1 fraction of the mask that washes
  washScale: number; // mask frequency — lower = larger washed regions

  // meshing
  voxelSize: number;
}

export interface RenderOptions {
  showGrid: boolean;
  showPassability: boolean;
  flatShading: boolean;
  showDecor: boolean;
  /** render terrain + decor as wireframe (mesh showcase) */
  wireframe: boolean;
  /** color-coded overlay of the texture-layer mask regions */
  showTexMasks: boolean;
  /** decorative fog blankets over the impassable mesa islands */
  showMesaFog: boolean;
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
  /** baked ambient-occlusion strength (0 = off) */
  aoAmount: number;
  /** sun horizontal angle, degrees */
  sunAzimuth: number;
  /** sun height above horizon, degrees — lower = longer shadows */
  sunElevation: number;
  /** shadow darkness (0 = shadows off) */
  shadowStrength: number;
  /** drifting cloud-shadow strength on direct sunlight (0 = off) */
  cloudShadow: number;
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

    archCount: 2,
    archDepth: 2.4,
    archThickness: 0.8,
    archClearance: 1.9,
    archMaxSpan: 8,
    windowCount: 2,
    windowRadius: 0.9,

    washAmp: 0.7,
    washHeight: 1.2,
    washCoverage: 0.45,
    washScale: 0.05,

    voxelSize: 0.3,
  };
}

export function defaultRenderOptions(): RenderOptions {
  return {
    showGrid: true,
    showPassability: false,
    flatShading: true,
    showDecor: true,
    wireframe: false,
    showTexMasks: false,
    showMesaFog: false,
    texAmount: 0.75,
    texScale: 0.22,
    texBump: 0.5,
    texRough: 0.5,
    texContrast: 1,
    texHue: 0.3,
    texMacro: 0.3,
    aoAmount: 0.65,
    sunAzimuth: -57,
    sunElevation: 45,
    shadowStrength: 1,
    cloudShadow: 0.3,
  };
}
