# WASM generator — architecture (feature/wasm-gen)

The generator's compute stages live in a Rust crate (`wasm/`), compiled to
WebAssembly with wasm-bindgen (`npm run wasm:build`, output `wasm/pkg/` is
COMMITTED so CI/GH Pages needs no Rust toolchain). TypeScript keeps layout,
carve placement, decor/fog (three.js object building) and all UI; Rust owns
the array crunching.

## Boundary: one call per mesh

```
TS: layout ──> fields ──────> carve placement ──> [generate_mesh] ──> decor/fog
              │    │                                    │
wasm:         │edt │fields_profile                      │ volume fill → carve ops
              └────┴── two small-raster calls           │ → surface nets → normals
                                                        │ → AO bake → colorize
                                                        └── ONE crossing
```

`generate_mesh(groundH, wallMask, s2, crackD, craterD, dims…, ops, params,
palette, forceAllMixed)` takes the five 2D field rasters (memcpy'd slices),
plus **plain JS objects** for params / palette / carve-ops (serde-decoded into
typed Rust structs — `GenParams`, `Palette`, `Vec<CarveOpSpec>`), and returns
every buffer three.js needs: positions, indices, normals, ao, colors, facies,
block stats, and per-stage timings. The ~4 MB density volume never crosses the
boundary (before the fusion it crossed four times per regenerate).

The `wasm gen` checkbox (params.wasmGen) still switches to the pure-JS chain —
that path is the fallback + regression reference, byte-identical by contract.

## Crate layout (wasm/src/)

| module      | role |
|-------------|------|
| math.rs     | value types: `Vec3`, ground-plane `Vec2`, `Rgb`, `Idx2`/`Idx3` (lattice pairs/triples), `Aabb` — Copy **f32** bundles with documented determinism contracts (fixed operand order, no FMA; deliberately not glam), plus `js_round`. Below the JS fringe every signature is compound — scalars unpack only at the `#[wasm_bindgen]`/serde boundary |
| params.rs   | `GenParams` / `Palette` serde mirrors of the TS objects (camelCase rename, defaults = defaultParams()); generic `from_js<T>` — the one boundary-decode home |
| grid.rs     | `Grid2` (world-mapped 2D views: `bilinear(Vec2)`/`nearest(Vec2)`), `VolDims` (`solid(Vec3)`, `off_surface`), `MapNoise` (n2/n3 built once per call), `FieldGrids` |
| noise.rs    | bit-exact mulberry32 + simplex port (matches core/noise.ts) |
| ops.rs      | `CarveOpSpec` (plug/vault/window as tagged serde enums) + SDF eval + block post-pass — TS closures serialized as data |
| normals.rs  | three.js computeVertexNormals port (indexed, f32-roundtrip-exact) |
| volume.rs   | block-sparse density fill (BLOCK=4) |
| nets.rs     | surface nets mesher |
| ao.rs       | 12-ray AO bake from the density volume |
| colorize.rs | Sedona palette vertex colors + facies channels |
| fields.rs   | Felzenszwalb EDT + per-column ground profile |
| pipeline.rs | typed `mesh_chain` (the stage sequence, exists once — used by `generate_mesh` AND the native bench) + `generate_mesh`/`MeshResult` wasm wrapper |
| par.rs      | `zip_for_each!` / chunk helpers — serial by default, rayon under `--features parallel` |
| timer.rs    | `now_ms()` — performance.now (wasm) / Instant (native) |

## Backend switches (same code, different compilers)

- **SIMD**: `wasm/.cargo/config.toml` sets `+simd128` (all modern browsers);
  autovectorization only, no intrinsics.
- **Parallel**: `cargo … --features parallel` flips the par.rs helpers to
  rayon. Browser builds stay serial (wasm threads need COOP/COEP headers +
  atomics std — future work); native builds use real cores.
- **Native**: the crate is also an rlib; `wasm/examples/bench_native.rs` runs
  the whole kernel chain natively:
  `cargo run --release --example bench_native --target x86_64-pc-windows-msvc
  [--features parallel]`

Determinism holds across all backends: same seed → same map (parallel loops
only cover per-item-independent work; reductions are order-insensitive).

## Harnesses (browser console, `__cwWasm.*`)

- `pipelineBench(runs)` — JS-vs-wasm per-stage table for a full regenerate.
- `meshCompare()` — byte-diff of the fused wasm mesh vs the pure-JS chain on
  the live app state (per-buffer mismatches / maxAbsDiff).
- `fieldsParity()` — same for the two fields kernels.
- `parity()` / `bench()` — noise exactness / raw kernel speed.

## Precision policy (gate 5)

Kernel math is **f32 end-to-end** — buffers are Float32Array anyway, world
coords sit orders of magnitude above f32 epsilon, and f32 doubles future
simd128 lane width. f64 survives only on an audited whitelist (each spot
carries a WHY comment): EDT internals, `GenParams.seed` (ToUint32 range),
timer/stage_ms, and boundary scalars narrowed ONCE at entry (serde decode is
the single f64→f32 conversion point — no width ping-pong inside kernels).
Integer/RNG paths (mulberry32, perm tables) are untouched, so the noise
lattice stays seed-stable. Determinism bar: same seed → bitwise-identical
output run-to-run and scalar-vs-parallel; the JS fallback chain (still f64)
is visually equivalent, not bitwise — the old byte-parity contract is
retired.

## Numbers (2026-07-07, 4-run means, seed 59439)

Browser, full regenerate (pipelineBench):

| stage       | JS ms | wasm ms | × |
|-------------|------:|--------:|-----|
| fields      | 29.7  | 20.2    | 1.5 |
| volumeFill  | 89.5  | 48.9    | 1.8 |
| surfaceNets | 30.4  | 9.4     | 3.2 |
| normals     | 12.4  | 1.8     | 6.9 |
| aoBake      | 92.3  | 38.6    | 2.4 |
| colorize    | 41.2  | 20.3    | 2.0 |
| **total**   | **363** | **207** | **1.75** |

(layout/carves/decor/fogOverlays stay JS — ~65 ms of three.js object building.)

Backend matrix — the same kernel code, compiler switches only
(`bench_native` synthetic workload; identical output checksums everywhere):

| backend                    | kernel chain |
|----------------------------|-------------:|
| browser wasm + simd128     | in-app 206 ms total |
| browser wasm, no simd128   | ~+2% — autovec buys nothing; real SIMD needs explicit f32x4 lanes |
| native x64, scalar (f32)   | 147 ms (f64 era: 155) |
| native x64, `--features parallel` (8 thr, f32) | **34 ms (4.3×)** — fill 6.2×, ao 7.0×, profile 6.4×, colorize 5.9×; nets (sequential by design) is the bottleneck |

Determinism verified after every gate: run-to-run bitwise identical, scalar vs
parallel checksums identical. (Through gate 4 the output was additionally
byte-identical to the JS chain; gate 5's f32 pass retired that in favor of
visual equivalence — on identical fields the divergence is 2 verts in 65k.)

## Toolchain notes

- rustup/wasm-pack live in `~/.cargo/bin` — NOT on PATH in fresh shells:
  `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"`.
- `npm run wasm:build` (release) / `wasm:dev`; always through npm — the script
  also strips pkg/.gitignore so the committed pkg stays tracked.
- The crate's default cargo target is wasm32 (config); native runs need an
  explicit `--target x86_64-pc-windows-msvc`.

## Roadmap

- Stage B: port layout / fields glue (hex raster, craters, cracks, mesa
  offsets, blur) / carve placement → ONE `generate(params)` call for the whole
  map; then optionally host the call in a Web Worker (async regenerate).
- wasm threads behind COOP/COEP (coi-serviceworker on GH Pages) + nightly
  atomics std → `parallel` in the browser.
- SIMD intrinsics/batching for the noise inner loops if profiles justify it.
