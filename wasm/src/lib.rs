//! CanyonWorks WASM generator kernels.
//!
//! Stage 1 (scaffold): the deterministic noise kit + a grid-fill bench
//! kernel, exposed through wasm-bindgen with the SAME seeding scheme as
//! core/noise.ts makeNoise(). Later stages move the volume fill, surface
//! nets and AO bake here.

mod ao;
mod colorize;
mod nets;
mod noise;
mod volume;

pub use ao::bake_ao;
pub use colorize::{colorize, ColorizeResult};
pub use nets::{surface_nets, NetsResult};
pub use volume::{fill_volume, VolumeResult};

use noise::{fbm2, fbm3, ridged2, Noise2, Noise3};
use wasm_bindgen::prelude::*;

/// Mirror of core/noise.ts `NoiseKit` — same seed derivation
/// (`seed ^ 0x2f6e2b1` / `seed ^ 0x5b7e4d3`), same output values.
#[wasm_bindgen]
pub struct NoiseKit {
    n2: Noise2,
    n3: Noise3,
}

#[wasm_bindgen]
impl NoiseKit {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32) -> NoiseKit {
        NoiseKit {
            n2: Noise2::new(seed ^ 0x2f6_e2b1),
            n3: Noise3::new(seed ^ 0x5b7_e4d3),
        }
    }

    pub fn noise2(&self, x: f64, y: f64) -> f64 {
        self.n2.sample(x, y)
    }

    pub fn noise3(&self, x: f64, y: f64, z: f64) -> f64 {
        self.n3.sample(x, y, z)
    }

    pub fn fbm2(&self, x: f64, y: f64, octaves: u32) -> f64 {
        fbm2(&self.n2, x, y, octaves)
    }

    pub fn fbm3(&self, x: f64, y: f64, z: f64, octaves: u32) -> f64 {
        fbm3(&self.n3, x, y, z, octaves)
    }

    pub fn ridged2(&self, x: f64, y: f64, octaves: u32) -> f64 {
        ridged2(&self.n2, x, y, octaves)
    }

    /// Bench/parity kernel: fill an nx×ny×nz grid with fbm3 sampled at
    /// world coordinates (ix,iy,iz)·voxel·freq — the same access pattern
    /// as the volume fill's cliff-roughness term. Returns a fresh
    /// Float32Array (copy across the boundary; the real volume port will
    /// expose views into wasm memory instead).
    pub fn fill_fbm3(&self, nx: u32, ny: u32, nz: u32, voxel: f64, freq: f64, octaves: u32) -> Vec<f32> {
        let mut out = vec![0.0f32; (nx * ny * nz) as usize];
        let mut idx = 0;
        for iz in 0..nz {
            let z = iz as f64 * voxel * freq;
            for iy in 0..ny {
                let y = iy as f64 * voxel * freq;
                for ix in 0..nx {
                    let x = ix as f64 * voxel * freq;
                    out[idx] = fbm3(&self.n3, x, y, z, octaves) as f32;
                    idx += 1;
                }
            }
        }
        out
    }
}
