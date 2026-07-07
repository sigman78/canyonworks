//! Typed generator parameters crossing the JS/wasm boundary as one serde-decoded
//! object (replaces the fixed-order Float64Array param vectors).
//!
//! `GenParams` mirrors src/gen/params.ts `GenParams` field-for-field. Numeric
//! fields are f32 (Gate 5): serde narrows each JS f64 number to f32 ON DECODE —
//! this is the ONE conversion point per input (conversion-tax rule); kernels
//! never ping-pong widths afterwards. Verified against the sources:
//! serde-wasm-bindgen 0.6.5 `deserialize_f32` forwards the JS number through
//! `visit_f64`, and serde core's f32 impl narrows with IEEE `v as f32`
//! (round-to-nearest-even) — deterministic. The struct carries a struct-level
//! `#[serde(default)]` so older/newer TS param objects still decode
//! (serde-wasm-bindgen ignores unknown fields; missing ones fall back to
//! `defaultParams()` values via `Default`).

use serde::Deserialize;
use wasm_bindgen::JsValue;

/// Mirror of src/gen/params.ts `GenParams`. Numeric fields f32 (narrowed once
/// by serde on decode) — except `seed`, see its field doc.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GenParams {
    /// KEEP f64 (Gate-5 whitelist item 3): the seed is consumed via
    /// `seed_u32()`, which reproduces JS `seed >>> 0` (ToUint32) — that needs
    /// f64's exact-integer range (2^53). An f32 seed would collapse distinct
    /// integer seeds >= 2^24 onto each other and silently change maps.
    pub seed: f64,

    // map footprint
    pub cols: f32,
    pub rows: f32,
    pub hex_size: f32,

    // canyon network layout (units: hexes unless noted)
    pub junctions: f32,
    pub extra_loops: f32,
    pub corridor_width: f32,
    pub corridor_wander: f32,
    pub choke_chance: f32,
    pub choke_width: f32,
    pub opening_radius: f32,
    pub opening_jitter: f32,
    pub border_pad: f32,
    pub target_open_frac: f32,
    pub edge_portals: f32,

    // vertical profile (world units)
    pub floor_base: f32,
    pub floor_amp: f32,
    pub floor_freq: f32,
    pub wall_height: f32,
    pub wall_var: f32,
    pub wall_freq: f32,
    pub wall_thickness: f32,
    pub ridge_amp: f32,
    pub ridge_freq: f32,
    pub terrace_step: f32,
    pub terrace_amt: f32,
    pub terrace_sharp: f32,
    pub ledge_amp: f32,
    pub talus_amp: f32,
    pub talus_fall: f32,
    pub wall_noise_amp: f32,
    pub wall_noise_freq: f32,

    // craters (baked into floor heightfield, passable)
    pub crater_count: f32,
    pub crater_min_r: f32,
    pub crater_max_r: f32,
    pub crater_depth: f32,

    // fissures (hex-aligned cracks)
    pub crack_count: f32,
    pub crack_len_min: f32,
    pub crack_len_max: f32,
    pub crack_width: f32,
    pub crack_depth: f32,

    // decor (instanced, non-SDF)
    pub boulder_count: f32,
    pub boulder_min_scale: f32,
    pub boulder_max_scale: f32,
    pub pillar_count: f32,
    pub scree_clusters: f32,
    pub scree_size: f32,

    // 3D carve ops
    pub arch_count: f32,
    pub arch_depth: f32,
    pub arch_thickness: f32,
    pub arch_clearance: f32,
    pub arch_max_span: f32,
    pub window_count: f32,
    pub window_radius: f32,

    // basal wash
    pub wash_amp: f32,
    pub wash_height: f32,
    pub wash_coverage: f32,
    pub wash_scale: f32,

    // meshing
    pub voxel_size: f32,
    pub wasm_gen: bool,
}

