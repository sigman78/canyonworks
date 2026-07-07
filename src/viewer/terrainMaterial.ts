import * as THREE from 'three';

/**
 * Tri-planar detail texturing injected into MeshStandardMaterial.
 *
 * The generated textures (nano-banana2, public/textures/) are used as a
 * multiplicative detail layer over the existing vertex-color palette: the
 * Sedona grading (strata bands, crater/crack tints, contact shade) stays
 * authoritative, the texture adds surface detail and hue richness.
 * Textures are treated as raw values (~0.5 mid), so `detail * 2` is
 * brightness-neutral. Tiling defaults to plain Repeat (hard tile edges
 * are masked by the anti-tiling dual tap); the `mirror tiling` render
 * toggle switches everything to MirroredRepeat + the shader-side normal
 * handedness correction (setMirrorTiling / uTriMirror must agree).
 */

export interface DetailTextures {
  cliff: THREE.Texture;
  sand: THREE.Texture;
  rock: THREE.Texture;
  dunes: THREE.Texture;
  gravel: THREE.Texture;
  mesa: THREE.Texture;
  drift: THREE.Texture;
  rubble: THREE.Texture;
  crater: THREE.Texture;
}

/** shared slider-driven uniforms — one object mutated by the GUI */
export interface DetailUniforms {
  scale: THREE.IUniform<number>;
  amount: THREE.IUniform<number>;
  /** world y above which plateau tops blend to the mesa layer */
  plateauY: THREE.IUniform<number>;
  /** strength of the normal perturbation derived from detail luminance */
  bump: THREE.IUniform<number>;
  /** strength of the per-layer roughness variation */
  rough: THREE.IUniform<number>;
  /** detail contrast around mid-gray (1 = as authored) */
  contrast: THREE.IUniform<number>;
  /** how much texture hue bleeds into the vertex palette (0 = pure luminance) */
  hue: THREE.IUniform<number>;
  /**
   * blend toward the texture's OWN color: 0 = multiplicative tint over the
   * vertex palette (classic), 1 = texture albedo modulated only by the
   * palette's luminance (palette keeps light/dark, texture provides hue)
   */
  albedo: THREE.IUniform<number>;
  /**
   * 1 = pre-v0.16 shading for A/B comparison: full-stack screen-space
   * emboss, no normal maps, no albedo blend. Runtime toggle, no recompile.
   */
  legacy: THREE.IUniform<number>;
  /** tri-planar blend sharpness (pow exponent; classic look = 4) */
  blendPow: THREE.IUniform<number>;
  /** noise displacement of the top/side transition boundary, 0..1 */
  blendNoise: THREE.IUniform<number>;
  /** world-space frequency of the blend noise */
  blendNoiseScale: THREE.IUniform<number>;
  /** height-priority layer transitions: 0 = classic linear fade, 1 = crisp */
  layerCrisp: THREE.IUniform<number>;
  /** very-low-frequency macro tonal patchiness */
  macro: THREE.IUniform<number>;
  /** strength of the baked per-vertex ambient occlusion */
  ao: THREE.IUniform<number>;
  /** 1 = color-coded overlay of the texture-layer mask regions */
  maskDebug: THREE.IUniform<number>;
  /**
   * 1 = textures tile with MirroredRepeat (hides hard tile edges, but
   * flips normal-map handedness per tile); 0 = plain Repeat. Must match
   * the wrap mode set on the textures — see setMirrorTiling().
   */
  mirror: THREE.IUniform<number>;
  /** strength of the drifting cloud shadows on direct sunlight */
  cloud: THREE.IUniform<number>;
  /** world-space drift offset of the cloud field, advanced per frame */
  cloudOffset: THREE.IUniform<THREE.Vector2>;
}

/** extra floor/plateau layers (terrain only, not decor) */
export interface DetailLayers {
  dunes: THREE.Texture;
  gravel: THREE.Texture;
  mesa: THREE.Texture;
  /** mesa-top hollows: thin sand drift over slickrock */
  drift: THREE.Texture;
  /** mesa-top lag: dark-varnished chips on bedrock */
  rubble: THREE.Texture;
  /** crater interiors: ash-taupe dust with cracks and ejecta pebbles */
  crater: THREE.Texture;
}

export interface DetailOptions {
  /** multi-layer top projection (dunes/gravel patches + mesa plateau) */
  layers?: DetailLayers;
  /**
   * true tangent-space normal maps (baked at load, see normalMaps.ts) for
   * the three dominant surfaces, tri-planar blended in world space. When
   * present they replace the screen-space luminance emboss; shared
   * IUniforms so the baker can swap `.value` in after async baking.
   */
  normalMaps?: {
    side: THREE.IUniform<THREE.Texture>;
    top: THREE.IUniform<THREE.Texture>;
    mesa: THREE.IUniform<THREE.Texture>;
    /**
     * packed accent-layer maps (xy in RG / xy in BA, see normalMaps.ts):
     * dg = dunes+gravel, cd = crater+drift, rb = rubble (+spare).
     * Required when `layers` is set — every layer then has a true normal
     * map and the legacy-shading toggle flips the WHOLE map uniformly.
     */
    accents?: {
      dg: THREE.IUniform<THREE.Texture>;
      cd: THREE.IUniform<THREE.Texture>;
      /** rubble normal xy in RG + rubble HEIGHT in B */
      rb: THREE.IUniform<THREE.Texture>;
      /** packed heights: dunes / gravel / crater / drift in RGBA */
      h: THREE.IUniform<THREE.Texture>;
    };
  };
  /** consume a baked per-vertex `ao` attribute (terrain mesh only) */
  vertexAo?: boolean;
  /**
   * blend a sand tint over the object-space bottom of the mesh (ground
   * contact for decor rocks); range is [full-sand y, no-sand y] in local
   * units, so it scales with the instance
   */
  sandContact?: { color: THREE.Color; range: [number, number] };
}

