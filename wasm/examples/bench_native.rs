//! Native per-stage benchmark for the CanyonWorks generator kernels (Gate 3).
//!
//! The crate's DEFAULT build target is wasm32 (wasm/.cargo/config.toml sets
//! `[build] target = "wasm32-unknown-unknown"`), so this example MUST be run
//! with an explicit native target triple:
//!
//! ```text
//! cargo run --release --example bench_native --target x86_64-pc-windows-msvc
//! cargo run --release --example bench_native --target x86_64-pc-windows-msvc --features parallel
//! ```
//!
//! (cargo is not on PATH in fresh shells — prepend `%USERPROFILE%\.cargo\bin`.)
//!
//! Workload: self-contained synthetic map sized like the real one (~200x180
//! field raster, GenParams::default()). A mulberry-seeded open raster (a
//! corridor chain + arena discs at the junctions) is pushed through the real
//! kernel chain via the typed library APIs:
//!
//!   edt -> profile -> pipeline::mesh_chain (fill + carve ops -> surface
//!   nets -> normals -> AO -> colorize)
//!
//! The mesh stages run through the SAME `mesh_chain` the wasm `generate_mesh`
//! export wraps — its internal timer::now_ms stage timings feed the table
//! directly; edt/profile are timed here. 1 warmup + 4 timed iterations,
//! per-stage mean table. Output checksums are printed so the scalar and
//! `--features parallel` runs can be diffed for determinism.
//!
//! Simplifications vs the real TS fields glue (documented per the spec):
//! - flattenW / flatRaw / mesaOff are ZEROED — the hex-flattening and
//!   per-mesa offset layout passes are not ported (Stage B), so passable-hex
//!   flattening and mesa altitude steps don't fire.
//! - crackD is a constant "far" field (9.0): fissure carving early-outs at
//!   crackD >= 1.3, which is what most real map area does anyway.
//! - Carve ops are three deterministic hardcoded specs (1 plug + 1 vault +
//!   1 window — Gate 6: the bench must exercise ops.rs) built by
//!   `bench_carve_ops` from site values scouted on THIS synthetic map, with
//!   shape fields and bounds derived by the exact carves.ts formulas — the
//!   sdf<=0-outside-bounds invariant holds by construction. They flow through
//!   `mesh_chain` exactly like the real map's ops (op-bounds MIXED forcing in
//!   the fill + the ops.rs post-pass); the fill stage time includes them.
//!   The first iteration also runs the chain once WITHOUT ops and prints both
//!   mixed-block counts, proving the ops bite.

use canyonworks_wasm::fields::{self, Crater, ProfileInputs};
use canyonworks_wasm::grid::{FieldGrids, Grid2, MapNoise};
use canyonworks_wasm::math::{idx2, vec2, Vec2};
use canyonworks_wasm::noise::Mulberry32;
use canyonworks_wasm::ops::{CarveOpSpec, CarveShape, OpKind};
use canyonworks_wasm::params::{GenParams, Palette, Rgb};
use canyonworks_wasm::pipeline::{mesh_chain, volume_ny};
use canyonworks_wasm::timer::now_ms;
use std::hint::black_box;

const NX: usize = 200;
const NZ: usize = 180;
/// Border wall thickness in cells — nothing opens inside it, so the map is
/// ringed by solid rock like a real layout.
const PAD: f32 = 12.0;

const WARMUP: usize = 1;
const ITERS: usize = 4;
const STAGE_NAMES: [&str; 7] = [
    "edt", "profile", "fill+ops", "nets", "normals", "ao", "colorize",
];

