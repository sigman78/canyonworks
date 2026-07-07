//! Faithful port of src/gen/surfacenets.ts `surfaceNets()`. The wasm path
//! always has block info, so the `blocks?` parameter of the JS is a required
//! argument here (folded into `VolDims`). Consumed only by the fused pipeline
//! (pipeline.rs) — the old per-stage wasm export is gone; the typed
//! `surface_nets` below is the crate's library face for this stage.
//!
//! Surface nets stays SEQUENTIAL by design: vertex indices are allocated in
//! cell-visit order and the index stream references earlier cells, so the
//! loop is order-dependent and must not go through par.rs.
//!
//! Determinism contract (Gate 5): deterministic f32, same expressions, same
//! cell-visit order; the JS fallback is visually equivalent, not bitwise.
//! - The build buffer is a Vec<Vec3> — f32 lanes since Gate 5 (the JS built
//!   a number[] and rounded at return; byte-parity is retired). diag_sq()/
//!   push_tri() read that build buffer directly, so the diagonal tie-break
//!   and the degenerate test compare in f32 — still deterministic.
//! - The corner buffer `g` is f32 slots exactly like the JS Float32Array;
//!   the crossing parameter t = da/(da - db) is computed in f32 straight
//!   from those slots (same expression, narrower lanes).
//! - Cells are visited z -> y -> xRun (+= BLOCK, skipping non-MIXED blocks)
//!   -> x, identical to the JS, so the vertex/index streams line up
//!   run-to-run for a given seed.

use crate::grid::VolDims;
use crate::math::{idx3, vec3, Vec3};
use crate::volume::{BLOCK, BLOCK_MIXED, BLOCK_SHIFT};

// 12 cube edges as corner-index pairs; corner i offset = (i&1, (i>>1)&1, (i>>2)&1)
const EDGES: [(usize, usize); 12] = [
    (0, 1), (2, 3), (4, 5), (6, 7), // along x
    (0, 2), (1, 3), (4, 6), (5, 7), // along y
    (0, 4), (1, 5), (2, 6), (3, 7), // along z
];

/// Typed output of `surface_nets`: one `[f32; 3]` slot per vertex plus the
/// triangle index stream, owned Vecs the pipeline consumes in place.
pub struct SurfaceMesh {
    pub vertices: Vec<[f32; 3]>,
    pub indices: Vec<u32>,
}

