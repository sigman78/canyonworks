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
}

/** shared slider-driven uniforms — one object mutated by the GUI */
export interface DetailUniforms {
  scale: THREE.IUniform<number>;
  amount: THREE.IUniform<number>;
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
  };
}

/**
 * Inject tri-planar detail into a MeshStandardMaterial. `side` is sampled
 * on the two vertical projections (cliff strata bands stay horizontal),
 * `top` on the ground projection. Handles instancing (boulders/scree).
 */
export function applyTriplanarDetail(
  mat: THREE.MeshStandardMaterial,
  side: THREE.Texture,
  top: THREE.Texture,
  u: DetailUniforms,
): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTriSide = { value: side };
    shader.uniforms.uTriTop = { value: top };
    shader.uniforms.uTriScale = u.scale;
    shader.uniforms.uTriAmt = u.amount;

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
        uniform float uTriAmt;`,
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
          vec3 triDet =
            triLayered( uTriSide, vTriPos.zy * uTriScale ) * triW.x +
            triLayered( uTriTop, vTriPos.xz * uTriScale ) * triW.y +
            triLayered( uTriSide, vTriPos.xy * uTriScale ) * triW.z;
          // macro layer: very-low-frequency tonal patchiness on the ground
          float triMacro = texture2D( uTriTop, vTriPos.xz * uTriScale * 0.061 ).g;
          triDet *= mix( 1.0, triMacro * 2.0, 0.3 );
          // mostly-luminance detail (slight hue bleed) so the vertex-color
          // palette (mesa caps, crater bands, crevice shade) stays in charge
          float triLum = dot( triDet, vec3( 0.299, 0.587, 0.114 ) );
          vec3 triMul = mix( vec3( triLum ), triDet, 0.25 ) * 1.85;
          diffuseColor.rgb *= mix( vec3( 1.0 ), triMul, uTriAmt );
        }`,
      );
  };
  // uniforms differ per material but the program is shared
  mat.customProgramCacheKey = () => 'triplanar';
}
