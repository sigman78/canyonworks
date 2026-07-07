# Worklog

## 2026-07-06 — WASM fields kernels (feature/wasm-gen, stage 6)

Two fields kernels ported (`wasm/src/fields.rs`): the Felzenszwalb
exact EDT (`signed_distance`, cell units — voxel scaling stays in the
TS caller) and the per-column ground-profile loop (`fields_profile`:
ridge/floor fbm, crater bowls/rims, talus, wall height + mesa offsets +
doming, terracing with phase jitter, gullies, hex flattening, crack
notches). Hex rasterization, RNG crater/crack placement, box blurs and
mesa flood fill stay in TS (cheap, branchy, grid-coupled). Fields now
also carries flattenW/flatRaw/mesaOff as parity-support intermediates.

Parity: **all-zero on both seeds** — EDT exact, groundH/wallMask/
craterD/maxH exact (cos/exp transcendentals matched V8 again). That is
6/6 kernels byte-identical; per-seed reproducibility fully preserved
through the whole wasm generator.

Pipeline table (4-run avg, wasm vs js):
  fields       32.6 -> 21.8 ms  (1.5×)
  volumeFill   90.2 -> 62.3 ms  (1.45×)
  surfaceNets  36.3 -> 13.7 ms  (2.65×)
  aoBake       92.6 -> 39.0 ms  (2.37×)
  colorize     42.0 -> 22.0 ms  (1.91×)
  total       372   -> 238 ms   (1.57× end-to-end)
Remaining JS: fogOverlays ~55 ms (three.js object building — not a
wasm candidate), normals ~11 ms, decor/layout/carves ~12 ms. The
generator math is now essentially all-wasm; further wins are
structural (SIMD batch noise, threads) rather than more ports.

## 2026-07-06 — WASM colorize (feature/wasm-gen, stage 5)

colorize ported (`wasm/src/colorize.rs`): bilinear field samplers over
the raw grids, nearest crater sampler, plateauWeight, all three color
branches, cave-tint probe, crack shading. The palette (15 colors × 3)
crosses the boundary PER CALL — the Palette panel mutates live Colors,
so caching wasm-side would freeze user tweaks; mesher flattens it at
the call site (also avoids a mesher↔volumeWasm import cycle).
`tryWasmColorize(...) ?? colorizeJs(...)` dispatch like AO.

Parity: **exactly 0 diffs on colors AND facies, both seeds** — the
flagged sin/exp transcendental risk didn't materialize either (V8 and
Rust libm agree on these input ranges; that's now 5 for 5 kernels
byte-identical). Visual check: full-wasm regenerate renders correctly.

Pipeline table (4-run avg, wasm vs js):
  volumeFill   81.5 -> 61.9 ms  (1.32×)
  surfaceNets  31.5 -> 13.9 ms  (2.27×)
  aoBake       91.5 -> 38.5 ms  (2.38×)
  colorize     36.9 -> 21.8 ms  (1.69×)
  total       357   -> 243 ms   (1.47× end-to-end)
(The "fields 1.32×" row is GC-coupling noise — fields has no wasm path
yet; JS-mode runs carry more allocation pressure from the JS kernels.)
Next: fields profile loop + EDT; fogOverlays (56 ms) is three.js
object building — not a wasm candidate.

## 2026-07-06 — WASM AO bake (feature/wasm-gen, stage 4)

bakeAo ported (`wasm/src/ao.rs`, `bake_ao`): 12-ray fan (order-exact
table build), 4-radius first-hit march, js_round probe lookups. JS side
refactored to a pure `computeAoJs` (raw arrays, no THREE dependency) so
the dispatch is `tryWasmAo(...) ?? computeAoJs(...)` at the mesher call
site — volumeWasm never imports mesher (would cycle). The flagged
Math.hypot-3-arg ULP risk did NOT materialize: **parity byte-identical
on both seeds** (0 diffs over 65.6k / 76.8k verts).

Pipeline table (4-run avg, wasm vs js):
  volumeFill   81.4 -> 61.3 ms  (1.33×)
  surfaceNets  23.3 -> 13.3 ms  (1.75×)
  aoBake       87.7 -> 38.8 ms  (2.26×)
  total       337   -> 254 ms   (regen ~25% faster end-to-end)
Standalone aoParity: 92 -> 50 ms / 110 -> 45 ms. AO gains most so far —
pure probe marching with zero allocation pressure suits wasm best.
Remaining JS stages: colorize 38.5 (port next), fogOverlays 54.9
(mostly three.js object building, poor wasm fit), fields 27.8.

## 2026-07-06 — WASM surface nets + per-stage perf tracking (feature/wasm-gen, stage 3)

surfaceNets ported to Rust (`wasm/src/nets.rs`, `surface_nets`) — takes
the FINAL volume data (carve-op post-pass already applied), so it can't
fuse with fill_volume until ops are ported; the ~4 MB data copy in is
milliseconds. Exactness traps that mattered: JS builds positions in a
number[] (f64) and rounds to f32 only at return, while the
diagonal-split tie-break (diagSq) and the degenerate-triangle test read
the UNROUNDED values — the Rust port builds in Vec<f64> the same way.
Corner buffer stays f32 like the JS Float32Array. Parity: **byte-
identical on both test seeds** — same vertex count, 0 position diffs,
0 index diffs (65.6k / 76.8k verts).

Per-stage perf tracking (user request — measure each JS→WASM
replacement at its TS call site): `core/perf.ts` marks around every
pipeline stage in regenerate/buildTerrainGeometry, `[perf]` debug line
per regenerate, and `__cwWasm.pipelineBench(runs)` regenerates with
wasmGen off/on and console.tables the comparison. No Rust-side
instrumentation — call-site timing includes boundary copies, which is
the honest number.

Pipeline table (4-run avg, seed 59439):
  volumeFill   82.5 -> 61.2 ms  (1.35×)  [wasm]
  surfaceNets  30.3 -> 12.6 ms  (2.4×)   [wasm]
  aoBake       88.6 ms   [next target — biggest JS stage left]
  colorize     36.2 ms | fields 28.5 | fogOverlays 55.3 | normals 10.8
  total        345 -> 307 ms
Control stages (normals/colorize/ao/fog) hold at ~1.0× as expected.
Nets beats fill on speedup because the JS version pays number[].push +
GC churn, which Rust's Vec eliminates — allocation-bound stages gain
more than compute-bound ones.

## 2026-07-06 — WASM volume fill (feature/wasm-gen, stage 2)

buildDensityVolume ported to Rust (`wasm/src/volume.rs`, `fill_volume`),
built by two parallel subagents against a pinned ABI spec (params as a
fixed-order f64 vector, fields as the flat Float32Arrays they already
are, ops as bounds-only) — the TS and Rust sides never touched each
other's files and integrated on first build.

Design calls:
- **Carve-op SDFs stay in JS.** The op closures capture placement
  geometry; rather than refactor carves.ts, the wasm fill only FORCES
  op blocks MIXED (bounds math), and a TS post-pass replays the ops
  over exactly those blocks in the same per-voxel order. Ops chain on
  top of the base density, so this is arithmetically identical — one
  nuance: the post-pass applies ops over the f32-rounded base rather
  than the f64 intermediate, theoretically a sub-ULP difference where
  an op SDF ties the base within f32 epsilon. Not observed (parity 0).
- **One copy per boundary crossing** (inputs in, data/blockType out,
  ~4 MB, ~2 ms) — zero-copy views deferred until surface nets moves
  into wasm too.
