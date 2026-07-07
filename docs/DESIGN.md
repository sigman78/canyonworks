# CanyonWorks — design notes

Experimental sandbox (generator / visualizer / editor) for canyon-style tactical
maps for **Nether-Mars** — an isometric hex-based game where programmed robot
platforms explore and fight in Martian canyons.

## Goals

- **Tactical scale**: a few intersecting canyons, larger openings (arenas),
  chokepoints. Canyons = walls + aesthetics; the game plays on the floor.
- **Hex-aligned**: gameplay topology lives on a pointy-top hex grid (odd-r
  offset storage). Everything passable/impassable resolves per hex.
- **Don't waste map space**: `targetOpenFrac` guarantees a chosen share of
  the map is *interior* floor (open cells whose whole neighborhood is open).
- **Flat playable floor, gameplay-first**: passability is decided at the
  hex level *before* geometry (`hexFlat`: open + SDF margin at center +
  outside crater footprints). A blurred flatten-weight raster then forces
  the ground to exactly `floorBase` on those hexes — walls, talus and
  crater rims cannot creep onto passable cells, so visuals and passability
  always agree. Obstructed = open but not flat (decorative). Hex-grid
  overlay renders only passable, connected cells (largest component).
- **Edge exits**: `edgePortals` corridors punch through the border seal and
  run off the diorama edge — future map extension / fog-of-war sightline
  blockers.
- **Stylized look**: Sedona/AZ palette (rust strata, warm sand, pale mesa
  caps), not photoreal Mars. Reference: `docs/concepts-01.jpg`.
- **Fast reiteration**: full regen in ~150–250 ms; every parameter is a
  lil-gui slider; brush editing with live feedback.

## Generation pipeline

```
hex layout          canyon network carved on hex grid:
 (layout.ts)        junction arenas + MST corridors + extra loops (intersections),
                    noise wander, chokepoints, border seal, edge portals
                    (carved after the seal), manual edit overrides.
                    Re-carves at increasing width scale until the interior-floor
                    target is met (chokepoints keep absolute width -> contrast
                    preserved).
      |
passability raster  hex open/wall sampled at voxel-column resolution
      |
2D signed EDT       Felzenszwalb squared EDT both ways -> signed distance to
 (sdf2d.ts)         canyon boundary per column, world units.
      |
column fields       floor height (fBm + crater dents w/ rims + talus rise at
 (fields.ts)        wall base) and wall profile (ridge-perturbed boundary,
                    eased rise, terraced strata, plateau-quantized tops,
                    erosion gullies). Mesa tops: per-region altitude
                    offsets (flood-filled wall regions, quantized steps),
                    rim-faded doming w/ sand-pocket hollows, drainage
                    channels continuous with the flank gullies (rim
                    notches). Fissures: 1-2 hex cracks carved as small
                    slots after the flatten pass (clipped on passable
                    hexes). Output: groundH / wallMask / craterD / crackD.
      |
carve ops           3D CSG on the density volume (arches & overhangs track):
 (carves.ts)        CarveOp = inside-positive pseudo-SDF + conservative
                    bounds (INVARIANT: sdf <= 0 outside them); 'add' unions
                    rock, 'cut' subtracts; array ordered adds-then-cuts.
                    Arch = plug + vault over a corridor throat: a
                    wall-to-wall rock mass (radial-probe placement from
                    flat hexes, highest-rock anchoring, saddle crown) with
                    an arched slot cut through along the corridor — walls
                    meet overhead, hole underneath, no legs on passable
                    cells. Windows = holes through thin fins (air on both
                    sides), above the floor. Floor/2D fields untouched ->
                    passability + overlays unaffected.
      |
3D density          density = groundH - y, plus 3D fBm roughness on the cliff
 (volume.ts)        band only (gives mild overhangs), plus the basal wash:
                    an erosion notch at wall bases (deepest at the floor,
                    fading over washHeight, depth from the 2D SDF) gated by
                    a map-wide large-scale noise mask + detail scallops ->
                    patchy overhangs and grottoes, flat floor untouched.
                    Then carve ops applied per voxel via per-block op
                    lists. Volume boundary forced to air -> closed
                    "diorama block" skirt. Block-sparse:
                    4³ blocks classified AIR/SOLID/MIXED from per-column
                    surface bands (1-voxel-padded footprint); only MIXED
                    blocks are evaluated per voxel, homogeneous blocks are
                    constant-filled (only their sign is ever read). Geometry
                    is byte-identical to a brute-force dense fill —
                    regression-checked by tools/verify-volume.ts.
      |
surface nets        one vertex per sign-crossing cell, quads across sign-
 (surfacenets.ts)   changing edges; traversal skips non-MIXED block runs in
                    the same global cell order. Vertex colors: slope+height
                    dependent strata bands / floor sand / mesa caps /
                    contact shading.
      |
decor modifiers     non-SDF instanced features (decor.ts):
                    - boulders: perturbed icosahedra, wall-base biased,
                      big ones mark their hex blocked
                    - lone pillars: four archetypes (hoodoo / spire /
                      totem / butte) with per-style profile, lean and
                      cap-chance; hex blocked
                    - ground contact: sand tint blended into decor
                      bottoms (baked for shafts, shader skirt for rocks)
                    - scree fans: small instanced rocks sliding from wall bases
                      along +grad(SDF), decorative (passable)
                    - craters are heightmap-baked (passable), tinted
```

