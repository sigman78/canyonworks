//! Block-sparse density-volume fill — Gate-2 expressive rewrite of the
//! line-by-line src/gen/volume.ts `buildDensityVolume()` port. Same terms,
//! same visit orders; the per-column / per-voxel density terms live in NAMED
//! functions (`cliff_roughness`, `terrace_jitter`, `strata_ledge`,
//! `wash_cut`...) composed by a thin block-sparse skeleton:
//!
//!   1. `column_bands`   — per-column roughness + surface band + basal wash
//!   2. `classify_blocks`— AIR / SOLID / MIXED per 4^3 block from the band
//!                         extremes (+ boundary-shell + op-bounds forcing)
//!   3. `fill_blocks`    — SOLID memset, MIXED per-voxel density
//!
//! Split of responsibilities: carve-op SDF evaluation stays OUT of the fill
//! (ops::apply_carve_ops runs as a post-pass on the returned data); the op
//! BOUNDS are consumed here so the touched blocks are forced MIXED and block
//! classification stays exact.
//!
//! Precision + determinism contract (Gate 5): the fill math is f32
//! end-to-end — the same expressions in the same operand order as the JS
//! original, just narrower lanes (a type-width change, not a re-derivation;
//! no FMA anywhere). Deterministic for a given seed across runs and the
//! scalar/parallel feature (no cross-target claim: the wash pierce guard's
//! `f32::hypot` is platform-libm math). Byte-parity with the JS path is
//! retired: the JS fallback is visually equivalent, not bitwise. Integer
//! paths — block math, indices, the noise perm tables — are untouched.

use crate::grid::{FieldGrids, MapNoise, VolDims};
use crate::math::{idx2, idx3, js_round, vec2, vec3, Aabb, Idx2, Idx3, Vec2, Vec3};
use crate::noise::{fbm2, fbm3, smoothstep, terrace_jitter};
use crate::par;
use crate::params::GenParams;

/// Cubic block edge length, voxels. Must equal 1 << BLOCK_SHIFT.
pub const BLOCK: usize = 4;
#[allow(dead_code)] // mirrors the volume.ts export; BLOCK is used directly here
pub const BLOCK_SHIFT: usize = 2;

pub const BLOCK_AIR: u8 = 0;
pub const BLOCK_SOLID: u8 = 1;
pub const BLOCK_MIXED: u8 = 2;

/// Voxel span `[start, end)` of block `b` along an axis of `n` voxels — the
/// ONE home for the `b*BLOCK .. min(b*BLOCK + BLOCK, n)` clamp that both the
/// fill and the carve-op post-pass (ops.rs) walk per block.
#[inline(always)]
pub(crate) fn block_span(b: usize, n: usize) -> (usize, usize) {
    let v0 = b * BLOCK;
    (v0, (v0 + BLOCK).min(n))
}

// js_round moved to math.rs (its ONE f32 home since Gate 5).

// ---------------------------------------------------------------------------
// Typed API (the crate's real library face — native benches and the fused
// pipeline call this; wasm-bindgen is just a wrapper)
// ---------------------------------------------------------------------------

/// A filled block-sparse density volume: x-fastest f32 densities (positive =
/// rock), the per-4^3-block classification, and the dims/world mapping every
/// downstream stage (ops/nets/ao/colorize) shares.
pub struct Volume {
    pub data: Vec<f32>,
    pub dims: VolDims,
    pub block_type: Vec<u8>,
    pub mixed_count: u32,
    pub solid_count: u32,
}

/// Inclusive block-index ranges of every block an op's AABB touches, padded
/// by one block below / one voxel above exactly like volume.ts.
#[derive(Debug, Clone, Copy)]
pub struct BlockRange {
    pub lo: Idx3,
    pub hi: Idx3,
}

