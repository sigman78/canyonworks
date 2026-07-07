//! Bit-compatible port of the JS noise stack: `mulberry32` (core/rng.ts)
//! and simplex-noise v4.0.3 (Jonas Wagner, MIT — the exact package the
//! TS generator uses), plus the fbm/ridged wrappers from core/noise.ts.
//!
//! Determinism contract: for the same seed, `Noise2`/`Noise3` here return
//! the SAME f64 values as `makeNoise(seed).n2/n3` in TS — both sides are
//! IEEE-754 doubles evaluated in the same operation order. The parity
//! harness (src/core/wasmGen.ts) checks this on every run.

/// Deterministic 32-bit PRNG, floats in [0, 1). Matches core/rng.ts
/// mulberry32 exactly (JS `|0`/`>>>`/`Math.imul` == u32 wrapping ops).
pub struct Mulberry32 {
    a: u32,
}

impl Mulberry32 {
    pub fn new(seed: u32) -> Self {
        Self { a: seed }
    }

    pub fn next(&mut self) -> f64 {
        self.a = self.a.wrapping_add(0x6d2b_79f5);
        let a = self.a;
        let mut t = (a ^ (a >> 15)).wrapping_mul(a | 1);
        t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61))) ^ t;
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

/// simplex-noise's buildPermutationTable: 256-entry shuffle mirrored to 512
fn build_permutation_table(rng: &mut Mulberry32) -> [u8; 512] {
    let mut p = [0u8; 512];
    for (i, v) in p.iter_mut().take(256).enumerate() {
        *v = i as u8;
    }
    for i in 0..255usize {
        // JS: i + ~~(random() * (256 - i)) — trunc == floor (operand >= 0)
        let r = i + (rng.next() * (256 - i) as f64) as usize;
        p.swap(i, r);
    }
    for i in 256..512 {
        p[i] = p[i - 256];
    }
    p
}

const SQRT3: f64 = 1.7320508075688772; // Math.sqrt(3) as f64
const F2: f64 = 0.5 * (SQRT3 - 1.0);
const G2: f64 = (3.0 - SQRT3) / 6.0;
const F3: f64 = 1.0 / 3.0;
const G3: f64 = 1.0 / 6.0;

#[rustfmt::skip]
const GRAD2: [f64; 24] = [
    1.0, 1.0, -1.0, 1.0, 1.0, -1.0, -1.0, -1.0,
    1.0, 0.0, -1.0, 0.0, 1.0, 0.0, -1.0, 0.0,
    0.0, 1.0, 0.0, -1.0, 0.0, 1.0, 0.0, -1.0,
];

#[rustfmt::skip]
const GRAD3: [f64; 36] = [
    1.0, 1.0, 0.0, -1.0, 1.0, 0.0, 1.0, -1.0, 0.0, -1.0, -1.0, 0.0,
    1.0, 0.0, 1.0, -1.0, 0.0, 1.0, 1.0, 0.0, -1.0, -1.0, 0.0, -1.0,
    0.0, 1.0, 1.0, 0.0, -1.0, 1.0, 0.0, 1.0, -1.0, 0.0, -1.0, -1.0,
];

#[inline(always)]
fn fast_floor(x: f64) -> i32 {
    x.floor() as i32
}

/// 2D simplex noise, output in [-1, 1]
pub struct Noise2 {
    perm: [u8; 512],
    grad_x: [f64; 512],
    grad_y: [f64; 512],
}

impl Noise2 {
    pub fn new(seed: u32) -> Self {
        let mut rng = Mulberry32::new(seed);
        let perm = build_permutation_table(&mut rng);
        let mut grad_x = [0.0; 512];
        let mut grad_y = [0.0; 512];
        for i in 0..512 {
            let g = (perm[i] % 12) as usize * 2;
            grad_x[i] = GRAD2[g];
            grad_y[i] = GRAD2[g + 1];
        }
        Self { perm, grad_x, grad_y }
    }

