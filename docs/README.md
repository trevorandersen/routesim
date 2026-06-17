# RouteSim — Documentation

RouteSim is an interactive network topology simulator: a canvas-based editor where you build networks of computers, servers, switches, routers, firewalls, and hubs, then run a discrete, frame-level simulation that animates real Ethernet frames (ARP, ICMP, DHCP, DNS, TCP) hop-by-hop. Each device has a CLI terminal modelled on a real open-source NOS.

It is a single-page app with **no framework and no runtime dependencies** — it builds to one portable HTML file. The toolchain is just two binaries: `esbuild` (bundler) and `bun` (runtime, test runner, dev server, build inliner).

## How to read these docs

- **[architecture.md](architecture.md)** — the big picture: module layout, data flow, the callback registry that breaks circular imports, and the two-phase simulation model. Start here.
- **[build.md](build.md)** — how source becomes the single self-contained `rs-web.html`.
- **[testing.md](testing.md)** — the Bun test suite, DOM mocking, fixtures, and how to run/write tests.
- **[benchmarking.md](benchmarking.md)** — the micro-benchmark harness, p99 budgets, and when to add a benchmark.
- **[scripting.md](scripting.md)** — the text-command interface: the console panel, the `window.routesim` JS API, the full command reference, and topology round-trip.
- **[scenarios.md](scenarios.md)** — guided challenges: the scenario data model, goal checking, the goal banner, and how to add a scenario.
- **[src/](src/)** — one document per source file, each a high-level overview of what the module does and how it fits into the whole.

## Per-file documentation

| Module | Doc | Responsibility |
|--------|-----|----------------|
| `src/app.ts` | [app.md](src/app.md) | Entry point — wires callbacks and boots the app |
| `src/state.ts` | [state.md](src/state.md) | The `AppState` singleton, undo stack, callback registry, built-in topologies |
| `src/types.ts` | [types.md](src/types.md) | Every TypeScript interface |
| `src/dom.ts` | [dom.md](src/dom.md) | Cached `getElementById` references |
| `src/ui.ts` | [ui.md](src/ui.md) | Event wiring, tool switching, theme, keyboard shortcuts |
| `src/canvas.ts` | [canvas.md](src/canvas.md) | All `<canvas>` drawing, pan/zoom, the render loop |
| `src/inspector.ts` | [inspector.md](src/inspector.md) | Right panel: device config + link history |
| `src/terminal/` | [terminal.md](src/terminal.md) | Per-device CLI: core dispatch/UI + host/server/router/switch/firewall modules |
| `src/devices.ts` | [devices.md](src/devices.md) | Device/link CRUD, hit-testing, lookup indexes, LAN grouping |
| `src/config.ts` | [config.md](src/config.md) | Save/load `config.json`, built-in + embedded configs |
| `src/engine.ts` | [engine.md](src/engine.md) | The simulation engine: per-device frame processing, headless runs, traceroute |
| `src/routing.ts` | [engine.md](src/engine.md) | Routing table, longest-match lookup, RIP convergence |
| `src/device-registry.ts` | [architecture.md](architecture.md) | Per-type device spec: label, name prefix, size, palette, icon, defaults |
| (firewall) | [firewall.md](src/firewall.md) | The transparent inline firewall device + router INPUT/FORWARD chains |
| (NAT) | [nat.md](src/nat.md) | Source NAT / PAT on routers: interface marks, translation table, return-path restore |
| (DNS/server) | [dns.md](src/dns.md) | The server device (dnsmasq): DNS A-records, name resolution flows, server-side DHCP |
| `src/commands.ts` | [scripting.md](scripting.md) | The text-command engine (parser, verb registry, topology export) |
| `src/console.ts` | [scripting.md](scripting.md) | The command console panel UI |
| `src/scenarios.ts` | [scenarios.md](scenarios.md) | Scenario data model, registry, and goal checking |
| `src/scenario-ui.ts` | [scenarios.md](scenarios.md) | The scenario goal banner UI |
| `src/simulation.ts` | [simulation.md](src/simulation.md) | Ping/DHCP event setup, L2 reachability, routing helpers |
| `src/frame.ts` | [frame.md](src/frame.md) | Ethernet frame factories + label/colour helpers |
| `src/normalise.ts` | [normalise.md](src/normalise.md) | Defensive config normalisation + defaults |
| `src/utils.ts` | [utils.md](src/utils.md) | Pure helpers: IPv4/MAC, escaping, the `cssColor` cache |
| `src/io.ts` | [scripting.md](scripting.md) | JSON import/export (config/scenario/script/log) |
| `src/ribbon.ts` | [src/ribbon.md](src/ribbon.md) | Tabbed ribbon: tab switching + dynamic scenario buttons |

## Conventions

- **Commonwealth English** throughout code and docs (`normalise`, `colour` in prose; CSS/code identifiers keep their canonical spelling, e.g. `color`).
- **No Node.js / npm / Python.** Only `esbuild` + `bun`. See [build.md](build.md).
- Per-device config field access goes through the permissive `DeviceConfig` type (see [types.md](src/types.md)).