/// One axis of the padded bounds->blocks math:
/// `ceil(((min-origin)/voxel - BLOCK)/BLOCK) .. floor(((max-origin)/voxel + 1)/BLOCK)`,
/// clamped to `[0, nb-1]`. Returned as f32 so emptiness (b1 < b0, bounds miss
/// the volume) can be checked before any usize cast (block counts are tiny —
/// exact in f32).
fn axis_block_range(min: f32, max: f32, origin: f32, voxel: f32, nb: usize) -> (f32, f32) {
    let blk = BLOCK as f32;
    let b0 = (((min - origin) / voxel - blk) / blk).ceil().max(0.0);
    let b1 = (((max - origin) / voxel + 1.0) / blk).floor().min((nb - 1) as f32);
    (b0, b1)
}

impl Aabb {
    /// THE bounds->blocks math — one home for the identical expressions that
    /// volume.ts's fill and volumeWasm.ts's applyCarveOpsPostPass both carry
    /// (`axis_block_range`, ONE formula mapped over x/y/z). Shared by the
    /// fill's MIXED forcing and ops::apply_carve_ops so classification and
    /// the post-pass always agree on which blocks an op can bite. `None`
    /// when the bounds miss the volume entirely (the JS loops run zero
    /// times). Lives here, next to BLOCK, not in math.rs.
    pub fn block_range(&self, dims: &VolDims) -> Option<BlockRange> {
        let (bx0, bx1) =
            axis_block_range(self.min.x, self.max.x, dims.origin.x, dims.voxel, dims.nb.x);
        // y has no origin — the volume starts at y = 0. `min.y - 0.0 == min.y`
        // exactly (IEEE), so sharing the axis fn is safe.
        let (by0, by1) = axis_block_range(self.min.y, self.max.y, 0.0, dims.voxel, dims.nb.y);
        let (bz0, bz1) =
            axis_block_range(self.min.z, self.max.z, dims.origin.z, dims.voxel, dims.nb.z);
        if bx1 < bx0 || by1 < by0 || bz1 < bz0 {
            return None;
        }
        Some(BlockRange {
            lo: idx3(bx0 as usize, by0 as usize, bz0 as usize),
            hi: idx3(bx1 as usize, by1 as usize, bz1 as usize),
        })
    }
}

/// Fill the density volume for a map: typed params, the shared field views,
/// and the map's shared noise (built once per generate call — no per-call
/// perm-table rebuild). `ny` is derived by the caller from maxH; x/z dims and
/// world mapping come from the field grids (the volume shares their raster).
/// `op_bounds` are the carve ops' world AABBs — the fill only needs to know
/// WHERE the (later, ops.rs) SDFs can bite so those blocks get true per-voxel
/// densities instead of an AIR skip / SOLID memset.
/// `force_all_mixed` is the bench flag disabling block classification.
pub fn fill(
    params: &GenParams,
    fields: &FieldGrids,
    noise: &MapNoise,
    ny: u32,
    op_bounds: &[Aabb],
    force_all_mixed: bool,
) -> Volume {
    let g = &fields.ground_h;
    let n = idx3(g.n.x, ny as usize, g.n.z);
    let blocks = |v: usize| v.div_ceil(BLOCK);
    let dims = VolDims {
        n,
        voxel: g.voxel,
        origin: g.origin,
        nb: idx3(blocks(n.x), blocks(n.y), blocks(n.z)),
    };
    let n_col = dims.n.x * dims.n.z;
    assert_eq!(fields.ground_h.data.len(), n_col, "groundH length");
    assert_eq!(fields.wall_mask.data.len(), n_col, "wallMask length");
    assert_eq!(fields.s2.data.len(), n_col, "s2 length");

    let ctx = FillCtx::new(params, fields, noise, dims);
    let cols = ctx.column_bands();
    let mut block_type = ctx.classify_blocks(&cols, force_all_mixed);
    force_op_bounds_mixed(&mut block_type, &dims, op_bounds);

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

    let data = ctx.fill_blocks(&cols, &block_type);

    Volume {
        data,
        dims,
        block_type,
        mixed_count,
        solid_count,
    }
}

// ---------------------------------------------------------------------------
// Pass 1 — per-column bands
// ---------------------------------------------------------------------------

