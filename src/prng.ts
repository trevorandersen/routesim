/**
 * Per-run pseudo-random source for the simulation's ephemeral, protocol-visible
 * values — TCP source ports, DHCP transaction ids, attack scan ports.
 *
 * Determinism policy (see CLAUDE.md "Determinism & honest divergence"): by
 * default each run reseeds from the wall clock, so identical topologies still
 * produce *varying* traffic like the real world. Pin the seed with the console
 * `seed <n>` command and every run becomes bit-for-bit reproducible — the same
 * ports, ids, and NAT translations — which is what makes the saved-capture
 * Compare view a true before/after diff. `seed off` restores the clock default.
 *
 * mulberry32: a small, fast, dependency-free generator (no crypto guarantees,
 * none needed — this is teaching traffic, not security).
 */

let override: number | null = null;   // user-pinned seed, or null for the clock default
let currentSeed = 0;                   // the seed the current/last run actually used
let rng: () => number = mulberry32(1);

/**
 * The generator itself. Exported so a harness needing its *own* independent
 * stream (the stress runner) reuses this implementation rather than copying it
 * — it must not share the module-global `rng`, which every run builder reseeds.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pin the seed (reproducible runs) or clear the pin with null (clock default). */
export function setSeedOverride(seed: number | null): void {
  override = seed == null ? null : seed >>> 0;
}
export function getSeedOverride(): number | null { return override; }

/** The seed the current/last run used — what `seed <n>` would reproduce it. */
export function currentSimSeed(): number { return currentSeed; }

/**
 * Reseed for a new run — called once at the start of every simulation. Uses the
 * pinned seed if set, else the wall clock (so unpinned runs vary). Returns the
 * seed used, for the run's log line.
 */
export function seedSimRng(): number {
  currentSeed = override != null ? override : (Date.now() >>> 0);
  rng = mulberry32(currentSeed);
  return currentSeed;
}

/** Next float in [0, 1) from the current run's stream. */
export function simRandom(): number { return rng(); }

/** Next integer in [loInclusive, hiExclusive) from the current run's stream. */
export function simRandomInt(loInclusive: number, hiExclusive: number): number {
  return loInclusive + Math.floor(rng() * (hiExclusive - loInclusive));
}
