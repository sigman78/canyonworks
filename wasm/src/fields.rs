//! Fields-stage kernels: the exact squared EDT behind src/gen/sdf2d.ts
//! `signedDistance()` (Felzenszwalb & Huttenlocher) and the per-column
//! ground-profile pass of src/gen/fields.ts `buildFields()` step 7
//! (`fieldsProfileJs()` on the TS side).
//!
//! The typed library face is `edt()` + `profile()` (&GenParams / Grid2 views /
//! &MapNoise in, `Profile` out); the `signed_distance` / `fields_profile`
//! wasm exports are thin wrappers over it. Everything AROUND these two
//! kernels stays in TypeScript this pass: hex-grid rasterization,
//! crater/crack placement (RNG walks), hexFlat, the flattenW box blurs and
//! mesaOffsets. The `* voxel` scaling of the SDF also stays in the TS caller
//! (buildFields step 2) — `edt` returns CELL units exactly like sdf2d.ts.
//!
//! Determinism contract (Gate 5):
//! - The EDT stays f64 (whitelist item 1, see `dt1d`) and is still expected
//!   bit-identical to the JS (pure f64 add/mul/div/sqrt in identical order,
//!   INF = 1e10).
//! - The profile pass is f32 end-to-end: same expressions, same operation
//!   and iteration order as the JS, just narrower lanes (a type-width
//!   change, not a re-derivation). Deterministic for a given seed; the JS
//!   fallback path is visually equivalent, not bitwise (the fieldsParity
//!   harness in src/core/wasmGen.ts measures nearness, not identity).
//! - `max_h` is an f32 max over the stored (post-clamp) heights, promoted
//!   to f64 only at the wasm getter boundary (whitelist item 5).
//! - The profile loop is parallel-ready: every cell's work is independent
//!   and the `max_h` reduction is a max over finite f32 values
//!   (order-insensitive), so serial and `--features parallel` builds produce
//!   identical output.

use crate::grid::{Grid2, MapNoise};
use crate::math::{idx2, vec2, Idx2, Vec2};
use crate::noise::{clamp01, dome_swell, fbm2, gully, lerp, smoothstep, terrace_jitter, Noise2};
use crate::par::zip_for_each;
use crate::params::{self, GenParams};
use ndarray::{ArrayViewMut2, Zip};
use wasm_bindgen::prelude::*;

const INF: f64 = 1e10;

// ---------------------------------------------------------------------------
// EDT (KEEP f64 — Gate-5 whitelist item 1; sdf2d.ts port, byte-identical)
// ---------------------------------------------------------------------------

/// sdf2d.ts `dt1d`: 1D squared-distance lower envelope. Integer indices are
/// exact in f64 (grid dims << 2^26), so every expression matches the JS
/// bit-for-bit.
///
/// KEEP f64 (Gate-5 whitelist item 1): this is integer-exact
/// squared-distance math plus parabola-intersection compares — narrowing to
/// f32 risks off-by-one-cell boundary ties (the envelope compare `s <= z[k]`
/// deciding which parabola owns a cell) for zero payoff: the whole EDT stage
/// is ~1.2 ms. The OUTPUT is Vec<f32> as always.
fn dt1d(f: &[f64], n: usize, d: &mut [f64], v: &mut [i32], z: &mut [f64]) {
    let mut k = 0usize;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for q in 1..n {
        let qf = q as f64;
        let vk = v[k] as f64;
        let mut s = (f[q] + qf * qf - (f[v[k] as usize] + vk * vk)) / (2.0 * qf - 2.0 * vk);
        while s <= z[k] {
            k -= 1;
            let vk = v[k] as f64;
            s = (f[q] + qf * qf - (f[v[k] as usize] + vk * vk)) / (2.0 * qf - 2.0 * vk);
        }
        k += 1;
        v[k] = q as i32;
        z[k] = s;
        z[k + 1] = INF;
    }
    k = 0;
    for q in 0..n {
        while z[k + 1] < q as f64 {
            k += 1;
        }
        let dq = q as f64 - v[k] as f64;
        d[q] = dq * dq + f[v[k] as usize];
    }
}

