//! Stage timing that works in both worlds: performance.now() under wasm,
//! std::time natively (the crate is also an rlib for native benches). Only
//! DELTAS of `now_ms()` are meaningful — the epoch is arbitrary in both
//! implementations.

/// Milliseconds from an arbitrary per-thread epoch, sub-ms resolution.
/// Browser build: `globalThis.performance.now()` through a thread-local
/// cached `js_sys::Function` (one Reflect walk per module lifetime, not per
/// call — stage timing must not perturb the stages it measures).
#[cfg(target_arch = "wasm32")]
pub fn now_ms() -> f64 {
    use wasm_bindgen::{JsCast, JsValue};

    thread_local! {
        /// (performance.now, performance) — the function needs its original
        /// `this` at call time
        static PERF_NOW: (js_sys::Function, JsValue) = {
            let perf = js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("performance"))
                .expect("globalThis.performance");
            let now = js_sys::Reflect::get(&perf, &JsValue::from_str("now"))
                .expect("performance.now")
                .dyn_into::<js_sys::Function>()
                .expect("performance.now is a function");
            (now, perf)
        };
    }
    PERF_NOW.with(|(now, perf)| {
        now.call0(perf)
            .expect("performance.now() call")
            .as_f64()
            .unwrap_or(0.0)
    })
}

/// Native build: `std::time::Instant` since a thread-local epoch (stages are
/// timed on the thread that runs them, so per-thread epochs are fine).
#[cfg(not(target_arch = "wasm32"))]
pub fn now_ms() -> f64 {
    use std::time::Instant;

    thread_local! {
        static EPOCH: Instant = Instant::now();
    }
    EPOCH.with(|epoch| epoch.elapsed().as_secs_f64() * 1000.0)
}