/// Port of surfaceNets(): one vertex per sign-crossing cell (centroid of
/// edge intersections), quads (as triangle pairs) across every sign-changing
/// grid edge. Convention: density > 0 is solid rock, <= 0 is air.
///
/// `origin_y` is separate from `dims` because the volume's world mapping has
/// no y origin (it starts at y = 0) — the mesher has always passed 0 here.
/// f32 like the rest of the world mapping (Gate 5); the caller narrows any
/// boundary f64 once at its own entry.
pub fn surface_nets(data: &[f32], block_type: &[u8], dims: &VolDims, origin_y: f32) -> SurfaceMesh {
    let (nx, ny, nz) = (dims.n.x, dims.n.y, dims.n.z);
    let voxel = dims.voxel;
    assert_eq!(data.len(), dims.n.count(), "data length");
    assert!(block_type.len() >= dims.nb.count(), "blockType length");
    // degenerate grid: the JS loops simply don't run (guards the usize n-1)
    if nx < 2 || ny < 2 || nz < 2 {
        return SurfaceMesh { vertices: Vec::new(), indices: Vec::new() };
    }

    // build buffer (f32 lanes since Gate 5) — tie-break/degeneracy tests read
    // it before the vertices Vec is materialized
    let mut positions: Vec<Vec3> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut cell_idx = vec![-1i32; dims.n.count()];
    let mut g = [0.0f32; 8]; // Float32Array(8) in the JS
    let stride_y = nx;
    let stride_z = nx * ny;
    let steps = [1usize, stride_y, stride_z];
    // the volume's world origin (y is the caller's origin_y, always 0 today)
    let origin = dims.origin.with_y(origin_y);

    // Cells are visited in the same global z -> y -> x order as the JS;
    // skipped runs are provably crossing-free, so the emitted vertex/index
    // streams are identical with or without the block skip.
    for z in 0..nz - 1 {
        for y in 0..ny - 1 {
            // block row base — dims.block_idx with bx = 0, y/z part hoisted
            let block_row = dims.block_idx(idx3(0, y >> BLOCK_SHIFT, z >> BLOCK_SHIFT));
            let mut x_run = 0usize;
            while x_run < nx - 1 {
                if block_type[block_row + (x_run >> BLOCK_SHIFT)] != BLOCK_MIXED {
                    x_run += BLOCK;
                    continue;
                }
                let x_end = (x_run + BLOCK).min(nx - 1);
                for x in x_run..x_end {
                    let base = dims.idx(idx3(x, y, z));
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
                    let mut v = Vec3::default();
                    let mut count = 0u32;
                    for &(a, b) in EDGES.iter() {
                        let in_a = (mask >> a) & 1;
                        let in_b = (mask >> b) & 1;
                        if in_a == in_b {
                            continue;
                        }
                        // crossing parameter straight from the f32 corner
                        // slots — same da/(da - db) expression, f32 lanes
                        let da = g[a];
                        let db = g[b];
                        let mut t = da / (da - db);
                        if !t.is_finite() {
                            t = 0.5;
                        }
                        // per lane: `va += ca + (cb - ca) * t` — the JS += lines,
                        // grouped (component-wise, order-safe)
                        let ca = corner(a);
                        let cb = corner(b);
                        v = v + (ca + (cb - ca) * t);
                        count += 1;
                    }
                    // JS `vx /= count` per lane: kept as DIVISION — a grouped
                    // reciprocal-multiply (v * (1/count)) would round differently
                    let cf = count as f32;
                    let v = vec3(v.x / cf, v.y / cf, v.z / cf);

                    cell_idx[base] = positions.len() as i32;
                    // world position: `origin + (cell + v) * voxel` per axis —
                    // the same per-lane expression the scalar spelling had
                    // (component-wise grouping, order-safe)
                    let cell = vec3(x as f32, y as f32, z as f32);
                    positions.push(origin + (cell + v) * voxel);

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

    SurfaceMesh {
        // the build buffer is already f32 lanes — this is a plain repack
        // into the `[f32; 3]` slots the pipeline consumes
        vertices: positions.iter().map(|p| p.to_f32()).collect(),
        indices,
    }
}

/// Cell-corner offset of corner index i: (i&1, (i>>1)&1, (i>>2)&1).
#[inline(always)]
fn corner(i: usize) -> Vec3 {
    vec3((i & 1) as f32, ((i >> 1) & 1) as f32, ((i >> 2) & 1) as f32)
}

/// squared length of the diagonal a-b on the build buffer (`dot(self)` is
/// the same left-assoc dx*dx + dy*dy + dz*dz sum; the tie-break compares in
/// f32 since Gate 5 — still deterministic)
#[inline(always)]
fn diag_sq(pos: &[Vec3], a: usize, b: usize) -> f32 {
    let d = pos[a] - pos[b];
    d.dot(d)
}

/// emit a triangle unless it is (near-)degenerate — cross-product test on
/// the build buffer, same 1e-10 epsilon as the JS, compared in f32 since
/// Gate 5 (`Vec3::cross` spells the exact component order the scalar code
/// used)
#[inline(always)]
fn push_tri(pos: &[Vec3], indices: &mut Vec<u32>, a: usize, b: usize, c: usize) {
    if a == b || b == c || a == c {
        return;
    }
    let ab = pos[b] - pos[a];
    let ac = pos[c] - pos[a];
    let n = ab.cross(ac);
    if n.dot(n) < 1e-10 {
        return;
    }
    indices.push(a as u32);
    indices.push(b as u32);
    indices.push(c as u32);
}
