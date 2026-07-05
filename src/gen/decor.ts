import * as THREE from 'three';
import { HexGrid } from '../core/hex';
import { mulberry32, randRange, type Rng } from '../core/rng';
import { fbm3, smoothstep, type NoiseKit } from '../core/noise';
import { applyTriplanarDetail, type DetailUniforms } from '../viewer/terrainMaterial';
import type { Fields } from './fields';
import type { GenParams } from './params';

export interface DecorResult {
  group: THREE.Group;
  /** hexes blocked by decor (impassable but visually open floor) */
  blocked: Uint8Array;
  counts: { boulders: number; pillars: number; scree: number };
}

/** optional tri-planar detail texturing for all rock materials */
export interface DecorDetail {
  rock: THREE.Texture;
  uniforms: DetailUniforms;
}

const ROCK_TONES = [0xa8542c, 0x96482a, 0xb56336, 0x8a4224, 0xc07444];

export function buildDecor(
  grid: HexGrid,
  fields: Fields,
  params: GenParams,
  noise: NoiseKit,
  detail?: DecorDetail,
): DecorResult {
  const rng = mulberry32(params.seed ^ 0x51ab7e2d);
  const group = new THREE.Group();
  group.name = 'decor';
  const blocked = new Uint8Array(grid.count);

  const boulders = scatterBoulders(grid, fields, params, noise, rng, group, blocked);
  const pillars = raisePillars(grid, fields, params, noise, rng, group, blocked);
  const scree = spreadScree(grid, fields, params, noise, rng, group);

  // rock detail texture on every decor material (instanced meshes included)
  if (detail) {
    group.traverse((o) => {
      const mat = (o as THREE.Mesh).material;
      if (mat instanceof THREE.MeshStandardMaterial) {
        applyTriplanarDetail(mat, detail.rock, detail.rock, detail.uniforms);
      }
    });
  }

  return { group, blocked, counts: { boulders, pillars, scree } };
}

// ---- geometry helpers -----------------------------------------------------

function makeRockGeometry(noise: NoiseKit, seed: number, spikiness: number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = fbm3(noise.n3, v.x * 1.1 + seed, v.y * 1.1 - seed, v.z * 1.1 + seed * 2, 3);
    const s = 1 + n * spikiness;
    pos.setXYZ(i, v.x * s, v.y * s * 0.8, v.z * s);
  }
  geo.computeVertexNormals();
  return geo;
}

function rockMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    roughness: 1,
    metalness: 0,
    flatShading: true,
  });
}

// ---- boulders -------------------------------------------------------------

function scatterBoulders(
  grid: HexGrid,
  fields: Fields,
  params: GenParams,
  noise: NoiseKit,
  rng: Rng,
  group: THREE.Group,
  blocked: Uint8Array,
): number {
  if (params.boulderCount <= 0) return 0;
  const geo = makeRockGeometry(noise, 3.7, 0.38);
  const mesh = new THREE.InstancedMesh(geo, rockMaterial(), params.boulderCount);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const color = new THREE.Color();
  const placed: { x: number; z: number; s: number }[] = [];
  let count = 0;
  let tries = 0;

  while (count < params.boulderCount && tries < params.boulderCount * 30) {
    tries++;
    let x = randRange(rng, grid.minX, grid.maxX);
    let z = randRange(rng, grid.minZ, grid.maxZ);
    const s2 = fields.sampleS2(x, z);
    if (s2 < 0.5) continue; // only on open floor
    if (fields.sampleCrack(x, z) < 1.3) continue; // never hover over a fissure
    // bias toward wall bases: far-from-wall spots often rejected
    if (s2 > 2.5 && rng() < 0.55) continue;
    let scale = randRange(rng, params.boulderMinScale, params.boulderMaxScale) * grid.size;
    // hex-blocking boulders sit on their hex center with a contained
    // footprint so neighboring hexes stay visually clear
    if (scale >= grid.size * 0.5) {
      const [col, row] = grid.worldToCell(x, z);
      if (!grid.inBounds(col, row)) continue;
      // only on flat hexes — not in a crater bowl or a crack hex
      if (!fields.hexFlat[grid.index(col, row)]) continue;
      [x, z] = grid.cellWorld(col, row);
      scale = Math.min(scale, grid.size * 0.62);
    }
    let ok = true;
    for (const p of placed) {
      if (Math.hypot(p.x - x, p.z - z) < (p.s + scale) * 1.6) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const y = fields.sampleGround(x, z) - scale * 0.25;
    e.set(rng() * 0.5, rng() * Math.PI * 2, rng() * 0.5);
    q.setFromEuler(e);
    m.compose(
      new THREE.Vector3(x, y, z),
      q,
      new THREE.Vector3(scale, scale * randRange(rng, 0.7, 1.0), scale),
    );
    mesh.setMatrixAt(count, m);
    color.setHex(ROCK_TONES[Math.floor(rng() * ROCK_TONES.length)]);
    color.multiplyScalar(randRange(rng, 0.85, 1.1));
    mesh.setColorAt(count, color);
    placed.push({ x, z, s: scale });

    // big boulders block their hex
    if (scale >= grid.size * 0.5) {
      const [col, row] = grid.worldToCell(x, z);
      if (grid.inBounds(col, row)) blocked[grid.index(col, row)] = 1;
    }
    count++;
  }
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);
  return count;
}

