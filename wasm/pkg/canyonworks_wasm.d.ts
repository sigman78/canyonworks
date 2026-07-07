/* tslint:disable */
/* eslint-disable */

/**
 * Mirror of core/noise.ts `NoiseKit` — same seed derivation
 * (`seed ^ 0x2f6e2b1` / `seed ^ 0x5b7e4d3`), same output values.
 */
export class NoiseKit {
    free(): void;
    [Symbol.dispose](): void;
    fbm2(x: number, y: number, octaves: number): number;
    fbm3(x: number, y: number, z: number, octaves: number): number;
    /**
     * Bench/parity kernel: fill an nx×ny×nz grid with fbm3 sampled at
     * world coordinates (ix,iy,iz)·voxel·freq — the same access pattern
     * as the volume fill's cliff-roughness term. Returns a fresh
     * Float32Array (copy across the boundary; the real volume port will
     * expose views into wasm memory instead).
     */
    fill_fbm3(nx: number, ny: number, nz: number, voxel: number, freq: number, octaves: number): Float32Array;
    constructor(seed: number);
    noise2(x: number, y: number): number;
    noise3(x: number, y: number, z: number): number;
    ridged2(x: number, y: number, octaves: number): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_noisekit_free: (a: number, b: number) => void;
    readonly noisekit_fbm2: (a: number, b: number, c: number, d: number) => number;
    readonly noisekit_fbm3: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly noisekit_fill_fbm3: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly noisekit_new: (a: number) => number;
    readonly noisekit_noise2: (a: number, b: number, c: number) => number;
    readonly noisekit_noise3: (a: number, b: number, c: number, d: number) => number;
    readonly noisekit_ridged2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
