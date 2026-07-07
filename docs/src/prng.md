# `src/prng.ts` — the seeded per-run PRNG

The simulation's source of the **ephemeral, protocol-visible random values**:
TCP source ports, DHCP transaction ids, and attack scan ports. Everything else
about a run is already deterministic; these three were the only `Math.random()`
/ `Date.now()` sites, and they leaked run-to-run variation into captures and NAT
translations.

## Policy

By default each run **reseeds from the wall clock**, so an identical topology
still produces *varying* traffic like the real world. Pin the seed with the
console **`seed <n>`** command and every run becomes bit-for-bit reproducible —
the same ports, the same ids, the same NAT translations — which turns the
saved-capture **Compare** view into a true before/after diff. `seed off`
restores the clock default; `seed` with no argument reports the current state
(and, when unpinned, the last run's seed so you can reproduce it).

This is the concrete implementation of the **Determinism & honest divergence**
principle in [CLAUDE.md](../../CLAUDE.md).

## API

- **`seedSimRng()`** — reseed for a new run (pinned value if set, else the
  clock); returns the seed used. Called at the top of every run builder
  (`buildPingEvents`/`buildConnectEvents`/`buildDhcpEvents`/`buildScanEvents`),
  so the seed is fixed *before* any ephemeral value is drawn. Nested builders
  (`buildHttpEvents` → `buildConnectEvents`, `buildAttackEvents` →
  `buildScanEvents`) inherit the leaf's reseed — harmless, since a pinned seed
  reseeds to the same stream every time.
- **`simRandom()`** / **`simRandomInt(lo, hi)`** — the next float / integer from
  the current run's stream. **New engine randomness must use these, never
  `Math.random()`/`Date.now()`**, or reproducibility silently breaks.
- **`setSeedOverride(n | null)`** / **`getSeedOverride()`** — pin or clear the
  seed (the `seed` command); module-global, so it persists across runs and
  topology loads until changed or the page reloads. Not serialised — it's a
  session-level debugging/repro aid, not topology config.
- **`currentSimSeed()`** — the seed the current/last run actually used.

Generator: **mulberry32** — small, fast, dependency-free (no crypto guarantees,
none needed). Frame ids are a separate monotonic counter in `frame.ts` with no
wall-clock component, so they too reproduce across identical runs.

## How it fits

A leaf module with no state/engine dependencies. `simulation.ts` draws its
ephemeral values from it (and reseeds per run); `commands.ts` exposes the `seed`
command. Tested in `tests/prng.test.ts` (stream reproducibility, end-to-end port
reproducibility, the `seed` command).