/// Per-column products of the band pass. These are the four Float32Array
/// scratch rasters of volume.ts (rough/bandLo/bandHi/washGate) fused into one
/// struct raster; since Gate 5 the math producing and consuming them is f32
/// too, so the fields are plain stores — no rounding step, no read promotion.
#[derive(Clone, Copy, Default)]
struct ColBand {
    /// cliff-face 3D roughness amplitude for this column
    rough: f32,
    /// lowest y the surface can reach in this column
    lo: f32,
    /// highest y the surface can reach in this column
    hi: f32,
    /// basal wash notch depth (0 = column not washed)
    wash_gate: f32,
}

/// Cliff-flank roughness amplitude: roughness strongest on the cliff flank
/// (wall-mask ramp 0.03..0.25), damped 60% again deep inside the wall mass
/// (0.85..1.0), none on open floor.
fn cliff_roughness(amp: f32, w: f32) -> f32 {
    amp * smoothstep(0.03, 0.25, w) * (1.0 - 0.6 * smoothstep(0.85, 1.0, w))
}

// ---------------------------------------------------------------------------
// Fill context: derived constants + input views, so the named term functions
// read named state instead of a positional param vector.
// ---------------------------------------------------------------------------

struct FillCtx<'a> {
    fields: FieldGrids<'a>,
    noise: &'a MapNoise,
    dims: VolDims,
    /// wallNoiseAmp — peak cliff-face 3D roughness amplitude
    amp: f32,
    /// wallNoiseFreq — cliff relief frequency
    nf: f32,
    /// ledgeAmp — strata bench/overhang lip strength
    ledge: f32,
    /// terraceStep — strata band height (world units)
    step_h: f32,
    /// surface can shift by cliff noise + protruding strata ledges
    influence: f32,
    /// strata ledges active (the fill loop's `ledge > 0.005 && stepH > 0.01`
    /// guard, hoisted)
    ledges_on: bool,
    floor_base: f32,
    wash_amp: f32,
    wash_h: f32,
    wash_scale: f32,
    /// mask threshold: coverage 0 -> nothing, 1 -> almost everywhere
    wash_thresh: f32,
    wash_on: bool,
}

impl<'a> FillCtx<'a> {
    fn new(p: &GenParams, fields: &FieldGrids<'a>, noise: &'a MapNoise, dims: VolDims) -> Self {
        let amp = p.wall_noise_amp;
        let ledge = p.ledge_amp;
        FillCtx {
            fields: *fields,
            noise,
            dims,
            amp,
            nf: p.wall_noise_freq,
            ledge,
            step_h: p.terrace_step,
            // surface can shift by cliff noise + protruding strata ledges
            influence: amp * 1.6 + ledge + dims.voxel,
            ledges_on: ledge > 0.005 && p.terrace_step > 0.01,
            floor_base: p.floor_base,
            wash_amp: p.wash_amp,
            wash_h: p.wash_height,
            wash_scale: p.wash_scale,
            wash_thresh: 1.0 - p.wash_coverage,
            wash_on: p.wash_amp > 0.01 && p.wash_coverage > 0.01 && p.wash_height > 0.05,
        }
    }

    /// Pass 1 — per-column roughness + surface band + basal wash gate.
    /// Row-parallel-ready: each column reads only the immutable field rasters
    /// (the wash pierce guard marches across s2, still read-only), so the
    /// per-row chunks are independent.
    fn column_bands(&self) -> Vec<ColBand> {
        let (nx, nz) = (self.dims.n.x, self.dims.n.z);
        let mut cols = vec![ColBand::default(); nx * nz];
        par::for_each_chunk_mut(&mut cols, nx, |iz, row| {
            for (ix, cb) in row.iter_mut().enumerate() {
                *cb = self.column_band(idx2(ix, iz));
            }
        });
        cols
    }

