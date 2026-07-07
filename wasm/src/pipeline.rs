//! Fused mesh pipeline: ONE wasm call runs volume fill -> carve ops ->
//! surface nets -> normals -> AO -> colorize. Only the five small 2D field
//! rasters cross the boundary inbound and the final mesh buffers come out —
//! the ~4MB density volume never leaves wasm memory.
//!
//! The chain itself is `mesh_chain` — fully typed (no JsValue anywhere), the
//! ONE home for the stage sequence + per-stage timing, shared by the
//! `generate_mesh` wasm export and examples/bench_native.rs. Every stage is a
//! kernel's typed library API (`volume::fill`, `ops::apply_carve_ops`,
//! `nets::surface_nets`, `normals::compute_normals`, `ao::bake`,
//! `colorize::run`) with shared context types from grid.rs (`FieldGrids`,
//! `VolDims`, `MapNoise`). The noise kit is built ONCE from the seed and
//! threaded through — no per-stage perm-table rebuilds, no positional f64
//! param vectors anywhere. `generate_mesh` is just serde decode + `mesh_chain`
//! + flatten into `MeshResult`.

use wasm_bindgen::prelude::*;

use crate::grid::{FieldGrids, MapNoise, VolDims};
use crate::math::{idx2, vec2, Aabb};
use crate::ops::{apply_carve_ops, CarveOpSpec};
use crate::params::{self, GenParams, Palette};
use crate::timer::now_ms;
use crate::{ao, colorize, nets, normals, volume};

/// Volume height in voxels for a map whose profile tops out at `max_h` —
/// the mesher's formula (`Math.ceil((maxH + 1.0) / voxel) + 1`) in f32 like
/// every other world scalar (Gate 5; the boundary f64s narrow at
/// `generate_mesh` entry). ONE home shared by `generate_mesh` and the
/// native bench.
#[inline]
pub fn volume_ny(max_h: f32, voxel: f32) -> u32 {
    (((max_h + 1.0) / voxel).ceil() + 1.0) as u32
}

/// Typed output of `mesh_chain`: structured mesh buffers plus the consumed
/// volume's dims/block stats and the per-stage timings. This is the crate's
/// library face for the fused chain — the native bench consumes it directly;
/// `MeshResult` is its flattened wasm-bindgen wrapper.
pub struct MeshBuffers {
    pub vertices: Vec<[f32; 3]>,
    pub indices: Vec<u32>,
    pub normals: Vec<[f32; 3]>,
    pub ao: Vec<f32>,
    pub colors: Vec<[f32; 3]>,
    pub facies: Vec<[f32; 3]>,
    /// dims/world mapping of the density volume the chain consumed
    pub dims: VolDims,
    pub mixed_count: u32,
    pub solid_count: u32,
    /// [volumeFill(+carve ops), surfaceNets, normals, aoBake, colorize] ms.
    /// KEEP f64 (Gate-5 whitelist item 2): timings come from
    /// `timer::now_ms` — performance.now is an f64 ms clock.
    pub stage_ms: [f64; 5],
}

/// The fused typed stage chain (order must equal the TS mesher's
/// buildTerrainGeometry): volume fill -> carve-op post-pass -> surface nets
/// -> vertex normals -> AO bake -> colorize, each stage timed.
///
/// `fields` also fixes the volume's x/z dims and world mapping (the volume
/// shares the field raster's grid); `ny` comes from `volume_ny`;
/// `force_all_mixed` is the bench flag disabling block classification.
pub fn mesh_chain(
    params: &GenParams,
    fields: &FieldGrids,
    ops: &[CarveOpSpec],
    palette: &Palette,
    noise: &MapNoise,
    ny: u32,
    force_all_mixed: bool,
) -> MeshBuffers {
    // The op AABBs MUST reach the fill even though the SDFs evaluate in the
    // post-pass: they force the touched blocks MIXED, keeping block
    // classification exact.
    let op_bounds: Vec<Aabb> = ops.iter().map(CarveOpSpec::aabb).collect();

    let t0 = now_ms();
    let mut vol = volume::fill(params, fields, noise, ny, &op_bounds, force_all_mixed);
    apply_carve_ops(&mut vol.data, &vol.dims, ops, &noise.n2);
    let t1 = now_ms();

    // originY = 0 — the volume starts at the world floor, same value the
    // mesher always passed
    let mesh = nets::surface_nets(&vol.data, &vol.block_type, &vol.dims, 0.0);
    let t2 = now_ms();

    let nrm = normals::compute_normals(&mesh.vertices, &mesh.indices);
    let t3 = now_ms();

    let ao = ao::bake(&mesh.vertices, &nrm, &vol.data, &vol.dims);
    let t4 = now_ms();

    let col = colorize::run(
        &mesh.vertices,
        &nrm,
        &vol.data,
        &vol.dims,
        fields,
        params,
        palette,
        noise,
    );
    let t5 = now_ms();

    MeshBuffers {
        vertices: mesh.vertices,
        indices: mesh.indices,
        normals: nrm,
        ao,
        colors: col.colors,
        facies: col.facies,
        dims: vol.dims,
        mixed_count: vol.mixed_count,
        solid_count: vol.solid_count,
        stage_ms: [t1 - t0, t2 - t1, t3 - t2, t4 - t3, t5 - t4],
    }
}