// ---- lone pillar rocks ----------------------------------------------------

function raisePillars(
  grid: HexGrid,
  fields: Fields,
  params: GenParams,
  noise: NoiseKit,
  rng: Rng,
  group: THREE.Group,
  blocked: Uint8Array,
): number {
  let count = 0;
  let tries = 0;
  const placed: { x: number; z: number }[] = [];
  while (count < params.pillarCount && tries < params.pillarCount * 60) {
    tries++;
    // snap to a hex center so the pillar and its blocked hex always agree
    const [col, row] = grid.worldToCell(
      randRange(rng, grid.minX, grid.maxX),
      randRange(rng, grid.minZ, grid.maxZ),
    );
    if (!grid.inBounds(col, row)) continue;
    const [x, z] = grid.cellWorld(col, row);
    const s2 = fields.sampleS2(x, z);
    if (s2 < 2.2) continue; // needs clearance — lone rock in an opening
    if (!fields.hexFlat[grid.index(col, row)]) continue; // not in crater/crack
    let ok = true;
    for (const p of placed) {
      if (Math.hypot(p.x - x, p.z - z) < grid.step * 5) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    // strong height variation: stumps to near-wall-height hoodoos
    const height = randRange(rng, 0.35, 0.95) * params.wallHeight;
    // keep the widest flare/noise bulge inside the hex (inradius ≈ 0.866·size)
    const r0 = randRange(rng, 0.36, 0.48) * grid.size;
    const pillar = makePillar(noise, rng, r0, height, params.terraceStep);
    const y = fields.sampleGround(x, z) - 0.15;
    pillar.position.set(x, y, z);
    pillar.rotation.y = rng() * Math.PI * 2;
    group.add(pillar);
    placed.push({ x, z });

    blocked[grid.index(col, row)] = 1;
    count++;
  }
  return count;
}

/**
 * Hoodoo-style pillar: flared footing with rubble, eroded waist, subtle
 * strata ledges, a narrow neck and a wider balanced cap stone on top.
 * r0 is the nominal shaft radius; total footprint stays inside one hex.
 */
function makePillar(
  noise: NoiseKit,
  rng: Rng,
  r0: number,
  height: number,
  strataStep: number,
): THREE.Group {
  const g = new THREE.Group();
  const seed = rng() * 100;
  const waistDepth = randRange(rng, 0.1, 0.24);
  const neckDepth = randRange(rng, 0.28, 0.45);
  const bandPhase = rng() * Math.PI * 2;
  const bandStep = Math.max(0.3, strataStep * 0.55);

  // ---- shaft (open-ended; the cap stone covers the top) ----
  const radialSegs = 10;
  const heightSegs = Math.max(8, Math.round(height / 0.3));
  const geo = new THREE.CylinderGeometry(1, 1, 1, radialSegs, heightSegs, true);
  geo.translate(0, 0.5, 0); // y in 0..1 along shaft
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const tone = new THREE.Color();
  const strata = [0xa04a24, 0xbe5c2c, 0xcf7038, 0xda8748];

  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i); // 0 bottom .. 1 top
    const a = Math.atan2(pos.getZ(i), pos.getX(i));
    const wy = t * height;

    const footing = 0.5 * Math.exp(-t * 6); // flared base
    const waist = 1 - waistDepth * Math.sin(Math.PI * Math.min(Math.max((t - 0.08) / 0.9, 0), 1));
    const neck = 1 - neckDepth * smoothstep(0.72, 0.98, t);
    const bands = 1 + 0.06 * Math.sin((wy / bandStep) * Math.PI + bandPhase); // strata ledges
    const n = fbm3(noise.n3, Math.cos(a) * 1.6 + seed, wy * 0.7, Math.sin(a) * 1.6 - seed, 3);
    const r = r0 * (0.85 + footing) * waist * neck * bands * (1 + n * 0.18);
    pos.setXYZ(i, Math.cos(a) * r, wy, Math.sin(a) * r);

    const band = Math.floor(wy / bandStep);
    tone.setHex(strata[((band % strata.length) + strata.length) % strata.length]);
    tone.multiplyScalar(0.9 + n * 0.12);
    colors[i * 3] = tone.r;
    colors[i * 3 + 1] = tone.g;
    colors[i * 3 + 2] = tone.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const shaft = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      roughness: 1,
      metalness: 0,
      flatShading: true,
      vertexColors: true,
    }),
  );
  g.add(shaft);

  // ---- balancing cap stone: wider than the neck, offset + tilted ----
  const capR = r0 * randRange(rng, 1.0, 1.45);
  const capGeo = makeRockGeometry(noise, seed + 11.3, 0.3);
  const capTone = new THREE.Color(0x8a4224).multiplyScalar(randRange(rng, 0.9, 1.08));
  const cap = new THREE.Mesh(
    capGeo,
    new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, flatShading: true, color: capTone }),
  );
  cap.scale.set(capR, capR * randRange(rng, 0.45, 0.62), capR);
  cap.position.set((rng() - 0.5) * 0.6 * r0, height + capR * 0.16, (rng() - 0.5) * 0.6 * r0);
  cap.rotation.set((rng() - 0.5) * 0.45, rng() * Math.PI * 2, (rng() - 0.5) * 0.45);
  g.add(cap);

  // ---- footing rubble ----
  const rubbleGeo = makeRockGeometry(noise, seed + 27.9, 0.45);
  const rubbleCount = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < rubbleCount; i++) {
    const a = rng() * Math.PI * 2;
    const d = r0 * randRange(rng, 1.25, 1.6);
    const s = randRange(rng, 0.1, 0.22);
    const rubbleTone = new THREE.Color(ROCK_TONES[Math.floor(rng() * ROCK_TONES.length)]);
    const rock = new THREE.Mesh(
      rubbleGeo,
      new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, flatShading: true, color: rubbleTone }),
    );
    rock.scale.set(s, s * 0.75, s);
    rock.position.set(Math.cos(a) * d, s * 0.3, Math.sin(a) * d);
    rock.rotation.y = rng() * Math.PI * 2;
    g.add(rock);
  }

  g.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
  });
  return g;
}