    /// One column of pass 1 (raster cell `i`): roughness, the [lo, hi] band
    /// the surface can occupy, and the basal-wash notch depth.
    fn column_band(&self, i: Idx2) -> ColBand {
        let rough = cliff_roughness(self.amp, self.fields.wall_mask.at(i));
        let h = self.fields.ground_h.at(i);
        let inf = if rough > 0.001 { self.influence } else { 0.0 };
        let mut lo = h - inf;
        let mut hi = h + inf;
        let mut gate = 0.0f32;
        if self.wash_on {
            let sc = self.fields.s2.at(i);
            // only columns near/inside a wall face can be washed
            if sc < 0.15 && sc > -(self.wash_amp + 0.3) {
                // the column's ground-plane world point, built once and
                // threaded through the wash terms
                let p = self.fields.s2.world(i);
                let g = self.wash_notch_depth(i, p, sc);
                if g > 0.02 {
                    gate = g;
                    // the wash can flip signs anywhere in the basal band
                    lo = lo.min(self.floor_base);
                    hi = hi.max(self.floor_base + self.wash_h + 0.1);
                }
            }
        }
        ColBand {
            rough,
            lo,
            hi,
            wash_gate: gate,
        }
    }

    /// Basal wash: how deep this column's notch may cut, 0 when the noise
    /// mask leaves the column dry. Depth = washAmp * mask edge * detail
    /// modulation, then clamped by the pierce guard so thin walls keep a
    /// solid core. `p` is the column's world point, `i` its raster cell (the
    /// pierce guard marches in index space).
    fn wash_notch_depth(&self, i: Idx2, p: Vec2, sc: f32) -> f32 {
        let n2 = &self.noise.n2;
        let ws = self.wash_scale;
        let mask = 0.5 + 0.5 * fbm2(n2, p * ws + vec2(5.3, -9.1), 3);
        let on = smoothstep(self.wash_thresh - 0.12, self.wash_thresh + 0.12, mask);
        if on <= 0.02 {
            return 0.0;
        }
        let detail = 0.6 + 0.4 * (0.5 + 0.5 * fbm2(n2, p * 0.33 + vec2(53.1, -27.7), 2));
        let g = self.wash_amp * on * detail;
        self.clamp_notch_to_core(i, sc, g)
    }

    /// Pierce guard: march inward along -grad(s2); the most-negative s2 on
    /// the ray is this cross-section's half thickness. Clamp the notch depth
    /// to keep a solid core.
    ///
    /// INTERNALS STAY SCALAR deliberately (the cell arrives as one `Idx2`,
    /// unpacked here): the gradient length is `f32::hypot` (the 2-arg
    /// Math.hypot port used since Gate 1, type-narrowed in Gate 5) —
    /// grouping (gx, gz) into a Vec2 would route it through `Vec2::length`'s
    /// sqrt-of-sum-of-squares, REORDERING the float math. The march itself is
    /// index-space, not a world point.
    fn clamp_notch_to_core(&self, i: Idx2, sc: f32, g: f32) -> f32 {
        let (ix, iz) = (i.x, i.z);
        let s2 = &self.fields.s2;
        let (nx, nz) = (s2.n.x, s2.n.z);
        let voxel = self.dims.voxel;
        let ixm = ix.saturating_sub(1); // Math.max(0, ix - 1)
        let ixp = (ix + 1).min(nx - 1);
        let izm = iz.saturating_sub(1);
        let izp = (iz + 1).min(nz - 1);
        let mut gx = s2.at(idx2(ixp, iz)) - s2.at(idx2(ixm, iz));
        let mut gz = s2.at(idx2(ix, izp)) - s2.at(idx2(ix, izm));
        // Math.hypot(gx, gz) port: hypot, deterministic (it only feeds the
        // march direction vector).
        let gl = gx.hypot(gz);
        if gl <= 1e-6 {
            return g;
        }
        gx /= gl;
        gz /= gl;
        let mut s_min = sc;
        // must march at least (depth + core) deep
        let reach = g + 0.9;
        let mut t = voxel;
        while t <= reach {
            let sx_f = js_round(ix as f32 - (gx * t) / voxel);
            let sz_f = js_round(iz as f32 - (gz * t) / voxel);
            let sx = sx_f.clamp(0.0, (nx - 1) as f32) as usize;
            let sz = sz_f.clamp(0.0, (nz - 1) as f32) as usize;
            s_min = s_min.min(s2.at(idx2(sx, sz)));
            t += voxel;
        }
        g.min(-s_min - 0.8)
    }

