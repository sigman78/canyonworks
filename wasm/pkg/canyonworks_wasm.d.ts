/* tslint:disable */
/* eslint-disable */

/**
 * wasm result wrapper around `Profile` — getters COPY out (established
 * pattern: the TS side keeps the buffers long-term, so they must be copies,
 * never views into wasm memory). Buffer getters via the shared
 * `pipeline::typed_array_getters!` (one copy, wasm memory -> JS heap);
 * `max_h` has a manual getter because it promotes f32 -> f64 at the
 * boundary (same four getter names/types as before — ABI unchanged).
 */
export class FieldsProfileResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly crater_d: Float32Array;
    readonly ground_h: Float32Array;
    /**
     * `max_h` is an f32 max internally (Gate-5 whitelist item 5); it is
     * promoted to f64 ONLY here, at the JS boundary — the getter keeps the
     * f64 (JS number) ABI it always had.
     */
    readonly max_h: number;
    readonly wall_mask: Float32Array;
}

/**
 * Final mesh buffers + block stats + per-stage timing, crossing the
 * boundary ONCE — `MeshBuffers` flattened for JS (the `[f32; 3]` buffers
 * become flat Vecs via `into_flattened`, a free reinterpretation; the JS
 * ABI is unchanged).
 */
export class MeshResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly ao: Float32Array;
    readonly colors: Float32Array;
    readonly facies: Float32Array;
    readonly indices: Uint32Array;
    readonly mixed_count: number;
    readonly nbx: number;
    readonly nby: number;
    readonly nbz: number;
    readonly normals: Float32Array;
    readonly positions: Float32Array;
    readonly solid_count: number;
    readonly stage_ms: Float64Array;
}

/**
 * Parity/bench harness face over the map's shared noise (core/noise.ts
 * `NoiseKit`, pruned to the methods the TS harness in src/core/wasmGen.ts
 * actually calls: `noise2`/`noise3` samples + the `fill_fbm3` bench
 * kernel). Delegates to `grid::MapNoise`, the ONE home for the makeNoise
 * seed derivation (`seed ^ 0x2f6e2b1` / `seed ^ 0x5b7e4d3`), so the harness
 * provably samples the same fields as every kernel stage. The JS-number
 * boundary stays f64 in/out; args narrow to f32 AND repack into the
 * compound `Vec2`/`Vec3` sample points ONCE at entry (Gate-5 whitelist
 * item 4 + the Gate-7 fringe rule — scalars live only here, at the
 * #[wasm_bindgen] surface). Kernel noise math is f32, so the TS parity
 * harness measures nearness to the JS noise, not bit-identity.
 */
export class NoiseKit {
    free(): void;
    [Symbol.dispose](): void;
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
}

/**
 * wasm export wrapper over `profile` — the per-column ground-profile pass.
 *
 * Typed-params boundary (Gate 2): `params` is the live GenParams object
 * decoded via serde (replaces the old 15-entry f64 vec + separate seed;
 * seed = `params.seed >>> 0`). `craters` stays a 4-stride [x, z, r, depth]
 * f64 array — it is a JS-built placement list, fine as-is. `s2` must be
 * ALREADY scaled to world units by the caller.
 */
export function fields_profile(nx: number, nz: number, voxel: number, origin_x: number, origin_z: number, s2: Float32Array, crack_d: Float32Array, flatten_w: Float32Array, flat_raw: Uint8Array, mesa_off: Float32Array, craters: Float64Array, params: any): FieldsProfileResult;

/**
 * Fused generator entry point — the whole mesh chain in one crossing.
 *
 * Inputs: the five 2D field rasters (ground_h/wall_mask/s2 feed the fill;
 * crack_d/crater_d feed colorize — the volume shares the field raster's
 * x/z grid, so one set of dims covers both), `max_h` (ny is derived here
 * via `volume_ny`), and carve ops + params + palette as JS objects decoded
 * via serde (`params::from_js`, the one decode+error-map home).
 * `force_all_mixed` is the bench flag disabling block classification.
 */
export function generate_mesh(ground_h: Float32Array, wall_mask: Float32Array, s2: Float32Array, crack_d: Float32Array, crater_d: Float32Array, nx: number, nz: number, voxel: number, origin_x: number, origin_z: number, max_h: number, ops: any, params: any, palette: any, force_all_mixed: boolean): MeshResult;

/**
 * wasm export wrapper over `edt` — JS ABI unchanged (Stage B may move its
 * caller in-crate later); the fringe repacks the scalar dims into the
 * `Idx2` the typed API takes.
 */
export function signed_distance(open_raster: Uint8Array, nx: number, nz: number): Float32Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_fieldsprofileresult_free: (a: number, b: number) => void;
    readonly __wbg_meshresult_free: (a: number, b: number) => void;
    readonly __wbg_noisekit_free: (a: number, b: number) => void;
    readonly fields_profile: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: any) => [number, number, number];
    readonly fieldsprofileresult_crater_d: (a: number) => any;
    readonly fieldsprofileresult_ground_h: (a: number) => any;
    readonly fieldsprofileresult_max_h: (a: number) => number;
    readonly fieldsprofileresult_wall_mask: (a: number) => any;
    readonly generate_mesh: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: any, r: any, s: any, t: number) => [number, number, number];
    readonly meshresult_ao: (a: number) => any;
    readonly meshresult_colors: (a: number) => any;
    readonly meshresult_facies: (a: number) => any;
    readonly meshresult_indices: (a: number) => any;
    readonly meshresult_mixed_count: (a: number) => number;
    readonly meshresult_nbx: (a: number) => number;
    readonly meshresult_nby: (a: number) => number;
    readonly meshresult_nbz: (a: number) => number;
    readonly meshresult_normals: (a: number) => any;
    readonly meshresult_positions: (a: number) => any;
    readonly meshresult_solid_count: (a: number) => number;
    readonly meshresult_stage_ms: (a: number) => any;
    readonly noisekit_fill_fbm3: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly noisekit_new: (a: number) => number;
    readonly noisekit_noise2: (a: number, b: number, c: number) => number;
    readonly noisekit_noise3: (a: number, b: number, c: number, d: number) => number;
    readonly signed_distance: (a: number, b: number, c: number, d: number) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
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
