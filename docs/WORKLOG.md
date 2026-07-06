# Worklog

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
  (0–0.6, default 0.3). `docs/shots/v0.13-cloud-shadows.jpg`.

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