// All tiled detail textures (albedo + baked/authored normal & height
// packs) register here so the mirror-tiling toggle can flip their wrap
// mode at runtime. Registration applies the CURRENT mode — normal maps
// bake async and arrive after the initial sync.
const tiledTextures: THREE.Texture[] = [];
let mirrorTiling = false;

export function registerTiledTexture(t: THREE.Texture): void {
  tiledTextures.push(t);
  const wrap = mirrorTiling ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
  t.wrapS = wrap;
  t.wrapT = wrap;
}

/** flip every registered texture between MirroredRepeat and plain Repeat */
export function setMirrorTiling(on: boolean): void {
  if (on === mirrorTiling) return;
  mirrorTiling = on;
  const wrap = on ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
  for (const t of tiledTextures) {
    t.wrapS = wrap;
    t.wrapT = wrap;
    t.needsUpdate = true; // wrap lives in the sampler state; re-upload
  }
}

export function loadDetailTextures(): DetailTextures {
  const loader = new THREE.TextureLoader();
  const load = (url: string): THREE.Texture => {
    const t = loader.load(url);
    registerTiledTexture(t);
    t.anisotropy = 8;
    return t;
  };
  return {
    cliff: load('textures/cliff.jpg'),
    sand: load('textures/sand.jpg'),
    rock: load('textures/rock.jpg'),
    dunes: load('textures/dunes.jpg'),
    gravel: load('textures/gravel.jpg'),
    mesa: load('textures/mesa.jpg'),
    drift: load('textures/drift.jpg'),
    rubble: load('textures/rubble.jpg'),
    crater: load('textures/crater.jpg'),
  };
}

/**
 * Inject tri-planar detail into a MeshStandardMaterial. `side` is sampled
 * on the two vertical projections (cliff strata bands stay horizontal),
 * `top` on the ground projection. Handles instancing (boulders/scree).
 *
 * With `layers`, the top projection becomes multi-layer: dune-ripple and
 * rocky-pavement patches scattered over the base sand (procedural
 * world-space value-noise masks, patches a few hexes wide), and plateau
 * tops above `u.plateauY` blend to the cracked-slickrock mesa texture.
 */