### Key decisions

- **Topology-first, not heightmap-first.** The hex open/wall set is the source
  of truth; the 2D SDF + procedural profile turn it into 3D. This guarantees
  the gameplay layer (open fraction, connectivity via MST) instead of hoping a
  heightmap threshold cooperates.
- **Per-column field precomputation.** The 3D density only varies in y via
  `groundH - y` plus wall-band noise, so columns are computed once — meshing a
  ~150×40×130 volume stays under 100 ms.
- **Manual edits are an override layer** (`force open` / `force wall` per hex),
  applied after auto-layout — so re-rolling parameters keeps your edits.
- **Winding convention**: density > 0 = solid rock; surface nets face loop
  order chosen cyclically per axis so normals point out of the rock.

## Modules

| path | role |
|---|---|
| `src/core/hex.ts` | pointy-top odd-r hex grid, axial math, world<->cell |
| `src/core/rng.ts` | mulberry32 seeded PRNG |
| `src/core/noise.ts` | simplex wrappers: fbm2/fbm3/ridged |
| `src/gen/params.ts` | `GenParams` (serializable), defaults |
| `src/gen/layout.ts` | canyon network on hex grid + open-target scaling |
| `src/gen/sdf2d.ts` | exact signed EDT |
| `src/gen/fields.ts` | per-column ground profile, craters |
| `src/gen/surfacenets.ts` | surface nets isosurface |
| `src/gen/mesher.ts` | density volume, meshing, Sedona vertex colors |
| `src/gen/decor.ts` | boulders / pillars / scree + blocked-hex mask |
| `src/viewer/viewer.ts` | fixed-iso ortho camera, pan/zoom, light rig |
| `src/viewer/overlays.ts` | hex grid lines, passability tint overlay |
| `src/viewer/mesaFog.ts` | decorative fog blankets over mesa islands |
| `src/edit/editor.ts` | brush painting, gizmo ring, undo stack |
| `src/ui/panel.ts` | lil-gui parameter panel |
| `src/main.ts` | app state, regen orchestration, HUD, import/export |

## Determinism

Same seed + same params + same edit layer = same map. RNG streams are split
(layout / craters / decor) and all corridor randomness is pre-rolled so the
open-target re-carve loop is stable.

## Map export

`Export map JSON` produces per-hex `{col,row,open,blocked}` (odd-r pointy-top)
plus the generating params — intended as the interchange toward the actual
game. Decor placement export (positions/types) is a TODO.

## Rendering (v0.7)

- **Detail textures** (`public/textures/`, generated by
  `tools/gen-textures.mjs` with nano-banana2 / gemini-3-pro-image; API key
  in `.env.local`, gitignored): cliff strata / floor sand / rock grain /
  dune ripples / rocky gravel pavement / cracked mesa slickrock with rock
  pools / drift (thin sand sheet over slickrock, mesa hollows) / rubble
  (dark chip lag on bedrock, mesa tops) / crater (ash-taupe dust with
  cracks + ejecta pebbles, crater bowls up to the rim). Regenerate any
  of them with `node tools/gen-textures.mjs [name]`. A `texture masks`
  View toggle false-colors all layer regions at once for tuning.
