//! Indexed vertex-normal accumulation — port of three.js
//! BufferGeometry.computeVertexNormals so the fused pipeline never hands the
//! mesh back to JS mid-chain. Vertices in, vertex normals out — one `[f32; 3]`
//! per vertex, all triple-scalar math grouped into `math::Vec3` expressions.
//!
//! Determinism contract (mirrors node_modules/three/src/core/BufferGeometry.js
//! indexed branch + math/Vector3.js; f32 end-to-end since Gate 5 —
//! deterministic, JS fallback visually equivalent, not bitwise):
//! - The normal attribute is Float32Array-backed, and three.js writes the
//!   running sum back through setXYZ after EVERY triangle — the per-triangle
//!   f32 accumulation in index order is preserved (now trivially: `Vec3` IS
//!   f32, so `from_f32`/`to_f32` are plain repacks, no width change).
//! - Each triangle reads nA/nB/nC before writing any of them, then stores in
//!   vA, vB, vC order — preserved verbatim so aliased (degenerate) index
//!   triples resolve the same way as in JS.
//! - `Vec3::cross` IS the three.js crossVectors component order, and
//!   `Vec3::normalize_or_zero` IS Vector3.normalize's
//!   `divideScalar(length() || 1)` (reciprocal-multiply, zero stays zero) —
//!   see math.rs for the documented ports.

use crate::math::Vec3;

/// Port of computeVertexNormals() for indexed geometry: zero the normal
/// buffer; per index triple (vA,vB,vC) accumulate cb = (pC−pB) × (pA−pB)
/// into all three vertex normals; then normalize each vertex normal.
pub fn compute_normals(vertices: &[[f32; 3]], indices: &[u32]) -> Vec<[f32; 3]> {
    let mut normals = vec![[0.0f32; 3]; vertices.len()];

    for tri in indices.chunks_exact(3) {
        let (va, vb, vc) = (tri[0] as usize, tri[1] as usize, tri[2] as usize);

        let pa = Vec3::from_f32(vertices[va]);
        let pb = Vec3::from_f32(vertices[vb]);
        let pc = Vec3::from_f32(vertices[vc]);

        // cb.subVectors(pC, pB); ab.subVectors(pA, pB); cb.cross(ab)
        let face = (pc - pb).cross(pa - pb);

        // read all three BEFORE any write (JS temp vectors), store vA, vB,
        // vC — the per-triangle f32 round-trip through the output buffer is
        // the three.js contract (setXYZ after every triangle), kept verbatim
        let na = Vec3::from_f32(normals[va]) + face;
        let nb = Vec3::from_f32(normals[vb]) + face;
        let nc = Vec3::from_f32(normals[vc]) + face;
        normals[va] = na.to_f32();
        normals[vb] = nb.to_f32();
        normals[vc] = nc.to_f32();
    }

    // normalizeNormals(): per vertex, divideScalar(length() || 1)
    for n in normals.iter_mut() {
        *n = Vec3::from_f32(*n).normalize_or_zero().to_f32();
    }

    normals
}
