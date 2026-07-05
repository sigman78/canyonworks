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
}

/** shared slider-driven uniforms — one object mutated by the GUI */
export interface DetailUniforms {
  scale: THREE.IUniform<number>;
  amount: THREE.IUniform<number>;
  /** world y above which plateau tops blend to the mesa layer */
  plateauY: THREE.IUniform<number>;
}

/** extra floor/plateau layers (terrain only, not decor) */
export interface DetailLayers {
  dunes: THREE.Texture;
  gravel: THREE.Texture;
  mesa: THREE.Texture;
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
  layers?: DetailLayers,
): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTriSide = { value: side };
    shader.uniforms.uTriTop = { value: top };
    shader.uniforms.uTriScale = u.scale;
    shader.uniforms.uTriAmt = u.amount;
    if (layers) {
      shader.uniforms.uTriDunes = { value: layers.dunes };
      shader.uniforms.uTriGravel = { value: layers.gravel };
      shader.uniforms.uTriMesa = { value: layers.mesa };
      shader.uniforms.uTriPlateauY = u.plateauY;
    }

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vTriNormal;',
      )
      .replace(
        '#include <fog_vertex>',
        `#include <fog_vertex>
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
        ${
          layers
            ? `uniform sampler2D uTriDunes;
        uniform sampler2D uTriGravel;
        uniform sampler2D uTriMesa;
        uniform float uTriPlateauY;
        // cheap value noise for world-space patch masks
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
        }`
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
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec3 triW = pow( abs( normalize( vTriNormal ) ), vec3( 4.0 ) );
          triW /= ( triW.x + triW.y + triW.z );
          vec2 triUvTop = vTriPos.xz * uTriScale;
          vec3 triTop = triLayered( uTriTop, triUvTop );
          ${
            layers
              ? `// floor patches: mini-dune ripples + rocky pavement
          float triMDune = triMask( vTriPos.xz * 0.13 + 3.7 );
          float triMGravel = triMask( vTriPos.xz * 0.11 + 9.2 );
          triTop = mix( triTop, triLayered( uTriDunes, triUvTop ), smoothstep( 0.48, 0.64, triMDune ) * 0.9 );
          triTop = mix( triTop, triLayered( uTriGravel, triUvTop ), smoothstep( 0.55, 0.7, triMGravel ) );
          // plateau tops: cracked slickrock with rock pools
          float triPlateau = smoothstep( uTriPlateauY - 1.2, uTriPlateauY, vTriPos.y );
          triTop = mix( triTop, triLayered( uTriMesa, triUvTop ), triPlateau );`
              : ''
          }
          vec3 triDet =
            triLayered( uTriSide, vTriPos.zy * uTriScale ) * triW.x +
            triTop * triW.y +
            triLayered( uTriSide, vTriPos.xy * uTriScale ) * triW.z;
          // macro layer: very-low-frequency tonal patchiness on the ground
          float triMacro = texture2D( uTriTop, vTriPos.xz * uTriScale * 0.061 ).g;
          triDet *= mix( 1.0, triMacro * 2.0, 0.3 );
          // mostly-luminance detail (slight hue bleed) so the vertex-color
          // palette (mesa caps, crater bands, crevice shade) stays in charge
          float triLum = dot( triDet, vec3( 0.299, 0.587, 0.114 ) );
          vec3 triMul = mix( vec3( triLum ), triDet, 0.3 ) * 1.85;
          diffuseColor.rgb *= mix( vec3( 1.0 ), triMul, uTriAmt );
        }`,
      );
  };
  // uniforms differ per material but the program is shared per variant
  mat.customProgramCacheKey = () => (layers ? 'triplanar-layers' : 'triplanar');
}
