//! Vertex colorize (port of src/gen/mesher.ts `colorizeJs()`): Sedona palette
//! baked into per-vertex colors plus the 3-channel `facies` morphology
//! attribute (dome hollow / crater interior / plateau cap), from the vertex
//! positions + normals, the density volume (cave-tint probe) and the
//! per-column field grids.
//!
//! Structure: the per-vertex math lives in NAMED pieces on `Shader`
//! (cliff_strata, plateau_weight, plateau_cap, floor_shade, crater_ring,
//! cave_shade, crack_shade); `run()` is a thin per-vertex loop composing
//! them. Colors travel as `math::Rgb`, world points/normals as `math::Vec3`
//! (ground-plane samples as `Vec2`). Sampling goes exclusively through the
//! shared grid.rs primitives: Grid2::bilinear (fields.ts `sample()`),
//! Grid2::nearest (mesher.ts `sampleCraterD` — crater distance wants the
//! crisp rim, not a bilinear smear), VolDims::solid (the rock-overhead
//! probe) and VolDims::off_surface (the shared just-off-the-surface probe
//! start, same as the AO bake).
//!
//! Determinism contract (Gate 5): deterministic f32, same expressions in the
//! same operator order — the JS fallback path is visually equivalent, not
//! bitwise (meshCompare in src/core/wasmGen.ts measures nearness, not
//! identity).
//! - Vertex/normal/field reads are f32 and STAY f32 end-to-end (the old
//!   promote-to-f64 step is gone with the byte-parity contract).
//! - Palette colors arrive PER CALL (the Palette panel mutates the live
//!   THREE.Color objects between runs) as linear-space r/g/b floats,
//!   narrowed once by serde on decode; the color math maps 1:1 onto
//!   THREE.Color semantics via math::Rgb — `Rgb::lerp` IS Color.lerp's
//!   `c + (o - c) * t` per channel and `Rgb::scaled` IS
//!   Color.multiplyScalar, so every `tmp.lerp(...)` / `tmp.mul(...)` in the
//!   JS becomes `tmp = tmp.lerp(...)` / `tmp = tmp.scaled(...)` with the
//!   same expressions.
//! - Per-vertex work is independent, so the loop runs through par.rs
//!   (serial by default, rayon under `--features parallel`) — element
//!   enumeration preserves vertex index order either way, and scalar vs
//!   parallel outputs are bitwise identical.

use crate::grid::{FieldGrids, MapNoise, VolDims};
use crate::math::{vec3, Rgb, Vec2, Vec3};
use crate::noise::{clamp01, dome_swell, fbm3, gully, smoothstep, Noise2};
use crate::par;
use crate::params::{GenParams, Palette};

/// cave-tint probe march heights above the offset start point (world units)
const CAVE_STEPS: [f32; 4] = [0.55, 1.0, 1.6, 2.4];

/// mesher.ts `fbm2Cheap`: two raw octaves at fixed scales
#[inline(always)]
fn fbm2_cheap(n2: &Noise2, p: Vec2) -> f32 {
    n2.sample(p * 0.13) * 0.65 + n2.sample(p * 0.47) * 0.35
}

/// Typed output of `run()`: one rgb color + one xyz facies triple per vertex.
pub struct Colorized {
    pub colors: Vec<[f32; 3]>,
    pub facies: Vec<[f32; 3]>,
}

/// Everything one vertex's shading needs, borrowed for the whole run: volume
/// (cave probe), field grids (ground/s2/crack/crater samplers), the map's
/// shared noise, the live palette (math::Rgb triples, decoded per call) and
/// the params the strata bands read.
struct Shader<'a> {
    dims: &'a VolDims,
    data: &'a [f32],
    fields: &'a FieldGrids<'a>,
    noise: &'a MapNoise,
    palette: &'a Palette,
    params: &'a GenParams,
    /// strata band height — JS `Math.max(0.4, params.terraceStep)`
    strata_step: f32,
}