/// wasm-bindgen getter boilerplate for BUFFER fields, ONE home (used here
/// and by fields::FieldsProfileResult): a `#[wasm_bindgen(getter)]` per
/// listed field returning a fresh `js_sys` typed array built straight from
/// the stored Vec's slice — ONE copy, wasm linear memory -> JS heap.
/// (Returning the Vec would copy twice: a Rust-side clone, then the
/// wasm-bindgen glue's copy into the JS typed array.) The .d.ts ABI is
/// unchanged — the getter still reads Float32Array/Uint32Array/Float64Array.
/// Still a COPY, never a view: the JS side (three.js attributes) keeps the
/// buffers long-term, and a view into wasm memory would dangle after the
/// next generate call.
macro_rules! typed_array_getters {
    ($ty:ident { $($(#[$meta:meta])* $name:ident: $arr:ty),+ $(,)? }) => {
        #[wasm_bindgen]
        impl $ty {
            $(
                $(#[$meta])*
                #[wasm_bindgen(getter)]
                pub fn $name(&self) -> $arr {
                    <$arr>::from(self.$name.as_slice())
                }
            )+
        }
    };
}
pub(crate) use typed_array_getters;

/// wasm-bindgen getter boilerplate for MeshResult's scalar (Copy) stat
/// fields: a `#[wasm_bindgen(getter)]` per listed field, cloning out.
/// Buffer fields go through `typed_array_getters!` above instead.
macro_rules! clone_getters {
    ($ty:ident { $($(#[$meta:meta])* $name:ident: $out:ty),+ $(,)? }) => {
        #[wasm_bindgen]
        impl $ty {
            $(
                $(#[$meta])*
                #[wasm_bindgen(getter)]
                pub fn $name(&self) -> $out {
                    self.$name.clone()
                }
            )+
        }
    };
}

/// Final mesh buffers + block stats + per-stage timing, crossing the
/// boundary ONCE — `MeshBuffers` flattened for JS (the `[f32; 3]` buffers
/// become flat Vecs via `into_flattened`, a free reinterpretation; the JS
/// ABI is unchanged).
#[wasm_bindgen]
pub struct MeshResult {
    positions: Vec<f32>,
    indices: Vec<u32>,
    normals: Vec<f32>,
    ao: Vec<f32>,
    colors: Vec<f32>,
    facies: Vec<f32>,
    nbx: u32,
    nby: u32,
    nbz: u32,
    mixed_count: u32,
    solid_count: u32,
    /// [volumeFill(+carve ops), surfaceNets, normals, aoBake, colorize] ms.
    /// KEEP f64 (Gate-5 whitelist item 2): performance.now clock, and the
    /// getter's JS ABI is a Float64Array as always.
    stage_ms: Vec<f64>,
}

typed_array_getters!(MeshResult {
    positions: js_sys::Float32Array,
    indices: js_sys::Uint32Array,
    normals: js_sys::Float32Array,
    ao: js_sys::Float32Array,
    colors: js_sys::Float32Array,
    facies: js_sys::Float32Array,
    stage_ms: js_sys::Float64Array,
});

clone_getters!(MeshResult {
    nbx: u32,
    nby: u32,
    nbz: u32,
    mixed_count: u32,
    solid_count: u32,
});

/// Fused generator entry point — the whole mesh chain in one crossing.
///
/// Inputs: the five 2D field rasters (ground_h/wall_mask/s2 feed the fill;
/// crack_d/crater_d feed colorize — the volume shares the field raster's
/// x/z grid, so one set of dims covers both), `max_h` (ny is derived here
/// via `volume_ny`), and carve ops + params + palette as JS objects decoded
/// via serde (`params::from_js`, the one decode+error-map home).
/// `force_all_mixed` is the bench flag disabling block classification.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn generate_mesh(
    ground_h: &[f32],
    wall_mask: &[f32],
    s2: &[f32],
    crack_d: &[f32],
    crater_d: &[f32],
    nx: u32,
    nz: u32,
    voxel: f64,
    origin_x: f64,
    origin_z: f64,
    max_h: f64,
    ops: JsValue,
    params: JsValue,
    palette: JsValue,
    force_all_mixed: bool,
) -> Result<MeshResult, JsValue> {
    let params: GenParams = params::from_js(&params)?;
    let palette: Palette = params::from_js(&palette)?;
    let ops: Vec<CarveOpSpec> = params::from_js(&ops)?;

    // The map's shared deterministic noise (core/noise.ts makeNoise seed
    // derivation), built ONCE and threaded through fill / carve-op SDFs /
    // colorize — no per-stage perm-table rebuilds.
    let noise = MapNoise::new(params.seed_u32());

    // JS f64 boundary scalars -> f32 world units ONCE at entry (Gate-5
    // whitelist item 4). Everything downstream — grids, the ny formula,
    // every kernel — runs f32; no per-sample narrowing anywhere.
    let (voxel, origin_x, origin_z, max_h) =
        (voxel as f32, origin_x as f32, origin_z as f32, max_h as f32);

    // World-mapped views over the five field rasters (one shared x/z grid —
    // the volume uses the same raster). The boundary's scalar dims/origin
    // repack into Idx2/Vec2 here, at the fringe.
    let fields = FieldGrids::new(
        ground_h,
        wall_mask,
        s2,
        crack_d,
        crater_d,
        idx2(nx as usize, nz as usize),
        voxel,
        vec2(origin_x, origin_z),
    );

    let b = mesh_chain(
        &params,
        &fields,
        &ops,
        &palette,
        &noise,
        volume_ny(max_h, voxel),
        force_all_mixed,
    );

    Ok(MeshResult {
        positions: b.vertices.into_flattened(),
        indices: b.indices,
        normals: b.normals.into_flattened(),
        ao: b.ao,
        colors: b.colors.into_flattened(),
        facies: b.facies.into_flattened(),
        nbx: b.dims.nb.x as u32,
        nby: b.dims.nb.y as u32,
        nbz: b.dims.nb.z as u32,
        mixed_count: b.mixed_count,
        solid_count: b.solid_count,
        stage_ms: b.stage_ms.to_vec(),
    })
}