/// sdf2d.ts `edtSq`: squared distance (in cells) to the nearest cell where
/// mask[i] == value; columns pass then rows pass, same scratch reuse.
/// f64 throughout — EDT internals per whitelist item 1 (see `dt1d`).
/// The raster extent arrives as one `Idx2`; the passes address the two axes
/// asymmetrically, so they unpack it once here.
fn edt_sq(mask: &[u8], dims: Idx2, value: u8) -> Vec<f64> {
    let (w, h) = (dims.x, dims.z);
    let n = w * h;
    let mut out = vec![0.0f64; n];
    for i in 0..n {
        out[i] = if mask[i] == value { 0.0 } else { INF };
    }

    let max_dim = w.max(h);
    let mut f = vec![0.0f64; max_dim];
    let mut d = vec![0.0f64; max_dim];
    let mut v = vec![0i32; max_dim];
    let mut z = vec![0.0f64; max_dim + 1];

    // columns
    for x in 0..w {
        for y in 0..h {
            f[y] = out[y * w + x];
        }
        dt1d(&f, h, &mut d, &mut v, &mut z);
        for y in 0..h {
            out[y * w + x] = d[y];
        }
    }
    // rows
    for y in 0..h {
        f[..w].copy_from_slice(&out[y * w..y * w + w]);
        dt1d(&f, w, &mut d, &mut v, &mut z);
        out[y * w..y * w + w].copy_from_slice(&d[..w]);
    }
    out
}

/// Typed API behind `signed_distance` — port of sdf2d.ts `signedDistance()`:
/// signed distance in CELL units, positive inside the open region, negative
/// inside walls (two squared EDTs combined as sqrt(dWall) - sqrt(dOpen)).
/// The `* voxel` world-unit scaling happens in the TS caller (fields.ts
/// step 2), NOT here. Expected bit-identical to the JS (f64 per whitelist
/// item 1; sqrt is IEEE-exact); the `as f32` at the store is the kernel's
/// one documented output narrowing.
pub fn edt(open: &[u8], dims: Idx2) -> Vec<f32> {
    let n = dims.count();
    assert_eq!(open.len(), n, "openRaster length");

    let d_to_wall = edt_sq(open, dims, 0);
    let d_to_open = edt_sq(open, dims, 1);
    let mut out = vec![0.0f32; n];
    for i in 0..n {
        out[i] = (d_to_wall[i].sqrt() - d_to_open[i].sqrt()) as f32;
    }
    out
}

/// wasm export wrapper over `edt` — JS ABI unchanged (Stage B may move its
/// caller in-crate later); the fringe repacks the scalar dims into the
/// `Idx2` the typed API takes.
#[wasm_bindgen]
pub fn signed_distance(open_raster: &[u8], nx: u32, nz: u32) -> Vec<f32> {
    edt(open_raster, idx2(nx as usize, nz as usize))
}

// ---------------------------------------------------------------------------
// Profile shaping helpers (fields.ts ports, f32)
// ---------------------------------------------------------------------------

/// fields.ts `terrace()`: quantize into flat treads with risers of
/// half-width `riser_hw` (JS default 0.25 — pass it explicitly).
#[inline(always)]
fn terrace(h: f32, step: f32, riser_hw: f32) -> f32 {
    if step <= 0.01 {
        return h;
    }
    let k = h / step;
    let f = k.floor();
    let frac = k - f;
    let s = smoothstep(0.5 - riser_hw, 0.5 + riser_hw, frac);
    (f + s) * step
}

/// fields.ts `bandWeight()`: strongest terracing mid-flank
#[inline(always)]
fn band_weight(w: f32) -> f32 {
    clamp01(4.0 * w * (1.0 - w))
}

/// fields.ts `stepWeight()`: wide flank window for the stepped look
#[inline(always)]
fn step_weight(w: f32) -> f32 {
    smoothstep(0.02, 0.14, w) * (1.0 - smoothstep(0.86, 1.0, w))
}

/// fields.ts `easeWall()`: steep base rise easing into the top
#[inline(always)]
fn ease_wall(w: f32) -> f32 {
    1.0 - (1.0 - w) * (1.0 - w)
}

// ---------------------------------------------------------------------------
// Named per-cell pieces (composed by profile_cell in JS operation order)
// ---------------------------------------------------------------------------

/// Boundary perturbation: fbm-warp the signed distance for wavy walls /
/// buttresses.
#[inline(always)]
fn ridge_perturb(n2: &Noise2, p: Vec2, params: &GenParams) -> f32 {
    fbm2(n2, p * params.ridge_freq, 3) * params.ridge_amp
}