impl<'a> Shader<'a> {
    fn new(
        dims: &'a VolDims,
        data: &'a [f32],
        fields: &'a FieldGrids<'a>,
        params: &'a GenParams,
        palette: &'a Palette,
        noise: &'a MapNoise,
    ) -> Shader<'a> {
        Shader {
            dims,
            data,
            fields,
            noise,
            palette,
            params,
            strata_step: 0.4f32.max(params.terrace_step),
        }
    }

    /// mesher.ts `plateauWeight()`: how much an up-facing surface reads as
    /// pale plateau cap, 0..1. A genuine cap must be (a) at/near its own
    /// column's top — 3D-carved ledges, wash lips and grotto floors sit far
    /// below their column's groundH — and (b) either deep inside a wall
    /// region (a true mesa top, however sunken by the per-region offsets) or
    /// genuinely tall (full-height rims). Low rounded knobs at wall BASES
    /// fail both: previously they crossed a bare y threshold and glowed
    /// bleached-cream inside shadowed bases, reading as light leaking
    /// through the rock.
    fn plateau_weight(&self, p: Vec3) -> f32 {
        let g = p.xz();
        let h_eff = self.fields.ground_h.bilinear(g).max(p.y);
        let top = smoothstep(h_eff - 1.7, h_eff - 1.1, p.y);
        if top <= 0.0 {
            return 0.0;
        }
        let wall_height = self.params.wall_height;
        let interior = smoothstep(1.1, 1.7, -self.fields.s2.bilinear(g));
        let tall = smoothstep(wall_height * 0.6, wall_height * 0.8, p.y);
        let high = interior.max(tall) * smoothstep(wall_height * 0.35, wall_height * 0.5, h_eff);
        top * high
    }

    /// Cliff face: quantized strata bands. The band index CLAMPS at the top
    /// of the authored dark->light sequence (no wrap) — cycling it wrapped
    /// the darkest bottom stratum back in as a near-black ring on tall
    /// (per-mesa offset) walls.
    fn cliff_strata(&self, y: f32, dither: f32) -> Rgb {
        let band = ((y + dither * 0.35) / self.strata_step).floor();
        let bi = band.clamp(0.0, 4.0) as usize;
        let mut tmp = self.palette.strata[bi];
        if band > 4.0 {
            // above the sequence: stay in the light family — subtle per-band
            // shade jitter keeps the banding readable (the JS sin-hash
            // `Math.sin(band * 12.9898) * 43758.5453`, in f32)
            let j = (band * 12.9898).sin() * 43758.5453;
            tmp = tmp.scaled(0.92 + (j - j.floor()) * 0.12);
        }
        // slight vertical gradient: darker at base
        let base_dark = clamp01(1.0 - y / (self.params.wall_height + self.params.wall_var));
        tmp.scaled(0.95 - base_dark * 0.15 + dither * 0.04)
    }

    /// Plateau top — see `plateau_weight()` for what qualifies (and what the
    /// old bare y-threshold got wrong).
    fn plateau_cap(&self, g: Vec2, dome: f32, dither: f32) -> Rgb {
        let mut tmp = self
            .palette
            .cap
            .lerp(self.palette.strata[4], clamp01(0.3 + dither * 0.4));
        // sand pockets collect in the dome hollows (same field as the swell)
        if dome < -0.12 {
            tmp = tmp.lerp(self.palette.floor_a, smoothstep(0.12, 0.5, -dome) * 0.6);
        }
        // drainage lines read darker (desert varnish in the channels)
        let gl = gully(&self.noise.n2, g);
        tmp.scaled(1.0 - gl * gl * 0.22 + dither * 0.04)
    }

    /// Canyon floor: warm sand duotone broken by crater rings, darkened
    /// toward rock at wall contact.
    fn floor_shade(&self, g: Vec2, s2v: f32, crater_dist: f32, dither: f32) -> Rgb {
        let t = clamp01(0.5 + fbm2_cheap(&self.noise.n2, g) * 0.7);
        let mut tmp = self.palette.floor_a.lerp(self.palette.floor_b, t);

        tmp = self.crater_ring(tmp, crater_dist, dither);

        // contact shading at wall bases; up-facing surfaces ON the wall
        // footprint itself (s2 < 0 — wash lips, basal knobs demoted from the
        // cap branch) darken further toward rock shelf so bright sand never
        // pops inside a shadowed wall base
        let contact = clamp01(1.0 - s2v / 1.6);
        if contact > 0.0 {
            tmp = tmp.lerp(
                self.palette.crevice,
                contact * 0.28 + smoothstep(0.0, 0.8, -s2v) * 0.25,
            );
        }
        tmp.scaled(1.0 + dither * 0.05)
    }

    /// Crater bands: scorched bowl -> rust inner slope -> bleached rim
    /// crest -> pale ejecta dust fading out (edges broken up by dither).
    fn crater_ring(&self, mut tmp: Rgb, crater_dist: f32, dither: f32) -> Rgb {
        if crater_dist < 1.5 {
            let ring = crater_dist + dither * 0.08;
            if ring < 0.85 {
                let wall_t = smoothstep(0.2, 0.8, ring); // bowl slope band
                let bowl = self.palette.crater_in.lerp(self.palette.crater_wall, wall_t);
                tmp = tmp.lerp(bowl, smoothstep(0.85, 0.45, ring) * 0.8);
            }
            let crest = (-((ring - 0.92) * (ring - 0.92)) / 0.016).exp();
            tmp = tmp.lerp(self.palette.crater_rim, crest * 0.75);
            if ring > 1.02 {
                tmp = tmp.lerp(self.palette.ejecta, smoothstep(1.5, 1.05, ring) * 0.3);
            }
        }
        tmp
    }

    /// Rock-overhead probe (grotto/notch interiors): interior surfaces under
    /// overhanging rock — wash grottoes, notch floors, vault backs — have no
    /// sky above; pull them hard toward the crevice shade. Without this,
    /// up-facing surfaces inside a hollow get classified as bright sand
    /// floor, which pops inside a shadowed wall base and reads like light
    /// leaking through the rock. Start point via the shared
    /// `VolDims::off_surface` (offset along the vertex normal, exactly like
    /// the AO bake); vertical samples via VolDims::solid (js_round + bounds
    /// rejection on the un-cast rounded float, sky-only march).
    fn cave_shade(&self, mut tmp: Rgb, p: Vec3, n: Vec3) -> Rgb {
        let start = self.dims.off_surface(p, n);
        let mut hits = 0u32;
        for &s in CAVE_STEPS.iter() {
            if self
                .dims
                .solid(self.data, vec3(start.x, start.y + s, start.z))
            {
                hits += 1;
            }
        }
        if hits > 0 {
            tmp = tmp.lerp(
                self.palette.crevice,
                (hits as f32 / CAVE_STEPS.len() as f32) * 0.62,
            );
        }
        tmp
    }

    /// Fissure shading (applies on floor AND across ridge tops): slot
    /// interior falls to near-black, pale weathered lip just outside. Also
    /// tints spots where the carve was clipped at flat hexes, so the crack
    /// reads continuous over passable corners.
    fn crack_shade(&self, mut tmp: Rgb, g: Vec2, dither: f32) -> Rgb {
        let ck = self.fields.crack_d.bilinear(g);
        if ck < 1.35 {
            let cr = ck + dither * 0.12;
            tmp = tmp.lerp(self.palette.crack_deep, smoothstep(1.05, 0.3, cr) * 0.88);
            let lip = (-((cr - 1.12) * (cr - 1.12)) / 0.012).exp();
            tmp = tmp.lerp(self.palette.crack_lip, lip * 0.3);
        }
        tmp
    }

    /// One vertex: classify (cliff / plateau cap / canyon floor), then apply
    /// the surface-independent cave and crack tints, write rgb + facies.
    fn shade_vertex(
        &self,
        vertex: [f32; 3],
        normal: [f32; 3],
        col_out: &mut [f32; 3],
        fac_out: &mut [f32; 3],
    ) {
        let p = Vec3::from_f32(vertex);
        let n = Vec3::from_f32(normal);
        let g = p.xz();
        let s2v = self.fields.s2.bilinear(g);

        // dither samples an anisotropically squashed noise domain (y at 0.5,
        // ground at 0.35) — a noise coordinate, not a world point, so the
        // sample point is built as an explicit vec3 (naming, not math)
        let dither = fbm3(&self.noise.n3, vec3(p.x * 0.35, p.y * 0.5, p.z * 0.35), 2);
        let dome = dome_swell(&self.noise.n2, g);
        let crater_dist = self.fields.crater_d.nearest(g);
        let cap_w = self.plateau_weight(p);

        // morphology channels for the shader: x = dome hollow (same field as
        // the mesa-top swell in fields.ts) -> drift sand pools there;
        // y = crater interior weight (1 in the bowl, fading out at the rim
        // crest); z = plateau-cap weight (gates the pale mesa texture layer)
        *fac_out = [
            clamp01((-dome - 0.05) / 0.55),
            1.0 - smoothstep(0.8, 1.02, crater_dist),
            cap_w,
        ];

        let tmp = if n.y < 0.65 {
            self.cliff_strata(p.y, dither)
        } else if cap_w > 0.4 {
            self.plateau_cap(g, dome, dither)
        } else {
            self.floor_shade(g, s2v, crater_dist, dither)
        };
        let tmp = self.cave_shade(tmp, p, n);
        let tmp = self.crack_shade(tmp, g, dither);

        *col_out = tmp.to_f32();
    }
}

