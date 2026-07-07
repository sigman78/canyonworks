//! Faithful port of src/gen/surfacenets.ts `surfaceNets()` (stage 3 of the
//! wasm generator move). The wasm path always has block info, so the
//! `blocks?` parameter of the JS is a required argument here.
//!
//! Determinism contract (the exactness traps, mirroring the JS precisely):
//! - The JS builds `positions` as a number[] — i.e. f64 — and converts to
//!   Float32Array only at return. diagSq()/pushTri() read the UNROUNDED f64
//!   positions during construction (diagonal tie-break + degenerate test).
//!   Ported as a Vec<f64> build buffer, rounded to f32 only at the end.
//! - The corner buffer `g` is a Float32Array in the JS: data (f32) is stored
//!   into f32 slots and promoted to f64 exactly where the centroid math
//!   reads it (`da`/`db`).
//! - Cells are visited z -> y -> xRun (+= BLOCK, skipping non-MIXED blocks)
//!   -> x, identical to the JS, so the vertex/index streams match
//!   byte-for-byte.

use crate::volume::{BLOCK, BLOCK_MIXED, BLOCK_SHIFT};
use wasm_bindgen::prelude::*;

// 12 cube edges as corner-index pairs; corner i offset = (i&1, (i>>1)&1, (i>>2)&1)
const EDGES: [(usize, usize); 12] = [
    (0, 1), (2, 3), (4, 5), (6, 7), // along x
    (0, 2), (1, 3), (4, 6), (5, 7), // along y
    (0, 4), (1, 5), (2, 6), (3, 7), // along z
];

#[wasm_bindgen]
pub struct NetsResult {
    positions: Vec<f32>,
    indices: Vec<u32>,
}

