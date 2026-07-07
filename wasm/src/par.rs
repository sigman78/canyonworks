//! Scalar/parallel loop switch: the SAME kernel code runs serial by default
//! and parallel under `--features parallel` (rayon) — no per-backend kernel
//! forks. wasm-pack builds stay serial (browser threads need COOP/COEP +
//! atomics std); native benches flip the feature to measure the same code on
//! real cores.
//!
//! Determinism contract: only loops whose per-item work is independent (and
//! whose reductions are order-insensitive, e.g. f32 max) may go through these
//! helpers — parallel and serial must produce identical output.

#![allow(dead_code, unused_macros, unused_imports)]

/// `zip_for_each!(zip, closure)` — ndarray `Zip::for_each`, or `par_for_each`
/// under the `parallel` feature.
macro_rules! zip_for_each {
    ($zip:expr, $f:expr) => {{
        #[cfg(feature = "parallel")]
        {
            $zip.par_for_each($f)
        }
        #[cfg(not(feature = "parallel"))]
        {
            $zip.for_each($f)
        }
    }};
}
pub(crate) use zip_for_each;

/// Enumerated mutable chunks of a slice (`chunk` elements each, e.g. one
/// vertex's 3 floats), serial or rayon depending on the feature.
pub fn for_each_chunk_mut<T, F>(data: &mut [T], chunk: usize, f: F)
where
    T: Send,
    F: Fn(usize, &mut [T]) + Sync + Send,
{
    #[cfg(feature = "parallel")]
    {
        use rayon::prelude::*;
        data.par_chunks_mut(chunk).enumerate().for_each(|(i, c)| f(i, c));
    }
    #[cfg(not(feature = "parallel"))]
    {
        for (i, c) in data.chunks_mut(chunk).enumerate() {
            f(i, c);
        }
    }
}

/// Enumerated ELEMENTS of a slice — the structured-access twin of
/// `for_each_chunk_mut` for `&mut [[f32; 3]]`-style views (one vertex, one
/// color = one element), serial or rayon.
pub fn for_each_mut<T, F>(data: &mut [T], f: F)
where
    T: Send,
    F: Fn(usize, &mut T) + Sync + Send,
{
    #[cfg(feature = "parallel")]
    {
        use rayon::prelude::*;
        data.par_iter_mut().enumerate().for_each(|(i, e)| f(i, e));
    }
    #[cfg(not(feature = "parallel"))]
    {
        for (i, e) in data.iter_mut().enumerate() {
            f(i, e);
        }
    }
}

/// Two same-length element slices walked in lockstep (e.g. colors + facies
/// per vertex), serial or rayon.
pub fn for_each2_mut<T, U, F>(a: &mut [T], b: &mut [U], f: F)
where
    T: Send,
    U: Send,
    F: Fn(usize, &mut T, &mut U) + Sync + Send,
{
    #[cfg(feature = "parallel")]
    {
        use rayon::prelude::*;
        a.par_iter_mut()
            .zip(b.par_iter_mut())
            .enumerate()
            .for_each(|(i, (ea, eb))| f(i, ea, eb));
    }
    #[cfg(not(feature = "parallel"))]
    {
        for (i, (ea, eb)) in a.iter_mut().zip(b.iter_mut()).enumerate() {
            f(i, ea, eb);
        }
    }
}

/// Two same-stride output slices walked in lockstep (e.g. colors + facies per
/// vertex), serial or rayon.
pub fn for_each_chunk2_mut<T, U, F>(a: &mut [T], b: &mut [U], chunk: usize, f: F)
where
    T: Send,
    U: Send,
    F: Fn(usize, &mut [T], &mut [U]) + Sync + Send,
{
    #[cfg(feature = "parallel")]
    {
        use rayon::prelude::*;
        a.par_chunks_mut(chunk)
            .zip(b.par_chunks_mut(chunk))
            .enumerate()
            .for_each(|(i, (ca, cb))| f(i, ca, cb));
    }
    #[cfg(not(feature = "parallel"))]
    {
        for (i, (ca, cb)) in a.chunks_mut(chunk).zip(b.chunks_mut(chunk)).enumerate() {
            f(i, ca, cb);
        }
    }
}
