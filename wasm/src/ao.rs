//! Faithful port of src/gen/mesher.ts `bakeAo()` (stage 4 of the wasm
//! generator move): per-vertex AO sampled straight from the density volume —
//! short rays fanned around the vertex normal, first solid hit occludes by
//! distance weight.
//!
//! Determinism contract:
//! - Position/normal reads are f32 promoted to f64 (exactly what
//!   BufferAttribute.getX returns from a Float32Array-backed attribute); all
//!   subsequent math is f64 in JS operator order.
//! - The lone caveat: the JS normalizes each bent ray with the THREE-argument
//!   Math.hypot. V8's hypot is NOT the naive sqrt of the sum of squares, so
//!   the `(dx*dx + dy*dy + dz*dz).sqrt()` used here may differ by one ULP —
//!   enough to flip a probe voxel when a marched sample lands exactly on a
//!   Math.round boundary. Expected parity: near-zero diff count, not
//!   guaranteed zero (the aoParity harness measures it).

use crate::volume::js_round;
use wasm_bindgen::prelude::*;

/// march distances (world units) and how much a first hit there occludes
const AO_RADII: [f64; 4] = [0.5, 1.1, 2.2, 4.0];
const AO_HIT: [f64; 4] = [1.0, 0.7, 0.45, 0.25];

/// ray fan: 8 cube corners + 4 horizontal compass dirs — built in the EXACT
/// order of the mesher.ts AO_DIRS IIFE: dx outer over [-1, 1], then dy, dz
/// inner, each component × (1/sqrt(3)) computed in f64; then the 4 compass
/// directions.
fn ao_dirs() -> [[f64; 3]; 12] {
    let s = 1.0 / 3.0f64.sqrt();
    let mut dirs = [[0.0f64; 3]; 12];
    let mut i = 0;
    for dx in [-1.0f64, 1.0] {
        for dy in [-1.0f64, 1.0] {
            for dz in [-1.0f64, 1.0] {
                dirs[i] = [dx * s, dy * s, dz * s];
                i += 1;
            }
        }
    }
    dirs[8] = [1.0, 0.0, 0.0];
    dirs[9] = [-1.0, 0.0, 0.0];
    dirs[10] = [0.0, 0.0, 1.0];
    dirs[11] = [0.0, 0.0, -1.0];
    dirs
}

/// Port of bakeAo(): one AO value per vertex (positions.len() / 3). Rays
/// start just off the surface along the vertex normal, get bent mildly
/// toward the normal, and march AO_RADII; the first solid hit adds its
/// AO_HIT weight. ao = 1 - occ / 12.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn bake_ao(
    positions: &[f32],
    normals: &[f32],
    data: &[f32],
    nx: u32,
    ny: u32,
    nz: u32,
    voxel: f64,
    origin_x: f64,
    origin_z: f64,
) -> Vec<f32> {
    let nx = nx as usize;
    let ny = ny as usize;
    let nz = nz as usize;
    assert_eq!(data.len(), nx * ny * nz, "data length");
    assert_eq!(positions.len(), normals.len(), "positions/normals length");
    let count = positions.len() / 3;
    let mut ao = vec![0.0f32; count];
    let inv = 1.0 / voxel;
    let dirs = ao_dirs();

    // bounds compared in f64 on the un-cast js_round result, EXACTLY like
    // the JS `if (ix < 0 || ix >= nx) return false` — reject before indexing
    let fx = nx as f64;
    let fy = ny as f64;
    let fz = nz as f64;
    let solid = |x: f64, y: f64, z: f64| -> bool {
        let ix = js_round((x - origin_x) * inv);
        if ix < 0.0 || ix >= fx {
            return false;
        }
        let iy = js_round(y * inv);
        if iy < 0.0 || iy >= fy {
            return false;
        }
        let iz = js_round((z - origin_z) * inv);
        if iz < 0.0 || iz >= fz {
            return false;
        }
        data[ix as usize + iy as usize * nx + iz as usize * nx * ny] > 0.0
    };

    for i in 0..count {
        let vnx = normals[i * 3] as f64;
        let vny = normals[i * 3 + 1] as f64;
        let vnz = normals[i * 3 + 2] as f64;
        // start just off the surface so rays don't self-intersect;
        // JS operator order: pos + ((vnx * voxel) * 0.8)
        let px = positions[i * 3] as f64 + vnx * voxel * 0.8;
        let py = positions[i * 3 + 1] as f64 + vny * voxel * 0.8;
        let pz = positions[i * 3 + 2] as f64 + vnz * voxel * 0.8;

        let mut occ = 0.0f64;
        for d in dirs.iter() {
            // bend the fan only mildly toward the normal: rays hug the
            // surface, so nearby walls / pit sides actually get hit (a
            // strongly biased fan escapes upward and bakes ~1 everywhere)
            let mut dx = d[0] + vnx * 0.6;
            let mut dy = d[1] + vny * 0.6;
            let mut dz = d[2] + vnz * 0.6;
            // JS: 1 / Math.hypot(dx, dy, dz) — see the module doc's hypot
            // note; this sqrt-of-sum may differ from V8's hypot by one ULP.
            let il = 1.0 / (dx * dx + dy * dy + dz * dz).sqrt();
            dx *= il;
            dy *= il;
            dz *= il;
            for (rr, hit) in AO_RADII.iter().zip(AO_HIT.iter()) {
                if solid(px + dx * rr, py + dy * rr, pz + dz * rr) {
                    occ += hit;
                    break;
                }
            }
        }
        ao[i] = (1.0 - occ / 12.0) as f32;
    }

    ao
}