    // -----------------------------------------------------------------------
    // Pass 2 — block classification
    // -----------------------------------------------------------------------

    /// Band extremes per block COLUMN, over a footprint padded by 1 voxel so
    /// a surface crossing just outside the block still marks it MIXED.
    /// The min/max reductions are block-local and order-insensitive (f32
    /// compares, NaN impossible), so the per-block-row chunks may run in
    /// parallel.
    fn column_extremes(&self, cols: &[ColBand]) -> (Vec<f32>, Vec<f32>) {
        let d = &self.dims;
        let (nx, nz, nbx, nbz) = (d.n.x, d.n.z, d.nb.x, d.nb.z);
        let mut col_lo = vec![0.0f32; nbx * nbz];
        let mut col_hi = vec![0.0f32; nbx * nbz];
        par::for_each_chunk2_mut(&mut col_lo, &mut col_hi, nbx, |bz, lo_row, hi_row| {
            let (z0, z1) = padded_span(bz, nz);
            for bx in 0..nbx {
                let (x0, x1) = padded_span(bx, nx);
                let mut lo = f32::INFINITY;
                let mut hi = f32::NEG_INFINITY;
                for iz in z0..=z1 {
                    let row = iz * nx;
                    for ix in x0..=x1 {
                        let cb = &cols[row + ix];
                        lo = lo.min(cb.lo);
                        hi = hi.max(cb.hi);
                    }
                }
                lo_row[bx] = lo;
                hi_row[bx] = hi;
            }
        });
        (col_lo, col_hi)
    }

