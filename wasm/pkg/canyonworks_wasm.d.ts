/* tslint:disable */
/* eslint-disable */

export class NetsResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly indices: Uint32Array;
    readonly positions: Float32Array;
}

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

export class VolumeResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly block_type: Uint8Array;
    readonly data: Float32Array;
    readonly mixed_count: number;
    readonly nbx: number;
    readonly nby: number;
    readonly nbz: number;
    readonly solid_count: number;
}

/**
 * Port of bakeAo(): one AO value per vertex (positions.len() / 3). Rays
 * start just off the surface along the vertex normal, get bent mildly
 * toward the normal, and march AO_RADII; the first solid hit adds its
 * AO_HIT weight. ao = 1 - occ / 12.
 */
export function bake_ao(positions: Float32Array, normals: Float32Array, data: Float32Array, nx: number, ny: number, nz: number, voxel: number, origin_x: number, origin_z: number): Float32Array;

/**
 * Port of buildDensityVolume() minus carve-op SDF evaluation (ops stay in
 * JS); op bounds are still consumed here to force affected blocks MIXED.
 *
 * `params` layout (spec PARAMS order):
 * 0 wallNoiseAmp, 1 wallNoiseFreq, 2 ledgeAmp, 3 terraceStep, 4 floorBase,
 * 5 washAmp, 6 washHeight, 7 washCoverage, 8 washScale.
 *
 * `op_bounds` is 6 f64 per op: [minX, maxX, minY, maxY, minZ, maxZ].
 */
export function fill_volume(seed: number, nx: number, ny: number, nz: number, voxel: number, origin_x: number, origin_z: number, ground_h: Float32Array, wall_mask: Float32Array, s2: Float32Array, params: Float64Array, op_bounds: Float64Array, force_all_mixed: boolean): VolumeResult;

/**
 * Port of surfaceNets(): one vertex per sign-crossing cell (centroid of
 * edge intersections), quads (as triangle pairs) across every sign-changing
 * grid edge. Convention: density > 0 is solid rock, <= 0 is air.
 */
export function surface_nets(data: Float32Array, block_type: Uint8Array, nx: number, ny: number, nz: number, voxel: number, origin_x: number, origin_y: number, origin_z: number, nbx: number, nby: number): NetsResult;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_netsresult_free: (a: number, b: number) => void;
    readonly __wbg_noisekit_free: (a: number, b: number) => void;
    readonly __wbg_volumeresult_free: (a: number, b: number) => void;
    readonly bake_ao: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number];
    readonly fill_volume: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number) => number;
    readonly netsresult_indices: (a: number) => [number, number];
    readonly netsresult_positions: (a: number) => [number, number];
    readonly noisekit_fbm2: (a: number, b: number, c: number, d: number) => number;
    readonly noisekit_fbm3: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly noisekit_fill_fbm3: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly noisekit_new: (a: number) => number;
    readonly noisekit_noise2: (a: number, b: number, c: number) => number;
    readonly noisekit_noise3: (a: number, b: number, c: number, d: number) => number;
    readonly noisekit_ridged2: (a: number, b: number, c: number, d: number) => number;
    readonly surface_nets: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => number;
    readonly volumeresult_block_type: (a: number) => [number, number];
    readonly volumeresult_data: (a: number) => [number, number];
    readonly volumeresult_mixed_count: (a: number) => number;
    readonly volumeresult_nbx: (a: number) => number;
    readonly volumeresult_nby: (a: number) => number;
    readonly volumeresult_nbz: (a: number) => number;
    readonly volumeresult_solid_count: (a: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
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
