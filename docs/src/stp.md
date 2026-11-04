# `src/stp.ts` — Spanning Tree (IEEE 802.1D) convergence

The L2 counterpart to [`routing.ts`](engine.md)'s RIP convergence. `runStpConvergence()` computes the spanning tree across all managed switches and, like RIP, mutates device config in place with the result: an elected root bridge per switch component, each bridge's least-cost path to it, and a role + state for every port. The one port role that has teeth is **alternate** — it blocks data on its link (`link.stpBlocked`), and that's what breaks a switching loop. Without it, a redundant L2 path is a **broadcast storm**: a flooded frame loops forever, multiplying without bound.

## When it runs

- **Before every simulation** — called in `startSimulation` and `runSimulationHeadless` ([engine.ts](engine.md)) right after `runRipConvergence`, so loops are already broken (blocked ports) before the first hop.
- **On topology / STP-config change** — via the `recomputeStp` callback (registered in [app.ts](app.md) as `runStpConvergence()` + `render()`), so a loaded looped topology, a freshly drawn redundant cable, a shut link, an undo, or an `stp on/off` shows its blocked port live without waiting for a run. Wired at: `applyConfigWithoutUndo` ([config.ts](config.md)), the `stp`/`managed` mutators, and every link change through the `linksChanged` hook ([state.ts](state.md) — which also flushes learnt MAC tables): `addLink`/`deleteLink`/`deleteSelection`/`toggleLinkShutdown` ([devices.ts](devices.md); LAN collapse/expand change no cabling, so they don't reconverge), the `shut`/`noshut` commands and the link inspector toggle (which previously skipped the recompute), and `restoreSnapshot`.

## The algorithm

Deterministic, instant (no listening/learning timers — a teaching simplification):

1. **Reset** all `link.stpBlocked` and the derived fields on every managed switch's `config.stp`.
2. **Participants** = managed switches with STP enabled (default on; only an explicit `stp.enabled === false` opts out — `isStpParticipant`).
3. **Bridge id** = priority (default 32768) joined to the switch's base MAC (`config.macAddress`, else `deriveMac(id)`). Lower wins (`cmpBridge`: priority, then MAC).
4. **Edges** = direct wired links between two participants (`isPhysicalLink` — a cable a collapsed LAN hides still counts, and a switch collapsed into a LAN still participates; skipping shut/wireless). A port to a *non-participant* (host/router/hub/AP) is an **edge port** — designated, forwarding.
5. **Per connected component**: the lowest-id bridge is the **root**; a BFS over the component's edges gives every bridge's hop **cost** to the root.
6. **Root port** (each non-root bridge): the incident edge toward a strictly-closer neighbour, tie-broken by (neighbour bridge id, neighbour port number, own port number) — the 802.1D ordering.
7. **Per edge**: the **designated** end is the one with the lower (cost, bridge id); it forwards. The other end is either that bridge's **root** port (forwarding) or an **alternate** (blocking) — and an alternate sets `link.stpBlocked = true`. That's the cut that breaks the loop.
8. **Write back** `config.stp.{bridgeId, rootId, rootCost, ports}` on each participant.

Each port gets `{ role: "root" | "designated" | "alternate", state: "forwarding" | "blocking" }`. The root bridge's ports are all designated/forwarding (`isRootBridge` = `bridgeId === rootId`).

## How the block takes effect

`link.stpBlocked` is folded into **`linkAuthorizedForData(link)`** ([devices.ts](devices.md)) alongside the WiFi / 802.1X / MACsec gates, so all three data-path chokepoints (`l2Reachable`, `findFirstHop`, the engine transit step) drop data on a blocked link with no extra wiring. BPDUs (and the other control frames) bypass it — see [engine.md](engine.md).

## Simplifications (documented teaching scope)

- **One tree per bridge**, not per-VLAN (no PVST/MSTP).
- **Fixed per-link cost of 1** (one hop).
- **Instant convergence** — no listening/learning state machine or timers; ports snap to their final state.
- **Loops across directly linked managed switches.** A loop closed *through* a hub or unmanaged switch isn't modelled (those are treated as transparent media, not bridges). The minimal representable loop is a triangle of three managed switches — the model rejects parallel links between one pair.

`bridgeId`/`rootId`/`rootCost`/`ports` are **derived** and never serialised; only `enabled` and a non-default `priority` round-trip (see [normalise.md](normalise.md) `normaliseStpConfig`, [config.md](config.md), and the `stp`/`managed` script-export emit).

## Exports

- **`runStpConvergence()`** — the convergence pass; returns `{ participants, roots, blocked }` for diagnostics/benchmarks.
- **`isStpParticipant(device)`** — a managed switch running STP (default on).
- **`isRootBridge(device)`** — `config.stp.bridgeId === config.stp.rootId` (drives the canvas root badge).
- **`bridgePriority(device)`**, **`DEFAULT_BRIDGE_PRIORITY`** (32768), **`designatedPorts(device)`** (the ports the animated BPDU run advertises out of).

## The animated BPDU run

`stp` / `run stp` ([scripting.md](../scripting.md)) animate the steady-state BPDU flood: each root bridge advertises a Configuration BPDU out its designated ports (root path cost 0), and `handleBpdu` ([engine.md](engine.md)) relays it down the tree — each bridge advertising its own root path cost (the receiver adds the link cost), terminating, never looping. A `silentStp` setting hides the frames like the other silent protocols. BPDUs are a faithful frame type (dst `01:80:C2:00:00:00`, the bridge group address) — see [frame.md](frame.md).


## Administratively-down cables (LOW sweep)

A shut cable takes no part in the tree: it is excluded from the participant edges *and* is no longer seeded as a designated/forwarding edge port, so the inspector's STP view does not show a shut port as live. (`StpState` has no "disabled" — a shut port simply has no entry.)
