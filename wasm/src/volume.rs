//! Faithful line-by-line port of src/gen/volume.ts `buildDensityVolume()`
//! (stage 2 of the wasm generator move), per the shared ABI spec.
//!
//! Split of responsibilities: this kernel does the per-column
//! rough/band/washGate pass, block classification (incl. the boundary-force
//! rule), op-BOUNDS block forcing, and the full per-voxel fill. Carve-op SDF
//! evaluation stays in JS — the TS caller re-derives per-block op lists from
//! the same bounds math and applies the ops on top of the returned data,
//! which chains identically to the inline evaluation in volume.ts.
//!
//! Determinism contract: all intermediate arithmetic is f64 in the same
//! operation order as the JS; every store into a Float32Array in the JS
//! (rough/bandLo/bandHi/washGate/colLo/colHi and the output data) goes
//! through `as f32` here, and every read back promotes losslessly to f64,
//! exactly like V8's typed-array semantics.

use crate::noise::{fbm2, fbm3, smoothstep, Noise2, Noise3};
use wasm_bindgen::prelude::*;

/// Cubic block edge length, voxels. Must equal 1 << BLOCK_SHIFT.
pub const BLOCK: usize = 4;
#[allow(dead_code)] // mirrors the volume.ts export; BLOCK is used directly here
pub const BLOCK_SHIFT: usize = 2;

pub const BLOCK_AIR: u8 = 0;
pub const BLOCK_SOLID: u8 = 1;
pub const BLOCK_MIXED: u8 = 2;

/// JS `Math.round(x)` == `Math.floor(x + 0.5)` for every finite x (including
/// negative halves: JS rounds half toward +inf). The marched sample indices
/// are clamped to [0, n-1] afterwards, so this is exact.
#[inline(always)]
pub(crate) fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

#[wasm_bindgen]
pub struct VolumeResult {
    data: Vec<f32>,
    block_type: Vec<u8>,
    nbx: u32,
    nby: u32,
    nbz: u32,
    mixed_count: u32,
    solid_count: u32,
}