    /// Classify every 4^3 block AIR / SOLID / MIXED from the column-band
    /// extremes. `force_all_mixed` (bench flag) skips classification and
    /// evaluates everything per voxel.
    fn classify_blocks(&self, cols: &[ColBand], force_all_mixed: bool) -> Vec<u8> {
        let d = &self.dims;
        let (nbx, nby, nbz) = (d.nb.x, d.nb.y, d.nb.z);
        let mut block_type = vec![0u8; d.nb.count()];
        if force_all_mixed {
            block_type.fill(BLOCK_MIXED);
            return block_type;
        }
        let (col_lo, col_hi) = self.column_extremes(cols);
        for bz in 0..nbz {
            for by in 0..nby {
                // y range padded by 1 voxel, same reasoning as the footprint pad
                let y_lo = ((by * BLOCK) as f32 - 1.0) * d.voxel;
                let y_hi = (by * BLOCK + BLOCK) as f32 * d.voxel;
                for bx in 0..nbx {
                    let b = idx3(bx, by, bz);
                    let lo = col_lo[bz * nbx + bx];
                    let hi = col_hi[bz * nbx + bx];
                    let mut t = if y_lo > hi {
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
                    if t == BLOCK_SOLID && self.touches_boundary_shell(b) {
                        t = BLOCK_MIXED;
                    }
                    block_type[d.block_idx(b)] = t;
                }
            }
        }
        block_type
    }

    /// Does block `b`'s PADDED voxel range reach the forced-air shell
    /// (x/z sides and the volume top)? Same early-out order as the JS
    /// (x lo/hi, z lo/hi, y hi — y has no forced-air floor).
    #[inline(always)]
    fn touches_boundary_shell(&self, b: Idx3) -> bool {
        let n = self.dims.n;
        b.x == 0
            || reaches_far_shell(b.x, n.x)
            || b.z == 0
            || reaches_far_shell(b.z, n.z)
            || reaches_far_shell(b.y, n.y)
    }

    // -----------------------------------------------------------------------
    // Pass 3 — fill
    // -----------------------------------------------------------------------

    /// Write the density volume: AIR blocks stay zero-init, SOLID blocks
    /// memset to 1.0, MIXED blocks get true per-voxel densities. A block only
    /// writes its own voxels and one bz block-row is one contiguous z-slab of
    /// `data` (idx = ix + iy*nx + iz*nx*ny), so the slabs are
    /// parallel-independent; serial order (bz asc) is unchanged from the JS.
    fn fill_blocks(&self, cols: &[ColBand], block_type: &[u8]) -> Vec<f32> {
        let d = &self.dims;
        let mut data = vec![0.0f32; d.n.count()];
        let slab = BLOCK * d.n.x * d.n.y; // one bz block-row of z-slices
        par::for_each_chunk_mut(&mut data, slab, |bz, slab_data| {
            self.fill_block_row(bz, slab_data, cols, block_type);
        });
        data
    }

    /// All blocks of one bz block-row; `slab` starts at z-slice bz*BLOCK.
    fn fill_block_row(&self, bz: usize, slab: &mut [f32], cols: &[ColBand], block_type: &[u8]) {
        let d = &self.dims;
        let (nx, ny, nz) = (d.n.x, d.n.y, d.n.z);
        let stride_z = nx * ny;
        let (z0, z_end) = block_span(bz, nz);
        for by in 0..d.nb.y {
            let (y0, y_end) = block_span(by, ny);
            for bx in 0..d.nb.x {
                let t = block_type[d.block_idx(idx3(bx, by, bz))];
                if t == BLOCK_AIR {
                    continue; // zero-init reads as air
                }
                let (x0, x_end) = block_span(bx, nx);
                if t == BLOCK_SOLID {
                    for iz in z0..z_end {
                        for iy in y0..y_end {
                            let row = iy * nx + (iz - z0) * stride_z;
                            slab[row + x0..row + x_end].fill(1.0);
                        }
                    }
                    continue;
                }
                // MIXED: true density, identical math to the classic dense
                // fill (carve ops excepted — applied by the ops.rs post-pass)
                for iz in z0..z_end {
                    let edge_z = iz == 0 || iz == nz - 1;
                    let zrow = (iz - z0) * stride_z;
                    for ix in x0..x_end {
                        let i = idx2(ix, iz); // the column's raster cell
                        let cb = &cols[iz * nx + ix];
                        // the column's ground-plane world point (the volume
                        // shares the field raster's grid), built once and
                        // threaded through the density terms
                        let pc = self.fields.ground_h.world(i);
                        let h = self.fields.ground_h.at(i);
                        let r = cb.rough;
                        let gate = cb.wash_gate;
                        let s2c = self.fields.s2.at(i);
                        let edge = edge_z || ix == 0 || ix == nx - 1;
                        let tj = self.terrace_jitter(pc, r);
                        for iy in y0..y_end {
                            let idx = ix + iy * nx + zrow;
                            if edge || iy == ny - 1 {
                                slab[idx] = -1.0; // forced air -> closed skirt
                                continue;
                            }
                            // the voxel's world point: column point + height
                            let p = pc.with_y(iy as f32 * d.voxel);
                            slab[idx] = self.density(p, h, r, tj, gate, s2c);
                        }
                    }
                }
            }
        }
    }

    /// Per-band phase jitter — the shared `noise::terrace_jitter` field the
    /// heightfield terracing (fields.rs `flank_terraces`) also samples, so
    /// the volume's strata bands line up with the 2D profile's benches.
    /// `p` is the column's ground-plane point.
    fn terrace_jitter(&self, p: Vec2, r: f32) -> f32 {
        if self.ledge > 0.005 && r > 0.001 {
            terrace_jitter(&self.noise.n2, p) * self.step_h * 0.6
        } else {
            0.0
        }
    }

    /// Signed density (positive = rock) of one interior voxel of a MIXED
    /// block at world point `p`: column base profile + cliff relief + strata
    /// ledges, minus the basal wash notch.
    #[inline(always)]
    fn density(&self, p: Vec3, h: f32, r: f32, tj: f32, gate: f32, s2c: f32) -> f32 {
        // column base profile: signed height of the ground surface above y
        let mut d = h - p.y;
        // cliff relief only near the surface band of rough columns (the
        // noise/ledge terms cannot move the surface further than `influence`)
        if r > 0.001 && d.abs() < self.influence {
            d += self.cliff_relief(p, r);
            if self.ledges_on {
                d += self.strata_ledge(p.y, tj, r);
            }
        }
        if self.wash_on
            && gate > 0.02
            && p.y > self.floor_base
            && p.y < self.floor_base + self.wash_h
        {
            d = d.min(-self.wash_cut(p.y, gate, s2c));
        }
        d
    }

    /// Cliff 3D roughness: fBm relief on the cliff face, scaled by the
    /// column's flank roughness; the y frequency is squashed (x0.7) so the
    /// features stretch vertically like weathered rock faces. The sample
    /// coordinate mixes per-lane scaling (anisotropic noise domain, not a
    /// world point), so it is built as an explicit `vec3` — naming, not math.
    #[inline(always)]
    fn cliff_relief(&self, p: Vec3, r: f32) -> f32 {
        let nf = self.nf;
        fbm3(&self.noise.n3, vec3(p.x * nf, p.y * nf * 0.7, p.z * nf), 3) * r
    }

    /// Strata ledges: caprock protrudes, soft layer recesses -> benches with
    /// overhang lips. `tj` jitters the band phase per column so the benches
    /// don't ring the whole map at constant heights; strength follows the
    /// flank roughness (r / amp).
    #[inline(always)]
    fn strata_ledge(&self, y: f32, tj: f32, r: f32) -> f32 {
        let p = (y + tj) / self.step_h;
        let fr = p - p.floor();
        let cap = smoothstep(0.3, 0.56, fr);
        self.ledge * (cap - 0.5) * (r / self.amp)
    }

    /// Basal wash notch depth at height y. sqrt profile: deepest at the
    /// floor, vertical tangent at the top; clamped so it never cuts below the
    /// floor plane nor through the wall face; the -0.04 erosion trims
    /// sub-voxel hairlines.
    #[inline(always)]
    fn wash_cut(&self, y: f32, gate: f32, s2c: f32) -> f32 {
        let fall = 1.0 - (y - self.floor_base) / self.wash_h;
        (gate * fall.sqrt() + s2c)
            .min(y - self.floor_base)
            .min(0.02 - s2c)
            - 0.04
    }
}

/// One axis of the boundary-shell test: does block `b`'s padded voxel range
/// (`b*BLOCK ..= b*BLOCK + BLOCK`) reach the last, forced-air voxel layer of
/// an axis `n` voxels long? The ONE formula `touches_boundary_shell` maps
/// over x/z/y.
#[inline(always)]
fn reaches_far_shell(b: usize, n: usize) -> bool {
    b * BLOCK + BLOCK >= n - 1
}

/// Padded `[start, end]` (inclusive) footprint of block `b` along an axis of
/// `n` cells: one cell beyond the block on each side, clamped to the raster —
/// `Math.max(0, b*BLOCK - 1) ..= Math.min(n - 1, b*BLOCK + BLOCK)`, the ONE
/// formula `column_extremes` maps over x and z.
#[inline(always)]
fn padded_span(b: usize, n: usize) -> (usize, usize) {
    ((b * BLOCK).saturating_sub(1), (n - 1).min(b * BLOCK + BLOCK))
}

/// Force every block a carve op's AABB touches to MIXED. The op post-pass
/// (ops::apply_carve_ops) derives its per-block op lists from the SAME
/// `Aabb::block_range` math, so classification stays exact even though
/// the SDFs are evaluated later.
fn force_op_bounds_mixed(block_type: &mut [u8], dims: &VolDims, op_bounds: &[Aabb]) {
    for b in op_bounds {
        let Some(r) = b.block_range(dims) else { continue };
        for bz in r.lo.z..=r.hi.z {
            for by in r.lo.y..=r.hi.y {
                for bx in r.lo.x..=r.hi.x {
                    block_type[dims.block_idx(idx3(bx, by, bz))] = BLOCK_MIXED;
                }
            }
        }
    }
}

// The old positional-ABI export (`fill_volume` + VolumeResult) and its
// Gate-1 adapter were deleted with the per-stage TS dispatchers: the typed
// `fill` above is the only entry, called by pipeline.rs generate_mesh.