/// Base floor: broad fbm undulation around floor_base.
#[inline(always)]
fn floor_noise(n2: &Noise2, p: Vec2, params: &GenParams) -> f32 {
    params.floor_base + fbm2(n2, p * params.floor_freq, 4) * params.floor_amp
}

/// Craters dent the floor: compact bowl + tall rim crest placed well inside
/// the footprint so hex-flattening outside can't clip them. Mutates
/// `floor_h` crater-by-crater in list order (the FP accumulation order is
/// part of the determinism contract) and returns the normalized distance
/// d/r to the nearest crater center (9.0 when none is in range) — the
/// craterD channel colorize later rings with rim/ejecta bands.
/// (f32 cos/exp — deterministic per target for a given seed.)
fn crater_bowls(craters: &[Crater], p: Vec2, floor_h: &mut f32) -> f32 {
    let mut d_min = 9.0f32;
    for c in craters {
        // center offset grouped; dot(self) is the same left-assoc
        // dx*dx + dz*dz squared length — compare stays SQUARED (no sqrt)
        let dc = p - c.pos;
        let dd = dc.dot(dc);
        // quick reject beyond 1.5r (2.25 = 1.5²) — outside both bowl and rim
        if dd > c.r * c.r * 2.25 {
            continue;
        }
        let d = dd.sqrt() / c.r;
        d_min = d_min.min(d);
        // bowl: raised-cosine dish over the inner 0.8r
        if d < 0.8 {
            *floor_h -= c.depth * (0.5 + 0.5 * ((std::f32::consts::PI * d) / 0.8).cos());
        }
        // rim: tall gaussian crest centered at 0.85r
        if d < 1.25 {
            *floor_h += c.depth * 0.7 * (-((d - 0.85) * (d - 0.85)) / 0.009).exp();
        }
    }
    d_min
}

/// Talus rise near the wall base: exponential apron decaying with distance
/// from the boundary. Caller guards `sd > 0` exactly like the JS.
#[inline(always)]
fn talus_rise(sd: f32, p: &GenParams) -> f32 {
    p.talus_amp * (-sd / p.talus_fall).exp()
}

/// Wall-top height: fbm variation around wall_height, then plateau-ish tops
/// (gentle quantization of the wall height itself), the per-mesa altitude
/// offset (quantized steps, constant per region), and doming — a
/// low-frequency swell over the mesa interior that fades toward the rim so
/// the silhouette edge stays crisp.
fn wall_top(n2: &Noise2, p: Vec2, w: f32, mesa_off: f32, params: &GenParams) -> f32 {
    let mut wall_h = params.wall_height
        + fbm2(n2, p * params.wall_freq + vec2(31.7, -17.3), 4) * params.wall_var;
    wall_h = lerp(wall_h, terrace(wall_h, params.terrace_step * 1.6, 0.25), 0.5);
    wall_h += mesa_off;
    // shared named field (noise.rs) — colorize.rs shades with the same swell
    let dome = dome_swell(n2, p);
    wall_h + dome * 0.8 * smoothstep(0.55, 0.95, w)
}

/// Terraced strata on the flank: flat treads, sharpness-controlled risers,
/// band phase undulated by low-freq noise (`tj`) so strata lines wander
/// instead of being ruler-straight contours.
fn flank_terraces(n2: &Noise2, p: Vec2, h: f32, w: f32, params: &GenParams) -> f32 {
    let riser_hw = 0.35 - 0.29 * params.terrace_sharp;
    // shared named field (noise.rs) — volume.rs jitters its strata ledges
    // with the same one, so volume benches track these treads
    let tj = terrace_jitter(n2, p) * params.terrace_step * 0.6;
    lerp(
        h,
        terrace(h + tj, params.terrace_step, riser_hw) - tj,
        params.terrace_amt * step_weight(w),
    )
}

/// Erosion gullies down the flank, continuing as drainage channels across
/// the top (same ridged-noise field → channels notch the rim exactly where
/// they run off the edge). Returns the carve depth to subtract.
fn gully_notch(n2: &Noise2, p: Vec2, w: f32) -> f32 {
    // shared named field (noise.rs) — colorize.rs varnishes along the same one
    let g = gully(n2, p);
    g * g * (0.5 * band_weight(w) + 0.55 * smoothstep(0.6, 0.95, w))
}