- **Tri-planar detail shader** (`src/viewer/terrainMaterial.ts`): injected
  into MeshStandardMaterial via onBeforeCompile — no custom material, all
  lights/shadows/fog keep working. Side projections use the cliff texture
  (strata bands stay horizontal), top uses sand; decor rocks use rock on
  all axes. Instanced meshes supported.
- **Anti-repetition layering**: per projection, two samples of the texture
  (second rotated ~137 deg and rescaled 1.37x) are blended by a
  low-frequency variation field sampled from the texture itself; a
  very-low-frequency macro tap adds large tonal patches. Kills visible
  tiling without extra assets.
- **Multi-layer ground (v0.8)**: the top projection scatters dune-ripple
  and rocky-pavement patches over the base sand, masked by 2-octave value
  noise in world space (patches span a few hexes regardless of texture
  scale). Above `wallHeight * 0.45` the ground layer blends into the
  mesa facies (v0.12): slickrock plates, dune sand pooled in the dome
  hollows (per-vertex `facies` morphology attribute baked at mesh time),
  and rubble patches — bump and roughness follow the same weights.
- **Palette-preserving blend**: detail is applied as a mostly-luminance
  multiplier (hue bleed slider, default 0.3) over the vertex colors, so
  the hand-tuned Sedona palette — mesa caps, crater bands, fissure slots,
  crevice shade — survives texturing. `texture amt` 0 returns to pure
  vertex color.
- **Bump & sheen (v0.9)**: the detail textures double as height fields —
  per-projection height gradients perturb the shading normal
  (perturbNormalArb math, no normal maps). Gradients use explicit-offset
  taps (`uv + dFdx(uv)`, like three's dHdxy_fwd) so every sample is
  mip/aniso filtered — NOT `dFdx` of a sampled value, which is constant
  per 2x2 pixel quad and reads as pixelation. Roughness variation rides
  the detail luminance and layer masks: bright detail / dune patches /
  plateau slickrock read smoother, gravel stays matte (clamped to
  [0.5, 1] — subtle by design).
- **Render tweaks folder**: texture amt/scale, bump, sheen, detail
  contrast, hue bleed, macro patches, AO amount, sun azimuth/elevation,
  shadow strength — shared live uniforms / light-rig params, no shader
  recompile and no regen.
- **Baked AO (v0.10)**: per-vertex ambient occlusion ray-marched through
  the density volume at meshing time (12 rays bent only 0.6 toward the
  normal so they hug the surface and hit nearby walls; 4 steps out to
  4 wu for canyon-scale enclosure) into an `ao` attribute. Applied with
  a pow-2.2 contrast curve — fully to indirect light, 45% to direct — so
  crevices deepen without flattening the sun side.
- **Sun & shadows (v0.10)**: directional sun on a spherical mount
  (azimuth/elevation sliders, radius fitted to the map), default 45°
  elevation for readable self-shadowing; 4096 shadow map,
  normalBias 0.2; `shadow strength` maps to `light.shadow.intensity`.

## Palette (current)

- cliff strata: `#83341a #b04a20 #9c3f1e #c9662f #d57d3e`
- floor sand: `#db9d5c` -> `#bd7a44`, mesa cap `#edc79a`
- contact/crevice shade `#54240f`, background haze `#e9c9a0`
- crater bands: bowl `#9c6a54`, inner slope `#c08a5f`, rim crest `#f2d4a6`,
  ejecta dust `#e7ba8a` (deliberately lighter/cooler than the rust walls so
  craters don't read as more shadow)
- fissures: slot interior `#2b1208` (near-black rust), weathered lip
  `#ecc9a0`

## Fissures (v0.6)

Hex-aligned cracks that block crawling platforms but not flyers:

- Each fissure spans **1–2 adjoining open hexes** (short heading-directed
  walk through jittered centers; single-hex cracks are a segment through
  their hex). Crack hexes drop out of `hexFlat` -> obstructed, so
  passability is hex-crisp and a multi-hex crack is contiguous.
- Geometry is a `crackD` distance raster -> semicircular slot profile with
  fBm-jagged edges and tapered tips, carved after the flatten pass but
  hard-clipped by the unblurred flat-hex mask: a passable hex never gets
  holed; the dark tint alone crosses clipped corners to keep the visual
  line continuous.
- The walk is length-generic: raising `crackLenMax`/`crackDepth` brings
  back long barrier chains that seal a region off (fly-only zones behind
  fog-of-war) — deliberately kept small for now per feedback.
