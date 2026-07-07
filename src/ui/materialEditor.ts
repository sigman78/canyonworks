import GUI from 'lil-gui';
import * as THREE from 'three';

/**
 * Material editor: a "Materials" GUI folder with sliders for the scalar
 * parameters of the scene's main materials (terrain, decor rock, mesa
 * fog, overlays). Overrides persist in localStorage and must be
 * RE-APPLIED after every regenerate — decor and fog materials are
 * recreated with the scene content, only the terrain material survives.
 */

const STORAGE_KEY = 'canyonworks.materials.v1';

export interface ScalarParam {
  /** property name on the material (e.g. 'roughness') */
  key: string;
  /** GUI label (defaults to key) */
  label?: string;
  min: number;
  max: number;
  step: number;
  /** the value the scene creates the material with (= reset target) */
  def: number;
}

export interface MaterialSlot {
  /** storage key — stable across sessions */
  key: string;
  /** GUI folder label */
  name: string;
  params: ScalarParam[];
  /**
   * live materials for this slot, re-fetched on every apply — decor and
   * fog materials are recreated per regenerate, so holding references
   * would edit orphans
   */
  materials(): THREE.Material[];
}

export interface MaterialEditor {
  /** push the stored values onto the CURRENT scene materials */
  applyAll(): void;
}

type State = Record<string, Record<string, number>>;

function load(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as State;
  } catch {
    /* corrupted storage — start clean */
  }
  return {};
}

function save(state: State): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable */
  }
}

export function buildMaterialEditor(gui: GUI, slots: MaterialSlot[]): MaterialEditor {
  const state = load();
  // every param always has a stored value (default when untouched) so
  // apply() can write unconditionally onto freshly created materials
  for (const slot of slots) {
    state[slot.key] ??= {};
    for (const p of slot.params) state[slot.key][p.key] ??= p.def;
  }

  const apply = (slot: MaterialSlot): void => {
    const vals = state[slot.key];
    for (const mat of slot.materials()) {
      const m = mat as unknown as Record<string, unknown>;
      for (const p of slot.params) {
        if (typeof m[p.key] === 'number') m[p.key] = vals[p.key];
      }
    }
  };

  const root = gui.addFolder('Materials');
  root.close();
  for (const slot of slots) {
    const f = root.addFolder(slot.name);
    f.close();
    // lil-gui edits this proxy; state + live materials follow
    const proxy = { ...state[slot.key] };
    for (const p of slot.params) {
      f.add(proxy, p.key, p.min, p.max, p.step)
        .name(p.label ?? p.key)
        .listen()
        .onChange((v: number) => {
          state[slot.key][p.key] = v;
          apply(slot);
          save(state);
        });
    }
    f.add(
      {
        reset: () => {
          for (const p of slot.params) {
            proxy[p.key] = p.def;
            state[slot.key][p.key] = p.def;
          }
          apply(slot);
          save(state);
        },
      },
      'reset',
    ).name('↺ defaults');
  }

  return {
    applyAll: () => {
      for (const slot of slots) apply(slot);
    },
  };
}