/// Fixed Sedona-ish palette (colorize only cares that the values are sane
/// 0..1 floats; the real TERRAIN_PALETTE lives in mesher.ts and is
/// GUI-mutable, which is irrelevant natively).
fn bench_palette() -> Palette {
    let c = |r: f32, g: f32, b: f32| Rgb { r, g, b };
    Palette {
        strata: [
            c(0.42, 0.20, 0.14),
            c(0.55, 0.27, 0.17),
            c(0.66, 0.35, 0.20),
            c(0.76, 0.45, 0.26),
            c(0.83, 0.55, 0.33),
        ],
        floor_a: c(0.80, 0.55, 0.35),
        floor_b: c(0.70, 0.45, 0.28),
        cap: c(0.88, 0.66, 0.45),
        crevice: c(0.30, 0.14, 0.10),
        crater_in: c(0.55, 0.33, 0.22),
        crater_wall: c(0.62, 0.38, 0.24),
        crater_rim: c(0.78, 0.52, 0.32),
        ejecta: c(0.82, 0.60, 0.40),
        crack_deep: c(0.25, 0.11, 0.08),
        crack_lip: c(0.60, 0.34, 0.20),
    }
}

/// Open a capsule (thick segment) of radius `r` cells between two cell-space
/// points, clamped one cell inside the raster so the border stays wall.
/// f32 cell-space geometry (Gate 5) — cell coords are < 2^8, far inside f32's
/// exact-integer range. The endpoints travel as `Vec2` (Gate 7); `dot`/the
/// grouped ops spell the identical left-associated scalar expressions. The
/// x0/x1/z0/z1 bounds stay per-axis scalars — each axis clamps to its own
/// extent (NX vs NZ).
fn stamp_capsule(open: &mut [u8], a: Vec2, b: Vec2, r: f32) {
    let x0 = (a.x.min(b.x) - r).floor().max(1.0) as usize;
    let x1 = (a.x.max(b.x) + r).ceil().min((NX - 2) as f32) as usize;
    let z0 = (a.z.min(b.z) - r).floor().max(1.0) as usize;
    let z1 = (a.z.max(b.z) + r).ceil().min((NZ - 2) as f32) as usize;
    let d = b - a;
    let len2 = d.dot(d).max(1e-9);
    for iz in z0..=z1 {
        for ix in x0..=x1 {
            let p = vec2(ix as f32, iz as f32);
            let u = ((p - a).dot(d) / len2).clamp(0.0, 1.0);
            let q = p - (a + d * u);
            if q.dot(q) <= r * r {
                open[iz * NX + ix] = 1;
            }
        }
    }
}

/// Mulberry-seeded synthetic layout: `junctions` random points joined into a
/// corridor chain, `extra_loops` extra closures, an arena disc on every
/// junction. Stands in for the TS hex-network rasterizer (not ported).
fn build_open_raster(p: &GenParams, rng: &mut Mulberry32) -> Vec<u8> {
    let mut open = vec![0u8; NX * NZ];
    let n_junctions = p.junctions as usize;
    let mut pts: Vec<Vec2> = Vec::with_capacity(n_junctions);
    for _ in 0..n_junctions {
        // Mulberry32 stays f64-out (whitelist: RNG paths untouched); each
        // draw narrows ONCE where it enters the f32 geometry. Components are
        // named scalars first (x then z) so the RNG draw order stays explicit.
        let x = PAD + rng.next() as f32 * (NX as f32 - 2.0 * PAD);
        let z = PAD + rng.next() as f32 * (NZ as f32 - 2.0 * PAD);
        pts.push(vec2(x, z));
    }
    // corridor half-width / arena radius: params are world units -> cells
    let corr_r = (p.corridor_width * 0.5 / p.voxel_size).max(2.0);
    let arena_r = p.opening_radius / p.voxel_size;
    for i in 1..pts.len() {
        stamp_capsule(&mut open, pts[i - 1], pts[i], corr_r);
    }
    for _ in 0..p.extra_loops as usize {
        // index picks consume the raw f64 draw (integer derivation, not
        // geometry — no narrowing)
        let a = (rng.next() * pts.len() as f64) as usize;
        let b = (rng.next() * pts.len() as f64) as usize;
        if a != b {
            stamp_capsule(&mut open, pts[a], pts[b], corr_r);
        }
    }
    for &c in &pts {
        stamp_capsule(&mut open, c, c, arena_r);
    }
    open
}

