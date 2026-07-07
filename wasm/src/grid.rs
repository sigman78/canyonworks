//! World-mapped 2D field views + volume dims: the ONE home for the bilinear /
//! nearest / solid-probe sampling that used to be copy-pasted per kernel
//! (colorize.rs, fields.rs, ao.rs all carried their own).
//!
//! Determinism contract (Gate 5): the three samplers keep the exact
//! expression shape and operand order of their JS originals but run in f32 —
//! field reads are f32 already, world coords are f32 (narrowed ONCE at the
//! boundary), index clamps use the same min/max shape as the JS
//! `Math.max(0, Math.min(n - k, ...))` chains. Deterministic across runs and
//! targets; the JS fallback path is visually equivalent, not bitwise.

use crate::math::{idx2, idx3, js_round, vec2, Idx2, Idx3, Vec2, Vec3};
use crate::noise::{clamp01, Noise2, Noise3};

/// The map's shared deterministic noise, built ONCE per generate call and
/// threaded through every stage (the old per-stage kernels each rebuilt their
/// perm tables per call). Same seed derivation as core/noise.ts makeNoise().
pub struct MapNoise {
    pub n2: Noise2,
    pub n3: Noise3,
}

impl MapNoise {
    pub fn new(seed: u32) -> MapNoise {
        MapNoise {
            n2: Noise2::new(seed ^ 0x2f6_e2b1),
            n3: Noise3::new(seed ^ 0x5b7_e4d3),
        }
    }
}

/// The five per-column field rasters every mesh stage samples, as world-mapped
/// views over one shared x/z grid (the volume shares the same grid; y starts
/// at 0).
#[derive(Clone, Copy)]
pub struct FieldGrids<'a> {
    pub ground_h: Grid2<'a>,
    pub wall_mask: Grid2<'a>,
    pub s2: Grid2<'a>,
    pub crack_d: Grid2<'a>,
    pub crater_d: Grid2<'a>,
}

impl<'a> FieldGrids<'a> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        ground_h: &'a [f32],
        wall_mask: &'a [f32],
        s2: &'a [f32],
        crack_d: &'a [f32],
        crater_d: &'a [f32],
        n: Idx2,
        voxel: f32,
        origin: Vec2,
    ) -> Self {
        let g = |data| Grid2::new(data, n, voxel, origin);
        FieldGrids {
            ground_h: g(ground_h),
            wall_mask: g(wall_mask),
            s2: g(s2),
            crack_d: g(crack_d),
            crater_d: g(crater_d),
        }
    }
}

/// Borrowed 2D field (row-major `[i.z * n.x + i.x]`) with world mapping.
/// World mapping is f32 (Gate 5) — the boundary's f64 voxel/origin scalars
/// are narrowed ONCE where the view is built, never per sample. The raster
/// extent travels as one `Idx2` (Gate 7), like `VolDims`' `Idx3` triples.
#[derive(Clone, Copy)]
pub struct Grid2<'a> {
    pub data: &'a [f32],
    pub n: Idx2,
    pub voxel: f32,
    pub origin: Vec2,
}

/// One axis of the bilinear sample: world coord -> (base cell, fraction).
/// Base cell is floor clamped to [0, n-2] (JS `max(0, min(n-2, floor))`),
/// fraction is clamp01 so out-of-range points clamp instead of extrapolating.
#[inline(always)]
fn axis_cell_frac(w: f32, origin: f32, voxel: f32, n: usize) -> (f32, f32) {
    let f = (w - origin) / voxel;
    let i0 = f.floor().clamp(0.0, (n - 2) as f32);
    (i0, clamp01(f - i0))
}

/// One axis of the nearest sample: js_round + clamp to [0, n-1].
#[inline(always)]
fn axis_nearest(w: f32, origin: f32, voxel: f32, n: usize) -> usize {
    js_round((w - origin) / voxel).clamp(0.0, (n - 1) as f32) as usize
}

/// THE ground-plane raster->world mapping: `origin + i * voxel` per axis
/// (component-wise, order-safe grouping — IEEE addition commutes). ONE
/// formula shared by `Grid2::world` and `VolDims::world` — the volume shares
/// the field raster's grid, and the two mappings must never drift apart.
#[inline(always)]
fn world_xz(origin: Vec2, voxel: f32, i: Idx2) -> Vec2 {
    origin + vec2(i.x as f32, i.z as f32) * voxel
}

/// One axis of the solid probe: js_round to a voxel index, bounds compared
/// on the un-cast rounded float EXACTLY like the JS
/// `if (ix < 0 || ix >= nx) return false` — reject before indexing.
#[inline(always)]
fn axis_cell(w: f32, origin: f32, inv_voxel: f32, n: usize) -> Option<usize> {
    let i = js_round((w - origin) * inv_voxel);
    if i < 0.0 || i >= n as f32 {
        None
    } else {
        Some(i as usize)
    }
}

impl<'a> Grid2<'a> {
    pub fn new(data: &'a [f32], n: Idx2, voxel: f32, origin: Vec2) -> Self {
        Grid2 {
            data,
            n,
            voxel,
            origin,
        }
    }

