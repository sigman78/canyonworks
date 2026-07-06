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
