//! Faithful ports of two fields-builder kernels (stage 6 of the wasm
//! generator move): src/gen/sdf2d.ts `signedDistance()` (Felzenszwalb &
//! Huttenlocher exact squared EDT + signed combine) and the per-column
//! ground-profile loop of src/gen/fields.ts `buildFields()` step 7
//! (`fieldsProfileJs()` on the TS side).
//!
//! Everything AROUND these two kernels stays in TypeScript: hex-grid
//! rasterization, crater/crack placement (RNG walks), hexFlat, the
//! flattenW box blurs and mesaOffsets. The `* voxel` scaling of the SDF
//! also stays in the TS caller (buildFields step 2) — `signed_distance`
//! returns CELL units exactly like sdf2d.ts.
//!
//! Determinism contract:
//! - All intermediate arithmetic is f64 in the same operation order as the
//!   JS; f32 input reads (s2/crackD/flattenW/mesaOff) promote losslessly to
//!   f64 like V8 typed-array reads; groundH/wallMask/craterD stores go
//!   through `as f32`. `max_h` is tracked on the f64 `h` AFTER the 0.15
//!   clamp — the JS compares the f64 `h`, not the f32 store.
//! - The EDT is pure f64 add/mul/div/sqrt in identical order (INF = 1e10),
//!   so `signed_distance` is expected bit-identical to the JS.
//!
//! KNOWN NON-EXACTNESS: the crater bowl/rim math uses `Math.cos`/`Math.exp`
//! and the talus term uses `Math.exp`. V8's transcendentals are not
//! bit-identical to Rust's libm — either may differ by ~1 ULP (same caveat
//! as wasm/src/colorize.rs). `Math.sqrt` is IEEE-exact and contributes
//! nothing. Parity for `fields_profile` is therefore NEAR-or-exactly
//! identical: the fieldsParity harness (src/core/wasmGen.ts) may report a
//! nonzero exactDiff, but maxDiff must stay tiny (< 1e-5 world units).
//!
//! `params` layout (FIELDS PARAMS order — must match the flattener in
//! src/gen/volumeWasm.ts):
//! 0 ridgeFreq, 1 ridgeAmp, 2 floorBase, 3 floorFreq, 4 floorAmp,
//! 5 talusAmp, 6 talusFall, 7 wallThickness, 8 wallHeight, 9 wallFreq,
//! 10 wallVar, 11 terraceStep, 12 terraceAmt, 13 terraceSharp,
//! 14 crackDepth.
//!
//! `craters` is 4 f64 per crater: [x, z, r, depth].

use crate::noise::{clamp01, fbm2, lerp, ridged2, smoothstep, Noise2};
use wasm_bindgen::prelude::*;

const INF: f64 = 1e10;

/// sdf2d.ts `dt1d`: 1D squared-distance lower envelope. Integer indices are
/// exact in f64 (grid dims << 2^26), so every expression matches the JS
/// bit-for-bit.
fn dt1d(f: &[f64], n: usize, d: &mut [f64], v: &mut [i32], z: &mut [f64]) {
    let mut k = 0usize;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for q in 1..n {
        let qf = q as f64;
        let vk = v[k] as f64;
        let mut s = (f[q] + qf * qf - (f[v[k] as usize] + vk * vk)) / (2.0 * qf - 2.0 * vk);
        while s <= z[k] {
            k -= 1;
            let vk = v[k] as f64;
            s = (f[q] + qf * qf - (f[v[k] as usize] + vk * vk)) / (2.0 * qf - 2.0 * vk);
        }
        k += 1;
        v[k] = q as i32;
        z[k] = s;
        z[k + 1] = INF;
    }
    k = 0;
    for q in 0..n {
        while z[k + 1] < q as f64 {
            k += 1;
        }
        let dq = q as f64 - v[k] as f64;
        d[q] = dq * dq + f[v[k] as usize];
    }
}

/// sdf2d.ts `edtSq`: squared distance (in cells) to the nearest cell where
/// mask[i] == value; columns pass then rows pass, same scratch reuse.
fn edt_sq(mask: &[u8], w: usize, h: usize, value: u8) -> Vec<f64> {
    let n = w * h;
    let mut out = vec![0.0f64; n];
    for i in 0..n {
        out[i] = if mask[i] == value { 0.0 } else { INF };
    }

    let max_dim = w.max(h);
    let mut f = vec![0.0f64; max_dim];
    let mut d = vec![0.0f64; max_dim];
    let mut v = vec![0i32; max_dim];
    let mut z = vec![0.0f64; max_dim + 1];

    // columns
    for x in 0..w {
        for y in 0..h {
            f[y] = out[y * w + x];
        }
        dt1d(&f, h, &mut d, &mut v, &mut z);
        for y in 0..h {
            out[y * w + x] = d[y];
        }
    }
    // rows
    for y in 0..h {
        f[..w].copy_from_slice(&out[y * w..y * w + w]);
        dt1d(&f, w, &mut d, &mut v, &mut z);
        d[..w].iter().enumerate().for_each(|(x, &dv)| out[y * w + x] = dv);
    }
    out
}

