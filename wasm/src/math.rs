//! Grouped value types for the generator's math: world points/directions
//! (`Vec3`, ground-plane `Vec2`) and linear-space colors (`Rgb`). The JS
//! source spreads these across scalar triples (x, y, z / r, g, b) — fine
//! for JS, noise here: everything that belongs to one entity travels as one
//! value. The types are `Copy` f32 bundles; LLVM scalarizes them (SROA), so
//! the grouping costs nothing.
//!
//! PRECISION (Gate 5): all lanes are f32 — the mesh buffers are Float32Array
//! on the JS side anyway, world coords (±60, voxel 0.3) sit orders of
//! magnitude above f32's relative epsilon, and f32 halves scratch footprints
//! and unlocks 4-wide simd128 lanes. The old byte-parity-with-JS contract is
//! retired; the bar is DETERMINISM + visual equivalence.
//!
//! DETERMINISM CONTRACT: every method is a fixed f32 expression in the
//! documented operand order — the same order the JS (and the f64 Rust it
//! replaces) used; this is a type-width change, not a re-derivation.
//! Component-wise ops (add/sub/scale/lerp) are order-safe by construction;
//! dot/cross/length spell out their exact forms below. No mul_add/FMA
//! anywhere — which is also why this is a local module and not a glam
//! dependency: glam's fma paths follow target features, i.e. silent
//! cross-target output drift, exactly what the determinism contract forbids.

use serde::Deserialize;
use std::ops::{Add, Mul, Neg, Sub};

/// World-space point or direction, f32 (see module doc).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[inline(always)]
pub const fn vec3(x: f32, y: f32, z: f32) -> Vec3 {
    Vec3 { x, y, z }
}

impl Vec3 {
    /// Ergonomic ctor from one stored vertex/normal (a Float32Array slot) —
    /// same width now, no conversion.
    #[inline(always)]
    pub fn from_f32(v: [f32; 3]) -> Vec3 {
        vec3(v[0], v[1], v[2])
    }

    /// One Float32Array-slot store — same width now, no rounding.
    #[inline(always)]
    pub fn to_f32(self) -> [f32; 3] {
        [self.x, self.y, self.z]
    }

    /// `x*ox + y*oy + z*oz`, left-associated — JS `a*b + c*d + e*f` order.
    #[inline(always)]
    pub fn dot(self, o: Vec3) -> f32 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }

    /// three.js `crossVectors(self, o)` component order:
    /// `(y*oz - z*oy, z*ox - x*oz, x*oy - y*ox)`.
    #[inline(always)]
    pub fn cross(self, o: Vec3) -> Vec3 {
        vec3(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }

    /// `sqrt(x*x + y*y + z*z)` — the multi-arg-Math.hypot port (same
    /// sqrt-of-sum-of-squares the kernels have always used; ao.rs precedent).
    #[inline(always)]
    pub fn length(self) -> f32 {
        (self.x * self.x + self.y * self.y + self.z * self.z).sqrt()
    }

    /// three.js `Vector3.normalize()`: multiply by `1 / (length() || 1)` —
    /// reciprocal-multiply, and a zero-length vector STAYS zero (no epsilon).
    #[inline(always)]
    pub fn normalize_or_zero(self) -> Vec3 {
        let len = self.length();
        let inv = 1.0 / if len > 0.0 { len } else { 1.0 };
        self * inv
    }

    /// Ground-plane projection (world y is up).
    #[inline(always)]
    pub fn xz(self) -> Vec2 {
        Vec2 { x: self.x, z: self.z }
    }
}

/// Integer lattice index/extent triple (voxel or block space) — the grouped
/// form of the `ix/iy/iz`, `nx/ny/nz`, `bx/by/bz` scalar triples (Gate 6:
/// index/bounds triples travel as one value). Minimal by design: methods only
/// where several call sites want them; loop NESTS over the axes stay explicit
/// at the call sites (visit orders are contracts).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Idx3 {
    pub x: usize,
    pub y: usize,
    pub z: usize,
}

#[inline(always)]
pub const fn idx3(x: usize, y: usize, z: usize) -> Idx3 {
    Idx3 { x, y, z }
}

impl Idx3 {
    /// Lattice cell count `x * y * z` — the one home for the
    /// `nx * ny * nz` / `nbx * nby * nbz` products the kernels allocate and
    /// assert with.
    #[inline(always)]
    pub const fn count(self) -> usize {
        self.x * self.y * self.z
    }
}

/// Integer lattice index/extent pair for the ground-plane rasters — the
/// lattice twin of `Vec2` (Gate 7): same x/z naming contract (the 2D fields
/// live in world XZ; y is up). Minimal like `Idx3`: methods only where
/// several call sites want them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Idx2 {
    pub x: usize,
    pub z: usize,
}

#[inline(always)]
pub const fn idx2(x: usize, z: usize) -> Idx2 {
    Idx2 { x, z }
}