#[wasm_bindgen]
impl NetsResult {
    #[wasm_bindgen(getter)]
    pub fn positions(&self) -> Vec<f32> {
        self.positions.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn indices(&self) -> Vec<u32> {
        self.indices.clone()
    }
}

/// Port of surfaceNets(): one vertex per sign-crossing cell (centroid of
/// edge intersections), quads (as triangle pairs) across every sign-changing
/// grid edge. Convention: density > 0 is solid rock, <= 0 is air.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn surface_nets(
    data: &[f32],
    block_type: &[u8],
    nx: u32,
    ny: u32,
    nz: u32,
    voxel: f64,
    origin_x: f64,
    origin_y: f64,
    origin_z: f64,
    nbx: u32,
    nby: u32,
) -> NetsResult {
    let nx = nx as usize;
    let ny = ny as usize;
    let nz = nz as usize;
    let nbx = nbx as usize;
    let nby = nby as usize;
    assert_eq!(data.len(), nx * ny * nz, "data length");
    assert!(
        block_type.len() >= nbx * nby * nz.div_ceil(BLOCK),
        "blockType length"
    );
    // degenerate grid: the JS loops simply don't run (guards the usize n-1)
    if nx < 2 || ny < 2 || nz < 2 {
        return NetsResult { positions: Vec::new(), indices: Vec::new() };
    }

    // f64 build buffer — the JS number[]; rounded to f32 only at return
    let mut positions: Vec<f64> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut cell_idx = vec![-1i32; nx * ny * nz];
    let mut g = [0.0f32; 8]; // Float32Array(8) in the JS
    let stride_y = nx;
    let stride_z = nx * ny;
    let steps = [1usize, stride_y, stride_z];

    // Cells are visited in the same global z -> y -> x order as the JS;
    // skipped runs are provably crossing-free, so the emitted vertex/index
    // streams are byte-identical either way.
    for z in 0..nz - 1 {
        for y in 0..ny - 1 {
            let block_row = ((z >> BLOCK_SHIFT) * nby + (y >> BLOCK_SHIFT)) * nbx;
            let mut x_run = 0usize;
            while x_run < nx - 1 {
                if block_type[block_row + (x_run >> BLOCK_SHIFT)] != BLOCK_MIXED {
                    x_run += BLOCK;
                    continue;
                }
                let x_end = (x_run + BLOCK).min(nx - 1);
                for x in x_run..x_end {
                    let base = x + y * stride_y + z * stride_z;
                    let mut mask = 0u32;
                    for i in 0..8 {
                        let v = data
                            [base + (i & 1) + ((i >> 1) & 1) * stride_y + ((i >> 2) & 1) * stride_z];
                        g[i] = v;
                        if v > 0.0 {
                            mask |= 1 << i;
                        }
                    }
                    if mask == 0 || mask == 0xff {
                        continue;
                    }

                    // vertex = centroid of edge crossings, in cell-local [0,1]^3
                    let mut vx = 0.0f64;
                    let mut vy = 0.0f64;
                    let mut vz = 0.0f64;
                    let mut count = 0u32;
                    for &(a, b) in EDGES.iter() {
                        let in_a = (mask >> a) & 1;
                        let in_b = (mask >> b) & 1;
                        if in_a == in_b {
                            continue;
                        }
                        // f32 slots promoted to f64 here, exactly like the JS read
                        let da = g[a] as f64;
                        let db = g[b] as f64;
                        let mut t = da / (da - db);
                        if !t.is_finite() {
                            t = 0.5;
                        }
                        let ax = (a & 1) as f64;
                        let ay = ((a >> 1) & 1) as f64;
                        let az = ((a >> 2) & 1) as f64;
                        let bx = (b & 1) as f64;
                        let by = ((b >> 1) & 1) as f64;
                        let bz = ((b >> 2) & 1) as f64;
                        vx += ax + (bx - ax) * t;
                        vy += ay + (by - ay) * t;
                        vz += az + (bz - az) * t;
                        count += 1;
                    }
                    vx /= count as f64;
                    vy /= count as f64;
                    vz /= count as f64;

                    cell_idx[base] = (positions.len() / 3) as i32;
                    positions.push(origin_x + (x as f64 + vx) * voxel);
                    positions.push(origin_y + (y as f64 + vy) * voxel);
                    positions.push(origin_z + (z as f64 + vz) * voxel);

                    // faces: for each axis edge from corner 0, if sign changes,
                    // connect the 4 cells sharing that edge (requires neighbors behind us)
                    let c = [x, y, z];
                    for d in 0..3usize {
                        let s0 = mask & 1;
                        let s1 = (mask >> (1usize << d)) & 1;
                        if s0 == s1 {
                            continue;
                        }
                        let u = (d + 1) % 3;
                        let w = (d + 2) % 3;
                        if c[u] == 0 || c[w] == 0 {
                            continue;
                        }
                        let v0 = cell_idx[base];
                        let v1 = cell_idx[base - steps[u]];
                        let v2 = cell_idx[base - steps[u] - steps[w]];
                        let v3 = cell_idx[base - steps[w]];
                        if v1 < 0 || v2 < 0 || v3 < 0 {
                            continue;
                        }
                        let (v0, v1, v2, v3) =
                            (v0 as usize, v1 as usize, v2 as usize, v3 as usize);
                        // split the quad along its shorter diagonal and drop degenerate
                        // slivers — avoids hairline triangles on near-flat regions
                        if diag_sq(&positions, v0, v2) <= diag_sq(&positions, v1, v3) {
                            if s0 != 0 {
                                push_tri(&positions, &mut indices, v0, v1, v2);
                                push_tri(&positions, &mut indices, v0, v2, v3);
                            } else {
                                push_tri(&positions, &mut indices, v0, v3, v2);
                                push_tri(&positions, &mut indices, v0, v2, v1);
                            }
                        } else if s0 != 0 {
                            push_tri(&positions, &mut indices, v1, v2, v3);
                            push_tri(&positions, &mut indices, v1, v3, v0);
                        } else {
                            push_tri(&positions, &mut indices, v1, v0, v3);
                            push_tri(&positions, &mut indices, v1, v3, v2);
                        }
                    }
                }
                x_run += BLOCK;
            }
        }
    }

    NetsResult {
        // new Float32Array(positions): each f64 rounds to f32 here, and only here
        positions: positions.iter().map(|&p| p as f32).collect(),
        indices,
    }
}

/// squared length of the diagonal a-b, on the UNROUNDED f64 build buffer
#[inline(always)]
fn diag_sq(pos: &[f64], a: usize, b: usize) -> f64 {
    let dx = pos[a * 3] - pos[b * 3];
    let dy = pos[a * 3 + 1] - pos[b * 3 + 1];
    let dz = pos[a * 3 + 2] - pos[b * 3 + 2];
    dx * dx + dy * dy + dz * dz
}

/// emit a triangle unless it is (near-)degenerate — cross-product test on
/// the UNROUNDED f64 build buffer, epsilon identical to the JS
#[inline(always)]
fn push_tri(pos: &[f64], indices: &mut Vec<u32>, a: usize, b: usize, c: usize) {
    if a == b || b == c || a == c {
        return;
    }
    let abx = pos[b * 3] - pos[a * 3];
    let aby = pos[b * 3 + 1] - pos[a * 3 + 1];
    let abz = pos[b * 3 + 2] - pos[a * 3 + 2];
    let acx = pos[c * 3] - pos[a * 3];
    let acy = pos[c * 3 + 1] - pos[a * 3 + 1];
    let acz = pos[c * 3 + 2] - pos[a * 3 + 2];
    let cx = aby * acz - abz * acy;
    let cy = abz * acx - abx * acz;
    let cz = abx * acy - aby * acx;
    if cx * cx + cy * cy + cz * cz < 1e-10 {
        return;
    }
    indices.push(a as u32);
    indices.push(b as u32);
    indices.push(c as u32);
}