/// Values = defaultParams() in src/gen/params.ts, verbatim.
impl Default for GenParams {
    fn default() -> Self {
        GenParams {
            seed: 1337.0,

            cols: 30.0,
            rows: 26.0,
            hex_size: 1.0,

            junctions: 7.0,
            extra_loops: 2.0,
            corridor_width: 2.6,
            corridor_wander: 1.6,
            choke_chance: 0.55,
            choke_width: 0.5,
            opening_radius: 2.4,
            opening_jitter: 0.45,
            border_pad: 1.0,
            target_open_frac: 0.3,
            edge_portals: 3.0,

            floor_base: 1.2,
            floor_amp: 0.06,
            floor_freq: 0.08,
            wall_height: 5.2,
            wall_var: 1.6,
            wall_freq: 0.05,
            wall_thickness: 2.6,
            ridge_amp: 0.9,
            ridge_freq: 0.22,
            terrace_step: 1.15,
            terrace_amt: 0.75,
            terrace_sharp: 0.65,
            ledge_amp: 0.18,
            talus_amp: 0.35,
            talus_fall: 1.4,
            wall_noise_amp: 0.35,
            wall_noise_freq: 0.55,

            crater_count: 6.0,
            crater_min_r: 1.2,
            crater_max_r: 2.6,
            crater_depth: 0.5,

            crack_count: 4.0,
            crack_len_min: 1.0,
            crack_len_max: 2.0,
            crack_width: 0.35,
            crack_depth: 0.8,

            boulder_count: 26.0,
            boulder_min_scale: 0.25,
            boulder_max_scale: 0.85,
            pillar_count: 3.0,
            scree_clusters: 14.0,
            scree_size: 0.16,

            arch_count: 2.0,
            arch_depth: 2.4,
            arch_thickness: 0.8,
            arch_clearance: 1.9,
            arch_max_span: 8.0,
            window_count: 2.0,
            window_radius: 0.9,

            wash_amp: 0.7,
            wash_height: 1.2,
            wash_coverage: 0.45,
            wash_scale: 0.05,

            voxel_size: 0.3,
            wasm_gen: true,
        }
    }
}

impl GenParams {
    /// JS `seed >>> 0` (ToUint32) for typical non-negative integer seeds —
    /// the value every kernel feeds into the Mulberry32 noise seeding.
    /// (Why `seed` stays f64: see the field doc — Gate-5 whitelist item 3.)
    pub fn seed_u32(&self) -> u32 {
        (self.seed as i64 as u64 & 0xffff_ffff) as u32
    }
}

/// Decode ONE JS object crossing the boundary (serde error -> JS exception).
/// The single home for the decode-and-map-error dance — every boundary type
/// (GenParams, Palette, Vec<CarveOpSpec>) goes through here. For f32 fields
/// this decode IS the one f64->f32 narrowing point (module doc).
pub fn from_js<T: serde::de::DeserializeOwned>(v: &JsValue) -> Result<T, JsValue> {
    serde_wasm_bindgen::from_value(v.clone()).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Linear-space color as THREE.Color exposes it ({r, g, b} floats). Lives in
/// math.rs with the rest of the color math; re-exported here because the
/// serde Palette is its main producer.
pub use crate::math::Rgb;

/// Mirror of mesher.ts TERRAIN_PALETTE (order/meaning identical to the old
/// 45-entry flattenPalette() vector: strata[0..5] bottom-to-top, floorA,
/// floorB, cap, crevice, craterIn, craterWall, craterRim, ejecta, crackDeep,
/// crackLip). Channels narrow to f32 on decode (module doc).
/// The TS side rebuilds the spec PER CALL — the live THREE.Color objects are
/// mutated by the Palette panel between regenerates, so nothing here may be
/// cached across calls.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Palette {
    pub strata: [Rgb; 5],
    pub floor_a: Rgb,
    pub floor_b: Rgb,
    pub cap: Rgb,
    pub crevice: Rgb,
    pub crater_in: Rgb,
    pub crater_wall: Rgb,
    pub crater_rim: Rgb,
    pub ejecta: Rgb,
    pub crack_deep: Rgb,
    pub crack_lip: Rgb,
}
