/**
 * The benchmark harness itself (review R111). It decides whether the suite is
 * green, so its own behaviour is pinned: a sub-microsecond function is batched
 * (it used to measure the clock, not the function), a pass is bounded, an
 * over-budget pass is re-measured and the best pass reported, and a function
 * that is slow on every pass still fails.
 */
import { describe, it, expect } from "bun:test";
import { bench, percentile, printResults, MAX_SAMPLES } from "./bench-harness";

// Spin for about `us` microseconds.
function busy(us: number): void {
  const end = performance.now() + us / 1000;
  while (performance.now() < end) { /* spin */ }
}
const quick = { warmup: 0, minTime: 20, minIters: 50 };

describe("bench harness (R111)", () => {
  it("percentile is nearest-rank over the sorted samples", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);     // 1..100
    expect(percentile(samples, 0.5)).toBe(50);
    expect(percentile(samples, 0.99)).toBe(99);
    expect(percentile(samples, 1)).toBe(100);
    expect(percentile([7], 0.99)).toBe(7);
    expect(percentile([], 0.99)).toBe(0);
  });

  it("batches a sub-microsecond function, so it measures the function and not the clock", () => {
    let n = 0;
    const result = bench("tiny", () => { n++; }, { ...quick, budget: 1000 });
    expect(result.batch).toBeGreaterThan(1);
    expect(result.ops % result.batch).toBe(0);                        // ops counts calls, in whole batches
    expect(result.p50).toBeLessThan(1);                               // per-call time, well under a microsecond
    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it("does not batch a function that is already slower than the clock's resolution", () => {
    const result = bench("slow", () => busy(60), { ...quick, budget: 100_000 });
    expect(result.batch).toBe(1);
    expect(result.p50).toBeGreaterThan(40);
  });

  it("a pass is bounded: it stops at the sample cap even when the time budget has not run out", () => {
    const result = bench("capped", () => {}, { warmup: 0, minTime: 5_000, minIters: 10, budget: 1000 });
    expect(result.ops / result.batch).toBeLessThanOrEqual(MAX_SAMPLES);
    expect(result.ops / result.batch).toBe(MAX_SAMPLES);
  }, 20_000);

  it("re-measures an over-budget pass and reports the best one", () => {
    // Slow for the calibration (20 calls) and the whole first pass (its 50
    // samples take the pass's 20 ms), with a few left over — as when something
    // else on the machine gets in the way for a moment. The second pass starts
    // with those few and is otherwise fast: far under 1% of its samples.
    let slowCalls = 20 + 50 + 10;
    const result = bench("recovers", () => { if (slowCalls > 0) { slowCalls--; busy(400); } }, { ...quick, budget: 100 });
    expect(result.attempts).toBe(2);
    expect(result.passed).toBe(true);
    expect(result.p99).toBeLessThan(100);
  });

  it("a function that is slow on every pass still fails, after all its attempts", () => {
    const result = bench("regressed", () => busy(300), { ...quick, budget: 100, attempts: 3 });
    expect(result.passed).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.p99).toBeGreaterThan(100);
  });

  it("the number of attempts is configurable, and at least one", () => {
    expect(bench("once", () => busy(300), { ...quick, budget: 100, attempts: 1 }).attempts).toBe(1);
    expect(bench("zero", () => busy(300), { ...quick, budget: 100, attempts: 0 }).attempts).toBe(1);
  });

  it("printResults reports failure, and says when a pass needed re-measuring", () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    let allPassed = true, onePassed = true;
    try {
      const base = { name: "a", ops: 100, mean: 1, p50: 1, p99: 2, opsPerSec: 1e6, budget: 10, batch: 1 };
      allPassed = printResults([{ ...base, passed: true, attempts: 1 }, { ...base, name: "b", passed: true, attempts: 2 }]);
      onePassed = printResults([{ ...base, passed: true, attempts: 1 }, { ...base, name: "c", p99: 50, passed: false, attempts: 3 }]);
    } finally { console.log = log; }
    expect(allPassed).toBe(true);
    expect(onePassed).toBe(false);
    const text = lines.join("\n");
    expect(text).toContain("(best of 2)");
    expect(text).toContain("2/2 benchmarks passed");
    expect(text).toContain("1/2 benchmarks passed");
    expect(text).toMatch(/c .*✗ \(best of 3\)/);
  });
});