// ---- scree fans -----------------------------------------------------------

function spreadScree(
  grid: HexGrid,
  fields: Fields,
  params: GenParams,
  noise: NoiseKit,
  rng: Rng,
  group: THREE.Group,
): number {
  if (params.screeClusters <= 0) return 0;
  const perCluster = 14;
  const capacity = params.screeClusters * perCluster;
  const geo = makeRockGeometry(noise, 8.13, 0.5);
  const mesh = new THREE.InstancedMesh(geo, rockMaterial(), capacity);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const color = new THREE.Color();
  let count = 0;
  let clusters = 0;
  let tries = 0;

  while (clusters < params.screeClusters && tries < params.screeClusters * 40) {
    tries++;
    const x = randRange(rng, grid.minX, grid.maxX);
    const z = randRange(rng, grid.minZ, grid.maxZ);
    const s2 = fields.sampleS2(x, z);
    if (s2 < 0.4 || s2 > 1.8) continue; // wall-base band only

    // slide direction: away from the wall = +grad(s2)
    const eps = fields.voxel;
    let gx = fields.sampleS2(x + eps, z) - fields.sampleS2(x - eps, z);
    let gz = fields.sampleS2(x, z + eps) - fields.sampleS2(x, z - eps);
    const gl = Math.hypot(gx, gz) || 1;
    gx /= gl;
    gz /= gl;

    const spread = randRange(rng, 1.2, 2.4);
    for (let i = 0; i < perCluster && count < capacity; i++) {
      const along = Math.pow(rng(), 1.4) * spread;
      const side = (rng() - 0.5) * (0.6 + along * 0.9);
      const sx = x + gx * along - gz * side;
      const sz = z + gz * along + gx * side;
      if (fields.sampleS2(sx, sz) < 0.15) continue;
      if (fields.sampleCrack(sx, sz) < 1.1) continue; // don't float over slots
      const s = params.screeSize * randRange(rng, 0.5, 1.4) * (1.15 - along / (spread + 0.5) * 0.5);
      const y = fields.sampleGround(sx, sz) - s * 0.2;
      e.set(rng() * Math.PI, rng() * Math.PI * 2, 0);
      q.setFromEuler(e);
      m.compose(new THREE.Vector3(sx, y, sz), q, new THREE.Vector3(s, s * 0.75, s));
      mesh.setMatrixAt(count, m);
      color.setHex(ROCK_TONES[Math.floor(rng() * ROCK_TONES.length)]);
      color.multiplyScalar(randRange(rng, 0.8, 1.05));
      mesh.setColorAt(count, color);
      count++;
    }
    clusters++;
  }
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);
  return count;
}
