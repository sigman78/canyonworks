# Tasks

## Done (v0.1)

- [x] Vite + TS + three.js scaffold, lil-gui panel, HUD
- [x] Hex grid core (pointy-top, odd-r), seeded RNG, simplex fBm
- [x] Canyon network layout: junction arenas + MST corridors + loops,
      wander, chokepoints, border seal
- [x] Open-area target (`targetOpenFrac`) via width-scaled re-carve
      (chokepoints keep absolute width)
- [x] Passability raster -> signed 2D EDT (Felzenszwalb)
- [x] Column fields: floor fBm, talus, ridge-perturbed walls, terraces,
      plateau tops, erosion gullies, craters (dent + rim, tint)
- [x] 3D density + surface nets meshing, closed diorama skirt
- [x] Sedona vertex-color pass (strata bands / floor / caps / contact shade)
- [x] Decor: instanced boulders (hex-blocking), lone pillars, scree fans
- [x] Fixed-iso ortho viewer, pan/zoom, warm light rig + shadows
- [x] Hex grid overlay (draped), passability overlay (open/blocked)
- [x] Brush editor: carve/wall force-layers, gizmo ring, stroke undo
      (Ctrl+Z), debounced regen, persistent across param changes
- [x] Params persistence (localStorage), import/export JSON,
      map JSON export (per-hex open/blocked)
- [x] Keyboard shortcuts (1/2/3 modes, [ ] brush, R, G, P)

## Done (v0.2 — inflight feedback)

- [x] Flat playable floor (floorBase) + per-hex obstruction test
      (height deviation / SDF clip) — talus rings, crater bowls & rims,
      wall creep all impassable-but-decorative
- [x] Hex grid overlay only on passable+connected cells (largest component)
- [x] Passability overlay: green playable / orange decor / red obstructed
- [x] Edge portals (`edgePortals`): canyon exits running off the map edge;
      out-of-map raster inherits border cell state
- [x] Playable-interior metric drives the open-area target (not raw open)
- [x] Network readability defaults (7 junctions, narrower corridors)
- [x] Surface nets: shorter-diagonal quad split + degenerate-triangle skip
      (hairline sliver fix)
- [x] HUD shows open% and playable%; map JSON v2 exports obstructed/passable

## Done (v0.3 — gameplay-first passability)

- [x] Passability decided at hex level (SDF margin + crater footprint +
      decor), geometry forced to follow via flatten-weight raster
- [x] Exits passable all the way to the border
- [x] Crisp hex-aligned crater footprints
- [x] Pillars & blocking boulders snapped to hex centers, footprints
      contained within the hex inradius

## Done (v0.4 — pillar rework)

- [x] Hoodoo pillars: flared footing + rubble, eroded waist, strata
      ledges, narrow neck, balancing cap stone (offset + tilted),
      wide height variation; footprint contained in one hex

## Done (v0.5 — colored craters)

- [x] Crater readability: deeper compact bowl + tall rim crest inside the
      footprint; `craterD` normalized-distance field
- [x] Crater color bands: scorched bowl / rust slope / bleached rim /
      ejecta dust ring

## Done (v0.6 — fissures)

- [x] Hex-aligned micro-fissures (1–2 adjoining hexes): slot carve with
      tapered tips, near-black interior + pale lip coloring
- [x] Crack hexes obstructed (crawlers blocked, flyers pass)
- [x] Carve clipped by flat hexes — passable floor never holed
- [x] Decor avoids fissures; pillars/blocking boulders require a flat hex
- [x] ~~Barrier chains sealing off regions~~ built, then deferred on
      feedback (too large for now) — raise crackLenMax/crackDepth to get
      them back when fly-only zones become a feature

## Done (v0.7 — rendering pass)

- [x] nano-banana2 texture generator (`tools/gen-textures.mjs` ->
      `public/textures/`): cliff strata / floor sand / rock detail
- [x] Tri-planar detail shader (onBeforeCompile on MeshStandardMaterial):
      cliff on steep, sand on flat, rock on decor; instancing-aware
- [x] Anti-repetition: dual-sample layering (rotated/rescaled second tap
      blended by texture-derived variation field) + macro tonal patches
- [x] Mostly-luminance detail keeps the vertex palette authoritative
- [x] View sliders: texture amt / texture scale (live uniforms)