/// Wall flank (sd < 0 branch): ease from the floor+talus shoulder up to the
/// wall top with the steep base rise, then terrace the flank and carve
/// gullies. Returns (h, w) — w is the 0..1 flank progress the later stages
/// reuse as the wall mask.
fn wall_profile(
    n2: &Noise2,
    p: Vec2,
    sd: f32,
    floor_h: f32,
    mesa_off: f32,
    params: &GenParams,
) -> (f32, f32) {
    let depth = -sd;
    let w = smoothstep(0.0, params.wall_thickness, depth);
    let wall_h = wall_top(n2, p, w, mesa_off, params);
    let mut h = lerp(floor_h + params.talus_amp, wall_h, ease_wall(w));
    if params.terrace_amt > 0.0 && w > 0.02 && w < 0.98 {
        h = flank_terraces(n2, p, h, w, params);
    }
    h -= gully_notch(n2, p, w);
    (h, w)
}

/// Fissures: narrow slot canyons cut AFTER flattening so a crack stays
/// continuous across hex boundaries; flat (passable) hexes hard-clip it via
/// the UNBLURRED flat_raw mask (a slot can never punch a hole into a
/// passable hex). Crossing a wall (sd < -0.5) carves a deeper notch through
/// the ridge top. Returns the carve depth to subtract — 0.0 outside a crack
/// (`h - 0.0` is an exact identity, so the caller applies it
/// unconditionally).
fn fissure_notch(
    n2: &Noise2,
    p: Vec2,
    sd: f32,
    crack: f32,
    flat_raw: bool,
    params: &GenParams,
) -> f32 {
    // JS: `if (ck < 1.3 && !flatRaw[i])` — operands finite, inversion exact
    if crack >= 1.3 || flat_raw {
        return 0.0;
    }
    // waviness on the slot lip
    let cd = crack + fbm2(n2, p * 1.1 + vec2(91.3, -37.7), 2) * 0.3;
    if cd >= 1.0 {
        return 0.0;
    }
    let depth = params.crack_depth * if sd < -0.5 { 1.8 } else { 1.0 };
    // JS Math.max(0, 1 - cd*cd); operands are finite here so the branch is
    // behavior-identical
    let t = 1.0 - cd * cd;
    depth * (if t > 0.0 { t } else { 0.0 }).sqrt()
}

/// Everything one raster cell produces: the post-clamp height (the max_h
/// reduction reads the same stored value), the wall-mask weight and the
/// normalized nearest-crater distance.
struct CellSample {
    h: f32,
    w: f32,
    crater_d: f32,
}

/// One column of the ground profile — the exact fieldsProfileJs per-cell
/// body, composed from the named pieces above in the same operation order.
#[allow(clippy::too_many_arguments)]
#[inline]
fn profile_cell(
    params: &GenParams,
    n2: &Noise2,
    craters: &[Crater],
    p: Vec2,
    s2: f32,
    crack: f32,
    flatten_w: f32,
    flat_raw: bool,
    mesa_off: f32,
) -> CellSample {
    // perturb boundary for wavy walls / buttresses
    let sd = s2 + ridge_perturb(n2, p, params);

    // floor
    let mut floor_h = floor_noise(n2, p, params);
    let crater_d = crater_bowls(craters, p, &mut floor_h);

    // talus rise near the wall base
    if sd > 0.0 {
        floor_h += talus_rise(sd, params);
    }

    let (mut h, mut w) = if sd >= 0.0 {
        (floor_h, 0.0)
    } else {
        wall_profile(n2, p, sd, floor_h, mesa_off, params)
    };

    // enforce the hex-level floor decision: passable hexes are perfectly
    // flat, walls/talus/craters may not creep onto them
    if flatten_w > 0.002 {
        h += (params.floor_base - h) * flatten_w;
        w *= 1.0 - flatten_w;
    }

    // fissures cut after flattening (see fissure_notch)
    h -= fissure_notch(n2, p, sd, crack, flat_raw, params);

    h = h.max(0.15);

    CellSample { h, w, crater_d }
}

// ---------------------------------------------------------------------------
// Typed profile API
// ---------------------------------------------------------------------------

