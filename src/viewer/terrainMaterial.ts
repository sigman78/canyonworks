import * as THREE from 'three';

/**
 * Tri-planar detail texturing injected into MeshStandardMaterial.
 *
 * The generated textures (nano-banana2, public/textures/) are used as a
 * multiplicative detail layer over the existing vertex-color palette: the
 * Sedona grading (strata bands, crater/crack tints, contact shade) stays
 * authoritative, the texture adds surface detail and hue richness.
 * Textures are treated as raw values (~0.5 mid), so `detail * 2` is
 * brightness-neutral. MirroredRepeatWrapping hides any tiling seams.
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
  /** very-low-frequency macro tonal patchiness */
  macro: THREE.IUniform<number>;
  /** strength of the baked per-vertex ambient occlusion */
  ao: THREE.IUniform<number>;
  /** 1 = color-coded overlay of the texture-layer mask regions */
  maskDebug: THREE.IUniform<number>;
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
  /** consume a baked per-vertex `ao` attribute (terrain mesh only) */
  vertexAo?: boolean;
  /**
   * blend a sand tint over the object-space bottom of the mesh (ground
   * contact for decor rocks); range is [full-sand y, no-sand y] in local
   * units, so it scales with the instance
   */
  sandContact?: { color: THREE.Color; range: [number, number] };
}

export function loadDetailTextures(): DetailTextures {
  const loader = new THREE.TextureLoader();
  const load = (url: string): THREE.Texture => {
    const t = loader.load(url);
    t.wrapS = THREE.MirroredRepeatWrapping;
    t.wrapT = THREE.MirroredRepeatWrapping;
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
  const { layers, vertexAo, sandContact } = opts;
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
    shader.uniforms.uTriMacroA = u.macro;
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
        uniform float uTriMacroA;
        uniform float uCloudAmt;
        uniform vec2 uCloudOff;
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
          vec3 triW = pow( abs( normalize( vTriNormal ) ), vec3( 4.0 ) );
          triW /= ( triW.x + triW.y + triW.z );
          vec2 triUvTop = vTriPos.xz * uTriScale;
          vec3 triTop = triLayered( uTriTop, triUvTop );
          ${
            layers
              ? `// floor patches: mini-dune ripples + rocky pavement
          float triMDune = triMask( vTriPos.xz * 0.13 + 3.7 );
          float triMGravel = triMask( vTriPos.xz * 0.11 + 9.2 );
          float triLDune = smoothstep( 0.48, 0.64, triMDune ) * 0.9;
          float triLGravel = smoothstep( 0.55, 0.7, triMGravel );
          triTop = mix( triTop, triLayered( uTriDunes, triUvTop ), triLDune );
          triTop = mix( triTop, triLayered( uTriGravel, triUvTop ), triLGravel );
          // crater interiors: ash-dust layer filling the bowl up to the rim
          // crest, where it blends back into the surrounding floor
          float triCrater = ${vertexAo ? 'vTriFacies.y' : '0.0'};
          triTop = mix( triTop, triLayered( uTriCrater, triUvTop ), triCrater );
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
          triMesa = mix( triMesa, triLayered( uTriDrift, triUvTop ), triMDuneTop );
          triMesa = mix( triMesa, triLayered( uTriRubble, triUvTop ), triMGravelTop );
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
          // mostly-luminance detail (slight hue bleed) so the vertex-color
          // palette (mesa caps, crater bands, crevice shade) stays in charge
          float triLum = dot( triDet, vec3( 0.299, 0.587, 0.114 ) );
          vec3 triMul = mix( vec3( triLum ), triDet, uTriHue ) * 1.85;
          diffuseColor.rgb *= mix( vec3( 1.0 ), triMul, uTriAmt );
          // bright detail (sun-worn dust, polished rock) reads smoother
          triRoughM += max( triLum - 0.5, 0.0 ) * 0.3;
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
        roughnessFactor = clamp( roughnessFactor - triRoughM * uTriRough * uTriAmt, 0.5, 1.0 );`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          // screen-space bump from the detail textures as height fields
          // (same math as three's bumpmap perturbNormalArb) — gradients
          // sampled per projection and blended by the tri-planar weights
          vec3 triW = pow( abs( normalize( vTriNormal ) ), vec3( 4.0 ) );
          triW /= ( triW.x + triW.y + triW.z );
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
    (sandContact ? '-sand' : '');
}