## Done (v0.8 — layered floor & mesa detail)

- [x] dunes / gravel / mesa textures (nano-banana2)
- [x] Multi-layer top projection: sand + dune patches + gravel patches
      (world-space value-noise masks, patch = a few hexes)
- [x] Plateau tops blend to cracked slickrock with rock pools above
      wallHeight*0.6

## Done (v0.9 — bump & sheen)

- [x] Screen-space bump from the detail textures as height fields
      (perturbNormalArb-style, no normal maps; per-projection gradients
      via explicit-offset taps so sampling stays mip-filtered — dFdx of
      a sampled value is quad-constant and pixelates)
- [x] Per-layer roughness variation: dune sheen / slickrock polish /
      matte gravel; bright detail reads smoother
- [x] "Render tweaks" GUI folder: texture amt/scale, bump, sheen,
      detail contrast, hue bleed, macro patches — all live uniforms
- [x] Contrast reduced after feedback (bump 0.35 default, roughness
      clamped to [0.5, 1])

## Done (v0.10 — light pass)

- [x] Baked per-vertex AO from the density volume (12-ray surface-hugging
      fan, 4 steps to 4 wu, `ao` attribute + live `AO amount` uniform with
      pow-2.2 contrast — no rebake; v2 after "barely noticeable" feedback:
      a strongly normal-biased fan escapes upward and bakes ~1 everywhere)
- [x] Terrain self-shadowing that actually reads: default sun lowered
      65° -> 45°, shadow map 4096, normalBias 0.2 (boulder contact
      shadows visible, no acne)
- [x] Sun azimuth / elevation / shadow strength sliders (live)
- [x] Wireframe toggle (terrain + decor) for mesh showcase

## Done (v0.11 — pillar variety & ground contact)

- [x] Pillar archetypes: hoodoo / spire / totem / butte, per-style
      height & radius ranges, cap-chance instead of always-cap
- [x] Progressive lean (clamped so the top stays in the hex)
- [x] Tweaks on feedback: taller spires (40% whole-body tilt), wider
      squat buttes with dark slanted caprock slabs, balancing caps
      x1.3 (x2 was overkill)
- [x] Sand ground-contact blend: baked into pillar shaft vertex colors;
      shader `sandContact` option for boulders/scree/rubble (object-space
      bottom skirt, scales per instance)

## Done (v0.12 — mesa top variety)

- [x] Per-mesa altitude offsets (flood-filled wall regions, quantized
      steps: sunken / base / raised / towering)
- [x] Mesa doming (rim-faded low-freq swell) + sand pockets in hollows
- [x] Drainage channels across tops, continuous with flank gullies ->
      rim notches; darkened channel lines
- [x] Mesa-top texture facies: baked morphology attribute -> sand pools
      in hollows, rubble patches over slickrock (bump/roughness follow
      the same weights)
- [x] Mesa-specific textures (drift.jpg / rubble.jpg via nano-banana2)
      instead of reusing the floor dunes/gravel set
- [x] Crater interior texture layer (crater.jpg, ash dust) blended up to
      the rim via the facies.y crater weight
- [x] Texture-mask debug overlay toggle (color-coded layer regions)
- [ ] Remnant micro-landforms on tops (reuse pillar archetypes near rims)
      — idea 4, deferred
- [ ] Geometry potholes / rock pools on tops — idea 5, deferred

## Done (v0.13 — mesa fog look test)

- [x] Decorative fog-of-war blankets over impassable mesa islands
      (baked alpha from wallMask, triple-blurred coverage + per-layer
      alpha blur, puffy shaped-fBm billows; five stacked sandstorm
      sheets + screen-space apron toward the +x/+z borders that curtains
      the diorama base in the iso view — no terrain-intersecting sheets;
      View toggle; iterated on feedback)
- [x] Drifting cloud shadows on direct sunlight (animated world-space
      value noise, Render tweaks slider)

## Done (v0.14 — block-sparse volume, branch `research/voxel3d`)

- [x] `gen/volume.ts`: density fill extracted from mesher into a 4³
      block-classified volume (AIR/SOLID/MIXED from per-column surface
      bands, padded 1 voxel); only MIXED blocks evaluated per voxel
