import GUI from 'lil-gui';
import type { EditMode, GenParams, RenderOptions } from '../gen/params';

export interface PanelCallbacks {
  regenerate(): void;
  randomSeed(): void;
  clearEdits(): void;
  exportParams(): void;
  importParams(): void;
  exportMap(): void;
  onRenderOptionChanged(): void;
  onEditModeChanged(mode: EditMode): void;
  onBrushRadiusChanged(r: number): void;
}

export interface EditState {
  mode: EditMode;
  brushRadius: number;
}

export function buildPanel(
  params: GenParams,
  render: RenderOptions,
  edit: EditState,
  cb: PanelCallbacks,
): GUI {
  const gui = new GUI({ title: 'CanyonWorks' });
  const regen = () => cb.regenerate();

  const fMap = gui.addFolder('Map');
  fMap.add(params, 'seed', 0, 99999, 1).onFinishChange(regen);
  fMap.add(params, 'cols', 12, 48, 1).onFinishChange(regen);
  fMap.add(params, 'rows', 12, 48, 1).onFinishChange(regen);
  fMap.add(params, 'voxelSize', 0.2, 0.6, 0.05).name('voxel size').onFinishChange(regen);

  const fLayout = gui.addFolder('Canyon network');
  fLayout.add(params, 'junctions', 2, 9, 1).onFinishChange(regen);
  fLayout.add(params, 'extraLoops', 0, 4, 1).name('extra loops').onFinishChange(regen);
  fLayout.add(params, 'corridorWidth', 1.5, 6, 0.1).name('corridor width').onFinishChange(regen);
  fLayout.add(params, 'corridorWander', 0, 4, 0.1).name('wander').onFinishChange(regen);
  fLayout.add(params, 'chokeChance', 0, 1, 0.05).name('choke chance').onFinishChange(regen);
  fLayout.add(params, 'chokeWidth', 0.2, 1, 0.05).name('choke width ×').onFinishChange(regen);
  fLayout.add(params, 'openingRadius', 2, 6, 0.1).name('opening radius').onFinishChange(regen);
  fLayout.add(params, 'openingJitter', 0, 1, 0.05).name('opening jitter').onFinishChange(regen);
  fLayout.add(params, 'targetOpenFrac', 0.1, 0.6, 0.01).name('playable target').onFinishChange(regen);
  fLayout.add(params, 'edgePortals', 0, 4, 1).name('edge exits').onFinishChange(regen);

  const fProfile = gui.addFolder('Walls & floor');
  fProfile.add(params, 'wallHeight', 2, 10, 0.1).name('wall height').onFinishChange(regen);
  fProfile.add(params, 'wallVar', 0, 4, 0.1).name('wall variance').onFinishChange(regen);
  fProfile.add(params, 'wallThickness', 1, 6, 0.1).name('wall slope dist').onFinishChange(regen);
  fProfile.add(params, 'ridgeAmp', 0, 2.5, 0.05).name('ridge amp').onFinishChange(regen);
  fProfile.add(params, 'ridgeFreq', 0.05, 0.6, 0.01).name('ridge freq').onFinishChange(regen);
  fProfile.add(params, 'terraceStep', 0.4, 2.5, 0.05).name('terrace step').onFinishChange(regen);
  fProfile.add(params, 'terraceAmt', 0, 1, 0.05).name('terrace amt').onFinishChange(regen);
  fProfile.add(params, 'talusAmp', 0, 1.5, 0.05).name('talus amp').onFinishChange(regen);
  fProfile.add(params, 'wallNoiseAmp', 0, 1.2, 0.05).name('cliff roughness').onFinishChange(regen);
  fProfile.add(params, 'wallNoiseFreq', 0.1, 1.5, 0.05).name('roughness freq').onFinishChange(regen);
  fProfile.add(params, 'floorAmp', 0, 1.2, 0.05).name('floor relief').onFinishChange(regen);
  fProfile.close();

  const fDecor = gui.addFolder('Decor');
  fDecor.add(params, 'craterCount', 0, 20, 1).name('craters').onFinishChange(regen);
  fDecor.add(params, 'craterDepth', 0.1, 1, 0.05).name('crater depth').onFinishChange(regen);
  fDecor.add(params, 'crackCount', 0, 12, 1).name('fissures').onFinishChange(regen);
  fDecor.add(params, 'crackLenMax', 1, 6, 1).name('fissure length').onFinishChange(regen);
  fDecor.add(params, 'crackWidth', 0.2, 0.9, 0.05).name('fissure width').onFinishChange(regen);
  fDecor.add(params, 'crackDepth', 0.3, 1.5, 0.05).name('fissure depth').onFinishChange(regen);
  fDecor.add(params, 'boulderCount', 0, 80, 1).name('boulders').onFinishChange(regen);
  fDecor.add(params, 'pillarCount', 0, 8, 1).name('pillars').onFinishChange(regen);
  fDecor.add(params, 'screeClusters', 0, 40, 1).name('scree clusters').onFinishChange(regen);
  fDecor.close();

  const fEdit = gui.addFolder('Edit');
  fEdit
    .add(edit, 'mode', { 'View / pan': 'view', 'Carve (open)': 'carve', 'Wall (fill)': 'wall' })
    .name('mode')
    .listen()
    .onChange((m: EditMode) => cb.onEditModeChanged(m));
  fEdit
    .add(edit, 'brushRadius', 0.5, 6, 0.25)
    .name('brush radius')
    .listen()
    .onChange((r: number) => cb.onBrushRadiusChanged(r));
  fEdit.add({ clear: () => cb.clearEdits() }, 'clear').name('clear manual edits');

  const fView = gui.addFolder('View');
  fView.add(render, 'showGrid').name('hex grid').listen().onChange(() => cb.onRenderOptionChanged());
  fView
    .add(render, 'showPassability')
    .name('passability')
    .listen()
    .onChange(() => cb.onRenderOptionChanged());
  fView.add(render, 'showDecor').name('decor').onChange(() => cb.onRenderOptionChanged());
  fView
    .add(render, 'flatShading')
    .name('flat shading')
    .onChange(() => cb.onRenderOptionChanged());

  const actions = {
    regenerate: () => cb.regenerate(),
    randomSeed: () => cb.randomSeed(),
    exportParams: () => cb.exportParams(),
    importParams: () => cb.importParams(),
    exportMap: () => cb.exportMap(),
  };
  gui.add(actions, 'regenerate').name('⟳ Regenerate');
  gui.add(actions, 'randomSeed').name('🎲 Random seed');
  gui.add(actions, 'exportParams').name('⇩ Export params');
  gui.add(actions, 'importParams').name('⇧ Import params');
  gui.add(actions, 'exportMap').name('⇩ Export map JSON');

  return gui;
}
