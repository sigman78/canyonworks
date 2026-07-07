//! Faithful port of src/gen/mesher.ts `colorizeJs()` (stage 5 of the wasm
//! generator move): Sedona palette baked into per-vertex colors plus the
//! 3-channel `facies` morphology attribute (dome hollow / crater interior /
//! plateau cap), from the vertex positions + normals, the density volume
//! (cave-tint probe) and the per-column field grids.
//!
//! Determinism contract:
//! - Position/normal/field reads are f32 promoted to f64 (exactly what a
//!   Float32Array read yields in JS); all intermediate math is f64 in JS
//!   operator order; every store into the output Float32Arrays goes through
//!   `as f32`.
//! - The bilinear field sampler matches fields.ts `sample()` exactly
//!   (floor + clamp to [0, n-2], clamp01 fractions, lerp x then z); the
//!   crater sampler is NEAREST (js_round + clamp), matching mesher.ts
//!   `sampleCraterD`.
//! - Palette colors arrive PER CALL (the Palette panel mutates the live
//!   THREE.Color objects between runs) as linear-space r/g/b floats; the
//!   color math is plain lerp/multiply on those components, mirroring
//!   THREE.Color copy/lerp/multiplyScalar semantics.
//!
//! KNOWN NON-EXACTNESS: the strata-band jitter uses `Math.sin` and the
//! crater-crest / crack-lip gaussians use `Math.exp`. V8's transcendentals
//! are not bit-identical to Rust's libm — either may differ by ~1 ULP.
//! Parity is therefore NEAR-identical, not exact: the colorParity harness
//! (src/core/wasmGen.ts) may report a nonzero exactDiffCount, but maxDiff
//! must stay < 1e-6. Everything else (bilinear samplers, smoothsteps,
//! simplex noise, lerps) is exact-order IEEE and contributes nothing.
//!
//! `params` layout (spec COLOR PARAMS order — must match the flattener in
//! src/gen/volumeWasm.ts):
//! 0 terraceStep, 1 wallHeight, 2 wallVar.
//!
//! `palette` layout (spec PALETTE order — must match flattenPalette() in
//! src/gen/mesher.ts): 15 colors x 3 (r, g, b) = 45 f64 values:
//! strata0, strata1, strata2, strata3, strata4, floorA, floorB, cap,
//! crevice, craterIn, craterWall, craterRim, ejecta, crackDeep, crackLip.

use crate::noise::{fbm2, fbm3, ridged2, smoothstep, Noise2, Noise3};
use crate::volume::js_round;
use wasm_bindgen::prelude::*;

/// cave-tint probe march heights above the offset start point (world units)
const CAVE_STEPS: [f64; 4] = [0.55, 1.0, 1.6, 2.4];

/// JS `clamp01` written branch-for-branch (core/noise.ts): NaN falls through
/// both comparisons and returns NaN, same as the JS ternary chain.
#[inline(always)]
fn clamp01(v: f64) -> f64 {
    if v < 0.0 {
        0.0
    } else if v > 1.0 {
        1.0
    } else {
        v
    }
}

/// Plain f64 triple with THREE.Color op semantics: `copy` = assign (Copy),
/// `lerp(o, t)`: each channel += (other - this) * t; `mul(s)`: *= s.
#[derive(Clone, Copy)]
struct Col {
    r: f64,
    g: f64,
    b: f64,
}

impl Col {
    #[inline(always)]
    fn lerp(&mut self, o: Col, t: f64) {
        self.r += (o.r - self.r) * t;
        self.g += (o.g - self.g) * t;
        self.b += (o.b - self.b) * t;
    }

    #[inline(always)]
    fn mul(&mut self, s: f64) {
        self.r *= s;
        self.g *= s;
        self.b *= s;
    }
}

/// mesher.ts `fbm2Cheap`: two raw octaves at fixed scales
#[inline(always)]
fn fbm2_cheap(n2: &Noise2, x: f64, z: f64) -> f64 {
    n2.sample(x * 0.13, z * 0.13) * 0.65 + n2.sample(x * 0.47, z * 0.47) * 0.35
}