- Dispatcher `buildVolume()` (gen/volumeWasm.ts): wasm when
  `params.wasmGen` (new, default true, "wasm gen" checkbox in Map)
  AND the module is ready; JS fallback otherwise (also covers the
  module still loading during the first regenerate, older browsers,
  file:// contexts). `[wasm-vol]` debug line names the backend.
- JS Math.round ported as (x+0.5).floor (exact); f64::hypot ULP risk
  in the pierce guard documented — did not materialize.

Verified in-browser (`__cwWasm.volParity()`): **byte-identical on both
test seeds** — maxDiff 0, diffCount 0, blockType diff 0, over ~1.06M
and ~1.13M voxels WITH live carve ops (5 arches + windows) and wash.
Timing: volume fill 104 -> 73 ms and 110 -> 86 ms (~1.3-1.4×, scalar
port + boundary copies); full regenerate 365 -> 322 ms (~12% — the
fill is ~30% of regen). Consistent with the stage-1 baseline: the
remaining wins are structural — SIMD batch noise, surface nets + AO
bake in wasm (AO is the most parallel kernel), zero-copy views.

## 2026-07-06 — WASM generator scaffold (feature/wasm-gen, stacked on texture-set-v2)

User: move the generator to WASM for higher-level array-processing
abstractions + native-class speed; backend chosen: **Rust** (wasm-pack +
wasm-bindgen) over AssemblyScript (no numpy-like layer, no
autovectorizer), C++/Emscripten (toolchain friction), Zig (DIY glue) —
Rust is the only candidate scoring on expressiveness (iterators /
ndarray / rayon), codegen (LLVM + simd128) and TS integration
(generated .d.ts, vite-compatible pkg) at once.

Scaffold (stage 1):
- Toolchain: rustup (stable 1.96.1, minimal profile) + wasm32 target +
  wasm-pack 0.15 (prebuilt binary into .cargo/bin). MSVC build tools
  were already present (host proc-macros need a host linker).
- `wasm/` crate: cdylib + wasm-bindgen, simd128 enabled via
  .cargo/config.toml, LTO release profile. `npm run wasm:build` /
  `wasm:dev` (also strips wasm-pack's pkg/.gitignore stub — pkg/ is
  COMMITTED so the GH Pages workflow needs no Rust toolchain; revisit
  if the wasm grows).
- **Bit-exact noise port**: mulberry32 (u32 wrapping ops == JS
  `|0`/`imul`/`>>>`) + simplex-noise v4.0.3 noise2D/noise3D (ported
  from the installed package source, same f64 operation order) + fbm2/
  fbm3/ridged2. `NoiseKit(seed)` mirrors makeNoise()'s seed derivation.
- Harness `src/core/wasmGen.ts` (lazy import, dev hook `__cwWasm`):
  parity() = max |wasm−js| over a 2k-point cloud; bench() = same fbm3
  grid fill both worlds.

Results: **parity 0.0 (bit-identical) on both test seeds** — maps stay
reproducible through the port. Bench (1M voxels, 3-octave fbm3): JS
198 ms vs WASM 134 ms = **1.5×** for a line-by-line scalar port
(includes the Vec→Float32Array copy). Honest baseline: V8 JITs this
f64 scalar code well, and branchy simplex gathers defeat the
autovectorizer. The planned wins are structural, not line-by-line:
batch 4-wide SIMD evaluation (v128 lanes), f32 where precision
permits, zero-copy views into wasm memory, whole-volume-fill port
(one boundary crossing per regenerate), optional rayon threads later
(needs COOP/COEP — coi-serviceworker shim on GH Pages).

Next stages: port buildDensityVolume fill (fields sampled into flat
arrays on the TS side or ported wholesale), then surface nets, then
the AO bake.

## 2026-07-06 — palette panel (feature/texture-set-v2)

User: the tri-planar albedo hues — mesa/rocks/canyons — should be
tweakable too. Those colors are the GENERATOR's vertex palette
(textures only modulate it): mesher.ts colorize() bakes the Sedona
constants into vertex colors, decor.ts bakes rock/pillar tones per
instance. New "Palette" GUI folder (ui/palettePanel.ts):

- mesher's palette constants restructured into an exported live-object
  `TERRAIN_PALETTE` (strata ×5, floor sand/dust, plateau cap, crevice,
  crater bowl/slope/rim/ejecta, fissure depths/lip); decor gets
  `DECOR_PALETTE` (rock tones ×5, sand skirt, pillar bands ×4, butte
  slab, hoodoo cap). Internal aliases keep the diff minimal.
- Pillar butte tops now reference the SAME Color object as the mesa
  plateau cap (they were duplicate constants) — tweaking the cap keeps
  pillar tops in family automatically.
- Color pickers mutate the live Colors; the mesh re-bake (full
  regenerate) fires on onFinishChange only — dragging the picker stays
  cheap, commit re-bakes (~0.5 s).
- Persists in localStorage `canyonworks.palette.v1` as sRGB hex strings
  (round-trips THREE's color management: getHexString/set). Stored
  values are applied to the Colors at panel construction, BEFORE the
  app's first regenerate. Per-group "↺ defaults" reset.

Verified in-browser: GUI-driven teal strata re-bake the walls, survive
a full reload, and reset back to the Sedona defaults.

## 2026-07-06 — material editor (feature/texture-set-v2)

User: material editor for the scene's main material scalar parameters.
New "Materials" GUI folder (ui/materialEditor.ts) with a sub-panel per
material slot:

- **Terrain** (MeshStandardMaterial): roughness, metalness
- **Rock decor** (all boulder/pillar/scree materials as one slot):
  roughness, metalness
- **Mesa fog**: opacity
- **Hex grid**: opacity

Design notes:
- Slots fetch their LIVE materials on every apply — decor, fog and
  overlay materials are recreated on each regenerate, so the editor
  re-applies stored values from `rebuildOverlays()` (covers regenerate
  AND the brush quick-update path). Holding material references would
  edit orphans.
- Overrides persist in localStorage `canyonworks.materials.v1`,
  separate from the gen params blob; per-slot "↺ defaults" reset.
  State always stores a value per param (default when untouched), so
  apply() writes unconditionally onto fresh materials.
- Panel integration via an optional `buildMaterials(gui)` callback so
  the folder lands between Render tweaks and the action buttons.

Verified in-browser end-to-end: slider drives the live material +
persists; reload restores terrain metalness AND rock roughness; a
new-seed regenerate re-applies overrides onto the freshly created
decor materials.

## 2026-07-06 — texture set v2 (feature/texture-set-v2): richer colors, canonical normals

User: regenerate the texture set with richer colors, proper
materials/details, non-flipped normal maps. All 25 assets regenerated
(9 albedos at 2K, 7 heights, 9 normals at 1K).

- **Richer color**: every albedo prompt now names 3-5 distinct hues
  (gravel: terracotta / plum-grey / cream / ochre / near-black varnish;
  cliff: vermilion / burnt-sienna / plum strata + cream caps + blue-grey
  varnish streaks; crater: ash-taupe / dusty rose / lilac / sage…).
  V1 read as tinted grayscale; v2 stones on the floor are individually
  colored. Same-seed A/B: overall scene brightness identical (the
  vertex palette still owns the grading), floor +5% with much higher
  chroma.
- **Mean-luminance normalization** baked into gen-textures.mjs
  (`--normalize-only` re-levels without API calls): the shader treats
  texels as raw ~0.5-neutral values, so a bright-mean texture bleaches
  everything it covers. The fresh set came back 106-197 mean (drift
  197!) — all re-leveled to 128 multiplicatively (hue survives).
  Empirically the visible effect was small (~3%) because the palette
  dominates, but the contract is worth keeping.
- **Non-flipped normal maps**: two-layer fix. (1) The prompt now spells
  out channel directions ("where the surface tilts to face the RIGHT
  edge, red brighter than 128…"). (2) gen-normalmaps.mjs calibrates
  each generated map deterministically — correlates R/G (blurred,
  128px) against the gradient of the texture's own _h.png (bright =
  raised by construction; albedo luminance fallback for cliff/rock) and
  flips inverted channels IN THE FILE. Result: canonical files, the
  AUTHORED_FLIP_R loader hack retired (knobs kept at false for
  hand-dropped maps). The log vindicated per-map calibration: 7/9 maps
  came out R-inverted but MESA was correct-handed — a fixed global flip
  (the v1 approach) would have silently broken it. Strong correlations
  (gravel -0.71, rubble -0.73, mesa +0.81) confirm GenAI keeps layouts
  aligned enough to verify automatically after all.
- In-engine check (bump 0.5, sun -57°): stone relief lit consistently
  with geometry shadows — handedness correct; no seams (plain Repeat +
  anti-tiling dual tap); 2K albedos may contain an internal ~2x2 repeat
  painted by the model (effective detail ~1K) — acceptable, revisit if
  ground repetition shows.
- Tooling: sharp added as devDependency (JPEG encode, resampling,
  stats); img2img sources downscaled to 1K before upload.

## 2026-07-06 — v0.16 (research/voxel3d): real normal maps + texture albedo blend

Rendering/textures track kickoff (user: textures read as "monochrome
addition to vertex colors", bump is "an embossing shader trick"; wants real
bump + a control for texture-own-color vs vertex-propagated color; art
direction stays stylized-painterly).

- `src/viewer/normalMaps.ts`: tangent-space normal maps baked AT LOAD from
  the detail textures (luminance height field mixed with a 1/8-scale copy
  for broad forms, Sobel with mirrored wrap, flipY matched to
  TextureLoader). No offline asset step — regenerating textures via
  gen-textures.mjs automatically yields matching normals next run. ~1 s
  async for 3×1024², flat placeholders until ready.
- terrainMaterial: true tri-planar normal mapping (UDN swizzle per
  projection, world→view) for the three dominant surfaces — cliff sides,
  floor base, mesa top — gated by the `normalMaps` option so decor keeps
  the old emboss (also keeps the fragment-sampler count under the GL 16
  limit; accent patch layers dunes/gravel/etc. deliberately have no bump
  now). **Trap found on the way: the perturbation must MODIFY the existing
  view-space normal, not rebuild from the smooth vertex normal — replacing
  it silently discards the flat-shading facets and the whole diorama goes
  airbrushed-soft.**
- `tex albedo` slider (Render tweaks, default 0.3): crossfade between the
  classic multiplicative tint (vertex palette in charge) and the texture's
  OWN color modulated by the palette's luminance (light/dark structure —
  crevice shade, cap brightness — survives; hue/chroma come from the
  texture). At 1.0 the map goes noticeably browner/photographic; 0.2-0.4
  enriches hue while keeping the Sedona grading.
- Verified in-browser via slider A/B screenshots: bump 1.2 gives real
  directional relief on strata (reads at grazing angles where the emboss
  flattened); facets intact; decor unchanged.

**Feedback round (same day):** texture under-pronounced (detail contrast
1.35 helps — slider max raised to 2), wants more bumpiness, and decor
looked desynced (still on the oversharpened emboss).

- Bake strength 2.4 -> 4.5, fine/broad height mix 0.7/0.3.
- Decor now shares the real normal-map path (rock.jpg baked, one map in
  all three projection slots) — desync gone.
- Accent patches (dunes/gravel/crater/drift/rubble) got their emboss bump
  back, masked to the patches so the normal-mapped base isn't
  double-bumped. GPU TRAP: the first version branched on the mask, but
  triGradH uses dFdx/dFdy and screen derivatives inside divergent control
  flow are undefined — dashed speckle artifacts exactly along mask edges.
  Derivatives must stay in uniform control flow: compute unconditionally,
  weight by the mask.
- **`legacy shading` toggle** (Render tweaks, user request): uniform-driven
  runtime A/B — 1 restores the full pre-v0.16 pipeline (all-projection
  emboss, no normal maps, albedo blend forced off) with zero shader
  recompile. Uniform branches keep derivatives defined.

**GenAI normal-map experiment** (user asked "turn texture into normal map
via GenAI — will it work?"; tools/gen-normalmap-test.mjs, outputs in
tools/nmap-test/, gitignored): asked nano-banana2 for (a) a tangent-space
normal map and (b) a grayscale height map of cliff.jpg, image-to-image.
First verdict with a GENERIC prompt: not usable — redrawn layout AND
cartoon-quantized vectors (flat lavender + saturated green/crimson
stripes).

**Bug report + GenAI insistence (user):** the legacy toggle only flipped
parts of the map, and the user tried GenAI normal maps themselves with
okay-ish results — insisted on that route.

- Partial-toggle root cause: accent patches (dunes/gravel/crater/drift/
  rubble) had no baked normals, so they showed the emboss in BOTH modes —
  ~a third of the floor never visibly toggled. Fixed by giving every layer
  a true normal map: accent maps PACKED two-per-RGBA (xy in RG / xy in BA —
  the UDN blend only needs xy), keeping the terrain material at 15 of the
  16 guaranteed fragment samplers. Accent emboss removed from the new
  path; legacy mode keeps the full old emboss; toggle is now uniform.
- **GenAI maps redeemed by per-texture hint prompts**: tools/
  gen-normalmaps.mjs writes public/textures/<name>_n.png for all 9
  textures, each prompt describing what the texture depicts and what
  should protrude vs recess (strata ledges raised / bedding grooves
  recessed, stones as bumps, crack lines as grooves...). With hints the
  outputs have smooth continuous gradients and correct relief semantics —
  night-and-day vs the generic prompt. Layouts are still redrawn (not
  pixel-aligned with the albedo) but the painterly style absorbs it.
- Loader preference (normalMaps.ts): `<name>_n.png` if present, else the
  runtime Sobel bake — delete a file to fall back; `[normals]` console
  line says which source each map used.
- HUD (user request): `vox <raw> KB raw / <sparse> KB sparse` — dense
  Float32 volume footprint vs what true block-sparse storage would hold
  (mixed blocks × 4³ × 4B + one type byte per block). ~4.3 MB -> 2.3 MB at
  current wash-heavy settings.
- flat/smooth shading toggle now applies to decor materials too (they were
  hard-coded flat; synced with needsUpdate in applyRenderOptions, so decor
  rebuilt on regen inherits the current mode).

**Bug report (user): normal maps feel inverted vs the light.** Two real
sign bugs found:

1. Sobel bake had GREEN inverted: with flipY uploads, +v = image top but
   the row index grows downward, so n_v = +dy_rows — the bake stored -dy
   and every ledge lit from below.
2. **MirroredRepeatWrapping flips alternate tiles, which inverts the xy a
   normal map ENCODES there** — relief polarity flipped every ~4.5 wu tile
   (patchy "doesn't match the light" impression). The old screen-space
   emboss was immune (it differentiates the sampled field), which is why
   this never showed before. Fix: per-axis sign from tile parity
   (triMirrorSign) applied to every normal-map sample, authored and baked
   alike.

After both fixes, ledge lips light on the sun side and shadow beneath,
pebbles read raised, mesa cracks recessed — verified at two sites against
the sun azimuth.

Follow-up (user pinpointed): the GenAI-authored maps ALSO have their RED
channel drawn with inverted handedness (the tool prompt's "slope toward
right" is ambiguous). Un-detectable automatically (layouts not aligned
with the albedo) — loader now applies a calibration flip to `_n.png`
files (`AUTHORED_FLIP_R` / `_G` constants in normalMaps.ts).

**Tri-planar transition controls (user request).** Three new Render
tweaks: `blend crisp` (projection pow, 1.5-64 — near-step at max),
`blend noise` (noise displacement of the top/side boundary) and
`blend noise scale`. Implementation lesson: the noise must offset |N|.y
BEFORE the sharpening pow — displacing the input moves the boundary line
itself at any crispness, whereas scaling the weight after the pow shifts
it by ~ln(f)/p (invisible at high crisp; the first attempt did exactly
that and "didn't work"). Boundary displacement confined to the y weight:
the x<->z side boundary uses the same texture, nothing to see. Note on
visibility: this perturbs which DETAIL TEXTURE projects (cliff vs
top/mesa), not the vertex-color banding — the pale-cap/strata color line
is plateauWeight (mesher), a separate knob if noise is wanted there too.
Legacy mode pins the classic pow-4 blend.

**Height-priority layer transitions (user request).** The horizontal layer
stacks (floor: sand/dunes/gravel/crater; mesa: slickrock/drift/rubble; and
the plateau fringe itself) now blend by comparing per-layer HEIGHT +
mask dominance (classic splat height-lerp): the winning layer keeps crisp
pixels through the transition zone — stones stay solid over sand instead
of ghost-fading. `layer crisp` slider (0 = classic linear fade, legacy
pins it too).

- Heights are GenAI-generated (tools/gen-heightmaps.mjs -> <name>_h.png,
  per-texture hints: stones/plates white, dust/cracks dark), albedo
  luminance as fallback for missing files.
- Channel budget: sand/mesa heights ride in their normal maps' alpha,
  rubble height in its pack's B, the four accent heights in one packed
  RGBA (uTriAccH) — terrain lands at exactly 16 fragment samplers (the
  GL-guaranteed minimum; nothing left, next texture needs an eviction).
- The sharpened masks are written back into the shared triG* globals, so
  albedo, normal-map selection, bump and roughness all switch together
  (user: "obviously affects both albedo and normal maps" — yes).
- Verified: gravel-over-sand transition at crisp 0 vs 1 — stones fully
  solid deep into the blend zone vs ghosted crossfade.
- **Seam fix (user report: hard lines between sandy textures):** between
  two locally FEATURELESS layers the height pick degenerates — with no
  height variance, "who is higher" flips along a single contour of the
  mask: a hard seam. Two-part fix: (1) triHPick fades back to the plain
  linear mask where |hOver-hUnder| is small (flat sand blends softly,
  stones stay crisp — a self-tuning transition gap); (2) height maps are
  mean-centered to 128 at load, since GenAI/luminance heights carry
  arbitrary global levels and a level offset between layers displaces the
  whole transition. Also: yes, lerping normal maps' tangent xy is a valid
  blend (user wondered).

**"Tiling layer problem" (user): visible patches, worse at high bump /
layer crisp — suspected per-tile parameter desync.** Right instinct,
different tiles: the patches are the anti-tiling VARIATION REGIONS. The
albedo goes through triLayered (dual tap: base + rotated second copy,
swapped over noise-shaped blobs to hide tiling), but normal and height
maps were sampled with a single plain tap — inside every swap blob the
color showed the rotated copy while relief/heights showed the base copy.
Color-vs-bump disagreement over patch-shaped regions, scaling with bump
strength and layer crisp. Fix: triNmXY/triNmZW dual-tap helpers — both
taps mirror-corrected, the second tap's tangent xy rotated back through
the inverse of the triUv2 rotation, blended by the SAME variation field
(triVar) the albedo uses per texture; heights dual-tapped likewise.
Also caught: the decor shader variant referenced uTriMesa (layers-only
uniform) in the new path — undeclared identifier, invalid program (decor
rendered from stale programs; "program not valid" spam). Gated per
variant.

**View rotation (user request).** Camera orbits the map in 90° steps —
the terrain and lighting stay world-anchored (explicit: rotate the
CAMERA, not the landscape). `IsoViewer.rotateStep(±1)`: yaw becomes
YAW + steps·π/2; pan()'s screen→ground mapping and fitView's axis fit
follow the current step (odd steps swap the map's W/D on screen).
View-folder buttons ⟲/⟳ + Q/E keys (HUD hint updated). Side effects by
design: shadows/glints change per quarter (sun is world-anchored — flat
tops catch specular from some angles); known caveat: the mesa fog's
screen-space apron assumes the default orientation (+x/+z toward screen
bottom) and sits on the wrong side in rotated views (fog is off by
default; fix when fog graduates from look-test). Three stacked causes: (1) the
roughness clamp floor was 0.5, and this light rig (single sun, ortho iso,
ACES) shows no specular above ~0.35 roughness — the slider's entire range
was sub-threshold (also silently neutralized earlier global-roughness
probes); (2) effect gain too small; (3) the layer sheen weights by
UP-facing surfaces, but with a fixed sun/camera the half-vector sits ~37°
off vertical — flat ground physically can't glint, only tilted facets can,
and those were barely touched. Fixes: clamp floor 0.15, gain ×4, and the
bright-texel term (sun-worn rock) strengthened and de-gated from
up-facing so cliff facets carry the glints. Sheen 0 -> 1 now visibly adds
sun-catching sparkle on bright facets and slickrock rims.

**Residual floor seam (user: "still slightly visible; gone at bump 0, so
it's a bump problem").** Correct read — the last seam was the
triMirrorSign parity correction itself: a HARD sign flip at every
MirroredRepeat tile boundary (~4.5 wu grid), while the sampled normal
content underneath is linear/mip/aniso-FILTERED across that same
boundary. In the hairline band where filtered content and flipped sign
disagree, the tangent vector points the wrong way — a one-texel-ish
lighting crease that scales with bump and ignores layer crisp (heights
are scalar, no sign, hence immune). Fix: derivative-aware sign — the
parity ramps through zero over a fwidth-scaled band around each mirror
line, so bump fades out for a hair's width instead of flipping across
filtered texels. Verified at bump 1.5 on open sand: clean.

**Angle-corrected normal blending (user suggested UE's
BlendAngleCorrectedNormals).** Adopted — it's Reoriented Normal Mapping,
and the triplanar variant (Golus) is strictly better than our UDN
xy-add: per projection plane, the MESH normal (swizzled into that
plane's tangent frame) is the RNM base and the sampled map is reoriented
onto it, then the three results are swizzled back and weight-blended.
Wins over UDN: detail keeps its shape at grazing angles instead of
washing out (UDN's added xy is crushed by normalize when the base is
steep), and RNM is an exact identity at bump 0 — the flat-shading facets
pass through untouched by construction, where UDN only preserved them
approximately. Bump strength scales the sampled tangent xy BEFORE
reorienting; the legacy gate rides in the same scale (strength 0 ⇒
identity ⇒ legacy emboss applies to the raw mesh normal as before).
`triRnm()` guards its division by construction (base.z arrives as
abs(axis)+1 ≥ 1). Decor shares the path via the same shader factory.
Verified: floor at bump 1.5 seam-free and unchanged in character; mesa
tops/strata read crisper on slopes.

**Mirror tiling off by default (user: "might be problematic — at least
provide a toggle").** Fair — MirroredRepeat caused two real bugs (per-
tile normal handedness inversion, then the hairline sign-step seams) for
one benefit (hiding hard tile edges), and the anti-tiling dual tap
already masks those edges. Now: plain RepeatWrapping by default,
`mirror tiling` checkbox in Render tweaks. All tiled textures (albedos +
async-baked normal/height packs) register with terrainMaterial's
`registerTiledTexture`, and `setMirrorTiling` flips wrap + re-uploads at
runtime; the shader-side handedness correction is gated by the matching
uTriMirror uniform (mix inside triMirrorSign — no recompile, and the two
MUST agree or relief polarity alternates per tile). A/B verified at bump
1.2: repeat mode shows no visible tile edges on floors or mesa tops.

User: the existing terrace tweaks are "very minimalistic" — wants a real
stepped/benched canyon-wall look. Two coordinated changes:

- **Heightfield terracing reworked** (fields.ts): riser sharpness is now a
  parameter (`terraceSharp`: riser half-width 0.35 -> 0.06, treads go
  dead-flat at 1); band phase undulated by low-freq fBm so strata lines
  wander instead of tracing ruler-straight contours; and the flank window
  widened (stepWeight vs the old parabolic bandWeight, which faded the
  upper/lower steps into mush — a main cause of the old minimal look).
- **3D strata benches** (volume.ts): per elevation band, the upper half
  (resistant caprock) protrudes and the lower half (soft layer) recesses by
  `ledgeAmp` — the face gets channeled into benches with an overhang lip
  under every cap even where the slope is too steep for heightfield
  terracing to carve wide treads (tread width = step/slope ≈ 0.3-0.6 wu
  here, too narrow on its own — the first lip-only attempt proved that).
  Band phase uses the SAME jitter formula as fields.ts so the 3D benches
  ride the heightfield strata. Influence band widened by ledgeAmp so the
  block classification stays conservative.
- New "Walls & floor" sliders: `terrace sharp` (default 0.65) and
  `strata ledges` (default 0.18 — subtle); evaluated in-browser at
  sharp 0.9 / ledges 0.45 / amt 0.9: walls read as layered buttes with
  crisp under-cap shadows at gameplay zoom, spurs pick up ringed steps.
  Those cranked values are in the session localStorage for user tuning.

## 2026-07-06 — v0.14 (branch `research/voxel3d`): block-sparse density volume

Kickoff of the true-3D terrain research track (goal: arches + overhangs —
tunnels were considered and dropped as impractical for the map). Step 1 is
pure infrastructure: make the density volume block-sparse so a genuinely 3D
field (carve ops, more 3D noise) stays inside the regen budget, with **zero
output change**.

- `src/gen/volume.ts`: the density fill moved out of the mesher into
  `buildDensityVolume()`. The volume is split into 4³ blocks classified
  AIR / SOLID / MIXED against per-column surface bands
  `[groundH - influence, groundH + influence]` over a 1-voxel-padded
  footprint; only MIXED blocks are evaluated per voxel, homogeneous blocks
  are constant-filled (sign is all the mesher reads there). Storage stays
  one dense Float32Array — the sparsity is in evaluation/traversal, which
  is where the time goes (a few MB dense is irrelevant at this scale).
- `surfacenets.ts`: traversal keeps the exact global z→y→x cell order but
  skips whole non-MIXED block runs, so the emitted vertex/index streams
  are **byte-identical** to the brute-force path — that's the correctness
  contract, not "looks the same".
- `tools/verify-volume.ts` (npx tsx): A/B check classified vs forceAllMixed
  across 5 seeds × 3 voxel sizes — asserts byte-identical geometry and
  sign-identical density at every voxel (AO reads signs only).
- **Bug found by the verifier**: the diorama-skirt rule (volume boundary
  forced to air) was only applied to blocks *containing* boundary voxels,
  but cells in a block's last row read corners one voxel further — with a
  1-voxel-thin final block the skirt crossings sit in the *inner* neighbor,
  which classified SOLID and got skipped (dropped ~5.6k verts at
  voxel 0.15). BLOCK=8 masked it by luck of nz%8; BLOCK=4 exposed it.
  Fix: boundary-force any would-be-solid block whose padded range reaches
  the forced-air shell.
- BLOCK=4 beats 8: tighter hull around cliff faces (27% vs 36% mixed at
  voxel 0.15) and faster nets. Numbers (seed 42): voxel 0.3 — mixed 41%,
  nets 28→24 ms; voxel 0.15 — mixed 27%, fill 182→163 ms, nets 181→105 ms.
  Modest at 0.3 (noise eval was already band-gated); the win grows with
  resolution, and the block grid is the hook for per-block carve-op lists
  in the next step.
- Mesher now logs a `[mesher]` console.debug line with block stats + stage
  timings. Verified in-browser: default map renders identically, gen 466 ms
  total (fill 39, nets 66, normals+ao 107, color 33).

**Same day — carve-op stage + natural arches:**

- `src/gen/carves.ts`: `CarveOp` = inside-positive pseudo-SDF + conservative
  world bounds; `add` unions rock in (`d = max(d, sdf)`), `cut` subtracts
  (`d = min(d, -sdf)`, unused yet — reserved for fin windows). Ops plug into
  `buildDensityVolume` after the column fill: blocks whose padded range
  intersects an op's bounds are forced MIXED and get a per-block op list —
  assignment depends only on the bounds, so the byte-identity contract
  (verify-volume, now with `archCount 4`) covers ops too.
- **Arch = natural bridge over a corridor throat.** Placement is fully
  deterministic from the fields, no RNG: from each flat hex, probe 24 radial
  directions in the 2D SDF for the nearest wall and a facing wall within
  ±30° of opposite; span + both-rims-high-enough → candidate; greedy pick by
  score (rim height / span) with ≥6 wu separation. The op solid is a
  wall-to-wall beam: flat deck (plateau remnant — picks up the cap color +
  mesa texture layers automatically), parabolic underside thickest at the
  abutments, small fBm perturbation on edges/underside so the CSG doesn't
  read machine-cut.
- Placement iteration (caught by running the verifier across seeds, not by
  eye): v1 sampled rim height at fixed 1.1 wu behind the wall face — walls
  ease up over `wallThickness`, so that's a low shoulder and most seeds got
  ZERO arches. v2 marched inward to the first tall-enough rock — still
  starved seeds whose mesas sink (per-region altitude offsets; seed 12345's
  best reachable rock is 4.26 wu vs the 4.9 bar). v3: anchor at the HIGHEST
  rock within `wallThickness+1.5` of the face, sink the deck 10% below the
  lower rim, and let deck thickness give way (min 0.35) so only the
  clearance itself is a hard requirement. All test seeds now place 1–4
  arches (some maps genuinely offer few sites).
- Hexes under a deck keep their floor untouched (ops live only in the 3D
  volume; 2D fields and the draped overlays never see them), so passability
  and the grid are unchanged — the bridge just roofs an existing corridor.
  Clearance under the deck is guaranteed by construction (default 1.9 wu).
- "3D carve" GUI folder: arches / arch width / deck thickness / clearance /
  max span. Verified in-browser at seed 16859: 2/2 arches, the central one
  reads as a pale-capped rock span rooted into two mesas with the corridor
  grid running beneath; `[carves]` debug line logs placements + world
  coords.

**Feedback: "those arches won't cut it — just slabs."** User wants an
actual cut through existing walls or a real arched formation with a hole
underneath. Redesign (same day):

- **Arch = plug + vault** instead of a floating beam. The `add` op is now a
  full-height rock mass filling the throat wall-to-wall (rooted below the
  floor, crown blending between the two abutment heights with an eroded
  mid-span saddle); a `cut` op pierces an arched slot through it along the
  corridor — vertical sides to the spring line, semicircular crown, hugging
  the wall faces so no legs land on passable cells and the passage keeps
  its width. Op array is ordered adds-then-cuts so openings always win.
  Result reads as the canyon walls meeting overhead with a genuine dark
  vault beneath (verified in-browser; the plug merges invisibly with the
  strata).
- **Fin windows**: cut-only holes punched through thin tall fins (wall
  columns with |s2| <= 1.15 and open air on BOTH sides within reach), well
  above the floor — no passability impact. Scarce by nature on this
  generator's thick walls (0-1 per map typically); scan is deterministic.
- **Op-bounds invariant learned the hard way**: the vault slot was bounded
  only by its AABB while the sdf leaked along the passage axis — ops
  evaluate wherever their block list reaches, so phantom slot surfaces
  appeared at list boundaries and the verifier caught missing vertices
  (sign-scan clean, traversal divergent). CarveOp now documents the
  contract: sdf <= 0 everywhere outside the declared bounds; the slot got
  an explicit along-axis bound.
- `IsoViewer.lookAtWorld(x, z, zoom)` + `window.__cw` dev hook: scripted
  Playwright verification can now frame any world position instead of
  blind wheel-zooming.

**Same day — "washed foundation" basal erosion (user request):**

- In the base density fill (volume.ts, not an op): an erosion notch cut
  into wall faces — deepest at floor level, tapering to nothing over
  `washHeight` — driven by the per-column 2D SDF (depth into the wall).
  Gated by a map-wide LARGE-SCALE fBm mask (`washScale`, default 0.05 ->
  ~20 wu patches; `washCoverage` sets the threshold) times a medium-scale
  detail that scallops the grotto mouths, per explicit user direction that
  the effect must be patchy, not map-wide. Never cuts below floor+0.12,
  never outside walls (bounded by s2), so the flat playable floor and
  passability are untouched.
- Exactness: washed columns extend their classification band down to the
  floor; the notch is strictly contained in gated columns, and the existing
  ±1-column footprint padding covers edge reach into neighbors — verifier
  stays byte-identical with wash at coverage 0.7 across all seeds/voxels.
- Four sliders in "3D carve": base wash (depth), wash height, wash
  coverage, wash scale. Look verified in-browser: washed stretches show
  bright overhanging rims over deep-shadowed basal hollows; unwashed
  stretches keep the crisp talus line. Gen ~500 ms at defaults.

**Bug report: "bright spots at ground level next to walls in shadowed
areas" with wash tweaked up.** Investigation (A/B with wash on/off,
decor on/off, texture on/off at fixed cameras via the new lookAtWorld
hook) found three stacked causes; all fixed:

1. **Grazing notch ceiling** (geometry): the linear depth taper met the
   wall face at a razor angle, smearing a band of sliver triangles.
   Fixed: sqrt profile — vertical tangent at the top, the ceiling meets
   the face in a crisp lip — plus a 0.04 erosion to trim sub-voxel
   hairlines.
2. **Mesa texture on grotto ceilings** (shader): the triplanar top
   projection weights by |normal.y|⁴ and the plateau layer blended by
   world-y only, so DOWN-facing notch ceilings above uTriPlateauY-1.2
   received the pale slickrock texture. Fixed: plateau blend now
   multiplied by a signed up-facing gate (smoothstep 0.15..0.5 of
   normal.y). Note: pale patches on up-facing wall shoulders crossing the
   y threshold exist WITHOUT wash and are part of the established look —
   left alone.
3. **Pierced wall bases** (the actual "bright spots in shadow"): at high
   amp/coverage, notches washed from opposite faces of a thin wall met at
   the base — real sunlight streamed through a gap under an intact-looking
   lip and dappled the shadowed floor (the reporter's instinct said shadow
   mapping; the shadow map was fine — the wall genuinely had holes).
   Fixed: per-column pierce guard — march inward along -grad(s2); the
   most-negative s2 on the ray IS the local half-thickness (the ray
   crosses the medial and exits the far side, so neighboring walls can't
   contaminate the estimate); clamp notch depth to keep a >=0.45 wu solid
   core. Verified at worst-case settings (amp 1.6, coverage 1.0, sun 32°):
   shadow bands read uniformly dark; verifier stays byte-identical.

**Round 2 — user still saw "shine through" on wall undersides and was
convinced it's shadow leaking (resolution?).** Settled empirically with a
live A/B matrix at the exact artifact (window.__cw camera hook + Playwright
page.evaluate): normalBias 0.2→0.02 — no change; bias -0.0008→-0.004 — no
change; shadowSide DoubleSide — no change; 8K shadow map — no change; **sun
intensity 0 — patches STILL THERE.** With no direct light there is no
shadowing, so this is definitively pale ALBEDO under ambient, which the eye
reads as leaked light inside a shadowed wall base. The shadow stack is
healthy; don't re-litigate it (the experiment script pattern is in this
entry's commit).

Root cause: the plateau-cap color rule was `up-facing AND y > wallHeight *
0.45 (≈2.34)` — ANY rounded knob above 2.34 turned bleached-cream, and the
shader's mesa-texture layer used the same bare y smoothstep (weighted by
abs(normal.y)^4, so even DOWN-facing grotto ceilings took it). Pure
heightfield terrain never exposed this badly; the wash mass-produces
rounded lips and knobs at wall bases right next to dark hollows.

Fixes (all albedo-side):
- `plateauWeight()` in mesher.ts: cap requires (near own column top) AND
  (deep inside a wall region — smoothstep on -s2 — OR genuinely tall) AND
  a minimum height. Sunken mesa tops keep their cap (interior test); arch
  decks keep it (they rise above groundH, hEff = max(h, y) handles them);
  basal knobs and wash lips are demoted to the floor branch.
- `facies` attribute extended to vec3; `.z` = baked plateau weight; the
  shader's triPlateau now uses the baked channel (plus the signed
  up-facing gate from round 1) instead of the y smoothstep.
- Floor-branch contact shading strengthened for up-facing surfaces ON the
  wall footprint (s2 < 0): extra lerp toward CREVICE, so demoted benches
  read as dark rock shelf, not bright sand.
- Also kept from round 1 (real but secondary): sqrt notch profile (no
  grazing sliver band), rock-overhead crevice tint via density probes
  (grotto interiors darken), wash pierce guard.
Verified at the two reported artifact walls: pale patches gone / demoted
to warm rock; mesa tops, terraces and arch decks keep the established
pale-cap look.

**Round 3 — user still reports leak-like patches, requested a taller wash
with the notch floor pinned to ground level.** Done + shadow hardening:

- Notch bottom now sits exactly at floorBase (was floor+0.12 — the raised
  step at mouths is gone); washHeight slider extended to 4.5 — tall washes
  read as proper grottoes/galleries.
- `terrainMaterial.shadowSide = THREE.DoubleSide`: with back-face-only
  shadow depth (three.js default), thin rock — wash lips, remnant cores —
  is a classic light-leak vector; both-faces depth makes even paper-thin
  occluders reliable. No acne observed (normalBias 0.2 absorbs it).
- Pierce-guard min core 0.45 -> 0.8 wu (thicker occluders), and the guard's
  ray march reach extended to depth+0.9 — the old reach (depth+0.5) paired
  with the old core; reusing it would have silently shaved 0.3 off EVERY
  wash on thick walls (march can't see deeper than it walks).
- Hunted for genuine shadow leaks with hemisphere light disabled (pure sun:
  any leak glows against black): none found across six shadow-side walls at
  amp 1.5 / height 3.5 / coverage 1.0. If a leak sighting persists, get the
  exact spot + params and re-run the sun-off / hemi-off discriminator pair
  there before touching the shadow stack.

## 2026-07-05 — v0.13: decorative mesa fog of war (look test)

Goal: test a decorative "fog of war" veiling the large impassable mesa
islands (future: hide fly-only / unexplored regions).

- `src/viewer/mesaFog.ts`: alpha mask baked from the wall raster
  (wallMask > 0.35), box-blurred well past the rims, feathered at the
  raster border (no hard plane edge over the diorama rim). Five
  stacked translucent sheets (MeshBasicMaterial, depthWrite off,
  renderOrder after opaque terrain), each baking its OWN puff pattern —
  shaped fBm with real gaps between billows, then the whole alpha field
  box-blurred again so billows melt together instead of showing crisp
  noise contours — and a sandstorm dust tint that darkens toward the
  lower layers (240/198/146 -> 212/148/86), puff cores slightly darker
  (thick dust). Iterated on feedback twice: v1 was two thin whitish
  sheets on deep-wall only (too small, flat, white); v2 three sheets;
  v3 five sheets, triple coverage blur + per-layer alpha blur.
- **Screen-space apron** (feedback iteration): a first attempt at
  "bottom coverage" used low sheets intersecting the terrain — rejected,
  semitransparent plane/terrain intersections look ugly. Instead the
  bake grid extends ~14 wu past the +x/+z borders (the two directions
  that point toward the BOTTOM OF THE SCREEN in the fixed iso view),
  continuing the border alpha outward with a long fade. The high sheets
  then visually curtain the diorama base that used to protrude under
  the fog — the map reads as emerging from an endless dust sea, and no
  sheet ever touches terrain. The -x/-z (top-of-screen) borders keep
  the short feather.
- Rebuilt each regen from the current fields; `mesa fog` toggle in the
  View folder (off by default).
- Look: a layered dust-storm bank swallowing the mesa islands, billowy
  fingers spilling over the canyon rims; the playable floor stays
  readable through the clear channel.
- **Drifting cloud shadows** (same session): big soft value-noise blobs
  cut the DIRECT sunlight (directDiffuse/directSpecular in the shader's
  aomap injection, now unconditional — the noise helpers moved out of
  the layers-only block). The offset advances each frame in the render
  loop, so shadow patches drift slowly across the map; terrain and
  decor darken consistently. `cloud shadows` slider in Render tweaks
  (0–0.6, default 0.3), but the effect is active only while `mesa fog`
  is on — it belongs to the storm look; the base scene stays static.
  `docs/shots/v0.13-cloud-shadows.jpg`.

Screenshot: `docs/shots/v0.13-mesa-fog.jpg`.

## 2026-07-05 — v0.12: mesa top variety — levels, doming, drainage

Feedback: "the elephant in the room — flat and too similar mesa tops."
Picked ideas 1–3 of five proposed (per-mesa levels, doming + sand
hollows, drainage channels).

- **Per-mesa altitude offsets** (`mesaOffsets` in fields.ts): closed
  (wall) columns flood-filled into connected regions; each region rolls
  an offset in whole plateau-quantization steps — sunken (-1, 30%),
  base (30%), raised (+1, 28%), towering (+2, 12%). Labels dilated a few
  columns into the open fringe so the ridge-perturbed boundary samples a
  consistent offset. Adjacent mesas at different heights give the map a
  skyline; regions are naturally separated by corridors.
- **Doming**: low-frequency fBm swell (±0.8 wu) added to the wall height,
  weighted by `smoothstep(0.55, 0.95, w)` so it fades at the rim — tops
  roll and tilt but silhouette edges stay crisp. The same dome field
  drives color: hollows (dome < -0.12) blend toward floor sand -> sand
  pockets collect in the dips.
- **Drainage channels**: the existing flank-gully ridged-noise field now
  also carves across the tops (`0.55 * smoothstep(0.6, 0.95, w)` on top
  of the mid-flank band weight). Same field = channels continue over the
  rim and notch it where they run off. Channel lines also darken the top
  color slightly (desert varnish).
- Plateau color/texture thresholds lowered (0.66 -> 0.45 wallHeight in
  colorize, plateauY uniform 0.6 -> 0.45) so sunken mesas keep their
  mesa look; deep channel bottoms read sandy (wash bottoms).
- **Mesa-top texture facies** (follow-up feedback: tops still needed
  floor-style texture variety): the plateau layer is no longer a single
  mesa texture. A per-vertex `facies` attribute bakes the dome-hollow
  morphology (same fBm field as the swell); the shader pools a sand
  layer in hollows (broken up by world-space noise) and scatters rubble
  patches over the rest of the slickrock. Bump gradients and roughness
  follow the same weights. Sand-pocket vertex colors + drift texture
  land in the same dips -> texture follows morphology.
- **Mesa-specific textures** (feedback: don't reuse the floor set up
  top): two more nano-banana2 textures — drift.jpg (thin pale sand
  sheet drifted over slickrock, bare rock showing through) and
  rubble.jpg (dark-varnished chip lag on pale bedrock). The plateau
  facies use these instead of the floor's dunes/gravel, so tops read as
  wind-swept caprock rather than a raised canyon floor.
- **Crater interior texture**: craters get their own layer — crater.jpg
  (nano-banana2: cool ash-taupe dust, hairline desiccation cracks,
  glassy ejecta pebbles). The `facies` attribute grew to a vec2; its y
  channel bakes a crater weight from craterD (1 in the bowl, fading at
  the rim crest), and the shader blends the ash layer over the floor
  inside that weight — bowls read as a different material that hands
  off to the ordinary floor exactly at the rim, matching the vertex
  color bands.
- **Texture-mask debug overlay** (View > texture masks): color-codes
  every layer region at once — tan base sand, orange dunes, brown
  gravel, magenta crater interiors, sky slickrock, blue drift, green
  rubble; steep faces grayed. Live uniform, no recompile.
  `docs/shots/v0.12-texture-masks.jpg`.
- Bug the offsets exposed (user: "black ring at the top of walls"): the
  strata palette was indexed `band % 5`, so walls taller than 5 bands
  wrapped back to the darkest bottom stratum right under the pale cap.
  Walls never got that tall before towering mesas. The index now clamps
  at the light end of the sequence, with a small per-band shade jitter
  so tall walls keep readable banding.

Screenshots: `docs/shots/v0.12-mesa-levels.jpg`,
`docs/shots/v0.12-mesa-tops-close.jpg`.

## 2026-07-05 — v0.11: pillar variety + sand ground-contact blend

Goal: pillar variation (height, profile, lean, cap or no cap) and a way
to blend the sandy floor color into pillar/boulder bottoms at ground
contact.

- **Four pillar archetypes** (`PillarStyle` in decor.ts, weighted pick):
  - *hoodoo* — the classic: flared foot, eroded waist, narrow neck,
    balancing cap stone (85% of the time now, not always)
  - *spire* — tall (up to 1.35x wall height after feedback) strongly
    tapered needle, no cap; 40% get a pronounced whole-body tilt
  - *totem* — blocky stacked bands (stronger band amplitude + per-band
    radius jumps from a hash), capped 45% of the time
  - *butte* — squat and wide with a pale flat top under a **dark slanted
    caprock slab** (overhanging ~1.2x the shaft radius)
  Each has its own height/radius ranges; footprints stay hex-contained
  (tilted spires may overhang visually — decorative only).
- **Lean**: progressive centerline drift (offset grows with height,
  direction random); top offset clamped to ~0.9·r0. Cap stone follows
  the drift. Tilted spires rotate the whole group on top of it.
- **Balancing cap stones enlarged ~1.3x** (1.3–1.9·r0, was 1.0–1.45) —
  hoodoos read as balanced-rock formations; a first 2x pass was overkill
  (cartoon mushrooms) and got pulled back on feedback.
- Shaft cylinders are now closed (profile math multiplies the original
  coords instead of rebuilding from the angle, so cap-disk vertices
  survive) — capless tops don't show a hole.
- **Sand contact blend**:
  - pillar shafts: baked into vertex colors (sand lerp over the bottom
    ~0.65 wu)
  - boulders / scree / pillar rubble: new `sandContact` option in
    `applyTriplanarDetail` — blends a sand tint over the object-space
    bottom of each instance (rocks are buried ~0.25·scale, so the range
    [0.1, 0.6] local starts just above the ground line; first attempt
    used [-0.55, 0.05], which is entirely underground -> invisible).
    Detail texture still multiplies over the tint so grain carries.
  - scree no longer tumbles fully around X (rest pose ±0.35 rad) so the
    sand skirt stays down.
- `applyTriplanarDetail` positional flags refactored into a
  `DetailOptions` object ({layers, vertexAo, sandContact}).

Screenshots: `docs/shots/v0.11-pillar-variety.jpg`,
`docs/shots/v0.11-pillars-wide.jpg`, `docs/shots/v0.11-buttes.jpg`
(all-butte debug roll showing the dark caprock slabs).

## 2026-07-05 — v0.10: light pass — baked AO, terrain self-shadowing, sun controls

Goal: tweakable AO + self-shadowing for the terrain; larger boulders
casting shadows.

- Finding: every mesh already had castShadow/receiveShadow on — shadows
  just didn't *read*. The sun sat at ~65° elevation (short stubs of
  shadow) and `normalBias 0.4` swallowed small-object contact shadows.
- **Baked per-vertex AO** (`bakeAo` in mesher.ts): rays marched through
  the density volume that's already in hand at meshing time; first solid
  hit occludes by distance weight. Stored as an `ao` geometry attribute;
  the shader applies it via a live `AO amount` uniform (full on indirect
  light, 45% on direct, full on specular) — tweaking needs no rebake.
  Costs ~50 ms of the regen.
- AO bake v2 (feedback: barely noticeable even at 1.0): the first fan
  was too normal-biased (dirs bent by a full normal) — rays escaped
  upward and 99.5% of vertices baked ~1.0. Now 12 rays (8 corners + 4
  compass) bent by only 0.6·normal so they hug the surface and actually
  hit nearby walls, marching 4 steps out to 4 wu to catch canyon-scale
  enclosure (mean 0.995 -> 0.898, 12x more vertices in shadow range),
  plus a pow(ao, 2.2) contrast curve in the shader. Wall-base contact
  lines, hoodoo footings, crater bowls and fissure pits now read.
- **Sun rig controls** (live): `sun azimuth` / `sun elevation` sliders
  (spherical placement, radius fitted to the map), `shadow strength`
  via `light.shadow.intensity` (three r163+). Default elevation dropped
  65° -> 45° so walls, hoodoos and boulders throw real shadows.
- Shadow quality: map 2048 -> 4096, normalBias 0.4 -> 0.2, bias
  -0.0015 -> -0.0008 — boulder contact shadows show, no acne even at
  28° test elevation.
- AO + vertex-color contact shade + crack tint stack fine — AO is
  light-space so it deepens under the hemi fill without muddying the sun
  side.

- **Wireframe toggle** (View folder): terrain + all decor materials flip
  to wireframe live (no recompile — it's a render-state flag). Colors,
  lighting and AO still apply, so the surface-nets topology showcases
  well: `docs/shots/v0.10-wireframe.jpg`.

Screenshots: `docs/shots/v0.10-light-ao.jpg`,
`docs/shots/v0.10-light-ao-close.jpg` (AO at 1.0),
`docs/shots/v0.10-sun-swing.jpg` (azimuth 120 / elevation 28 / AO 1 —
long evening shadows), `docs/shots/v0.10-wireframe.jpg`.

## 2026-07-05 — v0.9: bump & sheen from the detail textures + render tweaks

Goal: normal/roughness variation without authoring normal maps. Mid-pass
feedback: first tuning was way too contrasty — reduced, and the shader
knobs got exposed as a "Render tweaks" GUI folder.

- Screen-space bump: the detail textures double as height fields; a
  per-projection height gradient perturbs the shading normal with the
  same math as three's bumpmap `perturbNormalArb`. Works through the
  tri-planar blend and instancing for free — mesa crack plates, dune
  ripples and cliff strata all pick up relief.
- Pixelation fix (feedback: "some sort of filtering missing on sampling
  bump", scale-independent): the first version took `dFdx/dFdy` of the
  *already-sampled* luminance — GPU derivatives are constant per 2x2
  pixel quad, so the bump normal was quad-blocky salt-and-pepper. Now the
  gradient is built like three's `dHdxy_fwd`: the height is re-sampled at
  `uv + dFdx(uv)` / `uv + dFdy(uv)`, so every tap goes through the
  regular mip/aniso filtering — per-pixel gradients, and bump fades
  naturally with minification. Gradients are taken per projection
  (side/top, layer textures blended by the same patch masks) and blended
  by the tri-planar weights. With the grit gone, default strength went
  0.35 -> 0.5.
- Roughness variation (base material stays roughness 1): bright detail
  reads smoother, dune patches get a slight sheen, plateau slickrock a
  polish, gravel stays matte (per-layer offsets ride the existing masks).
  Clamped to [0.5, 1] after the too-contrasty first pass.
- "Render tweaks" folder (all live uniforms, no recompile): texture amt /
  scale (moved from View), bump, sheen, detail contrast (around mid-gray),
  hue bleed (was hardcoded 0.3), macro patches (was hardcoded 0.3).
- Pipeline note: three's fragment order is color -> roughness -> normal,
  so the height/roughness offsets are stashed in globals in
  `color_fragment` and consumed by the later includes.

Screenshots: `docs/shots/v0.9-bump-sheen.jpg`,
`docs/shots/v0.9-bump-sheen-close.jpg`.

## 2026-07-05 — v0.8: layered floor & mesa detail

Feedback: floors need more variation (sandy patches / rocky patches / mini
dunes); exposed canyon tops too barren — wanted cracks / rock pools.

- Three more nano-banana2 textures: dunes.jpg (painted ripple crests),
  gravel.jpg (rocky desert pavement), mesa.jpg (cracked slickrock plates
  with dark potholes / rock pools — the Sedona tinaja look).
- Top projection is now multi-layer (terrain material only, decor keeps
  the single rock detail):
  - base sand -> dune-ripple patches -> gravel patches, masked by
    2-octave value noise in **world space** (patch size a few hexes,
    independent of the texture-scale slider; thresholds tuned to ~30% /
    ~20% coverage)
  - above `wallHeight * 0.6` (uPlateauY uniform, updated on regen) the
    layer blends to the mesa texture -> plateau tops get crack networks
    and pools instead of bare cap color
- Hue bleed nudged 0.25 -> 0.3 so gravel stones read slightly rockier.
- Each layer still goes through the dual-sample anti-tiling from v0.7.

Screenshots: `docs/shots/v0.8-floor-layers.jpg`,
`docs/shots/v0.8-floor-layers-close.jpg`.

## 2026-07-05 — v0.7: rendering pass — GenAI textures + tri-planar detail shader

Feedback: work on rendering quality — find/generate proper textures, play
with shaders; texture blending/layering welcome to fight repetition. Free
stock textures were an option, but nano-banana2 output matched the
painterly concept style better than photoreal CC0 (Polyhaven/ambientCG)
would.

- `tools/gen-textures.mjs`: generates tileable detail textures with
  nano-banana2 (`gemini-3-pro-image`) into `public/textures/` — cliff.jpg
  (horizontal strata bands), sand.jpg (dust + ripples), rock.jpg (granular
  weathered stone). Prompts insist on orthogonal view / even lighting /
  seamless wrap; MirroredRepeatWrapping hides any residual seams. API key
  read from `.env.local` (gitignored via `*.local`).
- `src/viewer/terrainMaterial.ts`: tri-planar detail injected into
  MeshStandardMaterial via onBeforeCompile. Side projections sample cliff
  (bands stay horizontal), top samples sand; weights = normal^4.
- Anti-repetition layering: each projection blends two samples of the same
  texture (second rotated ~137 deg, rescaled 1.37x) by a low-frequency
  variation field sampled from the texture itself, plus a very-low-freq
  macro layer for large tonal patches. No visible tiling at map scale.
- Palette preservation: first attempt multiplied the full-color texture ->
  whole scene over-tinted orange, mesa caps lost. Fixed with
  mostly-luminance detail (25% hue bleed): vertex palette (caps, crater
  bands, crack slots, crevice shade) stays authoritative.
- Decor: same injection with rock.jpg on every boulder/pillar/scree
  material (instancing handled in the shader via instanceMatrix).
- View panel: `texture amt` / `texture scale` sliders drive shared
  uniforms — live, no recompile.

Screenshots: `docs/shots/v0.7-textured.jpg`,
`docs/shots/v0.7-textured-close.jpg`.

## 2026-07-05 — v0.6: hex-aligned fissures

Feedback: add cracks/fissures on the terrain (and perhaps on ridge tops) as
hex-aligned passability blockers for crawlers (not flyers); bonus for
continuous cracks through several hexes so a future map region can be
reachable only by flying over.

- `placeCracks` (fields.ts): each fissure spans 1–2 adjoining open hexes
  (short heading-directed walk; starts keep a 1-hex gap from other cracks).
  Single-hex cracks are a short segment through the jittered center;
  multi-hex ones run tip-extended through jittered centers + midpoints, so
  the band always stays inside its hex chain.
- Crack hexes are excluded from `hexFlat` -> obstructed, same contract as
  craters. Crawlers can't cross, flyers can.
- Carving: `crackD` raster (normalized distance to centerline, per-segment
  bbox), semicircular slot profile + fBm jag, width tapers to a point at
  both tips. Carved AFTER the flatten pass but hard-clipped by the
  unblurred flat mask — a crack can never punch a hole into a passable hex
  (the dark tint still paints over clipped corners).
- Color: slot interior falls to near-black rust (#2b1208) with a pale
  weathered lip (#ecc9a0).
- Decor keeps out: boulders/scree reject spots over the slot; pillars and
  hex-blocking boulders now require a flat hex (also fixes them landing in
  crater bowls).
- Params: crackCount 4, crackLenMin/Max 1/2 hexes, crackWidth 0.35,
  crackDepth 0.8 (+ Decor panel sliders).
- First pass was multi-hex barrier chains (5–12 hexes, deep slots, could
  cross ridges and seal off regions — verified NE exit cut on seed 1337).
  User feedback: too large — scaled down to 1–2 hex micro-fissures,
  shallower. The walk is length-generic, so barrier cracks are just
  crackLenMax + crackDepth away when region-sealing becomes a real feature.

Screenshots: `docs/shots/v0.6-fissures.jpg`,
`docs/shots/v0.6-fissure-detail.jpg`.

## 2026-07-05 — v0.5: readable colored craters

Feedback: craters should be more readable, with color in the bowl and walls.

- Profile punch-up (fields.ts): compact bowl (raised-cosine over 0..0.8·r,
  deeper default 0.5) + a taller, tighter rim crest centered at 0.85·r
  (well inside the footprint so hex-flattening outside can't clip it).
- Replaced the vague `craterTint` with `craterD` — normalized distance to
  the nearest crater center (0 = center, 1 = rim, ~1.5 = ejecta edge, 9 =
  none) — a proper field the colorizer can band on.
- Crater color bands (mesher.ts): dusty ash-taupe bowl (#9c6a54) -> tan
  inner slope (#c08a5f) -> sun-bleached rim crest (#f2d4a6) -> pale ejecta
  dust ring (#e7ba8a) fading out, edges broken up by dither. Bands are
  deliberately lighter/cooler than the rust walls (first pass was too
  dark — bowl matched the wall-base crevice shade and just read as more
  shadow); blend strength eased to 0.8.
- Verified with passability overlay: crater center hexes read obstructed
  (red), rim/ejecta stay playable (green) — geometry matches passability.

Screenshot: `docs/shots/v0.5-craters.png` (craterCount 10, seed 1337).

## 2026-07-05 — v0.4: hoodoo pillars

Feedback: pillar geometry lackluster — no footing, top looked clipped off;
wanted height variation and a balancing stone on top.

Rebuilt `makePillar` as a hoodoo (returns a Group):

- Shaft from an open-ended unit cylinder, radius driven by a profile:
  flared footing (exp falloff), eroded waist (sin), narrow neck below the
  top (smoothstep), subtle strata ledges (sin bands aligned to
  terraceStep), angular fBm roughness. Strata vertex colors per band.
- Balancing cap stone: perturbed flattened icosahedron, wider than the
  neck (1.0–1.45·r0), randomly offset (±0.3·r0) and tilted (±0.22 rad),
  sunk into the shaft top so no seam shows; darker cap-rock tone.
- Footing rubble: 2–4 small rocks scattered around the base.
- Height range widened to 0.35–0.95·wallHeight (stumps to towers);
  nominal radius 0.36–0.48·hexSize so flare + noise + cap stay inside
  the hex inradius (pillars remain hex-center-snapped, one blocked hex).

Screenshot: `docs/shots/v0.4-hoodoo-pillars.png` (pillarCount 6).

## 2026-07-05 — v0.3: gameplay-first passability

Feedback: exit areas largely impassable, dead cells visually clear of
walls, crater borders "all over the place", pillars offset from the hex
grid blocking wrong-looking cells.

Root cause: passability was *derived from* geometry (height-deviation
sampling), so ridge noise / talus / crater rims made it fuzzy. Inverted
the relationship — **hex-level decision first, geometry follows**:

- `hexFlat` per hex, decided in buildFields before any profile math:
  open && SDF at center > 0.3·hexSize && not inside a crater footprint.
- Flatten-weight raster (per-hex flags, box-blurred ~half a hex) forces
  `groundH -> floorBase` and kills wall-band noise on flat hexes: walls,
  talus and crater rims physically cannot creep onto passable cells.
- `computeObstructed` is now just `open && !hexFlat` — deterministic,
  no height sampling, no tolerance tuning.
- Craters: hexes with center inside radius are obstructed and keep the
  bowl; everything outside is flattened -> crisp hex-aligned footprint.
- Pillars snap to hex centers, radius capped (≤0.6·size, noise bulge
  stays inside the hex inradius). Hex-blocking boulders (≥0.5) also snap
  to their hex center with capped footprint; small ones stay free.

Result (seed 1337): playable 28% -> 40% of map (open 47%), grid runs to
wall bases and through exits to the border, no orphan dead zones.
Screenshot: `docs/shots/v0.3-flatfloor-zoom.png`.

Possible follow-up: crater read is subtler now that rims clip at flat
hexes — may want deeper default bowl or a raised-rim ring inside the
crater hexes only.

## 2026-07-05 — v0.2: flat game floor, portals, network readability

Inflight feedback from first review:

- **Flat passable floor**: floor is now strictly flat at `floorBase`
  (floorAmp default dropped to micro-texture 0.06). New per-hex obstruction
  test (`computeObstructed`): 7 samples per hex; if ground deviates >0.22
  from floorBase or the wall SDF clips the hex, it's impassable. Craters,
  talus rings and pillar/boulder hexes now all read as obstacles.
- **Hex grid = game board**: grid lines render only on passable cells
  connected to the largest component (BFS); passability overlay shows
  green playable / orange decor-blocked / red obstructed-or-unreachable.
  HUD shows open% and playable% separately.
- **Network, not blob**: open-target loop now measures *interior* floor
  fraction (cells with all 6 neighbors open), scale-up capped tighter, and
  defaults retuned (7 junctions, corridor 2.6, arenas 2.4). Maps read as
  intersecting corridors with mesa fingers between them.
- **Edge exits**: `edgePortals` (default 3) — corridors from border points
  to the nearest junction, carved *after* the border seal; the passability
  raster clamps out-of-map columns to their border cell so exits run off
  the diorama edge (future fog-of-war blockers / map extension points).
- **Mesh slivers**: surface nets quads now split along the shorter diagonal
  and degenerate triangles are dropped (hairline-triangle report).

Screenshot: `docs/shots/v0.2-seed1337-flatfloor-portals.png`
(seed 1337: open 47% / playable 28%, 3 exits).

## 2026-07-05 — v0.1: full pipeline bootstrap

Built the sandbox from scratch (empty repo + concept art):

- Scaffolded Vite + TS + three.js + lil-gui + simplex-noise.
- Implemented the full generation pipeline: hex-carved canyon network →
  passability raster → signed 2D EDT → per-column ground profile →
  3D density (wall-band 3D noise) → surface nets → vertex-colored mesh.
  Full regen ~150–250 ms at 30×26 hexes / 0.3 voxel on desktop.
- Decor modifiers: instanced boulders (hex-blocking), strata pillars,
  scree fans along SDF gradient; craters baked into the floor heightfield.
- Fixed-iso viewer (ortho, 45°/35.26°), pan/zoom, warm sun + hemi rig,
  soft shadows, ACES, light distance haze.
- Brush editor with force-open/force-wall layers, undo, debounced regen;
  edits survive parameter re-rolls.
- lil-gui panel for all params, localStorage persistence, params
  import/export, per-hex map JSON export.

Iteration notes (validated via Playwright screenshots):

1. First render: pipeline worked but only ~22% of the map was open floor —
   junction margins too conservative, network hugged map center.
2. Tried noise-gated hex dilation to hit an open-area target: hit 50% but
   melted corridors/arenas into one blob — network structure (chokepoints,
   intersections) lost. **Reverted.**
3. Replaced with width-scaled re-carve: all corridor randomness pre-rolled,
   then the network is re-carved at increasing width scale until the target
   fraction is met; chokepoints keep absolute width, arenas scale as sqrt.
   Result: 40–45% open with clearly readable network topology (verified:
   seed 1337 gives ring canyon around central mesa; 4242 gives S-canyon
   with spur).
4. Palette punch-up: stronger strata contrast, warmer floor, less fog,
   thicker pillars (were toothpicks), wallNoiseAmp 0.45→0.35 (rims were
   mushy).

Screenshots: `docs/shots/v0.1-seed1337.png`,
`docs/shots/v0.1-seed4242-passability.png`.

Known quirks:

- Decor re-scatters on every regen (edits/exports don't pin it yet).
- No connectivity warning when manually walling off a region.
- GUI syncs with keyboard shortcuts via lil-gui `.listen()`.
