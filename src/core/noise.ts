import { createNoise2D, createNoise3D } from 'simplex-noise';
import type { NoiseFunction2D, NoiseFunction3D } from 'simplex-noise';
import { mulberry32 } from './rng';

export interface NoiseKit {
  n2: NoiseFunction2D;
  n3: NoiseFunction3D;
}

export function makeNoise(seed: number): NoiseKit {
  return {
    n2: createNoise2D(mulberry32(seed ^ 0x2f6e2b1)),
    n3: createNoise3D(mulberry32(seed ^ 0x5b7e4d3)),
  };
}

/** Fractal brownian motion, output roughly in [-1, 1]. */
export function fbm2(
  n2: NoiseFunction2D,
  x: number,
  y: number,
  octaves = 4,
  lacunarity = 2,
  gain = 0.5,
): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * n2(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

export function fbm3(
  n3: NoiseFunction3D,
  x: number,
  y: number,
  z: number,
  octaves = 3,
  lacunarity = 2,
  gain = 0.5,
): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * n3(x * freq, y * freq, z * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged noise in [0, 1]; sharp crests at 1. */
export function ridged2(n2: NoiseFunction2D, x: number, y: number, octaves = 3): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * (1 - Math.abs(n2(x * freq, y * freq)));
    amp *= 0.5;
    freq *= 2;
  }
  return sum;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