#[wasm_bindgen]
pub struct ColorizeResult {
    colors: Vec<f32>,
    facies: Vec<f32>,
}

#[wasm_bindgen]
impl ColorizeResult {
    #[wasm_bindgen(getter)]
    pub fn colors(&self) -> Vec<f32> {
        self.colors.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn facies(&self) -> Vec<f32> {
        self.facies.clone()
    }
}

/// Port of colorizeJs(): one rgb color + one xyz facies triple per vertex
/// (positions.len() / 3 each). Volume grid (`nx/ny/nz/voxel/origin_*`) feeds
/// the cave-tint probe; field grid (`fnx/fnz/fvoxel/forigin_*`) feeds the
/// groundH/s2/crackD bilinear samplers and the craterD nearest sampler.
/// Noise is constructed exactly like NoiseKit::new from `seed`.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn colorize(
    positions: &[f32],
    normals: &[f32],
    data: &[f32],
    nx: u32,
    ny: u32,
    nz: u32,
    voxel: f64,
    origin_x: f64,
    origin_z: f64,
    fnx: u32,
    fnz: u32,
    fvoxel: f64,
    forigin_x: f64,
    forigin_z: f64,
    ground_h: &[f32],
    s2: &[f32],
    crack_d: &[f32],
    crater_d: &[f32],
    params: &[f64],
    palette: &[f64],
    seed: u32,
) -> ColorizeResult {
    let nx = nx as usize;
    let ny = ny as usize;
    let nz = nz as usize;
    let fnx = fnx as usize;
    let fnz = fnz as usize;
    assert_eq!(data.len(), nx * ny * nz, "data length");
    assert_eq!(positions.len(), normals.len(), "positions/normals length");
    let n_col = fnx * fnz;
    assert_eq!(ground_h.len(), n_col, "groundH length");
    assert_eq!(s2.len(), n_col, "s2 length");
    assert_eq!(crack_d.len(), n_col, "crackD length");
    assert_eq!(crater_d.len(), n_col, "craterD length");
    assert!(params.len() >= 3, "params vector too short");
    assert_eq!(palette.len(), 45, "palette length");

    // COLOR PARAMS order — see module doc
    let terrace_step = params[0];
    let wall_height = params[1];
    let wall_var = params[2];

    // PALETTE order — see module doc
    let pc = |k: usize| Col {
        r: palette[k * 3],
        g: palette[k * 3 + 1],
        b: palette[k * 3 + 2],
    };
    let strata = [pc(0), pc(1), pc(2), pc(3), pc(4)];
    let floor_a = pc(5);
    let floor_b = pc(6);
    let cap = pc(7);
    let crevice = pc(8);
    let crater_in = pc(9);
    let crater_wall = pc(10);
    let crater_rim = pc(11);
    let ejecta = pc(12);
    let crack_deep = pc(13);
    let crack_lip = pc(14);

    // same seed derivation as core/noise.ts makeNoise() / lib.rs NoiseKit
    let n2 = Noise2::new(seed ^ 0x2f6_e2b1);
    let n3 = Noise3::new(seed ^ 0x5b7_e4d3);

    // fields.ts `sample()` factory: bilinear over a column grid — floor +
    // clamp base cell to [0, n-2] (JS max(0, min(n-2, floor))), clamp01
    // fractions, lerp x then z
    let sample = |arr: &[f32], x: f64, z: f64| -> f64 {
        let fx = (x - forigin_x) / fvoxel;
        let fz = (z - forigin_z) / fvoxel;
        let x0 = fx.floor().min((fnx - 2) as f64).max(0.0);
        let z0 = fz.floor().min((fnz - 2) as f64).max(0.0);
        let tx = clamp01(fx - x0);
        let tz = clamp01(fz - z0);
        let i00 = z0 as usize * fnx + x0 as usize;
        let a = arr[i00] as f64 + (arr[i00 + 1] as f64 - arr[i00] as f64) * tx;
        let b = arr[i00 + fnx] as f64 + (arr[i00 + fnx + 1] as f64 - arr[i00 + fnx] as f64) * tx;
        a + (b - a) * tz
    };

    // mesher.ts sampleCraterD: NEAREST (js_round + clamp), NOT bilinear
    let sample_crater = |x: f64, z: f64| -> f64 {
        let fx = (x - forigin_x) / fvoxel;
        let fz = (z - forigin_z) / fvoxel;
        let ix = js_round(fx).min((fnx - 1) as f64).max(0.0) as usize;
        let iz = js_round(fz).min((fnz - 1) as f64).max(0.0) as usize;
        crater_d[iz * fnx + ix] as f64
    };

    // mesher.ts plateauWeight(): cap = near own column top AND (deep inside
    // a wall region OR genuinely tall), gated on the column being high
    let plateau_weight = |x: f64, y: f64, z: f64| -> f64 {
        let h_eff = sample(ground_h, x, z).max(y);
        let top = smoothstep(h_eff - 1.7, h_eff - 1.1, y);
        if top <= 0.0 {
            return 0.0;
        }
        let interior = smoothstep(1.1, 1.7, -sample(s2, x, z));
        let tall = smoothstep(wall_height * 0.6, wall_height * 0.8, y);
        let high = interior.max(tall) * smoothstep(wall_height * 0.35, wall_height * 0.5, h_eff);
        top * high
    };

    // rock-overhead probe: js_round volume lookups, bounds compared in f64
    // on the un-cast js_round result, EXACTLY like the JS early returns
    let inv = 1.0 / voxel;
    let bx = nx as f64;
    let by = ny as f64;
    let bz = nz as f64;
    let solid_above = |x: f64, y: f64, z: f64| -> bool {
        let ix = js_round((x - origin_x) * inv);
        if ix < 0.0 || ix >= bx {
            return false;
        }
        let iy = js_round(y * inv);
        if iy < 0.0 || iy >= by {
            return false;
        }
        let iz = js_round((z - origin_z) * inv);
        if iz < 0.0 || iz >= bz {
            return false;
        }
        data[ix as usize + iy as usize * nx + iz as usize * nx * ny] > 0.0
    };

    let count = positions.len() / 3;
    let mut colors = vec![0.0f32; count * 3];
    let mut facies = vec![0.0f32; count * 3];
    // JS: Math.max(0.4, params.terraceStep)
    let strata_step = 0.4f64.max(terrace_step);

    for i in 0..count {
        let x = positions[i * 3] as f64;
        let y = positions[i * 3 + 1] as f64;
        let z = positions[i * 3 + 2] as f64;
        let n_y = normals[i * 3 + 1] as f64;
        let s2v = sample(s2, x, z);

        let dither = fbm3(&n3, x * 0.35, y * 0.5, z * 0.35, 2);
        let dome = fbm2(&n2, x * 0.045 + 11.0, z * 0.045 - 23.0, 3);
        let crater_dist = sample_crater(x, z);
        let cap_w = plateau_weight(x, y, z);
        facies[i * 3] = clamp01((-dome - 0.05) / 0.55) as f32;
        facies[i * 3 + 1] = (1.0 - smoothstep(0.8, 1.02, crater_dist)) as f32;
        facies[i * 3 + 2] = cap_w as f32;

        let mut tmp;
        if n_y < 0.65 {
            // cliff face: quantized strata bands; the index CLAMPS at the
            // top of the dark->light sequence (no wrap)
            let band = ((y + dither * 0.35) / strata_step).floor();
            let bi = band.max(0.0).min(4.0) as usize;
            tmp = strata[bi];
            if band > 4.0 {
                // above the sequence: subtle per-band shade jitter — the JS
                // sin-hash `Math.sin(band * 12.9898) * 43758.5453`; libm sin
                // may differ from V8 by ~1 ULP (see module doc)
                let j = (band * 12.9898).sin() * 43758.5453;
                tmp.mul(0.92 + (j - j.floor()) * 0.12);
            }
            // slight vertical gradient: darker at base
            let base_dark = clamp01(1.0 - y / (wall_height + wall_var));
            tmp.mul(0.95 - base_dark * 0.15 + dither * 0.04);
        } else if cap_w > 0.4 {
            // plateau top
            tmp = cap;
            tmp.lerp(strata[4], clamp01(0.3 + dither * 0.4));
            // sand pockets collect in the dome hollows
            if dome < -0.12 {
                tmp.lerp(floor_a, smoothstep(0.12, 0.5, -dome) * 0.6);
            }
            // drainage lines read darker (desert varnish in the channels)
            let g = ridged2(&n2, x * 0.35 + 7.7, z * 0.35 - 3.1, 2);
            tmp.mul(1.0 - g * g * 0.22 + dither * 0.04);
        } else {
            // canyon floor
            let t = clamp01(0.5 + fbm2_cheap(&n2, x, z) * 0.7);
            tmp = floor_a;
            tmp.lerp(floor_b, t);

            // crater bands: scorched bowl -> rust inner slope -> bleached
            // rim crest -> pale ejecta dust fading out
            let cd = crater_dist;
            if cd < 1.5 {
                let ring = cd + dither * 0.08;
                if ring < 0.85 {
                    let wall_t = smoothstep(0.2, 0.8, ring); // bowl slope band
                    let mut bowl = crater_in;
                    bowl.lerp(crater_wall, wall_t);
                    tmp.lerp(bowl, smoothstep(0.85, 0.45, ring) * 0.8);
                }
                // libm exp may differ from V8 by ~1 ULP (see module doc)
                let crest = (-((ring - 0.92) * (ring - 0.92)) / 0.016).exp();
                tmp.lerp(crater_rim, crest * 0.75);
                if ring > 1.02 {
                    tmp.lerp(ejecta, smoothstep(1.5, 1.05, ring) * 0.3);
                }
            }

            // contact shading at wall bases; up-facing surfaces ON the wall
            // footprint (s2 < 0) darken further toward rock shelf
            let contact = clamp01(1.0 - s2v / 1.6);
            if contact > 0.0 {
                tmp.lerp(crevice, contact * 0.28 + smoothstep(0.0, 0.8, -s2v) * 0.25);
            }
            tmp.mul(1.0 + dither * 0.05);
        }

        // interior surfaces under overhanging rock have no sky above; pull
        // them hard toward the crevice shade. Start point offset along the
        // vertex normal, exactly like the AO bake.
        {
            let px = x + normals[i * 3] as f64 * voxel * 0.8;
            let py = y + n_y * voxel * 0.8;
            let pz = z + normals[i * 3 + 2] as f64 * voxel * 0.8;
            let mut hits = 0u32;
            for s in CAVE_STEPS.iter() {
                if solid_above(px, py + s, pz) {
                    hits += 1;
                }
            }
            if hits > 0 {
                tmp.lerp(crevice, (hits as f64 / CAVE_STEPS.len() as f64) * 0.62);
            }
        }

        // fissure shading (floor AND ridge tops): slot interior falls to
        // near-black, pale weathered lip just outside
        let ck = sample(crack_d, x, z);
        if ck < 1.35 {
            let cr = ck + dither * 0.12;
            tmp.lerp(crack_deep, smoothstep(1.05, 0.3, cr) * 0.88);
            let lip = (-((cr - 1.12) * (cr - 1.12)) / 0.012).exp();
            tmp.lerp(crack_lip, lip * 0.3);
        }

        colors[i * 3] = tmp.r as f32;
        colors[i * 3 + 1] = tmp.g as f32;
        colors[i * 3 + 2] = tmp.b as f32;
    }

    ColorizeResult { colors, facies }
}