/// Random crater placements inside the padded footprint (world units), sized
/// from the crater params like the TS placement pass. f32 like `Crater`;
/// RNG draws narrow once each (see `build_open_raster`). NOTE the draw order
/// (x then z) is part of the fixture's determinism — the components are built
/// as named scalars before the Vec2 so the RNG sequence stays explicit.
fn build_craters(p: &GenParams, origin: Vec2, rng: &mut Mulberry32) -> Vec<Crater> {
    let voxel = p.voxel_size;
    (0..p.crater_count as usize)
        .map(|_| {
            let x = origin.x + (PAD + rng.next() as f32 * (NX as f32 - 2.0 * PAD)) * voxel;
            let z = origin.z + (PAD + rng.next() as f32 * (NZ as f32 - 2.0 * PAD)) * voxel;
            Crater {
                pos: vec2(x, z),
                r: p.crater_min_r + rng.next() as f32 * (p.crater_max_r - p.crater_min_r),
                depth: p.crater_depth * (0.6 + rng.next() as f32 * 0.8),
            }
        })
        .collect()
}

/// Deterministic synthetic carve ops: one arch (plug add + vault cut) and one
/// window cut — the Gate 6 hard-gate coverage of ops.rs (fill-time op-bounds
/// MIXED forcing AND the SDF post-pass, all three shape evals).
///
/// The SITE constants below were scouted on this exact synthetic map
/// (seed 1337 raster above) with the real carves.ts placement filters — a
/// genuine corridor throat flanked by tall rock for the arch, a genuine thin
/// high fin for the window — then hardcoded so the bench stays deterministic
/// and self-contained. Everything DERIVED from them (shape fields + bounds)
/// uses the exact makeArchOps/placeWindows formulas from src/gen/carves.ts,
/// so the CarveOp invariant (sdf <= 0 everywhere outside the bounds) holds by
/// construction. Scalar locals mirror the TS closure captures name-for-name —
/// the serde field shape is frozen flat, so the scalar spelling IS the entity.
fn bench_carve_ops(p: &GenParams) -> Vec<CarveOpSpec> {
    // placement constants from src/gen/carves.ts
    const EMBED: f32 = 0.9; // extra rooting depth past the anchor point
    const RIM_SINK: f32 = 0.1; // arch crown sits this fraction below the lower rim
    const MIN_CAP: f32 = 0.45; // thinnest viable rock above the vault apex

    let floor = p.floor_base;

    // ---- arch site (scouted; findArchSites candidate shape) ----------------
    // probe origin on the corridor floor, unit directions to the two facing
    // walls (24-sector angles), wall-face hit distances, highest-rock anchor
    // distances and the wall heights there. Best-scoring throat of the
    // seed-1337 synthetic map (score 1.154, span 3.65 < archMaxSpan 8, both
    // rims above minRim 3.81).
    let (px, pz) = (4.6f32, -9.2f32);
    let (d0x, d0z) = (-0.5f32, -0.866_025_4_f32); // sector 16 (240 deg)
    let (d1x, d1z) = (0.866_025_4_f32, 0.5f32); // sector 2 (30 deg)
    let (hit0, hit1) = (0.70f32, 2.95f32);
    let (anchor0, anchor1) = (2.20f32, 4.70f32);
    let (h0, h1) = (5.460f32, 5.411f32);

    // ---- makeArchOps, verbatim ---------------------------------------------
    // abutment anchor points (deep in the walls) and wall-face hit points
    let ax = px + d0x * (anchor0 + EMBED);
    let az = pz + d0z * (anchor0 + EMBED);
    let bx = px + d1x * (anchor1 + EMBED);
    let bz = pz + d1z * (anchor1 + EMBED);
    let f0x = px + d0x * hit0;
    let f0z = pz + d0z * hit0;
    let f1x = px + d1x * hit1;
    let f1z = pz + d1z * hit1;

    let rim = h0.min(h1);
    let crown = rim - RIM_SINK * (rim - floor); // plug top at mid-span
    let usable = crown - floor;
    // rock above the apex thins to fit low walls; clearance is guaranteed
    let cap = p.arch_thickness.min(MIN_CAP.max(usable - p.arch_clearance));
    let apex_y = crown - cap;

    let half_depth = p.arch_depth / 2.0; // along-corridor rock thickness
    let noise_amp = 0.3f32;

    // plug: full-height rock mass between the abutments
    let abx = bx - ax;
    let abz = bz - az;
    let len2 = abx * abx + abz * abz;
    let saddle = 0.25f32;
    // crown blends from one (sunk) abutment height to the other
    let top_a = h0 - RIM_SINK * (h0 - floor);
    let top_b = h1 - RIM_SINK * (h1 - floor);

    let r_plug = half_depth + noise_amp + 0.1;
    let plug = CarveOpSpec {
        kind: OpKind::Add,
        min_x: ax.min(bx) - r_plug,
        max_x: ax.max(bx) + r_plug,
        min_y: floor - 1.1,
        max_y: h0.max(h1) + 0.5,
        min_z: az.min(bz) - r_plug,
        max_z: az.max(bz) + r_plug,
        shape: CarveShape::Plug {
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
            floor_y: floor,
        },
    };

    // vault: arched slot through the plug along the corridor; across-passage
    // axis between the wall-face points, hugging the faces (small inset)
    let mx = (f0x + f1x) / 2.0;
    let mz = (f0z + f1z) / 2.0;
    let span = ((f1x - f0x) * (f1x - f0x) + (f1z - f0z) * (f1z - f0z)).sqrt();
    let mut v_half_w = 0.7f32.max(span / 2.0 - 0.2);
    // semicircular crown must spring above the floor
    v_half_w = v_half_w.min(0.7f32.max(apex_y - floor - 0.3));
    let spring_y = apex_y - v_half_w;
    let wx = (f1x - f0x) / span; // across-passage unit
    let wz = (f1z - f0z) / span;
    let cx = -wz; // passage direction unit (perp of across axis)
    let cz = wx;
    // slot length: pierce the plug cleanly and stop (ends land in open air)
    let v_len = half_depth + noise_amp + 1.2;

    let ex_x = wx.abs() * (v_half_w + noise_amp) + cx.abs() * v_len;
    let ex_z = wz.abs() * (v_half_w + noise_amp) + cz.abs() * v_len;
    let vault = CarveOpSpec {
        kind: OpKind::Cut,
        min_x: mx - ex_x,
        max_x: mx + ex_x,
        min_y: floor - 0.05,
        max_y: apex_y + noise_amp + 0.1,
        min_z: mz - ex_z,
        max_z: mz + ex_z,
        shape: CarveShape::Vault {
            mx,
            mz,
            wx,
            wz,
            cx,
            cz,
            half_w: v_half_w,
            spring_y,
            v_len,
            noise_amp,
            floor_y: floor,
        },
    };

    // ---- window site (scouted; placeWindows candidate shape) ---------------
    // point inside a thin high fin, SDF-gradient pierce direction (unit,
    // toward open air), depth into the fin (|s2|) and rim height there.
    // Top-scoring fin of the seed-1337 synthetic map (open air both sides
    // within reach, hole radius 0.636 > 0.45, ~9.7 units from the arch site —
    // past the 6-unit separation the real placement enforces).
    let (wpx, wpz) = (-0.30f32, -0.80f32);
    let (gx, gz) = (-0.2733f32, 0.9619f32);
    let half_thick = 1.100f32;
    let h = 4.872f32;

    // ---- placeWindows op derivation, verbatim ------------------------------
    // hole must fit between floor headroom and the rim
    let y_lo = floor + 1.5;
    let y_hi = h - 0.9;
    let r = p.window_radius.min((y_hi - y_lo) / 2.0);
    let cy = (y_hi - r).min((y_lo + r).max(floor + 0.62 * (h - floor)));
    let half = half_thick + 1.4; // pierce clean through + flare
    let ex = wpx - gx * half;
    let ez = wpz - gz * half;
    let fx = wpx + gx * half;
    let fz = wpz + gz * half;
    let dxx = fx - ex;
    let dzz = fz - ez;
    let wlen2 = dxx * dxx + dzz * dzz;
    let wnoise_amp = 0.35f32.min(r * 0.4);
    let rr = r + wnoise_amp + 0.1;
    let window = CarveOpSpec {
        kind: OpKind::Cut,
        min_x: ex.min(fx) - rr,
        max_x: ex.max(fx) + rr,
        min_y: cy - rr,
        max_y: cy + rr,
        min_z: ez.min(fz) - rr,
        max_z: ez.max(fz) + rr,
        shape: CarveShape::Window {
            ex,
            ez,
            dxx,
            dzz,
            len2: wlen2,
            cy,
            r,
            noise_amp: wnoise_amp,
        },
    };

    // carves.ts op ordering: adds first, then cuts, so openings win over
    // added rock
    vec![plug, vault, window]
}