impl Idx2 {
    /// Raster cell count `x * z` — the `nx * nz` product the 2D passes
    /// allocate and assert with (twin of `Idx3::count`).
    #[inline(always)]
    pub const fn count(self) -> usize {
        self.x * self.z
    }
}

/// World-space axis-aligned bounds — what a carve op's six min/max scalars
/// actually are (the serde field shape on `CarveOpSpec` stays flat because
/// the TS shape is frozen; `CarveOpSpec::aabb()` groups them). The
/// bounds->blocks math lives on `impl Aabb` in volume.rs, next to BLOCK.
#[derive(Debug, Clone, Copy)]
pub struct Aabb {
    pub min: Vec3,
    pub max: Vec3,
}

impl Add for Vec3 {
    type Output = Vec3;
    #[inline(always)]
    fn add(self, o: Vec3) -> Vec3 {
        vec3(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}

impl Sub for Vec3 {
    type Output = Vec3;
    #[inline(always)]
    fn sub(self, o: Vec3) -> Vec3 {
        vec3(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}

impl Mul<f32> for Vec3 {
    type Output = Vec3;
    #[inline(always)]
    fn mul(self, s: f32) -> Vec3 {
        vec3(self.x * s, self.y * s, self.z * s)
    }
}

impl Neg for Vec3 {
    type Output = Vec3;
    #[inline(always)]
    fn neg(self) -> Vec3 {
        vec3(-self.x, -self.y, -self.z)
    }
}

/// World ground-plane point or direction (the 2D rasters live in XZ; y is
/// up). Fields are deliberately named x/z, not x/y — one entity, one naming
/// scheme across 2D and 3D.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Vec2 {
    pub x: f32,
    pub z: f32,
}

#[inline(always)]
pub const fn vec2(x: f32, z: f32) -> Vec2 {
    Vec2 { x, z }
}

impl Vec2 {
    /// `x*ox + z*oz` (left-associated).
    #[inline(always)]
    pub fn dot(self, o: Vec2) -> f32 {
        self.x * o.x + self.z * o.z
    }

    /// `sqrt(x*x + z*z)` — 2-arg Math.hypot port.
    #[inline(always)]
    pub fn length(self) -> f32 {
        (self.x * self.x + self.z * self.z).sqrt()
    }

    /// Lift a ground-plane point to a world point at height `y` — the
    /// `vec3(p.x, y, p.z)` spelling the column loops kept repeating.
    #[inline(always)]
    pub fn with_y(self, y: f32) -> Vec3 {
        vec3(self.x, y, self.z)
    }
}

impl Add for Vec2 {
    type Output = Vec2;
    #[inline(always)]
    fn add(self, o: Vec2) -> Vec2 {
        vec2(self.x + o.x, self.z + o.z)
    }
}

impl Sub for Vec2 {
    type Output = Vec2;
    #[inline(always)]
    fn sub(self, o: Vec2) -> Vec2 {
        vec2(self.x - o.x, self.z - o.z)
    }
}

impl Mul<f32> for Vec2 {
    type Output = Vec2;
    #[inline(always)]
    fn mul(self, s: f32) -> Vec2 {
        vec2(self.x * s, self.z * s)
    }
}

/// JS `Math.round(x)` == `floor(x + 0.5)` for every finite x — JS rounds
/// halves toward +infinity, INCLUDING negative halves, so don't swap in
/// `f32::round` (it rounds halves away from zero: different result at
/// -0.5, -1.5, ...). Kernel indices derived from it are clamped to the
/// grid afterwards. ONE home (Gate 5) — grid samplers and kernels all use
/// this f32 form.
#[inline(always)]
pub fn js_round(x: f32) -> f32 {
    (x + 0.5).floor()
}

/// Linear-space color, f32 (mirrors THREE.Color where the palette lives —
/// its channels land in Float32Array attributes anyway). Home of the color
/// math the colorize shader uses; params.rs re-exports it for the serde
/// Palette (serde narrows the JS f64 channels to f32 on decode).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Rgb {
    pub r: f32,
    pub g: f32,
    pub b: f32,
}

#[inline(always)]
pub const fn rgb(r: f32, g: f32, b: f32) -> Rgb {
    Rgb { r, g, b }
}

impl Rgb {
    /// THREE.Color.lerp: `c + (o - c) * t` per channel, exactly that form
    /// (NOT `c*(1-t) + o*t` — different rounding).
    #[inline(always)]
    pub fn lerp(self, o: Rgb, t: f32) -> Rgb {
        rgb(
            self.r + (o.r - self.r) * t,
            self.g + (o.g - self.g) * t,
            self.b + (o.b - self.b) * t,
        )
    }

    /// THREE.Color.multiplyScalar.
    #[inline(always)]
    pub fn scaled(self, s: f32) -> Rgb {
        rgb(self.r * s, self.g * s, self.b * s)
    }

    /// One vertex-color Float32Array-slot store — same width now.
    #[inline(always)]
    pub fn to_f32(self) -> [f32; 3] {
        [self.r, self.g, self.b]
    }
}