- [x] Surface nets skips non-MIXED block runs in the same global cell
      order — output byte-identical to brute force
- [x] `tools/verify-volume.ts`: A/B verifier (geometry bytes + density
      signs), 5 seeds × 3 voxel sizes; caught a diorama-skirt
      classification bug at thin final blocks
- [x] `[mesher]` console.debug: block stats + per-stage timings
- [x] Carve-op stage: `gen/carves.ts` CarveOp (add/cut pseudo-SDF +
      bounds), per-block op lists in the volume, byte-identity contract
      extended to ops
- [x] Natural arches over corridor throats: deterministic radial-probe
      placement, highest-rock anchoring — REDESIGNED after user feedback
      ("slabs"): plug (wall-to-wall rock mass) + arched vault cut, legs in
      the walls, real hole underneath; adds-then-cuts op ordering
- [x] Fin windows: cut holes through thin fins (open air both sides),
      above the floor, no passability impact
- [x] Basal wash ("washed foundation"): erosion notch at wall bases ->
      overhangs/grottoes, gated by map-wide large-scale noise mask +
      detail scallops; flat floor untouched; 4 sliders
- [x] "3D carve" GUI folder (arches, depth, cap, clearance, span,
      windows, wash x4)
- [x] `IsoViewer.lookAtWorld` + `window.__cw` dev hook for scripted
      visual verification

## Done (v0.15 — stepped walls)

- [x] Terracing rework: riser sharpness param, undulating band phase,
      wider flank window (old bandWeight mushed top/bottom steps)
- [x] 3D strata benches: caprock half-band protrudes / soft half recesses
      (`ledgeAmp`), aligned with heightfield strata; overhang lip under
      every cap
- [x] Sliders: terrace sharp, strata ledges

## Done (v0.16 — rendering/textures: real bump + albedo blend)

- [x] Runtime normal-map baking from detail textures (normalMaps.ts)
- [x] True tri-planar normal mapping for side/floor/mesa (UDN, world
      space, perturbs the flat-shaded normal)
- [x] Decor on the same normal-map path (rock.jpg baked) — no more
      emboss desync
- [x] Accent-patch emboss restored, mask-weighted (derivatives kept in
      uniform control flow — branching caused speckles)
- [x] `tex albedo` slider: vertex-palette tint <-> texture own color
      (palette luminance preserved)
- [x] `legacy shading` A/B toggle (runtime uniform, no recompile) —
      fixed to flip the WHOLE map (accents had no normals and stayed
      emboss in both modes)
- [x] GenAI normal maps: generic prompt failed (redrawn + quantized),
      per-texture hint prompts WORK — tools/gen-normalmaps.mjs writes
      <name>_n.png for all 9; loader prefers them, Sobel bake fallback
- [x] Accent normal maps packed 2-per-RGBA (sampler budget: 15/16)
- [x] HUD: vox raw/sparse KB

## Done (texture set v2 — richer colors, canonical normals)

- [x] All 9 albedos regenerated at 2K with color-rich prompts (3-5 named
      hues each: multicolored gravel stones, vermilion/plum/cream cliff
      strata with varnish streaks…) — tools/gen-textures.mjs
- [x] Mean-luminance normalization to 128 baked into the generator
      (+ --normalize-only re-level mode): the shader treats texels as
      raw ~0.5 values, a bright-mean texture bleaches its surfaces
- [x] Non-flipped normal maps: explicit channel directions in the
      prompt + deterministic per-channel sign calibration against the
      height-map gradient (falls back to albedo luminance) — files are
      canonical, AUTHORED_FLIP_R loader hack retired. Calibration log
      proved per-map flips necessary: 7/9 came out R-inverted, mesa
      correct-handed
- [x] Heights regenerated from the v2 albedos (7 top layers)
- [x] sharp devDependency for the tool pipeline (encode/resample/stats)

## Next (rendering/textures)

- [ ] Roughness could key off the normal maps' cavity instead of bare
      luminance

## Next (feature/wasm-gen — Rust WASM generator kernels)

- [x] Scaffold: rustup + wasm-pack toolchain, wasm/ crate (simd128,
      LTO), npm run wasm:build/wasm:dev, pkg/ committed (no Rust in CI)
