import GUI from 'lil-gui';
import * as THREE from 'three';

/**
 * Palette panel: color pickers for the generator's baked vertex-color
 * palettes (mesher TERRAIN_PALETTE, decor DECOR_PALETTE). The entries
 * reference the LIVE Color objects the generators read — a change
 * mutates the Color and triggers a regenerate to re-bake the mesh.
 * Overrides persist in localStorage; stored values are applied to the
 * Colors at construction, BEFORE the app's first regenerate.
 */

const STORAGE_KEY = 'canyonworks.palette.v1';

export interface PaletteEntry {
  /** storage key — stable across sessions */
  key: string;
  label: string;
  /** the live Color the generator reads (mutated in place) */
  color: THREE.Color;
}

export interface PaletteGroup {
  key: string;
  name: string;
  entries: PaletteEntry[];
}

type State = Record<string, Record<string, string>>; // hex strings, '#rrggbb'

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

export function buildPalettePanel(gui: GUI, groups: PaletteGroup[], onChange: () => void): void {
  const state = load();
  // hex strings round-trip through THREE's color management correctly
  // (getHexString returns sRGB, set('#…') converts back to linear)
  const defaults: State = {};
  for (const g of groups) {
    defaults[g.key] = {};
    state[g.key] ??= {};
    for (const e of g.entries) {
      defaults[g.key][e.key] = `#${e.color.getHexString()}`;
      const stored = state[g.key][e.key];
      if (stored) e.color.set(stored); // apply persisted palette pre-regenerate
    }
  }

  const root = gui.addFolder('Palette');
  root.close();
  for (const g of groups) {
    const f = root.addFolder(g.name);
    f.close();
    const proxy: Record<string, string> = {};
    for (const e of g.entries) proxy[e.key] = `#${e.color.getHexString()}`;
    for (const e of g.entries) {
      f.addColor(proxy, e.key)
        .name(e.label)
        .listen()
        // live color + state on every picker tick, but the expensive
        // mesh re-bake only when the user commits (release/close)
        .onChange((v: string) => {
          e.color.set(v);
          state[g.key][e.key] = v;
          save(state);
        })
        .onFinishChange(() => onChange());
    }
    f.add(
      {
        reset: () => {
          for (const e of g.entries) {
            const hex = defaults[g.key][e.key];
            proxy[e.key] = hex;
            e.color.set(hex);
            delete state[g.key][e.key];
          }
          save(state);
          onChange();
        },
      },
      'reset',
    ).name('↺ defaults');
  }
}