#[wasm_bindgen]
impl VolumeResult {
    #[wasm_bindgen(getter)]
    pub fn data(&self) -> Vec<f32> {
        self.data.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn block_type(&self) -> Vec<u8> {
        self.block_type.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn nbx(&self) -> u32 {
        self.nbx
    }

    #[wasm_bindgen(getter)]
    pub fn nby(&self) -> u32 {
        self.nby
    }

    #[wasm_bindgen(getter)]
    pub fn nbz(&self) -> u32 {
        self.nbz
    }

    #[wasm_bindgen(getter)]
    pub fn mixed_count(&self) -> u32 {
        self.mixed_count
    }

    #[wasm_bindgen(getter)]
    pub fn solid_count(&self) -> u32 {
        self.solid_count
    }
}

/// Port of buildDensityVolume() minus carve-op SDF evaluation (ops stay in
/// JS); op bounds are still consumed here to force affected blocks MIXED.
///
/// `params` layout (spec PARAMS order):
/// 0 wallNoiseAmp, 1 wallNoiseFreq, 2 ledgeAmp, 3 terraceStep, 4 floorBase,
/// 5 washAmp, 6 washHeight, 7 washCoverage, 8 washScale.
///
/// `op_bounds` is 6 f64 per op: [minX, maxX, minY, maxY, minZ, maxZ].
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn fill_volume(
    seed: u32,
    nx: u32,
    ny: u32,
    nz: u32,
    voxel: f64,
    origin_x: f64,
    origin_z: f64,
    ground_h: &[f32],
    wall_mask: &[f32],
    s2: &[f32],
    params: &[f64],
    op_bounds: &[f64],
    force_all_mixed: bool,
) -> VolumeResult {
    let nx = nx as usize;
    let ny = ny as usize;
    let nz = nz as usize;
    let n_col = nx * nz;
    assert_eq!(ground_h.len(), n_col, "groundH length");
    assert_eq!(wall_mask.len(), n_col, "wallMask length");
    assert_eq!(s2.len(), n_col, "s2 length");
    assert!(params.len() >= 9, "params vector too short");
    assert_eq!(op_bounds.len() % 6, 0, "op_bounds stride");

    // Same seeding scheme as NoiseKit::new / core/noise.ts makeNoise().
    let n2 = Noise2::new(seed ^ 0x2f6_e2b1);
    let n3 = Noise3::new(seed ^ 0x5b7_e4d3);

    let mut data = vec![0.0f32; nx * ny * nz];

    let amp = params[0]; // wallNoiseAmp
    let nf = params[1]; // wallNoiseFreq
    let ledge = params[2]; // ledgeAmp
    let step_h = params[3]; // terraceStep
    // surface can shift by cliff noise + protruding strata ledges
    let influence = amp * 1.6 + ledge + voxel;

    let floor_base = params[4]; // floorBase
    let wash_amp = params[5]; // washAmp
    let wash_h = params[6]; // washHeight
    let wash_coverage = params[7];
    let wash_scale = params[8];
    let wash_on = wash_amp > 0.01 && wash_coverage > 0.01 && wash_h > 0.05;
    // mask threshold: coverage 0 -> nothing, 1 -> almost everywhere
    let wash_thresh = 1.0 - wash_coverage;

    // ---- per-column roughness + surface band + basal wash -------------------
    // Float32Array-backed in the JS: all four arrays round to f32 on store.
    let mut rough = vec![0.0f32; n_col];
    let mut band_lo = vec![0.0f32; n_col];
    let mut band_hi = vec![0.0f32; n_col];
    let mut wash_gate = if wash_on { Some(vec![0.0f32; n_col]) } else { None };
    for iz in 0..nz {
        let z = origin_z + iz as f64 * voxel;
        for ix in 0..nx {
            let col = iz * nx + ix;
            let w = wall_mask[col] as f64;
            // roughness strongest on the cliff flank, none on open floor
            let r = amp * smoothstep(0.03, 0.25, w) * (1.0 - 0.6 * smoothstep(0.85, 1.0, w));
            rough[col] = r as f32;
            let h = ground_h[col] as f64;
            let inf = if r > 0.001 { influence } else { 0.0 };
            let mut lo = h - inf;
            let mut hi = h + inf;

            if let Some(gate) = wash_gate.as_deref_mut() {
                let sc = s2[col] as f64;
                // only columns near/inside a wall face can be washed
                if sc < 0.15 && sc > -(wash_amp + 0.3) {
                    let x = origin_x + ix as f64 * voxel;
                    let mask =
                        0.5 + 0.5 * fbm2(&n2, x * wash_scale + 5.3, z * wash_scale - 9.1, 3);
                    let on = smoothstep(wash_thresh - 0.12, wash_thresh + 0.12, mask);
                    if on > 0.02 {
                        let detail =
                            0.6 + 0.4 * (0.5 + 0.5 * fbm2(&n2, x * 0.33 + 53.1, z * 0.33 - 27.7, 2));
                        let mut g = wash_amp * on * detail;
                        // pierce guard: march inward along -grad(s2); the
                        // most-negative s2 on the ray is this cross-section's
                        // half thickness. Clamp the notch depth to keep a
                        // solid core.
                        let ixm = ix.saturating_sub(1); // Math.max(0, ix - 1)
                        let ixp = (ix + 1).min(nx - 1);
                        let izm = iz.saturating_sub(1);
                        let izp = (iz + 1).min(nz - 1);
                        let mut gx = s2[iz * nx + ixp] as f64 - s2[iz * nx + ixm] as f64;
                        let mut gz = s2[izp * nx + ix] as f64 - s2[izm * nx + ix] as f64;
                        // Math.hypot(gx, gz): f64::hypot is correctly rounded
                        // on this pair in practice, but V8's implementation is
                        // not spec-pinned — a last-ULP difference is
                        // theoretically possible here (it only feeds the march
                        // direction vector; everything else is plain IEEE ops
                        // in identical order).
                        let gl = gx.hypot(gz);
                        if gl > 1e-6 {
                            gx /= gl;
                            gz /= gl;
                            let mut s_min = sc;
                            // must march at least (depth + core) deep
                            let reach = g + 0.9;
                            let mut t = voxel;
                            while t <= reach {
                                let sx_f = js_round(ix as f64 - (gx * t) / voxel);
                                let sz_f = js_round(iz as f64 - (gz * t) / voxel);
                                // JS: Math.max(0, Math.min(n - 1, round))
                                let sx = sx_f.min((nx - 1) as f64).max(0.0) as usize;
                                let sz = sz_f.min((nz - 1) as f64).max(0.0) as usize;
                                let sv = s2[sz * nx + sx] as f64;
                                if sv < s_min {
                                    s_min = sv;
                                }
                                t += voxel;
                            }
                            g = g.min(-s_min - 0.8);
                        }
                        if g > 0.02 {
                            gate[col] = g as f32;
                            // the wash can flip signs anywhere in the basal band
                            lo = lo.min(floor_base);
                            hi = hi.max(floor_base + wash_h + 0.1);
                        }
                    }
                }
            }
            band_lo[col] = lo as f32;
            band_hi[col] = hi as f32;
        }
    }

    // ---- block classification ------------------------------------------------
    let nbx = nx.div_ceil(BLOCK);
    let nby = ny.div_ceil(BLOCK);
    let nbz = nz.div_ceil(BLOCK);
    let mut block_type = vec![0u8; nbx * nby * nbz];

    // band extremes per block column, over a footprint padded by 1 voxel
    // (Float32Array in the JS; +/-Infinity round-trips through f32 exactly)
    let mut col_lo = vec![0.0f32; nbx * nbz];
    let mut col_hi = vec![0.0f32; nbx * nbz];
    for bz in 0..nbz {
        let z0 = (bz * BLOCK).saturating_sub(1); // Math.max(0, bz*BLOCK - 1)
        let z1 = (nz - 1).min(bz * BLOCK + BLOCK);
        for bx in 0..nbx {
            let x0 = (bx * BLOCK).saturating_sub(1);
            let x1 = (nx - 1).min(bx * BLOCK + BLOCK);
            let mut lo = f64::INFINITY;
            let mut hi = f64::NEG_INFINITY;
            for iz in z0..=z1 {
                let row = iz * nx;
                for ix in x0..=x1 {
                    if (band_lo[row + ix] as f64) < lo {
                        lo = band_lo[row + ix] as f64;
                    }
                    if (band_hi[row + ix] as f64) > hi {
                        hi = band_hi[row + ix] as f64;
                    }
                }
            }
            col_lo[bz * nbx + bx] = lo as f32;
            col_hi[bz * nbx + bx] = hi as f32;
        }
    }

    for bz in 0..nbz {
        for by in 0..nby {
            // y range padded by 1 voxel, same reasoning as the footprint pad
            let y_lo = (by * BLOCK) as f64 - 1.0;
            let y_lo = y_lo * voxel;
            let y_hi = (by * BLOCK + BLOCK) as f64 * voxel;
            for bx in 0..nbx {
                let t: u8;
                if force_all_mixed {
                    t = BLOCK_MIXED;
                } else {
                    let lo = col_lo[bz * nbx + bx] as f64;
                    let hi = col_hi[bz * nbx + bx] as f64;
                    let mut tt = if y_lo > hi {
                        BLOCK_AIR
                    } else if y_hi < lo {
                        BLOCK_SOLID
                    } else {
                        BLOCK_MIXED
                    };
                    // The volume boundary is forced air (closed diorama
                    // skirt), which the band doesn't know about: a would-be
                    // SOLID block whose PADDED range reaches the forced-air
                    // shell must be evaluated per voxel.
                    if tt == BLOCK_SOLID
                        && (bx == 0
                            || bx * BLOCK + BLOCK >= nx - 1
                            || bz == 0
                            || bz * BLOCK + BLOCK >= nz - 1
                            || by * BLOCK + BLOCK >= ny - 1)
                    {
                        tt = BLOCK_MIXED;
                    }
                    t = tt;
                }
                block_type[(bz * nby + by) * nbx + bx] = t;
            }
        }
    }

    // ---- carve ops: force affected blocks MIXED -------------------------------
    // Only the block forcing half of the volume.ts op loop lives here; the
    // per-block op LISTS (and sdf evaluation) are rebuilt on the JS side from
    // the exact same bounds math.
    let n_ops = op_bounds.len() / 6;
    for oi in 0..n_ops {
        let b = &op_bounds[oi * 6..oi * 6 + 6];
        let (min_x, max_x, min_y, max_y, min_z, max_z) = (b[0], b[1], b[2], b[3], b[4], b[5]);
        let blk = BLOCK as f64;
        let bx0 = (((min_x - origin_x) / voxel - blk) / blk).ceil().max(0.0) as i64;
        let bx1 = (((max_x - origin_x) / voxel + 1.0) / blk).floor().min((nbx - 1) as f64) as i64;
        let by0 = ((min_y / voxel - blk) / blk).ceil().max(0.0) as i64;
        let by1 = ((max_y / voxel + 1.0) / blk).floor().min((nby - 1) as f64) as i64;
        let bz0 = (((min_z - origin_z) / voxel - blk) / blk).ceil().max(0.0) as i64;
        let bz1 = (((max_z - origin_z) / voxel + 1.0) / blk).floor().min((nbz - 1) as f64) as i64;
        for bz in bz0..=bz1 {
            for by in by0..=by1 {
                for bx in bx0..=bx1 {
                    let bi = (bz as usize * nby + by as usize) * nbx + bx as usize;
                    block_type[bi] = BLOCK_MIXED;
                }
            }
        }
    }

    // counts tallied AFTER op forcing, like the JS
    let mut mixed_count = 0u32;
    let mut solid_count = 0u32;
    for &t in &block_type {
        if t == BLOCK_MIXED {
            mixed_count += 1;
        } else if t == BLOCK_SOLID {
            solid_count += 1;
        }
    }

    // ---- fill ------------------------------------------------------------------
    let stride_z = nx * ny;
    for bz in 0..nbz {
        let z0 = bz * BLOCK;
        let z_end = (z0 + BLOCK).min(nz);
        for by in 0..nby {
            let y0 = by * BLOCK;
            let y_end = (y0 + BLOCK).min(ny);
            for bx in 0..nbx {
                let t = block_type[(bz * nby + by) * nbx + bx];
                if t == BLOCK_AIR {
                    continue; // zero-init reads as air
                }
                let x0 = bx * BLOCK;
                let x_end = (x0 + BLOCK).min(nx);
                if t == BLOCK_SOLID {
                    for iz in z0..z_end {
                        for iy in y0..y_end {
                            let row = iy * nx + iz * stride_z;
                            data[row + x0..row + x_end].fill(1.0);
                        }
                    }
                    continue;
                }
                // MIXED: true density, identical math to the classic dense
                // fill (carve ops excepted — applied in the JS post-pass)
                for iz in z0..z_end {
                    let z = origin_z + iz as f64 * voxel;
                    let edge_z = iz == 0 || iz == nz - 1;
                    for ix in x0..x_end {
                        let col = iz * nx + ix;
                        let x = origin_x + ix as f64 * voxel;
                        let h = ground_h[col] as f64;
                        let r = rough[col] as f64;
                        let edge = edge_z || ix == 0 || ix == nx - 1;
                        // per-band phase jitter — SAME formula as the
                        // heightfield terracing in fields.ts
                        let tj = if ledge > 0.005 && r > 0.001 {
                            fbm2(&n2, x * 0.06 + 3.3, z * 0.06 - 6.1, 2) * step_h * 0.6
                        } else {
                            0.0
                        };
                        for iy in y0..y_end {
                            let idx = ix + iy * nx + iz * stride_z;
                            if edge || iy == ny - 1 {
                                data[idx] = -1.0; // forced air -> closed skirt
                                continue;
                            }
                            let y = iy as f64 * voxel;
                            let mut d = h - y;
                            if r > 0.001 && d.abs() < influence {
                                d += fbm3(&n3, x * nf, y * nf * 0.7, z * nf, 3) * r;
                                // strata ledges: caprock protrudes, soft
                                // layer recesses -> benches with overhang lips
                                if ledge > 0.005 && step_h > 0.01 {
                                    let p = (y + tj) / step_h;
                                    let fr = p - p.floor();
                                    let cap = smoothstep(0.3, 0.56, fr);
                                    d += ledge * (cap - 0.5) * (r / amp);
                                }
                            }
                            if let Some(gate) = wash_gate.as_deref() {
                                let g = gate[col] as f64;
                                if g > 0.02 && y > floor_base && y < floor_base + wash_h {
                                    // sqrt profile: deepest at the floor,
                                    // vertical tangent at the top; the -0.04
                                    // erosion trims sub-voxel hairlines
                                    let fall = 1.0 - (y - floor_base) / wash_h;
                                    let cut = (g * fall.sqrt() + s2[col] as f64)
                                        .min(y - floor_base)
                                        .min(0.02 - s2[col] as f64)
                                        - 0.04;
                                    d = d.min(-cut);
                                }
                            }
                            data[idx] = d as f32;
                        }
                    }
                }
            }
        }
    }

    VolumeResult {
        data,
        block_type,
        nbx: nbx as u32,
        nby: nby as u32,
        nbz: nbz as u32,
        mixed_count,
        solid_count,
    }
}
