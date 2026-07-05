# Worklog

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
