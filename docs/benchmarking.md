# Benchmarking

Performance is a project goal. Hot paths — device/port lookup, per-device frame processing, routing, RIP convergence, L2 reachability — carry **p99 latency budgets** enforced as ordinary tests, so a regression fails CI like any other test.

## Running

```bash
bun test tests/bench.test.ts
```

Each group prints a table (ops/sec, p50/p99 in µs, budget, pass/✗) and asserts that the measured p99 is within budget. The benchmark UI is also served by `test-server.ts`:

```bash
bun test-server.ts                # then open http://localhost:8767/benchmark.html
```

## Infrastructure

| File | Purpose |
|------|---------|
| `tests/bench.test.ts` | The benchmark cases, grouped by subject |
| `tests/bench-harness.ts` | `bench(name, fn, { budget })` — warms up, times many iterations, computes p50/p99, returns a `BenchResult`; `printResults()` formats the table |
| `tests/bench-fixtures.ts` | Scalable topology generators: `smallLinear`, `mediumStar`, `largeMesh`, `stressGrid`, `ripStress`, `managedSwitch`, `routerWithRoutes` |

Budgets are calibrated for a ~2 GHz CPU with headroom, so they pass on modest hardware while still catching real regressions.

## Current cases

| Group | What it measures |
|-------|------------------|
| `bench: getDevice` | The lazy device index lookup at 5/50/100 devices |
| `bench: linkedPortsFor` | Link adjacency + port resolution at several link counts |
| `bench: connectedIds` | Neighbour lookup via the link index |
| `bench: l2Reachable` | VLAN-aware BFS reachability (runs on every ping/DHCP validation) |
| `bench: render-path helpers` | `getVlanForDevice` and `isTrunkLink` — the memoised per-frame port-map reads the render loop runs once per host/link |
| `bench: linkById` | The lazy by-id link index (replaces per-frame `state.links.find`) |
| `bench: processAtSwitch` | Unmanaged flood, managed 802.1Q flood, known unicast |
| `bench: firewall` | `evaluateFirewall` worst case — a full 50-rule scan with no match |
| `bench: dns` | `processAtServer` answering a DNS query against 50 A-records |
| `bench: packetColumns` | The packet-list column mapping (runs per visible row on every sim-log sync) |
| `bench: routing` | `buildRoutingTable` and `processAtRouter` (connected/static/NAT translate) |
| `bench: routingLookup` | Per-frame route resolution — building the table per call vs reusing a prebuilt table (the ARP-flush path) |
| `bench: RIP convergence` | `runRipConvergence` at 5/10/15 routers |
| `bench: STP convergence` | `runStpConvergence` at 10/30 managed switches (a ring with chords — many L2 loops to resolve) |

## Adding a benchmark

When you add or change performance-sensitive code (engine handlers, lookups, routing, convergence), add a matching case:

```ts
describe("bench: myThing", () => {
  const results: BenchResult[] = [];
  beforeEach(() => resetState());

  it("myThing — N items", () => {
    const topo = largeMesh(50);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    results.push(bench("myThing — 50 items", () => {
      myThing(/* ... */);
    }, { budget: 100 }));   // p99 budget in µs
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("prints results", () => { if (results.length) printResults(results); });
});
```

Guidelines:
- Run the same case **before and after** a change to confirm no regression.
- Favour allocation-free, tight implementations on the simulation critical path.
- Keep budgets realistic — generous enough for low-end CPUs, tight enough to catch real slowdowns.
- Benchmarks that need a real DOM (e.g. `cssColor`'s `getComputedStyle`) can't run under the test stub — verify those via the preview instead.
