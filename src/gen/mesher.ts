import * as THREE from 'three';
import { clamp01, fbm3, smoothstep, type NoiseKit } from '../core/noise';
import type { Fields } from './fields';
import type { GenParams } from './params';
import { surfaceNets } from './surfacenets';

export interface TerrainResult {
  geometry: THREE.BufferGeometry;
  vertexCount: number;
  triangleCount: number;
}

/**
 * Sample the 3D density (column ground height + 3D roughness on the wall
 * band, which also yields mild overhangs) and mesh it with surface nets.
 */
export function buildTerrainGeometry(
  fields: Fields,
  params: GenParams,
  noise: NoiseKit,
): TerrainResult {
  const { nx, nz, voxel, originX, originZ, groundH, wallMask } = fields;
  const ny = Math.ceil((fields.maxH + 1.0) / voxel) + 1;
  const data = new Float32Array(nx * ny * nz);

  const amp = params.wallNoiseAmp;
  const nf = params.wallNoiseFreq;
  const influence = amp * 1.6 + voxel;
  const { n3 } = noise;

  for (let iz = 0; iz < nz; iz++) {
    const z = originZ + iz * voxel;
    const edgeZ = iz === 0 || iz === nz - 1;
    for (let ix = 0; ix < nx; ix++) {
      const col = iz * nx + ix;
      const x = originX + ix * voxel;
      const h = groundH[col];
      const w = wallMask[col];
      const edge = edgeZ || ix === 0 || ix === nx - 1;
      // roughness strongest on the cliff flank, none on open floor
      const rough = amp * smoothstep(0.03, 0.25, w) * (1 - 0.6 * smoothstep(0.85, 1, w));

      for (let iy = 0; iy < ny; iy++) {
        const idx = ix + iy * nx + iz * nx * ny;
        if (edge || iy === ny - 1) {
          data[idx] = -1; // force air at volume boundary -> closed diorama skirt
          continue;
        }
        const y = iy * voxel;
        let d = h - y;
        if (rough > 0.001 && Math.abs(d) < influence) {
          d += fbm3(n3, x * nf, y * nf * 0.7, z * nf, 3) * rough;
        }
        data[idx] = d;
      }
    }
  }

  const nets = surfaceNets(data, nx, ny, nz, voxel, originX, 0, originZ);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(nets.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(nets.indices, 1));
  geometry.computeVertexNormals();

  colorize(geometry, fields, params, noise);

  return {
    geometry,
    vertexCount: nets.positions.length / 3,
    triangleCount: nets.indices.length / 3,
  };
}

// ---- Sedona palette -------------------------------------------------------

const C = (hex: number) => new THREE.Color(hex);
/** cliff strata bands, bottom to top */
const STRATA = [C(0x83341a), C(0xb04a20), C(0x9c3f1e), C(0xc9662f), C(0xd57d3e)];
const FLOOR_A = C(0xdb9d5c); // warm sand
const FLOOR_B = C(0xbd7a44); // rustier dust
const CAP = C(0xedc79a); // pale plateau cap
const CREVICE = C(0x54240f); // deep shade at wall contact
const CRATER_IN = C(0x9c6a54); // dusty ash-taupe bowl (cooler than rust walls)
const CRATER_WALL = C(0xc08a5f); // tan inner slope
const CRATER_RIM = C(0xf2d4a6); // sun-bleached rim crest
const EJECTA = C(0xe7ba8a); // pale ejecta dust ring
const CRACK_DEEP = C(0x2b1208); // fissure slot interior, falls to near-black
const CRACK_LIP = C(0xecc9a0); // pale weathered lip along the fissure edge

function colorize(
  geometry: THREE.BufferGeometry,
  fields: Fields,
  params: GenParams,
  noise: NoiseKit,
): void {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geometry.getAttribute('normal') as THREE.BufferAttribute;
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const { n2 } = noise;
  const tmp = new THREE.Color();
  const strataStep = Math.max(0.4, params.terraceStep);

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nY = nrm.getY(i);
    const s2 = fields.sampleS2(x, z);

    const dither = fbm3(noise.n3, x * 0.35, y * 0.5, z * 0.35, 2);

    if (nY < 0.65) {
      // cliff face: quantized strata bands
      const band = Math.floor((y + dither * 0.35) / strataStep);
      const bi = ((band % STRATA.length) + STRATA.length) % STRATA.length;
      tmp.copy(STRATA[bi]);
      // slight vertical gradient: darker at base
      const baseDark = clamp01(1 - y / (params.wallHeight + params.wallVar));
      tmp.multiplyScalar(0.95 - baseDark * 0.15 + dither * 0.04);
    } else if (y > params.wallHeight * 0.66) {
      // plateau top
      tmp.copy(CAP).lerp(STRATA[4], clamp01(0.3 + dither * 0.4));
      tmp.multiplyScalar(1 + dither * 0.04);
    } else {
      // canyon floor
      const t = clamp01(0.5 + fbm2Cheap(n2, x, z) * 0.7);
      tmp.copy(FLOOR_A).lerp(FLOOR_B, t);

      // crater bands: scorched bowl -> rust inner slope -> bleached rim
      // crest -> pale ejecta dust fading out (edges broken up by dither)
      const cd = sampleCraterD(fields, x, z);
      if (cd < 1.5) {
        const ring = cd + dither * 0.08;
        if (ring < 0.85) {
          const wallT = smoothstep(0.2, 0.8, ring); // bowl slope band
          const bowl = new THREE.Color().copy(CRATER_IN).lerp(CRATER_WALL, wallT);
          tmp.lerp(bowl, smoothstep(0.85, 0.45, ring) * 0.8);
        }
        const crest = Math.exp(-((ring - 0.92) * (ring - 0.92)) / 0.016);
        tmp.lerp(CRATER_RIM, crest * 0.75);
        if (ring > 1.02) tmp.lerp(EJECTA, smoothstep(1.5, 1.05, ring) * 0.3);
      }

      // contact shading at wall bases
      const contact = clamp01(1 - s2 / 1.6);
      if (contact > 0) tmp.lerp(CREVICE, contact * 0.28);
      tmp.multiplyScalar(1 + dither * 0.05);
    }

    // fissure shading (applies on floor AND across ridge tops): slot
    // interior falls to near-black, pale weathered lip just outside. Also
    // tints spots where the carve was clipped at flat hexes, so the crack
    // reads continuous over passable corners.
    const ck = fields.sampleCrack(x, z);
    if (ck < 1.35) {
      const cr = ck + dither * 0.12;
      tmp.lerp(CRACK_DEEP, smoothstep(1.05, 0.3, cr) * 0.88);
      const lip = Math.exp(-((cr - 1.12) * (cr - 1.12)) / 0.012);
      tmp.lerp(CRACK_LIP, lip * 0.3);
    }

    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function fbm2Cheap(n2: NoiseKit['n2'], x: number, z: number): number {
  return n2(x * 0.13, z * 0.13) * 0.65 + n2(x * 0.47, z * 0.47) * 0.35;
}

function sampleCraterD(fields: Fields, x: number, z: number): number {
  const fx = (x - fields.originX) / fields.voxel;
  const fz = (z - fields.originZ) / fields.voxel;
  const ix = Math.max(0, Math.min(fields.nx - 1, Math.round(fx)));
  const iz = Math.max(0, Math.min(fields.nz - 1, Math.round(fz)));
  return fields.craterD[iz * fields.nx + ix];
}