    /// Direct grid read at raster cell `i` (one Float32Array slot).
    #[inline(always)]
    pub fn at(&self, i: Idx2) -> f32 {
        self.data[i.z * self.n.x + i.x]
    }

    /// Bilinear at ground-plane point `p` — same expression order as
    /// fields.ts `sample()`: per-axis base cell + fraction (`axis_cell_frac`,
    /// ONE formula mapped over x/z), then lerp x then z.
    #[inline(always)]
    pub fn bilinear(&self, p: Vec2) -> f32 {
        let (x0, tx) = axis_cell_frac(p.x, self.origin.x, self.voxel, self.n.x);
        let (z0, tz) = axis_cell_frac(p.z, self.origin.z, self.voxel, self.n.z);
        let nx = self.n.x;
        let i00 = z0 as usize * nx + x0 as usize;
        let a = self.data[i00] + (self.data[i00 + 1] - self.data[i00]) * tx;
        let b = self.data[i00 + nx] + (self.data[i00 + nx + 1] - self.data[i00 + nx]) * tx;
        a + (b - a) * tz
    }

    /// NEAREST at ground-plane point `p` (`axis_nearest` per axis) — same
    /// shape as mesher.ts `sampleCraterD()`. Crater distance wants the crisp
    /// rim, not a bilinear smear.
    #[inline(always)]
    pub fn nearest(&self, p: Vec2) -> f32 {
        let ix = axis_nearest(p.x, self.origin.x, self.voxel, self.n.x);
        let iz = axis_nearest(p.z, self.origin.z, self.voxel, self.n.z);
        self.at(idx2(ix, iz))
    }

    /// World-space position of raster cell `i` (ground plane) — the shared
    /// `world_xz` mapping.
    #[inline(always)]
    pub fn world(&self, i: Idx2) -> Vec2 {
        world_xz(self.origin, self.voxel, i)
    }
}

/// Volume dims + world mapping shared by fill/nets/ao/colorize. The density
/// data itself stays a slice or Vec owned by the caller — this is just the
/// index/world geometry (y has no origin: the volume starts at y = 0, so
/// `origin` is the ground-plane Vec2). Voxel extents `n` and 4^3-block
/// extents `nb` travel as `Idx3` triples.
/// World mapping is f32, narrowed once at the boundary like `Grid2`.
#[derive(Clone, Copy)]
pub struct VolDims {
    pub n: Idx3,
    pub voxel: f32,
    pub origin: Vec2,
    pub nb: Idx3,
}

impl VolDims {
    /// Linear voxel index, x-fastest: `ix + iy*nx + iz*nx*ny` — the ONE home
    /// for the spelling (nets' cell base and the solid probe route through
    /// it).
    #[inline(always)]
    pub fn idx(&self, i: Idx3) -> usize {
        i.x + i.y * self.n.x + i.z * self.n.x * self.n.y
    }

    /// Linear 4^3-block index, x-fastest: `(bz*nby + by)*nbx + bx` — the ONE
    /// home for the spelling (was hand-expanded in volume.rs x3 + ops.rs).
    #[inline(always)]
    pub fn block_idx(&self, b: Idx3) -> usize {
        (b.z * self.nb.y + b.y) * self.nb.x + b.x
    }

    /// World-space ground-plane position of voxel column `i` — the shared
    /// `world_xz` mapping, same as `Grid2::world` (the volume shares the
    /// field raster's grid).
    #[inline(always)]
    pub fn world(&self, i: Idx2) -> Vec2 {
        world_xz(self.origin, self.voxel, i)
    }

    /// World-space solidity probe at point `p` — same shape as the mesher.ts
    /// / bakeAo `solid` closure: js_round to voxel indices (Math.round ==
    /// js_round) with bounds rejection per axis (`axis_cell`, ONE formula
    /// mapped over x/y/z in the same early-out order; y's origin is 0.0 —
    /// `p.y - 0.0 == p.y` exactly, IEEE), outside the volume is air.
    #[inline(always)]
    pub fn solid(&self, data: &[f32], p: Vec3) -> bool {
        let inv = 1.0 / self.voxel;
        let Some(ix) = axis_cell(p.x, self.origin.x, inv, self.n.x) else {
            return false;
        };
        let Some(iy) = axis_cell(p.y, 0.0, inv, self.n.y) else {
            return false;
        };
        let Some(iz) = axis_cell(p.z, self.origin.z, inv, self.n.z) else {
            return false;
        };
        data[self.idx(idx3(ix, iy, iz))] > 0.0
    }

    /// Probe/ray start just off the surface along the vertex normal, shared
    /// by the AO fan (ao.rs) and the colorize cave probe (DRY map item 3).
    /// Operand order is the JS `pos + nx * voxel * 0.8`, i.e. the
    /// left-associated `(n * voxel) * 0.8` — deliberately NOT
    /// `n * (voxel * 0.8)`: same-expression-order policy (a type-width
    /// change must not also reassociate the multiply chain).
    #[inline(always)]
    pub fn off_surface(&self, p: Vec3, n: Vec3) -> Vec3 {
        p + n * self.voxel * 0.8
    }
}