/// Port of sdf2d.ts `signedDistance()`: signed distance in CELL units,
/// positive inside the open region, negative inside walls. The `* voxel`
/// world-unit scaling happens in the TS caller (fields.ts step 2), NOT here.
/// Expected bit-identical to the JS (sqrt is IEEE-exact).
#[wasm_bindgen]
pub fn signed_distance(open_raster: &[u8], nx: u32, nz: u32) -> Vec<f32> {
    let w = nx as usize;
    let h = nz as usize;
    let n = w * h;
    assert_eq!(open_raster.len(), n, "openRaster length");

    let d_to_wall = edt_sq(open_raster, w, h, 0);
    let d_to_open = edt_sq(open_raster, w, h, 1);
    let mut out = vec![0.0f32; n];
    for i in 0..n {
        out[i] = (d_to_wall[i].sqrt() - d_to_open[i].sqrt()) as f32;
    }
    out
}

/// fields.ts `terrace()`: quantize into flat treads with risers of
/// half-width `riser_hw` (JS default 0.25 — pass it explicitly).
#[inline(always)]
fn terrace(h: f64, step: f64, riser_hw: f64) -> f64 {
    if step <= 0.01 {
        return h;
    }
    let k = h / step;
    let f = k.floor();
    let frac = k - f;
    let s = smoothstep(0.5 - riser_hw, 0.5 + riser_hw, frac);
    (f + s) * step
}

/// fields.ts `bandWeight()`: strongest terracing mid-flank
#[inline(always)]
fn band_weight(w: f64) -> f64 {
    clamp01(4.0 * w * (1.0 - w))
}

/// fields.ts `stepWeight()`: wide flank window for the stepped look
#[inline(always)]
fn step_weight(w: f64) -> f64 {
    smoothstep(0.02, 0.14, w) * (1.0 - smoothstep(0.86, 1.0, w))
}

/// fields.ts `easeWall()`: steep base rise easing into the top
#[inline(always)]
fn ease_wall(w: f64) -> f64 {
    1.0 - (1.0 - w) * (1.0 - w)
}

#[wasm_bindgen]
pub struct FieldsProfileResult {
    ground_h: Vec<f32>,
    wall_mask: Vec<f32>,
    crater_d: Vec<f32>,
    max_h: f64,
}

