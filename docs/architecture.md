# Architecture

RouteSim is a single-page canvas application. All state lives in one `AppState` object (`state.ts`); modules communicate through a small **callback registry** rather than importing each other directly, which keeps the dependency graph acyclic despite heavy cross-talk. There is no framework and no virtual DOM — rendering is imperative: `render()` redraws the whole canvas, `syncPanel()` rebuilds the inspector HTML, `syncTerminal()` rebuilds the terminal HTML.

## Module dependency flow

```
app.ts (entry)
  ├── state.ts       ← AppState, undo system, callback registry, built-in topologies
  ├── dom.ts         ← getElementById refs (evaluated at load time)
  ├── ribbon.ts      ← tabbed ribbon (Main/File/View/Help) + scenario chooser
  ├── io.ts          ← JSON import/export (config/scenario/script/log)
  ├── settings-url.ts ← parse/apply settings from the URL query string (+ inverse)
  ├── ui.ts          ← event listeners, tool switching, keyboard, theme
  ├── canvas.ts      ← render loop, pan/zoom, device/link/transit drawing
  ├── inspector.ts   ← right panel: device details, link frame history
  ├── terminal/      ← bottom panel CLI: core dispatch/UI + host/router/switch/firewall/attacker (the Kali CLI, shared by the Kali PC and the Red Team actor)
  ├── devices.ts     ← device/link CRUD, hit testing, lookup indexes, LAN collapse
  ├── config.ts      ← topology serialise/apply + built-in topologies (no fetch)
  ├── engine.ts      ← simulation engine: step loop, per-device frame processing
  ├── routing.ts     ← routing table, longest-match lookup, RIP convergence
  ├── stp.ts         ← Spanning Tree (802.1D) convergence: root election, blocked ports
  ├── snort.ts       ← Snort rule parse/match/format for the passive IDS (fed by switch SPAN mirroring)
  ├── device-registry.ts ← per-type spec (label, prefix, size, palette, icon, defaults)
  ├── simulation.ts  ← buildPingEvents/buildDhcpEvents, L2 reachability, routing utils
  ├── frame.ts       ← EthernetFrame factories, frame labels/colours
  ├── normalise.ts   ← config normalisation, device defaults, router MAC generation
  ├── utils.ts       ← escapeHtml, IPv4/MAC validation, cssColor cache
  └── types.ts       ← all TypeScript interfaces
```

## The callback registry (breaking circular imports)

Many modules need to trigger work in others — e.g. `engine.ts` mutates state then needs the canvas to redraw; `devices.ts` changes selection then needs the inspector to refresh. Wiring these as direct imports would create cycles (e.g. `canvas → devices → canvas`). Two registration bridges avoid that:

- **`registerCallbacks()`** in `state.ts` — exposes `render`, `syncPanel`, `syncTerminal`, `resizeCanvas` through `sync()`. Any module calls `sync().render()` without importing `canvas.ts`.
- **`registerDeviceCallbacks()`** in `devices.ts` — exposes `setTool`, `setNetworkPanel`, `linkUp` (a new cable boots an unconfigured host — first-boot DHCP/APIPA in `engine.ts`), and `openTerminal` (configuring a CLI device auto-opens its terminal) so `devices.ts` can drive UI/engine work without importing `ui.ts`/`engine.ts`/`terminal/`.

Both are wired once in `app.ts` at startup. Tests register no-op versions via `registerNoopCallbacks()` (see [testing.md](testing.md)).

## State model

`state` (`state.ts`) is a single mutable object holding both **persistent** data (`devices`, `links`, `configStore`) and **transient** UI/sim data (`selectedId`, `tool`, `drag`, `pan`, `scale`, `simulation`, the terminal sessions — `terminalSessions`/`terminal` — and `dock`). The undo system snapshots only the persistent network (`networkSnapshot()` strips transient fields like link frame history). Editing fields capture an undo point on focus (`captureUndoOnFocus`).

## Simulation model (two phases)

A ping/DHCP run is driven by `engine.ts`:

1. **Process phase** — `buildPingEvents()`/`buildDhcpEvents()` (`simulation.ts`) validate the request and produce an initial queue of `SimEvent`s plus a `pendingArp` map for deferred ICMPs. The engine dequeues each event, runs the per-device handler (`processAtComputer` / `processAtSwitch` / `processAtRouter`), and collects the outgoing frames.
2. **Animate phase** — a `requestAnimationFrame` loop interpolates "transit dots" along links (amber = ARP, blue = ICMP request, green = ICMP reply, violet = DHCP, orange = TCP, cyan = DNS, red = errors). The opening frame is seeded as a transit from the source (so it animates off the source, not the first hop); when a dot arrives, the frame is delivered (and recorded in the packet capture) and re-enters the process phase at the next hop.

Routers run `runRipConvergence()` before a simulation starts so RIP-learned routes exist. Forwarding uses a merged routing table (`buildRoutingTable`) combining connected, static, and RIP routes.

Managed switches run `runStpConvergence()` (`stp.ts`) immediately after, electing a root bridge per connected component and blocking alternate ports (`link.stpBlocked`) to break L2 loops before any frame is sent.

See [engine.md](src/engine.md) and [simulation.md](src/simulation.md) for detail.

## Performance notes

The render loop and engine are hot paths. Key optimisations (all in the relevant module docs):

- `getDevice`, link adjacency (`linksFor`), and link-by-id (`linkById`) use **lazy indexes** in `devices.ts`, rebuilt only when `state.devices`/`state.links` change (detected by array identity + length).
- `cssColor` (`utils.ts`) **caches** `getComputedStyle` results, cleared on theme change, so the draw loop never forces a style recalc.
- The render loop caches static icon `Path2D`s and reads a switch's port maps through the **memoised** `memoPortModes`/`memoPortVlans` (`normalise.ts`, keyed on config-object identity).
- `runRipConvergence` memoises router interface normalisation across iterations; an ARP-reply that flushes several buffered frames builds the routing table once and passes it into each `routingLookup`.

These paths are guarded by the benchmark suite — see [benchmarking.md](benchmarking.md).