    pub fn sample(&self, x: f64, y: f64) -> f64 {
        let mut n0 = 0.0;
        let mut n1 = 0.0;
        let mut n2 = 0.0;
        let s = (x + y) * F2;
        let i = fast_floor(x + s);
        let j = fast_floor(y + s);
        let t = (i + j) as f64 * G2;
        let x0 = x - (i as f64 - t);
        let y0 = y - (j as f64 - t);
        let (i1, j1) = if x0 > y0 { (1, 0) } else { (0, 1) };
        let x1 = x0 - i1 as f64 + G2;
        let y1 = y0 - j1 as f64 + G2;
        let x2 = x0 - 1.0 + 2.0 * G2;
        let y2 = y0 - 1.0 + 2.0 * G2;
        let ii = (i & 255) as usize;
        let jj = (j & 255) as usize;
        let mut t0 = 0.5 - x0 * x0 - y0 * y0;
        if t0 >= 0.0 {
            let gi0 = ii + self.perm[jj] as usize;
            t0 *= t0;
            n0 = t0 * t0 * (self.grad_x[gi0] * x0 + self.grad_y[gi0] * y0);
        }
        let mut t1 = 0.5 - x1 * x1 - y1 * y1;
        if t1 >= 0.0 {
            let gi1 = ii + i1 + self.perm[jj + j1] as usize;
            t1 *= t1;
            n1 = t1 * t1 * (self.grad_x[gi1] * x1 + self.grad_y[gi1] * y1);
        }
        let mut t2 = 0.5 - x2 * x2 - y2 * y2;
        if t2 >= 0.0 {
            let gi2 = ii + 1 + self.perm[jj + 1] as usize;
            t2 *= t2;
            n2 = t2 * t2 * (self.grad_x[gi2] * x2 + self.grad_y[gi2] * y2);
        }
        70.0 * (n0 + n1 + n2)
    }
}

/// 3D simplex noise, output in [-1, 1]
pub struct Noise3 {
    perm: [u8; 512],
    grad_x: [f64; 512],
    grad_y: [f64; 512],
    grad_z: [f64; 512],
}

impl Noise3 {
    pub fn new(seed: u32) -> Self {
        let mut rng = Mulberry32::new(seed);
        let perm = build_permutation_table(&mut rng);
        let mut grad_x = [0.0; 512];
        let mut grad_y = [0.0; 512];
        let mut grad_z = [0.0; 512];
        for i in 0..512 {
            let g = (perm[i] % 12) as usize * 3;
            grad_x[i] = GRAD3[g];
            grad_y[i] = GRAD3[g + 1];
            grad_z[i] = GRAD3[g + 2];
        }
        Self { perm, grad_x, grad_y, grad_z }
    }

