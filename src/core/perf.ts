/**
 * Per-stage pipeline timing. Every regenerate records how long each
 * generator stage took into `lastPerf`; the wasm-vs-js comparison bench
 * (`__cwWasm.pipelineBench()`) reruns the pipeline with each backend and
 * tabulates the per-stage delta, so every JS→WASM replacement is tracked
 * stage-by-stage instead of only in the end-to-end number.
 */

export type PerfRecord = Record<string, number>;

/** timings of the most recent regenerate, ms per stage */
export const lastPerf: PerfRecord = {};

let current: PerfRecord = lastPerf;
let t0 = 0;

/** start a fresh record for one pipeline run (regenerate calls this first) */
export function perfBegin(): void {
  for (const k of Object.keys(current)) delete current[k];
  t0 = performance.now();
}

/**
 * close the currently running stage and start the next; stages are
 * measured back-to-back so the sum equals the covered pipeline span
 */
export function perfMark(stage: string): void {
  const now = performance.now();
  current[stage] = (current[stage] ?? 0) + (now - t0);
  t0 = now;
}

/**
 * record sub-stage timings measured elsewhere (the fused wasm mesh call
 * times its stages internally) and advance the mark cursor by their sum,
 * so the next perfMark measures only its own span — the covered time isn't
 * double-counted, and only the boundary overhead outside the stages leaks
 * into the following mark
 */
export function perfSpan(stages: PerfRecord): void {
  let sum = 0;
  for (const [stage, ms] of Object.entries(stages)) {
    current[stage] = (current[stage] ?? 0) + ms;
    sum += ms;
  }
  t0 += sum;
}

/** one compact debug line per regenerate: [perf] volumeFill 73.2 | nets 41.0 | … */
export function perfLog(): void {
  const parts = Object.entries(current).map(([k, v]) => `${k} ${v.toFixed(1)}`);
  console.debug(`[perf] ${parts.join(' | ')}`);
}

/** snapshot copy (bench aggregates across runs) */
export function perfSnapshot(): PerfRecord {
  return { ...current };
}
