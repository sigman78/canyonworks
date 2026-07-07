//! Carve ops (arch plug/vault, fin windows) as serializable data + Rust SDF
//! evaluation — replaces the JS closure post-pass so the volume never has to
//! cross the boundary between fill and meshing.
//!
//! `CarveShape` mirrors src/gen/carves.ts `CarveShapeSpec` field-for-field:
//! the TS side serializes the exact locals its sdf closures capture, and
//! `eval()` re-runs the same expressions in the same operator order (multi-arg
//! `Math.hypot` ports as sqrt of the sum of squares — long-standing precedent
//! in ao.rs). Since Gate 5 the ops are f32 end-to-end: the spec's JS numbers
//! narrow ONCE on serde decode (the one conversion point — params.rs module
//! doc), the SDF math runs f32 in the same operand order, and the density
//! buffer it edits is f32 already. Deterministic; the JS closure fallback is
//! visually equivalent, not bitwise. `apply_carve_ops` is the port of
//! `applyCarveOpsPostPass` in src/gen/volumeWasm.ts, which itself mirrors the
//! op pass inside volume.ts's fill loop.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::grid::VolDims;
use crate::math::{idx2, idx3, vec2, vec3, Aabb, Vec3};
use crate::noise::{clamp01, fbm2, Noise2};
use crate::volume::block_span;

/// `add` unions rock into the volume, `cut` subtracts air. Ops run in array
/// order (adds first, then cuts — carves.ts builds the list that way) so
/// vault/window openings always win over added rock.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpKind {
    Add,
    Cut,
}

/// Inside-positive pseudo-SDF payload, tagged by shape. Field names/meanings
/// are pinned by carves.ts `CarveShapeSpec` — the TS closure and this struct
/// are two views of the same captured numbers; never let them drift. Fields
/// are f32: serde narrows the JS f64 numbers on decode.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CarveShape {
    /// Arch plug: full-height rock mass filling a corridor throat wall-to-wall
    /// between abutment anchors A and A+AB, rooted below the floor, with a
    /// saddle-dipped, fBm-roughened crown blending from one abutment height to
    /// the other — reads as the two canyon walls meeting overhead.
    #[serde(rename_all = "camelCase")]
    Plug {
        ax: f32,
        az: f32,
        abx: f32,
        abz: f32,
        len2: f32,
        top_a: f32,
        top_b: f32,
        saddle: f32,
        half_depth: f32,
        noise_amp: f32,
        floor_y: f32,
    },
    /// Arch vault: an arched slot pierced through the plug along the corridor
    /// — vertical sides up to the spring line, semicircular crown, bounded
    /// along the passage and clamped so the flat passable floor is untouched.
    #[serde(rename_all = "camelCase")]
    Vault {
        mx: f32,
        mz: f32,
        wx: f32,
        wz: f32,
        cx: f32,
        cz: f32,
        half_w: f32,
        spring_y: f32,
        v_len: f32,
        noise_amp: f32,
        floor_y: f32,
    },
    /// Window: a round-ish hole punched through a thin high fin along the
    /// capsule axis E→E+D, well above the floor — Sedona window rocks.
    #[serde(rename_all = "camelCase")]
    Window {
        ex: f32,
        ez: f32,
        dxx: f32,
        dzz: f32,
        len2: f32,
        cy: f32,
        r: f32,
        noise_amp: f32,
    },
}

/// One carve op as sent from TS: kind + conservative world bounds of every
/// point where the SDF can be > 0 (the same bounds the wasm fill already used
/// to force blocks MIXED) + the shape payload. Numeric fields are f32,
/// narrowed once on serde decode.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CarveOpSpec {
    pub kind: OpKind,
    pub min_x: f32,
    pub max_x: f32,
    pub min_y: f32,
    pub max_y: f32,
    pub min_z: f32,
    pub max_z: f32,
    pub shape: CarveShape,
}