/// Colorize a mesh: one rgb color + one xyz facies triple per vertex. The
/// density volume feeds the cave-tint probe; the field grids feed the
/// groundH/s2/crackD bilinear samplers and the craterD nearest sampler;
/// `noise` is the map's shared kit (built once per generate — no per-stage
/// perm-table rebuild).
#[allow(clippy::too_many_arguments)]
pub fn run(
    vertices: &[[f32; 3]],
    normals: &[[f32; 3]],
    data: &[f32],
    dims: &VolDims,
    fields: &FieldGrids,
    params: &GenParams,
    palette: &Palette,
    noise: &MapNoise,
) -> Colorized {
    assert_eq!(data.len(), dims.n.count(), "data length");
    assert_eq!(vertices.len(), normals.len(), "vertices/normals length");
    let n_col = fields.ground_h.n.count();
    assert_eq!(fields.ground_h.data.len(), n_col, "groundH length");
    assert_eq!(fields.s2.data.len(), n_col, "s2 length");
    assert_eq!(fields.crack_d.data.len(), n_col, "crackD length");
    assert_eq!(fields.crater_d.data.len(), n_col, "craterD length");

    let shader = Shader::new(dims, data, fields, params, palette, noise);
    let mut colors = vec![[0.0f32; 3]; vertices.len()];
    let mut facies = vec![[0.0f32; 3]; vertices.len()];

    par::for_each2_mut(&mut colors, &mut facies, |i, col_out, fac_out| {
        shader.shade_vertex(vertices[i], normals[i], col_out, fac_out);
    });

    Colorized { colors, facies }
}