/// Crater footprint in world units (fields.ts `Crater`): center (ground-plane
/// Vec2), radius, bowl depth. f32 — the JS-built f64 placement list narrows
/// ONCE where the wasm boundary builds these (Gate-5 whitelist item 4), never
/// per cell.
#[derive(Debug, Clone, Copy)]
pub struct Crater {
    pub pos: Vec2,
    pub r: f32,
    pub depth: f32,
}

/// The rasters + placements the profile pass consumes, as world-mapped
/// `Grid2` views over one shared x/z grid (dims/world mapping are read off
/// `s2`; all rasters must share them — asserted in `profile`).
pub struct ProfileInputs<'a> {
    /// signed distance to the open/wall boundary, ALREADY voxel-scaled to
    /// world units by the caller (buildFields step 2)
    pub s2: Grid2<'a>,
    /// distance field of the hex-aligned fissure network
    pub crack_d: Grid2<'a>,
    /// blurred flatten weight: 1 over flat (passable) hexes, smoothly
    /// blended at their boundary so walls/talus/craters get a short apron
    /// instead of a step
    pub flatten_w: Grid2<'a>,
    /// UNBLURRED flat mask — crack carving is hard-clipped by it so a slot
    /// can never punch a hole into a passable hex (0 = not flat)
    pub flat_raw: &'a [u8],
    /// per-mesa altitude offsets (quantized plateau steps, constant per
    /// connected wall region) so mesas stop reading as one uniform slab
    pub mesa_off: Grid2<'a>,
    pub craters: &'a [Crater],
}

/// Output of the per-column ground-profile pass: the three per-cell rasters
/// plus the height maximum (feeds the volume's ny derivation). `max_h` is
/// f32 (Gate-5 whitelist item 5) — promoted to f64 only at the wasm getter.
pub struct Profile {
    pub ground_h: Vec<f32>,
    pub wall_mask: Vec<f32>,
    pub crater_d: Vec<f32>,
    pub max_h: f32,
}

/// Per-column ground profile — fields.ts buildFields step 7
/// (`fieldsProfileJs`): floor noise + crater bowls/rims + talus + wall
/// profile (plateau quantization, per-mesa offset, doming, terraced strata,
/// gullies) + hex flattening + fissure carving.
///
/// Iterates the (nz, nx) raster row-major (iz outer, ix inner — the JS loop
/// order) calling `profile_cell` per cell; the hot loop goes through
/// par.rs `zip_for_each!` so `--features parallel` fans rows out without a
/// second code path. Only the 2D noise channel of `noise` is touched.
pub fn profile(params: &GenParams, inputs: &ProfileInputs, noise: &MapNoise) -> Profile {
    let s2 = inputs.s2;
    let (nx, nz) = (s2.n.x, s2.n.z);
    let n = s2.n.count();
    assert_eq!(s2.data.len(), n, "s2 length");
    assert_eq!(inputs.crack_d.data.len(), n, "crackD length");
    assert_eq!(inputs.flatten_w.data.len(), n, "flattenW length");
    assert_eq!(inputs.flat_raw.len(), n, "flatRaw length");
    assert_eq!(inputs.mesa_off.data.len(), n, "mesaOff length");

    let mut ground_h = vec![0.0f32; n];
    let mut wall_mask = vec![0.0f32; n];
    let mut crater_d = vec![9.0f32; n];

    {
        let gh = ArrayViewMut2::from_shape((nz, nx), &mut ground_h[..]).expect("groundH shape");
        let wm = ArrayViewMut2::from_shape((nz, nx), &mut wall_mask[..]).expect("wallMask shape");
        let cd = ArrayViewMut2::from_shape((nz, nx), &mut crater_d[..]).expect("craterD shape");
        // the profile loop only ever touches the 2D noise channel
        let n2 = &noise.n2;
        zip_for_each!(
            Zip::indexed(gh).and(wm).and(cd),
            |(iz, ix), out_h, out_w, out_c| {
                // the (nz, nx)-shaped Zip hands the lattice index as two
                // scalars — repack into the cell's Idx2 once
                let i = idx2(ix, iz);
                let cell = profile_cell(
                    params,
                    n2,
                    inputs.craters,
                    s2.world(i),
                    s2.at(i),
                    inputs.crack_d.at(i),
                    inputs.flatten_w.at(i),
                    inputs.flat_raw[iz * nx + ix] != 0,
                    inputs.mesa_off.at(i),
                );
                *out_h = cell.h;
                *out_w = cell.w;
                *out_c = cell.crater_d;
            }
        );
    }

    // max_h: f32 max over the stored post-clamp heights (whitelist item 5).
    // Reducing serially AFTER the loop keeps the result identical under
    // `--features parallel` (f32 max over finite values is order-insensitive
    // anyway).
    let max_h = ground_h.iter().copied().fold(0.0f32, f32::max);

    Profile {
        ground_h,
        wall_mask,
        crater_d,
        max_h,
    }
}