/// f64 sum checksum — same buffer, same sequential order in both variants,
/// so scalar and parallel runs must print identical values. KEEP f64: this
/// is a diagnostic reduction, not kernel math — an f32 accumulator over
/// ~240k elements would swallow small per-element diffs, defeating the
/// determinism check.
fn checksum(v: &[f32]) -> f64 {
    v.iter().map(|&x| x as f64).sum()
}

fn main() {
    let params = GenParams::default();
    // world scalars are f32 from the start (Gate 5) — natively there is no
    // JS f64 boundary, so nothing to narrow
    let voxel = params.voxel_size;
    let origin = vec2(-(NX as f32) * voxel * 0.5, -(NZ as f32) * voxel * 0.5);

    let mut rng = Mulberry32::new(params.seed_u32() ^ 0x51ab_c123);
    let open = build_open_raster(&params, &mut rng);
    let craters = build_craters(&params, origin, &mut rng);
    let open_frac = open.iter().filter(|&&v| v == 1).count() as f64 / (NX * NZ) as f64;

    // zeroed layout-glue rasters + "far" crack field (see header comment)
    let n = NX * NZ;
    let flatten_w = vec![0.0f32; n];
    let flat_raw = vec![0u8; n];
    let mesa_off = vec![0.0f32; n];
    let crack_far = vec![9.0f32; n];

    // the map's shared noise, built ONCE like pipeline.rs generate_mesh
    let noise = MapNoise::new(params.seed_u32());
    let palette = bench_palette();
    // deterministic synthetic carve ops (1 plug + 1 vault + 1 window)
    let ops = bench_carve_ops(&params);

    println!(
        "bench_native: raster {}x{}, voxel {}, seed {}, open fraction {:.3}",
        NX,
        NZ,
        voxel,
        params.seed_u32(),
        open_frac
    );
    println!(
        "parallel feature: {} | logical cores: {}",
        cfg!(feature = "parallel"),
        std::thread::available_parallelism().map(|c| c.get()).unwrap_or(0)
    );
    #[cfg(feature = "parallel")]
    println!("rayon threads: {}", rayon::current_num_threads());

    let mut sums = [0.0f64; 7];
    let mut printed_stats = false;

    for it in 0..WARMUP + ITERS {
        let t0 = now_ms();
        // 1. squared EDT -> signed distance in CELL units; the `* voxel`
        //    world scaling stays with the caller exactly like TS buildFields
        //    step 2, so it's counted inside the edt stage here.
        let sdf_cells = fields::edt(&open, idx2(NX, NZ));
        let s2: Vec<f32> = sdf_cells.iter().map(|&d| d * voxel).collect();
        let t1 = now_ms();

        // 2. per-column ground profile over world-mapped f32 views
        fn g2<'a>(data: &'a [f32], voxel: f32, origin: Vec2) -> Grid2<'a> {
            Grid2::new(data, idx2(NX, NZ), voxel, origin)
        }
        let inputs = ProfileInputs {
            s2: g2(&s2, voxel, origin),
            crack_d: g2(&crack_far, voxel, origin),
            flatten_w: g2(&flatten_w, voxel, origin),
            flat_raw: &flat_raw,
            mesa_off: g2(&mesa_off, voxel, origin),
            craters: &craters,
        };
        let prof = fields::profile(&params, &inputs, &noise);
        let t2 = now_ms();

        // 3-7. the fused mesh chain — the SAME typed `mesh_chain` the wasm
        //    generate_mesh export wraps: fill (carve-op bounds force blocks
        //    MIXED) + ops post-pass -> nets -> normals -> ao -> colorize,
        //    each stage timed internally (bufs.stage_ms).
        let grids = FieldGrids::new(
            &prof.ground_h,
            &prof.wall_mask,
            &s2,
            &crack_far,
            &prof.crater_d,
            idx2(NX, NZ),
            voxel,
            origin,
        );
        let bufs = mesh_chain(
            &params,
            &grids,
            &ops,
            &palette,
            &noise,
            volume_ny(prof.max_h, voxel),
            false,
        );

        if !printed_stats {
            let d = &bufs.dims;
            let voxels = d.n.count();
            println!(
                "volume {}x{}x{} ({} voxels, {:.1} MB f32), blocks {}x{}x{} (mixed {}, solid {})",
                d.n.x,
                d.n.y,
                d.n.z,
                voxels,
                voxels as f64 * 4.0 / (1024.0 * 1024.0),
                d.nb.x,
                d.nb.y,
                d.nb.z,
                bufs.mixed_count,
                bufs.solid_count,
            );
            // ops-bite proof (once, untimed): the same chain WITHOUT ops must
            // classify fewer MIXED blocks (op bounds force theirs MIXED) and
            // mesh a different surface (the plug adds rock).
            let no_ops = mesh_chain(
                &params,
                &grids,
                &[],
                &palette,
                &noise,
                volume_ny(prof.max_h, voxel),
                false,
            );
            println!(
                "carve ops: {} | mixed blocks without ops {} -> with ops {} | verts without ops {} -> with ops {}",
                ops.len(),
                no_ops.mixed_count,
                bufs.mixed_count,
                no_ops.vertices.len(),
                bufs.vertices.len(),
            );
            println!(
                "mesh: {} verts, {} tris | checksums pos {:.6} nrm {:.6} ao {:.6} col {:.6} fac {:.6}",
                bufs.vertices.len(),
                bufs.indices.len() / 3,
                checksum(bufs.vertices.as_flattened()),
                checksum(bufs.normals.as_flattened()),
                checksum(&bufs.ao),
                checksum(bufs.colors.as_flattened()),
                checksum(bufs.facies.as_flattened()),
            );
            printed_stats = true;
        }

        if it >= WARMUP {
            sums[0] += t1 - t0;
            sums[1] += t2 - t1;
            for s in 0..5 {
                sums[2 + s] += bufs.stage_ms[s];
            }
        }

        // keep every stage's output observably live so LTO can't elide work
        black_box((&sdf_cells, &prof, &bufs));
    }

    println!();
    println!(
        "per-stage mean over {} iterations ({} warmup), {}:",
        ITERS,
        WARMUP,
        if cfg!(feature = "parallel") { "parallel" } else { "scalar" }
    );
    println!("  {:<10} {:>10}", "stage", "mean ms");
    let mut total = 0.0f64;
    for (name, sum) in STAGE_NAMES.iter().zip(sums.iter()) {
        let mean = sum / ITERS as f64;
        total += mean;
        println!("  {:<10} {:>10.3}", name, mean);
    }
    println!("  {:<10} {:>10.3}", "TOTAL", total);
}
