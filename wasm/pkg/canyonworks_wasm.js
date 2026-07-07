/* @ts-self-types="./canyonworks_wasm.d.ts" */

export class NetsResult {
    static __wrap(ptr) {
        const obj = Object.create(NetsResult.prototype);
        obj.__wbg_ptr = ptr;
        NetsResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        NetsResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_netsresult_free(ptr, 0);
    }
    /**
     * @returns {Uint32Array}
     */
    get indices() {
        const ret = wasm.netsresult_indices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get positions() {
        const ret = wasm.netsresult_positions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) NetsResult.prototype[Symbol.dispose] = NetsResult.prototype.free;

/**
 * Mirror of core/noise.ts `NoiseKit` — same seed derivation
 * (`seed ^ 0x2f6e2b1` / `seed ^ 0x5b7e4d3`), same output values.
 */
export class NoiseKit {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        NoiseKitFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_noisekit_free(ptr, 0);
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} octaves
     * @returns {number}
     */
    fbm2(x, y, octaves) {
        const ret = wasm.noisekit_fbm2(this.__wbg_ptr, x, y, octaves);
        return ret;
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} octaves
     * @returns {number}
     */
    fbm3(x, y, z, octaves) {
        const ret = wasm.noisekit_fbm3(this.__wbg_ptr, x, y, z, octaves);
        return ret;
    }
    /**
     * Bench/parity kernel: fill an nx×ny×nz grid with fbm3 sampled at
     * world coordinates (ix,iy,iz)·voxel·freq — the same access pattern
     * as the volume fill's cliff-roughness term. Returns a fresh
     * Float32Array (copy across the boundary; the real volume port will
     * expose views into wasm memory instead).
     * @param {number} nx
     * @param {number} ny
     * @param {number} nz
     * @param {number} voxel
     * @param {number} freq
     * @param {number} octaves
     * @returns {Float32Array}
     */
    fill_fbm3(nx, ny, nz, voxel, freq, octaves) {
        const ret = wasm.noisekit_fill_fbm3(this.__wbg_ptr, nx, ny, nz, voxel, freq, octaves);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {number} seed
     */
    constructor(seed) {
        const ret = wasm.noisekit_new(seed);
        this.__wbg_ptr = ret;
        NoiseKitFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {number} x
     * @param {number} y
     * @returns {number}
     */
    noise2(x, y) {
        const ret = wasm.noisekit_noise2(this.__wbg_ptr, x, y);
        return ret;
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {number}
     */
    noise3(x, y, z) {
        const ret = wasm.noisekit_noise3(this.__wbg_ptr, x, y, z);
        return ret;
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} octaves
     * @returns {number}
     */
    ridged2(x, y, octaves) {
        const ret = wasm.noisekit_ridged2(this.__wbg_ptr, x, y, octaves);
        return ret;
    }
}
if (Symbol.dispose) NoiseKit.prototype[Symbol.dispose] = NoiseKit.prototype.free;

export class VolumeResult {
    static __wrap(ptr) {
        const obj = Object.create(VolumeResult.prototype);
        obj.__wbg_ptr = ptr;
        VolumeResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        VolumeResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_volumeresult_free(ptr, 0);
    }
    /**
     * @returns {Uint8Array}
     */
    get block_type() {
        const ret = wasm.volumeresult_block_type(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get data() {
        const ret = wasm.volumeresult_data(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {number}
     */
    get mixed_count() {
        const ret = wasm.volumeresult_mixed_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get nbx() {
        const ret = wasm.volumeresult_nbx(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get nby() {
        const ret = wasm.volumeresult_nby(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get nbz() {
        const ret = wasm.volumeresult_nbz(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get solid_count() {
        const ret = wasm.volumeresult_solid_count(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) VolumeResult.prototype[Symbol.dispose] = VolumeResult.prototype.free;

/**
 * Port of bakeAo(): one AO value per vertex (positions.len() / 3). Rays
 * start just off the surface along the vertex normal, get bent mildly
 * toward the normal, and march AO_RADII; the first solid hit adds its
 * AO_HIT weight. ao = 1 - occ / 12.
 * @param {Float32Array} positions
 * @param {Float32Array} normals
 * @param {Float32Array} data
 * @param {number} nx
 * @param {number} ny
 * @param {number} nz
 * @param {number} voxel
 * @param {number} origin_x
 * @param {number} origin_z
 * @returns {Float32Array}
 */
export function bake_ao(positions, normals, data, nx, ny, nz, voxel, origin_x, origin_z) {
    const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(normals, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF32ToWasm0(data, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.bake_ao(ptr0, len0, ptr1, len1, ptr2, len2, nx, ny, nz, voxel, origin_x, origin_z);
    var v4 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v4;
}

/**
 * Port of buildDensityVolume() minus carve-op SDF evaluation (ops stay in
 * JS); op bounds are still consumed here to force affected blocks MIXED.
 *
 * `params` layout (spec PARAMS order):
 * 0 wallNoiseAmp, 1 wallNoiseFreq, 2 ledgeAmp, 3 terraceStep, 4 floorBase,
 * 5 washAmp, 6 washHeight, 7 washCoverage, 8 washScale.
 *
 * `op_bounds` is 6 f64 per op: [minX, maxX, minY, maxY, minZ, maxZ].
 * @param {number} seed
 * @param {number} nx
 * @param {number} ny
 * @param {number} nz
 * @param {number} voxel
 * @param {number} origin_x
 * @param {number} origin_z
 * @param {Float32Array} ground_h
 * @param {Float32Array} wall_mask
 * @param {Float32Array} s2
 * @param {Float64Array} params
 * @param {Float64Array} op_bounds
 * @param {boolean} force_all_mixed
 * @returns {VolumeResult}
 */
export function fill_volume(seed, nx, ny, nz, voxel, origin_x, origin_z, ground_h, wall_mask, s2, params, op_bounds, force_all_mixed) {
    const ptr0 = passArrayF32ToWasm0(ground_h, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(wall_mask, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF32ToWasm0(s2, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF64ToWasm0(params, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArrayF64ToWasm0(op_bounds, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ret = wasm.fill_volume(seed, nx, ny, nz, voxel, origin_x, origin_z, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, force_all_mixed);
    return VolumeResult.__wrap(ret);
}

/**
 * Port of surfaceNets(): one vertex per sign-crossing cell (centroid of
 * edge intersections), quads (as triangle pairs) across every sign-changing
 * grid edge. Convention: density > 0 is solid rock, <= 0 is air.
 * @param {Float32Array} data
 * @param {Uint8Array} block_type
 * @param {number} nx
 * @param {number} ny
 * @param {number} nz
 * @param {number} voxel
 * @param {number} origin_x
 * @param {number} origin_y
 * @param {number} origin_z
 * @param {number} nbx
 * @param {number} nby
 * @returns {NetsResult}
 */
export function surface_nets(data, block_type, nx, ny, nz, voxel, origin_x, origin_y, origin_z, nbx, nby) {
    const ptr0 = passArrayF32ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(block_type, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.surface_nets(ptr0, len0, ptr1, len1, nx, ny, nz, voxel, origin_x, origin_y, origin_z, nbx, nby);
    return NetsResult.__wrap(ret);
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./canyonworks_wasm_bg.js": import0,
    };
}

const NetsResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_netsresult_free(ptr, 1));
const NoiseKitFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_noisekit_free(ptr, 1));
const VolumeResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_volumeresult_free(ptr, 1));

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('canyonworks_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
