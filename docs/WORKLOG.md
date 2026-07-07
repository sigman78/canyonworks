# Worklog

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
