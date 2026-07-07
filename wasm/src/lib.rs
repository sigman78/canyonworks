//! CanyonWorks WASM generator kernels.
//!
//! The wasm boundary is a single fused `generate_mesh` call (pipeline.rs) —
//! volume fill -> carve ops -> surface nets -> normals -> AO -> colorize in
//! one crossing — plus the two still-per-stage fields exports
//! (`signed_distance` / `fields_profile`) and the `NoiseKit` parity/bench
//! harness. Everything else is the TYPED library face: public modules
//! (params/grid/noise + one module per kernel) whose functions take
//! `&GenParams` / `Grid2` / `VolDims` / `&MapNoise` — no positional f64
//! vectors. Native benches (examples/, built with an explicit native
//! `--target`) call these typed APIs directly; wasm-bindgen is just a
//! wrapper.

pub mod ao;
pub mod colorize;
pub mod fields;
pub mod grid;
pub mod math;
pub mod nets;
pub mod noise;
pub mod normals;
pub mod ops;
mod par;
pub mod params;
pub mod pipeline;
pub mod timer;
pub mod volume;

pub use fields::{fields_profile, signed_distance, FieldsProfileResult};
pub use pipeline::{generate_mesh, MeshResult};

use grid::MapNoise;
use math::{vec2, vec3};
use noise::fbm3;
use wasm_bindgen::prelude::*;

/// Parity/bench harness face over the map's shared noise (core/noise.ts
/// `NoiseKit`, pruned to the methods the TS harness in src/core/wasmGen.ts
/// actually calls: `noise2`/`noise3` samples + the `fill_fbm3` bench
/// kernel). Delegates to `grid::MapNoise`, the ONE home for the makeNoise
/// seed derivation (`seed ^ 0x2f6e2b1` / `seed ^ 0x5b7e4d3`), so the harness
/// provably samples the same fields as every kernel stage. The JS-number
/// boundary stays f64 in/out; args narrow to f32 AND repack into the
/// compound `Vec2`/`Vec3` sample points ONCE at entry (Gate-5 whitelist
/// item 4 + the Gate-7 fringe rule — scalars live only here, at the
/// #[wasm_bindgen] surface). Kernel noise math is f32, so the TS parity
/// harness measures nearness to the JS noise, not bit-identity.
#[wasm_bindgen]
pub struct NoiseKit {
    noise: MapNoise,
}

#[wasm_bindgen]
impl NoiseKit {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32) -> NoiseKit {
        NoiseKit {
            noise: MapNoise::new(seed),
        }
    }

    pub fn noise2(&self, x: f64, y: f64) -> f64 {
        self.noise.n2.sample(vec2(x as f32, y as f32)) as f64
    }

    pub fn noise3(&self, x: f64, y: f64, z: f64) -> f64 {
        self.noise.n3.sample(vec3(x as f32, y as f32, z as f32)) as f64
    }

    /// Bench/parity kernel: fill an nx×ny×nz grid with fbm3 sampled at
    /// world coordinates (ix,iy,iz)·voxel·freq — the same access pattern
    /// as the volume fill's cliff-roughness term. Returns a fresh
    /// Float32Array (copy across the boundary; the real volume port will
    /// expose views into wasm memory instead).
    pub fn fill_fbm3(&self, nx: u32, ny: u32, nz: u32, voxel: f64, freq: f64, octaves: u32) -> Vec<f32> {
        // f64 JS scalars -> f32 once at entry (Gate-5 whitelist item 4)
        let (voxel, freq) = (voxel as f32, freq as f32);
        let mut out = vec![0.0f32; (nx * ny * nz) as usize];
        let mut idx = 0;
        // per-lane coordinates hoisted per loop level (unchanged), composed
        // into the compound sample point where the innermost lane lands
        for iz in 0..nz {
            let z = iz as f32 * voxel * freq;
            for iy in 0..ny {
                let y = iy as f32 * voxel * freq;
                for ix in 0..nx {
                    let x = ix as f32 * voxel * freq;
                    out[idx] = fbm3(&self.noise.n3, vec3(x, y, z), octaves);
                    idx += 1;
                }
            }
        }
        out
    }
}