#[wasm_bindgen]
impl FieldsProfileResult {
    #[wasm_bindgen(getter)]
    pub fn ground_h(&self) -> Vec<f32> {
        self.ground_h.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn wall_mask(&self) -> Vec<f32> {
        self.wall_mask.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn crater_d(&self) -> Vec<f32> {
        self.crater_d.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn max_h(&self) -> f64 {
        self.max_h
    }
}

/// Port of the fields.ts step-7 per-column ground-profile loop
/// (`fieldsProfileJs` on the TS side): floor noise + crater bowls/rims +
/// talus + wall profile (plateau quantization, per-mesa offset, doming,
/// terraced strata, gullies) + hex flattening + fissure carving.
///
/// Inputs: `s2` is the signed distance ALREADY scaled to world units by the
/// caller; `craters` is 4-stride [x, z, r, depth]; `params` uses the FIELDS
/// PARAMS order in the module doc. The loop only uses the 2D noise channel:
/// `Noise2::new(seed ^ 0x2f6e2b1)`, the same derivation as NoiseKit.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn fields_profile(
    nx: u32,
    nz: u32,
    voxel: f64,
    origin_x: f64,
    origin_z: f64,
    s2: &[f32],
    crack_d: &[f32],
    flatten_w: &[f32],
    flat_raw: &[u8],
    mesa_off: &[f32],
    craters: &[f64],
    params: &[f64],
    seed: u32,
) -> FieldsProfileResult {
    let nx = nx as usize;
    let nz = nz as usize;
    let n = nx * nz;
    assert_eq!(s2.len(), n, "s2 length");
    assert_eq!(crack_d.len(), n, "crackD length");
    assert_eq!(flatten_w.len(), n, "flattenW length");
    assert_eq!(flat_raw.len(), n, "flatRaw length");
    assert_eq!(mesa_off.len(), n, "mesaOff length");
    assert_eq!(craters.len() % 4, 0, "craters stride");
    assert!(params.len() >= 15, "params vector too short");

    // FIELDS PARAMS order — see module doc
    let ridge_freq = params[0];
    let ridge_amp = params[1];
    let floor_base = params[2];
    let floor_freq = params[3];
    let floor_amp = params[4];
    let talus_amp = params[5];
    let talus_fall = params[6];
    let wall_thickness = params[7];
    let wall_height = params[8];
    let wall_freq = params[9];
    let wall_var = params[10];
    let terrace_step = params[11];
    let terrace_amt = params[12];
    let terrace_sharp = params[13];
    let crack_depth = params[14];

    // same seed derivation as core/noise.ts makeNoise() / lib.rs NoiseKit;
    // the profile loop only ever touches the 2D channel
    let n2 = Noise2::new(seed ^ 0x2f6_e2b1);

    let mut ground_h = vec![0.0f32; n];
    let mut wall_mask = vec![0.0f32; n];
    let mut crater_d_out = vec![9.0f32; n];
    let mut max_h = 0.0f64;

    for iz in 0..nz {
        let z = origin_z + iz as f64 * voxel;
        for ix in 0..nx {
            let i = iz * nx + ix;
            let x = origin_x + ix as f64 * voxel;

            // perturb boundary for wavy walls / buttresses
            let ridge = fbm2(&n2, x * ridge_freq, z * ridge_freq, 3) * ridge_amp;
            let sd = s2[i] as f64 + ridge;

            // floor
            let mut floor_h =
                floor_base + fbm2(&n2, x * floor_freq, z * floor_freq, 4) * floor_amp;

            // craters dent the floor: compact bowl + tall rim crest
            let mut d_min = 9.0f64;
            let mut ci = 0;
            while ci < craters.len() {
                let cx = craters[ci];
                let cz = craters[ci + 1];
                let cr = craters[ci + 2];
                let cdepth = craters[ci + 3];
                ci += 4;
                let dx = x - cx;
                let dz = z - cz;
                let dd = dx * dx + dz * dz;
                if dd > cr * cr * 2.25 {
                    continue;
                }
                let d = dd.sqrt() / cr;
                if d < d_min {
                    d_min = d;
                }
                if d < 0.8 {
                    // libm cos may differ from V8 by ~1 ULP (see module doc)
                    floor_h -= cdepth * (0.5 + 0.5 * ((std::f64::consts::PI * d) / 0.8).cos());
                }
                if d < 1.25 {
                    // libm exp may differ from V8 by ~1 ULP (see module doc)
                    floor_h += cdepth * 0.7 * (-((d - 0.85) * (d - 0.85)) / 0.009).exp();
                }
            }
            crater_d_out[i] = d_min as f32;

            // talus rise near the wall base (exp: same ~1 ULP caveat)
            if sd > 0.0 {
                floor_h += talus_amp * (-sd / talus_fall).exp();
            }

            let mut h: f64;
            let mut w = 0.0f64;
            if sd >= 0.0 {
                h = floor_h;
            } else {
                let depth = -sd;
                w = smoothstep(0.0, wall_thickness, depth);
                let mut wall_h = wall_height
                    + fbm2(&n2, x * wall_freq + 31.7, z * wall_freq - 17.3, 4) * wall_var;
                // plateau-ish tops: gentle quantization of the wall height
                wall_h = lerp(wall_h, terrace(wall_h, terrace_step * 1.6, 0.25), 0.5);
                // per-mesa altitude offset (quantized steps, constant per region)
                wall_h += mesa_off[i] as f64;
                // doming: low-frequency swell fading toward the rim
                let dome = fbm2(&n2, x * 0.045 + 11.0, z * 0.045 - 23.0, 3);
                wall_h += dome * 0.8 * smoothstep(0.55, 0.95, w);

                h = lerp(floor_h + talus_amp, wall_h, ease_wall(w));

                // terraced strata on the flank
                if terrace_amt > 0.0 && w > 0.02 && w < 0.98 {
                    let riser_hw = 0.35 - 0.29 * terrace_sharp;
                    let tj = fbm2(&n2, x * 0.06 + 3.3, z * 0.06 - 6.1, 2) * terrace_step * 0.6;
                    h = lerp(
                        h,
                        terrace(h + tj, terrace_step, riser_hw) - tj,
                        terrace_amt * step_weight(w),
                    );
                }
                // erosion gullies down the flank + drainage channels on top
                let gully = ridged2(&n2, x * 0.35 + 7.7, z * 0.35 - 3.1, 2);
                h -= gully * gully * (0.5 * band_weight(w) + 0.55 * smoothstep(0.6, 0.95, w));
            }

            // enforce the hex-level floor decision
            let fw = flatten_w[i] as f64;
            if fw > 0.002 {
                h += (floor_base - h) * fw;
                w *= 1.0 - fw;
            }

            // fissures: cut AFTER flattening; flat (passable) hexes clip
            let ck = crack_d[i] as f64;
            if ck < 1.3 && flat_raw[i] == 0 {
                let cd = ck + fbm2(&n2, x * 1.1 + 91.3, z * 1.1 - 37.7, 2) * 0.3;
                if cd < 1.0 {
                    let depth = crack_depth * if sd < -0.5 { 1.8 } else { 1.0 };
                    // JS Math.max(0, 1 - cd*cd); operands are finite here so
                    // the branch is behavior-identical
                    let t = 1.0 - cd * cd;
                    h -= depth * (if t > 0.0 { t } else { 0.0 }).sqrt();
                }
            }

            if h < 0.15 {
                h = 0.15;
            }
            ground_h[i] = h as f32;
            wall_mask[i] = w as f32;
            // JS compares the f64 h (post-clamp), NOT the f32 store
            if h > max_h {
                max_h = h;
            }
        }
    }

    FieldsProfileResult {
        ground_h,
        wall_mask,
        crater_d: crater_d_out,
        max_h,
    }
}