export function applyTriplanarDetail(
  mat: THREE.MeshStandardMaterial,
  side: THREE.Texture,
  top: THREE.Texture,
  u: DetailUniforms,
  opts: DetailOptions = {},
): void {
  const { layers, vertexAo, sandContact, normalMaps } = opts;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTriSide = { value: side };
    shader.uniforms.uTriTop = { value: top };
    shader.uniforms.uTriScale = u.scale;
    shader.uniforms.uTriAmt = u.amount;
    shader.uniforms.uTriBump = u.bump;
    shader.uniforms.uTriRough = u.rough;
    shader.uniforms.uCloudAmt = u.cloud;
    shader.uniforms.uCloudOff = u.cloudOffset;
    shader.uniforms.uTriContrast = u.contrast;
    shader.uniforms.uTriHue = u.hue;
    shader.uniforms.uTriAlbedo = u.albedo;
    shader.uniforms.uTriLegacy = u.legacy;
    shader.uniforms.uTriBlendPow = u.blendPow;
    shader.uniforms.uTriBlendNoise = u.blendNoise;
    shader.uniforms.uTriBlendNS = u.blendNoiseScale;
    shader.uniforms.uTriLayerCrisp = u.layerCrisp;
    shader.uniforms.uTriMacroA = u.macro;
    shader.uniforms.uTriMirror = u.mirror;
    if (normalMaps) {
      shader.uniforms.uTriSideN = normalMaps.side;
      shader.uniforms.uTriTopN = normalMaps.top;
      shader.uniforms.uTriMesaN = normalMaps.mesa;
      if (normalMaps.accents) {
        shader.uniforms.uTriAccDG = normalMaps.accents.dg;
        shader.uniforms.uTriAccCD = normalMaps.accents.cd;
        shader.uniforms.uTriAccRB = normalMaps.accents.rb;
        shader.uniforms.uTriAccH = normalMaps.accents.h;
      }
    }
    if (vertexAo) shader.uniforms.uTriAo = u.ao;
    if (sandContact) {
      shader.uniforms.uSandC = { value: sandContact.color };
      shader.uniforms.uSandR = { value: new THREE.Vector2(...sandContact.range) };
    }
    if (layers) {
      shader.uniforms.uTriDunes = { value: layers.dunes };
      shader.uniforms.uTriGravel = { value: layers.gravel };
      shader.uniforms.uTriMesa = { value: layers.mesa };
      shader.uniforms.uTriDrift = { value: layers.drift };
      shader.uniforms.uTriRubble = { value: layers.rubble };
      shader.uniforms.uTriCrater = { value: layers.crater };
      shader.uniforms.uTriPlateauY = u.plateauY;
      shader.uniforms.uTriMaskDbg = u.maskDebug;
    }

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vTriPos;
        varying vec3 vTriNormal;
        ${vertexAo ? 'attribute float ao;\n        varying float vTriAo;\n        attribute vec3 facies;\n        varying vec3 vTriFacies;' : ''}
        ${sandContact ? 'varying float vSandY;' : ''}`,
      )
      .replace(
        '#include <fog_vertex>',
        `#include <fog_vertex>
        ${vertexAo ? 'vTriAo = ao;\n        vTriFacies = facies;' : ''}
        ${sandContact ? 'vSandY = transformed.y;' : ''}
        vec4 triWp = vec4( transformed, 1.0 );
        vec3 triN = objectNormal;
        #ifdef USE_INSTANCING
          triWp = instanceMatrix * triWp;
          triN = mat3( instanceMatrix ) * triN;
        #endif
        vTriPos = ( modelMatrix * triWp ).xyz;
        vTriNormal = mat3( modelMatrix ) * triN;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vTriPos;
        varying vec3 vTriNormal;
        uniform sampler2D uTriSide;
        uniform sampler2D uTriTop;
        uniform float uTriScale;
        uniform float uTriAmt;
        uniform float uTriBump;
        uniform float uTriRough;
        uniform float uTriContrast;
        uniform float uTriHue;
        uniform float uTriAlbedo;
        uniform float uTriLegacy;
        uniform float uTriMacroA;
        uniform float uTriMirror;
        uniform float uCloudAmt;
        uniform vec2 uCloudOff;
        ${normalMaps ? 'uniform sampler2D uTriSideN;\n        uniform sampler2D uTriTopN;\n        uniform sampler2D uTriMesaN;' : ''}
        ${normalMaps?.accents ? 'uniform sampler2D uTriAccDG;\n        uniform sampler2D uTriAccCD;\n        uniform sampler2D uTriAccRB;\n        uniform sampler2D uTriAccH;' : ''}
        // cheap value noise (patch masks + drifting cloud shadows)
        float triHash( vec2 p ) {
          return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
        }
        float triNoise( vec2 p ) {
          vec2 i = floor( p );
          vec2 f = fract( p );
          f = f * f * ( 3.0 - 2.0 * f );
          return mix(
            mix( triHash( i ), triHash( i + vec2( 1.0, 0.0 ) ), f.x ),
            mix( triHash( i + vec2( 0.0, 1.0 ) ), triHash( i + vec2( 1.0, 1.0 ) ), f.x ),
            f.y );
        }
        float triMask( vec2 p ) {
          return 0.65 * triNoise( p ) + 0.35 * triNoise( p * 2.7 + 13.1 );
        }
        // MirroredRepeatWrapping flips alternate tiles, which INVERTS the
        // xy a normal map encodes there — relief polarity would flip every
        // tile (the old screen-space emboss was immune: it differentiates
        // the sampled field). Sign per axis from the tile parity — ramped
        // through ZERO across the filtered texel band at each boundary: a
        // hard sign step against linearly filtered (mip/aniso) content
        // leaves hairline lighting seams along every tile line, visible on
        // featureless floors at high bump. Derivative-aware width keeps
        // the fade one filter-footprint wide at any zoom. With mirror
        // tiling OFF (uTriMirror = 0, plain Repeat) no correction applies.
        vec2 triMirrorSign( vec2 uv ) {
          vec2 par = 1.0 - 2.0 * mod( floor( uv ), 2.0 );
          vec2 w = fract( uv );
          vec2 edge = min( w, 1.0 - w ) / max( fwidth( uv ) * 2.0, vec2( 1e-5 ) );
          return mix( vec2( 1.0 ), par * clamp( edge, 0.0, 1.0 ), uTriMirror );
        }
        // The albedo's anti-tiling (triLayered) swaps in a rotated second
        // copy of the texture over noise-shaped regions. Normal and height
        // maps must follow the SAME swap with the SAME variation field —
        // single-tap sampling left relief/heights showing the base copy
        // where the albedo showed the rotated one: patch-shaped
        // color-vs-bump desync (worse at high bump / layer crisp).
        vec2 triUv2( vec2 uv ) {
          return mat2( -0.73, 0.68, -0.68, -0.73 ) * uv * 1.37 + vec2( 0.17, 0.41 );
        }
        float triVar( sampler2D tex, vec2 uv ) {
          return smoothstep( 0.3, 0.7, texture2D( tex, uv * 0.09 + vec2( 0.33 ) ).g );
        }
        // dual-tap normal xy: both taps mirror-corrected, second tap's
        // tangent vector rotated back through the inverse of the triUv2
        // rotation, blended by the (albedo-synced) variation v
        vec2 triNmXY( sampler2D nmap, vec2 uv, float v ) {
          vec2 a = ( texture2D( nmap, uv ).xy * 2.0 - 1.0 ) * triMirrorSign( uv );
          vec2 u2 = triUv2( uv );
          vec2 b = ( texture2D( nmap, u2 ).xy * 2.0 - 1.0 ) * triMirrorSign( u2 );
          b = mat2( -0.73, -0.68, 0.68, -0.73 ) * b;
          return mix( a, b, v );
        }
        // same, reading a pack's BA channels
        vec2 triNmZW( sampler2D nmap, vec2 uv, float v ) {
          vec2 a = ( texture2D( nmap, uv ).zw * 2.0 - 1.0 ) * triMirrorSign( uv );
          vec2 u2 = triUv2( uv );
          vec2 b = ( texture2D( nmap, u2 ).zw * 2.0 - 1.0 ) * triMirrorSign( u2 );
          b = mat2( -0.73, -0.68, 0.68, -0.73 ) * b;
          return mix( a, b, v );
        }
        // Reoriented Normal Mapping (UE's BlendAngleCorrectedNormals):
        // rotates the detail normal onto the base as if the base were the
        // detail's tangent frame. base.z arrives as abs(axis)+1 >= 1, so
        // the division is safe. Identity when det == (0,0,1).
        vec3 triRnm( vec3 base, vec3 det ) {
          base += vec3( 0.0, 0.0, 1.0 );
          det *= vec3( -1.0, -1.0, 1.0 );
          return base * dot( base, det ) / base.z - det;
        }
        uniform float uTriBlendPow;
        uniform float uTriBlendNoise;
        uniform float uTriBlendNS;
        // tri-planar projection weights: tweakable sharpness (pow up to
        // near-step) + noise DISPLACEMENT of the top/side boundary. The
        // noise offsets |N|.y BEFORE the sharpening pow — offsetting the
        // input moves the transition line itself, so the raggedness reads
        // at any crispness (scaling the weight after the pow only nudged
        // the boundary by ~ln(f)/p: invisible). Legacy pins classic pow-4.
        vec3 triWeights( vec3 nrm, vec3 pos ) {
          float p = mix( uTriBlendPow, 4.0, uTriLegacy );
          vec3 an = abs( normalize( nrm ) );
          float bn = ( triMask( ( pos.xz + pos.y * vec2( 0.83, -0.61 ) ) * uTriBlendNS + 7.3 ) - 0.5 )
            * uTriBlendNoise * 0.7 * ( 1.0 - uTriLegacy );
          an.y = clamp( an.y + bn, 0.001, 1.0 );
          vec3 w = pow( an, vec3( p ) );
          return w / ( w.x + w.y + w.z );
        }
        uniform float uTriLayerCrisp;
        // height-priority layer transition: the layer whose (height + mask
        // dominance) wins keeps its pixels — stones stay crisp over sand in
        // the transition zone instead of ghost-fading. Returns the
        // effective blend factor for the overlaying layer.
        float triHPick( float hUnder, float hOver, float t, float soft ) {
          float ma = hUnder + 1.0 - t;
          float mb = hOver + t;
          float m = max( ma, mb ) - soft;
          float wb = max( mb - m, 0.0 );
          float tp = wb / ( max( ma - m, 0.0 ) + wb );
          // where BOTH layers are locally featureless (sand over sand) the
          // height pick collapses into a hard contour line — fade back to
          // the plain mask there; stones (high contrast) stay crisp
          return mix( t, tp, clamp( abs( hOver - hUnder ) * 3.0, 0.0, 1.0 ) );
        }
        ${vertexAo ? 'uniform float uTriAo;\n        varying float vTriAo;\n        varying vec3 vTriFacies;' : ''}
        ${sandContact ? 'uniform vec3 uSandC;\n        uniform vec2 uSandR;\n        varying float vSandY;' : ''}
        // roughness offset + layer mask weights, computed in color_fragment
        // and consumed by the roughness / normal includes further down
        float triRoughM = 0.0;
        float triGDune = 0.0;
        float triGGravel = 0.0;
        float triGPlateau = 0.0;
        float triGMDune = 0.0;
        float triGMGravel = 0.0;
        float triGCrater = 0.0;
        ${
          layers
            ? `uniform sampler2D uTriDunes;
        uniform sampler2D uTriGravel;
        uniform sampler2D uTriMesa;
        uniform sampler2D uTriDrift;
        uniform sampler2D uTriRubble;
        uniform sampler2D uTriCrater;
        uniform float uTriPlateauY;
        uniform float uTriMaskDbg;`
            : ''
        }`,
      )
      .replace(
        '#include <common>',
        `#include <common>
        // two layers of the same texture (second rotated ~137deg and
        // rescaled x1.37), blended by a low-frequency variation field
        // sampled from the texture itself -> breaks visible tiling
        vec3 triLayered( sampler2D tex, vec2 uv ) {
          vec3 a = texture2D( tex, uv ).rgb;
          vec2 uv2 = mat2( -0.73, 0.68, -0.68, -0.73 ) * uv * 1.37 + vec2( 0.17, 0.41 );
          vec3 b = texture2D( tex, uv2 ).rgb;
          float v = texture2D( tex, uv * 0.09 + vec2( 0.33 ) ).g;
          return mix( a, b, smoothstep( 0.3, 0.7, v ) );
        }
        // per-pixel height gradient via explicit-offset taps (three's
        // dHdxy_fwd): each tap goes through the regular mip/aniso
        // filtering, unlike dFdx of a sampled value which is constant
        // per 2x2 quad and reads as pixelation
        vec2 triGradH( sampler2D tex, vec2 uv ) {
          vec2 tdx = dFdx( uv );
          vec2 tdy = dFdy( uv );
          float h = texture2D( tex, uv ).g;
          return vec2(
            texture2D( tex, uv + tdx ).g - h,
            texture2D( tex, uv + tdy ).g - h );
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          ${
            sandContact
              ? `// sand skirt where the rock meets the ground; the detail
          // texture still multiplies over it so grain carries across
          float sandF = 1.0 - smoothstep( uSandR.x, uSandR.y, vSandY );
          diffuseColor.rgb = mix( diffuseColor.rgb, uSandC, sandF * 0.85 );`
              : ''
          }
          vec3 triW = triWeights( vTriNormal, vTriPos );
          vec2 triUvTop = vTriPos.xz * uTriScale;
          vec3 triTop = triLayered( uTriTop, triUvTop );
          ${
            layers
              ? `// floor patches: mini-dune ripples + rocky pavement.
          // Height-priority transitions (when accent heights are packed):
          // each mask is sharpened by triHPick so the layer whose height
          // wins keeps crisp pixels through the transition zone — stones
          // over sand instead of a ghosted crossfade. The effective masks
          // feed albedo AND (via the triG* globals) normal maps, bump and
          // roughness. Legacy mode restores the raw linear masks.
          ${
            normalMaps?.accents
              ? `// heights dual-tapped with the same variation fields the
          // albedo's triLayered uses, so relief stays in sync inside the
          // anti-tiling swap regions
          vec2 triUvT2 = triUv2( triUvTop );
          vec4 triVdgcd = vec4(
            triVar( uTriDunes, triUvTop ),
            triVar( uTriGravel, triUvTop ),
            triVar( uTriCrater, triUvTop ),
            triVar( uTriDrift, triUvTop ) );
          vec4 triHacc = mix(
            texture2D( uTriAccH, triUvTop ), texture2D( uTriAccH, triUvT2 ), triVdgcd );
          float triHRun = mix(
            texture2D( uTriTopN, triUvTop ).a, texture2D( uTriTopN, triUvT2 ).a,
            triVar( uTriTop, triUvTop ) );
          float triHMesaRun = mix(
            texture2D( uTriMesaN, triUvTop ).a, texture2D( uTriMesaN, triUvT2 ).a,
            triVar( uTriMesa, triUvTop ) );
          float triHRubble = mix(
            texture2D( uTriAccRB, triUvTop ).b, texture2D( uTriAccRB, triUvT2 ).b,
            triVar( uTriRubble, triUvTop ) );
          float triSoft = mix( 0.9, 0.08, uTriLayerCrisp );`
              : `vec4 triHacc = vec4( 0.5 );
          float triHRun = 0.5;
          float triHMesaRun = 0.5;
          float triHRubble = 0.5;
          float triSoft = 0.9;`
          }
          float triMDune = triMask( vTriPos.xz * 0.13 + 3.7 );
          float triMGravel = triMask( vTriPos.xz * 0.11 + 9.2 );
          float triLDune = smoothstep( 0.48, 0.64, triMDune ) * 0.9;
          float triLGravel = smoothstep( 0.55, 0.7, triMGravel );
          triLDune = mix( triHPick( triHRun, triHacc.r, triLDune, triSoft ), triLDune, uTriLegacy );
          triTop = mix( triTop, triLayered( uTriDunes, triUvTop ), triLDune );
          triHRun = mix( triHRun, triHacc.r, triLDune );
          triLGravel = mix( triHPick( triHRun, triHacc.g, triLGravel, triSoft ), triLGravel, uTriLegacy );
          triTop = mix( triTop, triLayered( uTriGravel, triUvTop ), triLGravel );
          triHRun = mix( triHRun, triHacc.g, triLGravel );
          // crater interiors: ash-dust layer filling the bowl up to the rim
          // crest, where it blends back into the surrounding floor
          float triCrater = ${vertexAo ? 'vTriFacies.y' : '0.0'};
          triCrater = mix( triHPick( triHRun, triHacc.b, triCrater, triSoft ), triCrater, uTriLegacy );
          triTop = mix( triTop, triLayered( uTriCrater, triUvTop ), triCrater );
          triHRun = mix( triHRun, triHacc.b, triCrater );
          // plateau tops: slickrock base with its own facies — dune sand
          // pools in the dome hollows (baked morphology attribute), rubble
          // patches from world-space noise
          // baked plateau weight (facies.z): computed on the CPU from
          // local-top proximity + wall-interior/height tests, so basal
          // knobs, wash lips and grotto ceilings never receive the pale
          // mesa texture (they read as light leaking into shadows).
          // Up-facing gate kept: the top projection weight uses abs().
          float triPlateau = ${vertexAo ? 'vTriFacies.z' : 'smoothstep( uTriPlateauY - 1.2, uTriPlateauY, vTriPos.y )'}
            * smoothstep( 0.15, 0.5, normalize( vTriNormal ).y );
          vec3 triMesa = triLayered( uTriMesa, triUvTop );
          float triHollow = ${vertexAo ? 'clamp( vTriFacies.x * 1.4 - 0.15, 0.0, 1.0 )' : '0.0'};
          float triMDuneTop =
            triHollow * ( 0.45 + 0.55 * smoothstep( 0.35, 0.6, triMask( vTriPos.xz * 0.19 + 51.7 ) ) ) * 0.85;
          float triMGravelTop = smoothstep( 0.58, 0.72, triMask( vTriPos.xz * 0.09 + 31.2 ) ) * 0.8;
          triMDuneTop = mix( triHPick( triHMesaRun, triHacc.a, triMDuneTop, triSoft ), triMDuneTop, uTriLegacy );
          triMesa = mix( triMesa, triLayered( uTriDrift, triUvTop ), triMDuneTop );
          triHMesaRun = mix( triHMesaRun, triHacc.a, triMDuneTop );
          triMGravelTop = mix( triHPick( triHMesaRun, triHRubble, triMGravelTop, triSoft ), triMGravelTop, uTriLegacy );
          triMesa = mix( triMesa, triLayered( uTriRubble, triUvTop ), triMGravelTop );
          triHMesaRun = mix( triHMesaRun, triHRubble, triMGravelTop );
          // the plateau fringe too: slickrock plates poke through the floor
          // stack at the mesa edge instead of dissolving
          triPlateau = mix( triHPick( triHRun, triHMesaRun, triPlateau, triSoft ), triPlateau, uTriLegacy );
          triTop = mix( triTop, triMesa, triPlateau );
          // smoother dune sand + polished slickrock, gravel/rubble matte
          triRoughM += ( triLDune * 0.18 - triLGravel * 0.12 ) * triW.y;
          triRoughM += triPlateau * ( 0.28 + triMDuneTop * 0.08 - triMGravelTop * 0.25 ) * triW.y;
          // hand the mask weights to the bump pass
          triGDune = triLDune;
          triGGravel = triLGravel;
          triGPlateau = triPlateau;
          triGMDune = triMDuneTop;
          triGMGravel = triMGravelTop;
          triGCrater = triCrater;`
              : ''
          }
          vec3 triDet =
            triLayered( uTriSide, vTriPos.zy * uTriScale ) * triW.x +
            triTop * triW.y +
            triLayered( uTriSide, vTriPos.xy * uTriScale ) * triW.z;
          // macro layer: very-low-frequency tonal patchiness on the ground
          float triMacro = texture2D( uTriTop, vTriPos.xz * uTriScale * 0.061 ).g;
          triDet *= mix( 1.0, triMacro * 2.0, uTriMacroA );
          triDet = mix( vec3( 0.5 ), triDet, uTriContrast );
          // two blend modes, crossfaded by uTriAlbedo:
          // 0 — multiplicative tint: mostly-luminance detail (uTriHue hue
          //     bleed) over the vertex palette, which stays in charge
          // 1 — texture's OWN color, modulated by the palette's luminance:
          //     crevice shade / cap brightness structure survives, but hue
          //     and chroma come from the texture itself
          float triLum = dot( triDet, vec3( 0.299, 0.587, 0.114 ) );
          vec3 triMul = mix( vec3( triLum ), triDet, uTriHue ) * 1.85;
          vec3 triTinted = diffuseColor.rgb * mix( vec3( 1.0 ), triMul, uTriAmt );
          float triBaseLum = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
          vec3 triOwn = triDet * 1.85 * triBaseLum;
          diffuseColor.rgb = mix( triTinted, triOwn, uTriAlbedo * uTriAmt * ( 1.0 - uTriLegacy ) );
          // bright detail (sun-worn dust, polished rock) reads smoother —
          // deliberately NOT up-facing-gated: with the fixed sun/camera the
          // specular half-vector is ~37° off vertical, so flat ground can
          // hardly glint and the sheen lives on tilted facets
          triRoughM += max( triLum - 0.42, 0.0 ) * 0.9;
          ${
            layers
              ? `// debug: color-coded texture-mask regions (View > texture masks)
          if ( uTriMaskDbg > 0.5 ) {
            vec3 triDbg = vec3( 0.87, 0.78, 0.52 );                          // base sand: tan
            triDbg = mix( triDbg, vec3( 0.95, 0.5, 0.1 ), triLDune );        // dunes: orange
            triDbg = mix( triDbg, vec3( 0.45, 0.27, 0.1 ), triLGravel );     // gravel: brown
            triDbg = mix( triDbg, vec3( 0.85, 0.2, 0.65 ), triCrater );      // crater: magenta
            vec3 triDbgMesa = vec3( 0.55, 0.75, 0.92 );                      // slickrock: sky
            triDbgMesa = mix( triDbgMesa, vec3( 0.15, 0.4, 0.95 ), triMDuneTop );   // drift: blue
            triDbgMesa = mix( triDbgMesa, vec3( 0.15, 0.65, 0.3 ), triMGravelTop ); // rubble: green
            triDbg = mix( triDbg, triDbgMesa, triPlateau );
            triDbg = mix( vec3( 0.45 ), triDbg, triW.y );                    // steep faces: gray
            diffuseColor.rgb = triDbg;
          }`
              : ''
          }
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        // sheen: the old 0.5 clamp floor made the slider invisible — this
        // light rig (single sun, ortho iso, ACES) only shows specular well
        // below 0.5 roughness, so give the effect real gain and range
        roughnessFactor = clamp( roughnessFactor - triRoughM * uTriRough * uTriAmt * 4.0, 0.15, 1.0 );`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        normalMaps
          ? `#include <normal_fragment_maps>
        {
          // TRUE normal mapping: baked tangent-space maps (normalMaps.ts),
          // tri-planar blended in world space (UDN swizzle per projection
          // plane), then rotated into view space. Replaces the old
          // screen-space luminance emboss, which flattened at grazing
          // angles and shimmered with screen resolution.
          vec3 triW = triWeights( vTriNormal, vTriPos );
          vec2 triUvTop = vTriPos.xz * uTriScale;
          vec2 triUvX = vTriPos.zy * uTriScale;
          vec2 triUvZ = vTriPos.xy * uTriScale;
          // every map dual-tapped through triNmXY/ZW with the variation
          // field of its OWN albedo texture — relief follows the albedo's
          // anti-tiling swaps (single taps desynced patch-wise)
          vec2 triTXxy = triNmXY( uTriSideN, triUvX, triVar( uTriSide, triUvX ) );
          vec2 triTZxy = triNmXY( uTriSideN, triUvZ, triVar( uTriSide, triUvZ ) );
          vec2 triTY = triNmXY( uTriTopN, triUvTop, triVar( uTriTop, triUvTop ) );
          vec2 triTYm = triNmXY( uTriMesaN, triUvTop, triVar( ${layers ? 'uTriMesa' : 'uTriTop'}, triUvTop ) );
          ${
            normalMaps.accents
              ? `// packed accent maps (xy/xy per RGBA): the top-projection
          // normal follows the SAME layer chain as the albedo, so every
          // patch carries true relief and the legacy toggle is uniform
          vec2 triPdgD = triNmXY( uTriAccDG, triUvTop, triVar( uTriDunes, triUvTop ) );
          vec2 triPdgG = triNmZW( uTriAccDG, triUvTop, triVar( uTriGravel, triUvTop ) );
          vec2 triPcdC = triNmXY( uTriAccCD, triUvTop, triVar( uTriCrater, triUvTop ) );
          vec2 triPcdD = triNmZW( uTriAccCD, triUvTop, triVar( uTriDrift, triUvTop ) );
          vec2 triPrb = triNmXY( uTriAccRB, triUvTop, triVar( uTriRubble, triUvTop ) );
          triTY = mix( mix( triTY, triPdgD, triGDune ), triPdgG, triGGravel );
          triTY = mix( triTY, triPcdC, triGCrater );
          triTYm = mix( mix( triTYm, triPcdD, triGMDune ), triPrb, triGMGravel );`
              : ''
          }
          triTY = mix( triTY, triTYm, triGPlateau );
          // per-plane RNM (Golus's triplanar variant): the mesh normal,
          // swizzled into each projection's tangent frame, is the RNM
          // base — so at bump 0 the mesh normal passes through EXACTLY
          // (flat facets preserved), and at grazing angles detail bends
          // with the surface instead of washing out like the old UDN add.
          // Bump strength scales the sampled slope before reorienting;
          // normal maps off in legacy mode (uTriLegacy is a runtime A/B
          // toggle — uniform branches keep derivatives defined)
          float triBumpS = uTriBump * uTriAmt * 1.6 * ( 1.0 - uTriLegacy );
          vec3 triTnX = normalize( vec3( triTXxy * triBumpS, 1.0 ) );
          vec3 triTnY = normalize( vec3( triTY * triBumpS, 1.0 ) );
          vec3 triTnZ = normalize( vec3( triTZxy * triBumpS, 1.0 ) );
          vec3 triWNb = inverseTransformDirection( normal, viewMatrix );
          vec3 triAbsN = abs( triWNb );
          vec3 triNX = triRnm( vec3( triWNb.zy, triAbsN.x ), triTnX );
          vec3 triNY = triRnm( vec3( triWNb.xz, triAbsN.y ), triTnY );
          vec3 triNZ = triRnm( vec3( triWNb.xy, triAbsN.z ), triTnZ );
          vec3 triSgn = sign( triWNb );
          triNX.z *= triSgn.x;
          triNY.z *= triSgn.y;
          triNZ.z *= triSgn.z;
          vec3 triWNr = normalize( triNX.zyx * triW.x + triNY.xzy * triW.y + triNZ.xyz * triW.z );
          normal = normalize( ( viewMatrix * vec4( triWNr, 0.0 ) ).xyz );
          // legacy mode: the FULL pre-v0.16 screen-space emboss — all
          // projections, whole stack. Weighted by uTriLegacy rather than
          // branched: triGradH uses dFdx/dFdy, and derivatives inside
          // divergent control flow are undefined (dashed speckles).
          vec2 triGTop = triGradH( uTriTop, triUvTop );
          ${
            layers
              ? `vec2 triGrDune = triGradH( uTriDunes, triUvTop );
          vec2 triGrGravel = triGradH( uTriGravel, triUvTop );
          triGTop = mix( mix( triGTop, triGrDune, triGDune ), triGrGravel, triGGravel );
          triGTop = mix( triGTop, triGradH( uTriCrater, triUvTop ), triGCrater );
          vec2 triGrMesa = mix(
            mix( triGradH( uTriMesa, triUvTop ), triGradH( uTriDrift, triUvTop ), triGMDune ),
            triGradH( uTriRubble, triUvTop ), triGMGravel );
          triGTop = mix( triGTop, triGrMesa, triGPlateau );`
              : ''
          }
          vec2 triDh = (
            triGradH( uTriSide, vTriPos.zy * uTriScale ) * triW.x +
            triGTop * triW.y +
            triGradH( uTriSide, vTriPos.xy * uTriScale ) * triW.z )
            * uTriBump * uTriAmt * uTriLegacy;
          vec3 triSx = dFdx( - vViewPosition );
          vec3 triSy = dFdy( - vViewPosition );
          vec3 triR1 = cross( triSy, normal );
          vec3 triR2 = cross( normal, triSx );
          float triJ = dot( triSx, triR1 ) * faceDirection;
          vec3 triGrad = sign( triJ ) * ( triDh.x * triR1 + triDh.y * triR2 );
          normal = normalize( abs( triJ ) * normal - triGrad );
        }`
          : `#include <normal_fragment_maps>
        {
          // screen-space bump from the detail textures as height fields
          // (same math as three's bumpmap perturbNormalArb) — gradients
          // sampled per projection and blended by the tri-planar weights
          vec3 triW = triWeights( vTriNormal, vTriPos );
          vec2 triUvTop = vTriPos.xz * uTriScale;
          vec2 triGTop = triGradH( uTriTop, triUvTop );
          ${
            layers
              ? `vec2 triGrDune = triGradH( uTriDunes, triUvTop );
          vec2 triGrGravel = triGradH( uTriGravel, triUvTop );
          triGTop = mix( mix( triGTop, triGrDune, triGDune ), triGrGravel, triGGravel );
          triGTop = mix( triGTop, triGradH( uTriCrater, triUvTop ), triGCrater );
          vec2 triGrMesa = mix(
            mix( triGradH( uTriMesa, triUvTop ), triGradH( uTriDrift, triUvTop ), triGMDune ),
            triGradH( uTriRubble, triUvTop ), triGMGravel );
          triGTop = mix( triGTop, triGrMesa, triGPlateau );`
              : ''
          }
          vec2 triDh = (
            triGradH( uTriSide, vTriPos.zy * uTriScale ) * triW.x +
            triGTop * triW.y +
            triGradH( uTriSide, vTriPos.xy * uTriScale ) * triW.z ) * uTriBump * uTriAmt;
          vec3 triSx = dFdx( - vViewPosition );
          vec3 triSy = dFdy( - vViewPosition );
          vec3 triR1 = cross( triSy, normal );
          vec3 triR2 = cross( normal, triSx );
          float triJ = dot( triSx, triR1 ) * faceDirection;
          vec3 triGrad = sign( triJ ) * ( triDh.x * triR1 + triDh.y * triR2 );
          normal = normalize( abs( triJ ) * normal - triGrad );
        }`,
      );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <aomap_fragment>',
      `#include <aomap_fragment>
      {
        ${
          vertexAo
            ? `// baked crevice AO: full on the indirect (hemi) light, partial on
        // the sun so pockets still read shaded under direct light
        float triAo = mix( 1.0, pow( vTriAo, 2.2 ), uTriAo );
        reflectedLight.indirectDiffuse *= triAo;
        reflectedLight.directDiffuse *= mix( 1.0, triAo, 0.45 );
        reflectedLight.directSpecular *= triAo;`
            : ''
        }
        // drifting cloud shadows: big soft blobs cutting the direct sun
        float triCld = triMask( ( vTriPos.xz + uCloudOff ) * 0.055 );
        float triCldShadow = 1.0 - uCloudAmt * smoothstep( 0.42, 0.78, triCld );
        reflectedLight.directDiffuse *= triCldShadow;
        reflectedLight.directSpecular *= triCldShadow;
      }`,
    );
  };
  // uniforms differ per material but the program is shared per variant
  mat.customProgramCacheKey = () =>
    (layers ? 'triplanar-layers' : 'triplanar') +
    (vertexAo ? '-ao' : '') +
    (sandContact ? '-sand' : '') +
    (normalMaps ? '-nmap' : '') +
    (normalMaps?.accents ? '-acc' : '');
}