    pub fn sample(&self, x: f64, y: f64, z: f64) -> f64 {
        let s = (x + y + z) * F3;
        let i = fast_floor(x + s);
        let j = fast_floor(y + s);
        let k = fast_floor(z + s);
        let t = (i + j + k) as f64 * G3;
        let x0 = x - (i as f64 - t);
        let y0 = y - (j as f64 - t);
        let z0 = z - (k as f64 - t);
        #[allow(clippy::collapsible_else_if)]
        let (i1, j1, k1, i2, j2, k2) = if x0 >= y0 {
            if y0 >= z0 {
                (1, 0, 0, 1, 1, 0)
            } else if x0 >= z0 {
                (1, 0, 0, 1, 0, 1)
            } else {
                (0, 0, 1, 1, 0, 1)
            }
        } else {
            if y0 < z0 {
                (0, 0, 1, 0, 1, 1)
            } else if x0 < z0 {
                (0, 1, 0, 0, 1, 1)
            } else {
                (0, 1, 0, 1, 1, 0)
            }
        };
        let x1 = x0 - i1 as f64 + G3;
        let y1 = y0 - j1 as f64 + G3;
        let z1 = z0 - k1 as f64 + G3;
        let x2 = x0 - i2 as f64 + 2.0 * G3;
        let y2 = y0 - j2 as f64 + 2.0 * G3;
        let z2 = z0 - k2 as f64 + 2.0 * G3;
        let x3 = x0 - 1.0 + 3.0 * G3;
        let y3 = y0 - 1.0 + 3.0 * G3;
        let z3 = z0 - 1.0 + 3.0 * G3;
        let ii = (i & 255) as usize;
        let jj = (j & 255) as usize;
        let kk = (k & 255) as usize;
        let p = &self.perm;

        let mut t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
        let n0 = if t0 < 0.0 {
            0.0
        } else {
            let gi0 = ii + p[jj + p[kk] as usize] as usize;
            t0 *= t0;
            t0 * t0 * (self.grad_x[gi0] * x0 + self.grad_y[gi0] * y0 + self.grad_z[gi0] * z0)
        };
        let mut t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
        let n1 = if t1 < 0.0 {
            0.0
        } else {
            let gi1 = ii + i1 + p[jj + j1 + p[kk + k1] as usize] as usize;
            t1 *= t1;
            t1 * t1 * (self.grad_x[gi1] * x1 + self.grad_y[gi1] * y1 + self.grad_z[gi1] * z1)
        };
        let mut t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
        let n2 = if t2 < 0.0 {
            0.0
        } else {
            let gi2 = ii + i2 + p[jj + j2 + p[kk + k2] as usize] as usize;
            t2 *= t2;
            t2 * t2 * (self.grad_x[gi2] * x2 + self.grad_y[gi2] * y2 + self.grad_z[gi2] * z2)
        };
        let mut t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
        let n3 = if t3 < 0.0 {
            0.0
        } else {
            let gi3 = ii + 1 + p[jj + 1 + p[kk + 1] as usize] as usize;
            t3 *= t3;
            t3 * t3 * (self.grad_x[gi3] * x3 + self.grad_y[gi3] * y3 + self.grad_z[gi3] * z3)
        };
        32.0 * (n0 + n1 + n2 + n3)
    }
}

/// fbm wrappers matching core/noise.ts (default lacunarity 2, gain 0.5)
pub fn fbm2(n: &Noise2, x: f64, y: f64, octaves: u32) -> f64 {
    let mut amp = 1.0;
    let mut freq = 1.0;
    let mut sum = 0.0;
    let mut norm = 0.0;
    for _ in 0..octaves {
        sum += amp * n.sample(x * freq, y * freq);
        norm += amp;
        amp *= 0.5;
        freq *= 2.0;
    }
    sum / norm
}

pub fn fbm3(n: &Noise3, x: f64, y: f64, z: f64, octaves: u32) -> f64 {
    let mut amp = 1.0;
    let mut freq = 1.0;
    let mut sum = 0.0;
    let mut norm = 0.0;
    for _ in 0..octaves {
        sum += amp * n.sample(x * freq, y * freq, z * freq);
        norm += amp;
        amp *= 0.5;
        freq *= 2.0;
    }
    sum / norm
}

/// core/noise.ts `smoothstep(a, b, x)`: t = clamp01((x-a)/(b-a)); t*t*(3-2t).
/// clamp01 written out branch-for-branch to match the JS ternary exactly
/// (NaN passes through both comparisons and returns NaN, same as JS).
pub fn smoothstep(a: f64, b: f64, x: f64) -> f64 {
    let v = (x - a) / (b - a);
    let t = if v < 0.0 {
        0.0
    } else if v > 1.0 {
        1.0
    } else {
        v
    };
    t * t * (3.0 - 2.0 * t)
}

/// core/noise.ts `clamp01`: branch-for-branch JS ternary (NaN passes
/// through both comparisons and returns NaN, same as JS).
#[inline(always)]
pub fn clamp01(v: f64) -> f64 {
    if v < 0.0 {
        0.0
    } else if v > 1.0 {
        1.0
    } else {
        v
    }
}

/// core/noise.ts `lerp(a, b, t)`: a + (b - a) * t, same operation order.
#[inline(always)]
pub fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

pub fn ridged2(n: &Noise2, x: f64, y: f64, octaves: u32) -> f64 {
    let mut amp = 0.5;
    let mut freq = 1.0;
    let mut sum = 0.0;
    for _ in 0..octaves {
        sum += amp * (1.0 - n.sample(x * freq, y * freq).abs());
        amp *= 0.5;
        freq *= 2.0;
    }
    sum
}
