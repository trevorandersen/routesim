# RouteSim — Documentation

RouteSim is an interactive network topology simulator: a canvas-based editor where you build networks of computers, servers, switches, routers, firewalls, and hubs, then run a discrete, frame-level simulation that animates real Ethernet frames (ARP, ICMP, DHCP, DNS, TCP) hop-by-hop. Each device has a CLI terminal modelled on a real open-source NOS.

It is a single-page app with **no framework and no runtime dependencies** — it builds to one portable HTML file. The toolchain is just two binaries: `esbuild` (bundler) and `bun` (runtime, test runner, dev server, build inliner).

## How to read these docs

- **[user-guide.html](user-guide.html)** — a self-contained, printable guide in two parts: how to use RouteSim (building, running, reading results, scenarios, settings), and how the simulation works underneath (the frame model, a run's four stages, switching, routing, RIP/STP, services, NAT, failure diagnosis, determinism, and what is deliberately simplified). Open it directly in a browser.
- **[architecture.md](architecture.md)** — the map of the whole codebase: every source file by layer, the shared state and its mutation rules, the callback bridges and the import cycles they leave, how the GUI, terminals, console and scripts converge on one set of actions, the simulation pipeline, the topology lifecycle, and extension recipes. Start here.
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
| `src/simlog-view.ts` | [engine.md](src/engine.md) | The Sim Log pane: packet list, event log, filter and capture bars |
| `src/port-picker.ts` | [ui.md](src/ui.md) | The Shift-click port-picker dialog (rows from `devices.buildPortList`) |
| `src/canvas.ts` | [canvas.md](src/canvas.md) | All `<canvas>` drawing, pan/zoom, the render loop |
| `src/inspector.ts` | [inspector.md](src/inspector.md) | Right panel: device config + link history |
| `src/terminal/` | [terminal.md](src/terminal.md) | Per-device CLI: core dispatch/UI + host/server/router/switch/firewall modules |
| `src/devices.ts` | [devices.md](src/devices.md) | Device/link CRUD, hit-testing, lookup indexes, LAN grouping |
| `src/config.ts` | [config.md](src/config.md) | Topology serialise/apply + built-in topologies (no `config.json`/fetch) |
| `src/engine.ts` | [engine.md](src/engine.md) | The simulation engine: per-device frame processing, headless runs, traceroute |
| `src/routing.ts` | [engine.md](src/engine.md) | Routing table, longest-match lookup, RIP convergence |
| `src/stp.ts` | [stp.md](src/stp.md) | Spanning Tree (802.1D): root election, port roles/states, loop-breaking |
| `src/snort.ts` | [ids.md](src/ids.md) | Snort rule parsing/matching for the passive IDS sensor (+ SPAN port mirroring) |
| `src/packet-filter.ts` | [packet-filter.md](src/packet-filter.md) | Sim-log packet-list display filter: protocol tokens + a Wireshark-style expression grammar |
| `src/device-registry.ts` | [architecture.md](architecture.md), [devices.md](src/devices.md) | Per-type device spec: label, name prefix, size, palette, icon, defaults, default port count, capability roles (`isHost`/`hasSingleNic`/`isBootable`/…) |
| (firewall) | [firewall.md](src/firewall.md) | The transparent inline firewall device + router INPUT/FORWARD chains |
| (NAT) | [nat.md](src/nat.md) | Source NAT / PAT on routers: interface marks, translation table, return-path restore |
| (DNS/server) | [dns.md](src/dns.md) | The server device (dnsmasq): DNS A-records, name resolution flows, server-side DHCP |
| `src/commands.ts` | [scripting.md](scripting.md) | The text-command engine (parser, verb registry, topology export) |
| `src/console.ts` | [scripting.md](scripting.md) | The command console panel UI |
| `src/scenarios.ts` | [scenarios.md](scenarios.md) | Scenario data model, registry, and goal checking |
| `src/scenario-library.ts` | [scenarios.md](scenarios.md) | The built-in scenario curriculum |
| `src/scenario-ui.ts` | [scenarios.md](scenarios.md) | The scenario goal banner UI |
| `src/simulation.ts` | [simulation.md](src/simulation.md) | Ping/DHCP event setup, L2 reachability, routing helpers |
| `src/frame.ts` | [frame.md](src/frame.md) | Ethernet frame factories + label/colour helpers |
| `src/normalise.ts` | [normalise.md](src/normalise.md) | Defensive config normalisation + defaults |
| `src/utils.ts` | [utils.md](src/utils.md) | Pure helpers: IPv4/MAC, escaping, the `cssColor` cache |
| `src/io.ts` | [scripting.md](scripting.md) | JSON import/export (config/scenario/script/log) |
| `src/settings-url.ts` | [settings-url.md](src/settings-url.md) | Read/apply settings from the URL query string (+ inverse) |
| `src/share-link.ts` | [share-link.md](src/share-link.md) | A whole network in a link (`#net=…`): the codec behind File → Copy link |
| `src/autosave.ts` | [autosave.md](src/autosave.md) | Keeps the network in the browser's localStorage and restores it on the next visit |
| `src/tutorial.ts` | [tutorial.md](src/tutorial.md) | Tutorial mode: an auto-playing faux-cursor demo that builds a network |
| `src/ribbon.ts` | [src/ribbon.md](src/ribbon.md) | Tabbed ribbon: tab switching + dynamic scenario buttons |
| `src/tokenize.ts` | [tokenize.md](src/tokenize.md) | Quote-aware tokenizer for the command language, and its `quoteArg` inverse |
| `src/prng.ts` | [prng.md](src/prng.md) | Seeded per-run PRNG for ephemeral ports and transaction ids |
| `src/help.ts` | [help.md](src/help.md) | The in-app Help → Guide reference for every device type and setting |
| `src/diagnostics.ts` | [testing.md](testing.md) | Read-only model invariants (`diagnoseState`), behind `routesim.diagnose()` and the lifecycle tests |
| `src/stress.ts` | [testing.md](testing.md) | Seeded random command runner with a per-step invariant check |

## Conventions

- **Commonwealth English** throughout code and docs (`normalise`, `colour` in prose; CSS/code identifiers keep their canonical spelling, e.g. `color`).
- **No Node.js / npm / Python.** Only `esbuild` + `bun`. See [build.md](build.md).
- Per-device config field access goes through the permissive `DeviceConfig` type (see [types.md](src/types.md)).