// ---------------------------------------------------------------------------
// wasm exports (kept per-stage until Stage B; params boundary retyped)
// ---------------------------------------------------------------------------

/// wasm result wrapper around `Profile` — getters COPY out (established
/// pattern: the TS side keeps the buffers long-term, so they must be copies,
/// never views into wasm memory). Buffer getters via the shared
/// `pipeline::typed_array_getters!` (one copy, wasm memory -> JS heap);
/// `max_h` has a manual getter because it promotes f32 -> f64 at the
/// boundary (same four getter names/types as before — ABI unchanged).
#[wasm_bindgen]
pub struct FieldsProfileResult {
    ground_h: Vec<f32>,
    wall_mask: Vec<f32>,
    crater_d: Vec<f32>,
    max_h: f32,
}

crate::pipeline::typed_array_getters!(FieldsProfileResult {
    ground_h: js_sys::Float32Array,
    wall_mask: js_sys::Float32Array,
    crater_d: js_sys::Float32Array,
});

#[wasm_bindgen]
impl FieldsProfileResult {
    /// `max_h` is an f32 max internally (Gate-5 whitelist item 5); it is
    /// promoted to f64 ONLY here, at the JS boundary — the getter keeps the
    /// f64 (JS number) ABI it always had.
    #[wasm_bindgen(getter)]
    pub fn max_h(&self) -> f64 {
        self.max_h as f64
    }
}

/// wasm export wrapper over `profile` — the per-column ground-profile pass.
///
/// Typed-params boundary (Gate 2): `params` is the live GenParams object
/// decoded via serde (replaces the old 15-entry f64 vec + separate seed;
/// seed = `params.seed >>> 0`). `craters` stays a 4-stride [x, z, r, depth]
/// f64 array — it is a JS-built placement list, fine as-is. `s2` must be
/// ALREADY scaled to world units by the caller.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn fields_profile(
    nx: u32,
    nz: u32,
    voxel: f64,
    origin_x: f64,
    origin_z: f64,
    s2: &[f32],
    crack_d: &[f32],
    flatten_w: &[f32],
    flat_raw: &[u8],
    mesa_off: &[f32],
    craters: &[f64],
    params: JsValue,
) -> Result<FieldsProfileResult, JsValue> {
    let params: GenParams = params::from_js(&params)?;
    // fringe repack: the boundary's scalar dims become the raster's Idx2
    let n = idx2(nx as usize, nz as usize);
    assert_eq!(craters.len() % 4, 0, "craters stride");
    // f64 JS placement list -> f32 Craters: the ONE narrowing point at entry
    // (Gate-5 whitelist item 4), never per cell.
    let craters: Vec<Crater> = craters
        .chunks_exact(4)
        .map(|c| Crater {
            pos: vec2(c[0] as f32, c[1] as f32),
            r: c[2] as f32,
            depth: c[3] as f32,
        })
        .collect();

    // all four rasters share one grid/world mapping (same closure pattern as
    // grid.rs FieldGrids::new). f64 JS scalars -> f32 world units: the ONE
    // narrowing point at entry (Gate-5 whitelist item 4), never per sample.
    let (voxel, origin) = (voxel as f32, vec2(origin_x as f32, origin_z as f32));
    let g = |data| Grid2::new(data, n, voxel, origin);
    let inputs = ProfileInputs {
        s2: g(s2),
        crack_d: g(crack_d),
        flatten_w: g(flatten_w),
        flat_raw,
        mesa_off: g(mesa_off),
        craters: &craters,
    };
    // same makeNoise seed derivation as every other stage (MapNoise); the
    // profile pass only reads the 2D channel
    let noise = MapNoise::new(params.seed_u32());

    let p = profile(&params, &inputs, &noise);
    Ok(FieldsProfileResult {
        ground_h: p.ground_h,
        wall_mask: p.wall_mask,
        crater_d: p.crater_d,
        max_h: p.max_h,
    })
}