impl CarveOpSpec {
    /// The six flat min/max scalars grouped as the world AABB they are (the
    /// serde field shape is frozen by the TS side, so the grouping happens
    /// here, not in the struct).
    pub fn aabb(&self) -> Aabb {
        Aabb {
            min: vec3(self.min_x, self.min_y, self.min_z),
            max: vec3(self.max_x, self.max_y, self.max_z),
        }
    }
}

impl CarveShape {
    /// Inside-positive pseudo-SDF at world point `p` — ports of the carves.ts
    /// closures (makeArchOps plugSdf/vaultSdf, placeWindows sdf) in grouped
    /// f32 form: axis projections are `Vec2::dot`, radial distances are
    /// `Vec2/Vec3::length` — each spells the identical left-associated
    /// expression the scalar form used (`dot` = `dx*ax + dz*az`, `length` =
    /// `sqrt(x*x + y*y + z*z)`), so the grouping reorders nothing.
    /// `n2` is the map's shared noise (seed ^ 0x2f6e2b1), handed in by the
    /// pipeline so both language paths perturb the same field.
    pub fn eval(&self, n2: &Noise2, p: Vec3) -> f32 {
        match *self {
            CarveShape::Plug {
                ax,
                az,
                abx,
                abz,
                len2,
                top_a,
                top_b,
                saddle,
                half_depth,
                noise_amp,
                floor_y,
            } => {
                let a = vec2(ax, az); // abutment anchor
                let ab = vec2(abx, abz); // abutment axis A -> B
                let q = p.xz();
                // normalized position along the abutment axis + radial
                // distance from the closest axis point
                let u = clamp01((q - a).dot(ab) / len2);
                let r = (q - (a + ab * u)).length();
                let w = 2.0 * u - 1.0;
                // crown dips mid-span (eroded saddle) and undulates
                let top_n = fbm2(n2, q * 0.55 + vec2(19.7, -31.1), 2);
                let top = top_a + (top_b - top_a) * u - saddle * (1.0 - w * w) + top_n * 0.25;
                let face_n = fbm2(n2, q * 0.7 + vec2(41.3, -8.9), 2);
                (half_depth + face_n * noise_amp - r).min((top - p.y).min(p.y - (floor_y - 1.0)))
            }
            CarveShape::Vault {
                mx,
                mz,
                wx,
                wz,
                cx,
                cz,
                half_w,
                spring_y,
                v_len,
                noise_amp,
                floor_y,
            } => {
                let rel = p.xz() - vec2(mx, mz); // offset from the vault midpoint
                let w = rel.dot(vec2(wx, wz)); // across-passage coordinate
                let v = rel.dot(vec2(cx, cz)); // along-passage coordinate
                let dy = (p.y - spring_y).max(0.0);
                // silhouette perturbation varies with height (uneven arch
                // outline) — a height-sheared noise domain, not a world
                // point, so the sample coordinate is an explicit vec2
                let e = fbm2(
                    n2,
                    vec2((p.x + p.y * 0.4) * 0.7 - 3.7, (p.z - p.y * 0.4) * 0.7 + 23.9),
                    2,
                );
                // radial distance in the (across, above-spring) section plane:
                // vertical sides below the spring line, semicircular crown above
                let prof = half_w + e * noise_amp - vec2(w, dy).length();
                // bounded along the passage + never cut below the flat floor
                prof.min((v_len - v.abs()).min(p.y - floor_y))
            }
            CarveShape::Window {
                ex,
                ez,
                dxx,
                dzz,
                len2,
                cy,
                r,
                noise_amp,
            } => {
                let a = vec2(ex, ez); // capsule anchor
                let d = vec2(dxx, dzz); // capsule axis E -> E+D
                let u = clamp01((p.xz() - a).dot(d) / len2);
                let c = a + d * u; // closest axis point, ground plane
                let q = p - c.with_y(cy); // offset from the capsule spine
                // height-sheared noise domain — explicit vec2, like the vault
                let e = fbm2(
                    n2,
                    vec2((p.x + p.y * 0.5) * 0.9 + 7.1, (p.z - p.y * 0.5) * 0.9 - 15.3),
                    2,
                );
                r + e * noise_amp - q.length()
            }
        }
    }
}

