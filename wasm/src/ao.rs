//! Baked ambient occlusion (port of src/gen/mesher.ts `bakeAo()`): per-vertex
//! AO sampled straight from the density volume — short rays fanned around the
//! vertex normal, first solid hit occludes by distance weight. Vertex and
//! normal travel as `math::Vec3`; the fan is `[Vec3; 12]`.
//!
//! Determinism contract (Gate 5): deterministic f32, same expressions in the
//! same operator order (the Vec3 ops are component-wise/order-safe;
//! `Vec3::length` spells the exact sqrt-of-sum-of-squares the scalar code —
//! and the JS Math.hypot port — always used). The JS fallback path is
//! visually equivalent, not bitwise (meshCompare in src/core/wasmGen.ts
//! measures nearness, not identity).

use crate::grid::VolDims;
use crate::math::{vec3, Vec3};
use crate::par;

/// march distances (world units) and how much a first hit there occludes
const AO_RADII: [f32; 4] = [0.5, 1.1, 2.2, 4.0];
const AO_HIT: [f32; 4] = [1.0, 0.7, 0.45, 0.25];

/// ray fan: 8 cube corners + 4 horizontal compass dirs — built in the EXACT
/// order of the mesher.ts AO_DIRS IIFE: dx outer over [-1, 1], then dy, dz
/// inner, each component × (1/sqrt(3)); then the 4 compass directions.
fn ao_dirs() -> [Vec3; 12] {
    let s = 1.0 / 3.0f32.sqrt();
    let mut dirs = [Vec3::default(); 12];
    let mut i = 0;
    for dx in [-1.0f32, 1.0] {
        for dy in [-1.0f32, 1.0] {
            for dz in [-1.0f32, 1.0] {
                dirs[i] = vec3(dx * s, dy * s, dz * s);
                i += 1;
            }
        }
    }
    dirs[8] = vec3(1.0, 0.0, 0.0);
    dirs[9] = vec3(-1.0, 0.0, 0.0);
    dirs[10] = vec3(0.0, 0.0, 1.0);
    dirs[11] = vec3(0.0, 0.0, -1.0);
    dirs
}

/// One vertex's occlusion: rays start just off the surface along the vertex
/// normal (the shared `VolDims::off_surface` offset — same start the
/// colorize cave probe uses), get bent mildly toward it, and march AO_RADII
/// outward; the first solid hit on each ray adds its AO_HIT weight. Returns
/// `1 - occ / 12` (12 = fan size), the value stored per vertex.
fn vertex_ao(p: Vec3, n: Vec3, data: &[f32], dims: &VolDims, dirs: &[Vec3; 12]) -> f32 {
    // start just off the surface so rays don't self-intersect
    let start = dims.off_surface(p, n);

    let mut occ = 0.0f32;
    for &dir in dirs.iter() {
        // bend the fan only mildly toward the normal: rays hug the
        // surface, so nearby walls / pit sides actually get hit (a
        // strongly biased fan escapes upward and bakes ~1 everywhere)
        let d = dir + n * 0.6;
        // JS `1 / Math.hypot(dx, dy, dz)` port: reciprocal of the
        // sqrt-of-sum-of-squares length, reciprocal-multiply form kept.
        let d = d * (1.0 / d.length());
        for (&rr, &hit) in AO_RADII.iter().zip(AO_HIT.iter()) {
            if dims.solid(data, start + d * rr) {
                occ += hit;
                break;
            }
        }
    }
    1.0 - occ / 12.0
}

/// Bake one AO value per vertex. The volume solidity probe is the shared
/// `VolDims::solid` (js_round + bounds rejection on the un-cast rounded
/// float, outside = air).
/// Per-vertex work is independent, so the loop runs through par.rs (serial
/// by default, rayon under `--features parallel`) — element enumeration
/// preserves vertex index order either way.
pub fn bake(vertices: &[[f32; 3]], normals: &[[f32; 3]], data: &[f32], dims: &VolDims) -> Vec<f32> {
    assert_eq!(data.len(), dims.n.count(), "data length");
    assert_eq!(vertices.len(), normals.len(), "vertices/normals length");
    let mut ao = vec![0.0f32; vertices.len()];
    let dirs = ao_dirs();

    par::for_each_mut(&mut ao, |i, out| {
        *out = vertex_ao(
            Vec3::from_f32(vertices[i]),
            Vec3::from_f32(normals[i]),
            data,
            dims,
            &dirs,
        );
    });

    ao
}
