/**
 * Lightweight benchmark harness for RouteSim.
 *
 * Uses performance.now() with warmup, calibration, and statistical
 * measurement. Designed to run under Bun's test runner.
 */

export interface BenchResult {
  name: string;
  ops: number;
  mean: number;       // µs per op
  p50: number;        // µs
  p99: number;        // µs
  opsPerSec: number;
  passed: boolean;
  budget: number;     // µs
}

export interface BenchOptions {
  budget?: number;     // p99 budget in µs (default: 1000)
  warmup?: number;     // warmup iterations (default: 50)
  minTime?: number;    // minimum measurement time in ms (default: 500)
  minIters?: number;   // minimum measured iterations (default: 100)
}

/**
 * Benchmark a synchronous function.
 *
 * 1. Warmup — run fn() to let JIT optimize
 * 2. Calibrate — 20 iterations to estimate per-iteration time
 * 3. Measure — collect samples for at least minTime ms
 * 4. Compute p50/p99/mean, compare to budget
 */
export function bench(name: string, fn: () => void, opts: BenchOptions = {}): BenchResult {
  const budget = opts.budget ?? 1000;
  const warmup = opts.warmup ?? 50;
  const minTime = opts.minTime ?? 500;
  const minIters = opts.minIters ?? 100;

  // 1. Warmup
  for (let i = 0; i < warmup; i++) fn();

  // 2. Calibrate — measure 20 iterations to estimate cost
  const calSamples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    fn();
    calSamples.push((performance.now() - t0) * 1000); // µs
  }
  calSamples.sort((a, b) => a - b);

  // 3. Measure — collect individual samples
  const samples: number[] = [];
  const deadline = performance.now() + minTime;

  while (samples.length < minIters || performance.now() < deadline) {
    const t0 = performance.now();
    fn();
    samples.push((performance.now() - t0) * 1000); // µs
  }

  // 4. Compute stats
  samples.sort((a, b) => a - b);
  const ops = samples.length;
  const sum = samples.reduce((a, b) => a + b, 0);
  const mean = sum / ops;
  const p50 = percentile(samples, 0.50);
  const p99 = percentile(samples, 0.99);
  const opsPerSec = mean > 0 ? 1_000_000 / mean : Infinity;

  return {
    name,
    ops,
    mean,
    p50,
    p99,
    opsPerSec,
    passed: p99 < budget,
    budget,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Print a formatted results table to stdout.
 * Returns true if all benchmarks passed.
 */
export function printResults(results: BenchResult[]): boolean {
  const nameWidth = Math.max(12, ...results.map(r => r.name.length));

  const header = [
    "Benchmark".padEnd(nameWidth),
    "ops/sec".padStart(12),
    "p50 (µs)".padStart(12),
    "p99 (µs)".padStart(12),
    "budget (µs)".padStart(13),
    "status".padStart(8),
  ].join("  ");

  const separator = "─".repeat(header.length);

  console.log("\n" + separator);
  console.log(header);
  console.log(separator);

  for (const r of results) {
    const status = r.passed ? "  ✓" : "  ✗";
    const line = [
      r.name.padEnd(nameWidth),
      formatNumber(r.opsPerSec).padStart(12),
      r.p50.toFixed(1).padStart(12),
      r.p99.toFixed(1).padStart(12),
      r.budget.toFixed(0).padStart(13),
      status.padStart(8),
    ].join("  ");
    console.log(line);
  }

  console.log(separator);

  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  console.log(`${passed}/${total} benchmarks passed\n`);

  return passed === total;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toFixed(0);
}