/// Carve-op post-pass over the filled volume — port of
/// `applyCarveOpsPostPass` in src/gen/volumeWasm.ts: identical block/voxel
/// iteration and op ordering; the SDF math runs f32 since Gate 5.
///
/// Per-block op lists are rebuilt purely from op bounds via
/// `Aabb::block_range` — the SAME math the fill used to force these
/// blocks MIXED, so only the list building matters here. Ops are scanned in
/// array order, so each block's list is in ascending op order — that
/// WITHIN-block order is what the output depends on. Block iteration order
/// does not affect the result (per-voxel writes are independent across
/// blocks); a BTreeMap keeps it deterministic anyway.
///
/// Voxel loops run iz -> ix -> iy (the fill loop's nesting) over each block's
/// clamped voxel range. Edge voxels (ix/iz == 0 or n-1, iy == ny-1) are forced
/// -1 air by the fill and are skipped BEFORE op evaluation, exactly like the
/// JS `continue` — ops never touch the closed diorama skirt. Per voxel the
/// world point is built ONCE and shared by every op: d = data[idx], then in
/// list order d = add ? max(d, s) : min(d, -s), stored back — buffer, point
/// and SDF are all f32 now, so there is no store-rounding step anymore.
pub fn apply_carve_ops(data: &mut [f32], dims: &VolDims, ops: &[CarveOpSpec], n2: &Noise2) {
    if ops.is_empty() {
        return;
    }

    let mut op_lists: BTreeMap<usize, Vec<u32>> = BTreeMap::new();
    for (oi, op) in ops.iter().enumerate() {
        let Some(r) = op.aabb().block_range(dims) else {
            continue; // op bounds miss the volume: the JS loops run zero times
        };
        for bz in r.lo.z..=r.hi.z {
            for by in r.lo.y..=r.hi.y {
                for bx in r.lo.x..=r.hi.x {
                    let bi = dims.block_idx(idx3(bx, by, bz));
                    op_lists.entry(bi).or_default().push(oi as u32);
                }
            }
        }
    }
    if op_lists.is_empty() {
        return;
    }

    for (&bi, list) in &op_lists {
        // invert block_idx: linear key -> block coords (x fastest)
        let b = idx3(
            bi % dims.nb.x,
            (bi / dims.nb.x) % dims.nb.y,
            bi / (dims.nb.x * dims.nb.y),
        );
        let (x0, x_end) = block_span(b.x, dims.n.x);
        let (y0, y_end) = block_span(b.y, dims.n.y);
        let (z0, z_end) = block_span(b.z, dims.n.z);

        for iz in z0..z_end {
            let edge_z = iz == 0 || iz == dims.n.z - 1;
            for ix in x0..x_end {
                if edge_z || ix == 0 || ix == dims.n.x - 1 {
                    continue; // forced -1 air at the volume boundary; ops never see it
                }
                // the column's ground-plane world point (shared VolDims
                // mapping), built once per column like the fill loop
                let pc = dims.world(idx2(ix, iz));
                for iy in y0..y_end {
                    if iy == dims.n.y - 1 {
                        continue; // top boundary voxel, same forced -1
                    }
                    // the voxel's world point, built once for all ops
                    let p = pc.with_y(iy as f32 * dims.voxel);
                    let idx = dims.idx(idx3(ix, iy, iz));
                    let mut d = data[idx];
                    for &oi in list {
                        let op = &ops[oi as usize];
                        let s = op.shape.eval(n2, p);
                        d = match op.kind {
                            OpKind::Add => d.max(s),
                            OpKind::Cut => d.min(-s),
                        };
                    }
                    data[idx] = d;
                }
            }
        }
    }
}