- [x] Bit-exact noise port (mulberry32 + simplex-noise 4.0.3 + fbm/
      ridged) — parity 0.0; bench harness __cwWasm (1.5× scalar baseline)
- [x] buildDensityVolume port (fill_volume): byte-identical parity on
      test seeds incl. carve ops (JS post-pass) + wash; fill ~1.3-1.4×,
      regen ~12%; wasmGen param (default on) + JS fallback dispatcher
- [x] Surface nets port (nets.rs): byte-identical (0 pos/idx diffs),
      2.4× — allocation-bound stages gain most
- [x] Per-stage perf tracking at TS call sites (core/perf.ts +
      __cwWasm.pipelineBench): volumeFill 1.35×, nets 2.4×, total
      345 -> 307 ms; control stages hold 1.0×
- [x] AO bake port: byte-identical, 2.37× (biggest single win)
- [x] colorize port: byte-identical (palette crosses per call), 1.91×
- [x] fields kernels port (EDT + profile loop): byte-identical, 1.5×;
      placement/rasters stay TS. Pipeline total 372 -> 238 ms (1.57×)
- [x] Structural refactor ("wasm for real", 2026-07-07 — docs/WASMGEN.md):
      typed serde boundary (GenParams/Palette/CarveOpSpec objects, all
      f64 param vectors deleted), carve-op SDFs + computeVertexNormals
      ported, fused single-call generate_mesh (volume never crosses;
      207 ms total, 1.75×), kernels rewritten as a typed Rust library
      (grid.rs samplers, MapNoise once per call, named per-cell fns),
      par.rs scalar/rayon switch + native bench: 155 -> 35 ms (4.4×,
      8 threads) same code; simd128 autovec measured ≈ 2% (nothing)
- [ ] Stage B: port layout / fields glue (hex raster, craters, cracks,
      blur, mesa offsets) / carve placement -> ONE generate(params) call;
      then optionally host it in a Web Worker (async regenerate)
- [ ] Browser threads: wasm-bindgen-rayon (nightly atomics std) + a
      coi-serviceworker shim for GH Pages — brings the native 4.4×
      parallel win to the app
- [ ] Explicit 4-wide SIMD batching for the noise inner loops (autovec
      gave ~0; needs restructured lanes to pay)
- [ ] Parallelize surface nets (now 31% of the parallel-native total;
      needs a two-pass vertex-index scheme — sequential by design today)
- [ ] fogOverlays stays three.js (not portable); decor/layout cheap in TS

## Next (research/voxel3d — arches & overhangs, NO tunnels)

- [ ] Look iteration with user: arch proportions/count, wash
      depth/coverage defaults, window scarcity (thick walls offer few
      fins — consider fin-friendlier wall gen if windows matter)
- [ ] Cornice at the rim (lean-out near the top) — the wash covers the
      base; a rim counterpart would complete the profile
- [ ] Headroom-aware passability (still guaranteed by construction;
      needed if cut ops ever open odd spaces over passable cells)
- [ ] Wash vs decor: scree fans / boulders can float inside washed
      hollows (decor samples the 2D fields only) — check & fix if seen

## Next

- [ ] Decor edit brushes: place/erase boulders & pillars by hand; persist
      decor edits across regen (currently decor re-scatters every regen)
- [ ] Decor export in map JSON (positions, types, radii)
- [ ] Fissure edit brush (paint a crack path by hand along hexes)
- [ ] Connectivity warning after manual wall painting (largest component is
      already used for the grid/stats; smaller cut-off regions just lose
      their grid silently — could highlight them instead)
- [ ] Undo for parameter changes (currently only brush strokes)
- [ ] Move generation into a Web Worker if maps get bigger (>48 hexes)
- [ ] Optional 60°-step camera rotation (hex-friendly)
- [ ] Hover hex highlight in edit mode (currently only brush ring gizmo)
- [ ] Screes should optionally mark hexes blocked when dense
- [ ] Import map JSON back (currently only params round-trip)

## Ideas / later

- Height-layered gameplay (upper plateau routes, ramps between levels)
- Wind-blown dust particles, heat shimmer post FX
- Minimap render-to-texture (like concept's command console)
- Biome variants: dark basalt canyon, white sandstone, polar ice

## Done (v0.16 addenda)

- [x] flat/smooth shading toggle now applies to decor meshes too
