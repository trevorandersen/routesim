# RouteSim

Interactive network topology simulator. Canvas-based editor with discrete frame-level ping simulation, animated hop-by-hop forwarding, and per-device CLI terminals.

## Goals & principles

RouteSim is a teaching tool: it makes the invisible parts of a network visible by simulating real Ethernet frames (ARP, ICMP, DHCP) and watching them hop through switches and routers. Design decisions follow from a few principles:

- **Zero-install, single file.** The whole app builds to portable single-file HTML that runs offline by opening it in a browser. `rs-web.html` embeds `config.json` too, so it makes zero runtime requests; `rs-main.html` fetches `config.json` at runtime (it reads/writes that file locally).
- **Minimal toolchain.** Only two binaries: `esbuild` (bundle) and `bun` (run, test, serve, inline). No Node.js, no npm, no `package.json`, no `node_modules`, no Python. Hard constraint — see Build.
- **Faithful to the protocols.** Simulated behaviour should match how real ARP, switching, routing, RIP, and DHCP work — down to frame fields and the order of operations. Correctness over shortcuts.
- **Typed, tested, and small.** Prefer concrete types over `any`, keep per-device handlers focused, and cover new behaviour with tests.
- **Performance is a feature.** The simulation engine runs hot — device/port lookup, per-device frame processing, routing, and RIP convergence are all on the critical path. Keep them fast, and add a benchmark with a p99 budget for any new performance-sensitive code so regressions are caught early.
- **Scoped work.** When exploring or searching the codebase, stay within this repository — don't scan the home directory or the wider filesystem.

## Build

```bash
bash build.sh          # dev build  → rs-main.html + rs-web.html
bash build.sh --minify # minified build
```

The project uses only two tools: `esbuild` (bundler) and `bun` (runtime, test runner, test server, build inlining). For each variant the build bundles TypeScript into an IIFE via esbuild, then `bun build-inline.ts <output>` inlines the JS + CSS into `template.html`. Each output is a single portable HTML file.

### Build variants

`build.sh` emits two variants from the same source, differing only by the compile-time flag `__BUILD_READONLY__` (injected via esbuild `--define`, read through `src/env.ts`):

| Output | `__BUILD_READONLY__` | config.json | Use |
|--------|----------------------|-------------|-----|
| `rs-main.html` | `false` | fetched at runtime; read **and** write | Local use (full editor) |
| `rs-web.html` | `true` | **embedded** at build time; read only (Save hidden) | Self-contained one-file web host |

`src/env.ts` exports `READONLY`, which defaults to `false` in dev/test (bun runs the TS directly, without the `--define`). Guard any write-only capability behind `READONLY` and hide its UI in `setupUI()` — see `saveConfig()` in `config.ts` and the Save button wiring in `ui.ts`. To add a variant, add one `build_variant <flag> <output> [extra build-inline args]` line in `build.sh`.

**Embedded config (web variant):** `build.sh` passes `--embed-config` to `build-inline.ts` for `rs-web.html`, which inlines `config.json` into a `<script id="embeddedConfig" type="application/json">` block (the `{{CONFIG}}` slot in `template.html`; left empty for `rs-main.html`). At startup `refreshConfigStore()` (config.ts) calls `readEmbeddedConfigStore()` and uses the embedded store if present, otherwise falls back to `fetch("./config.json")`. So `rs-web.html` is a true single file — no runtime requests.

**`build-inline.ts` gotcha:** it inserts CSS/JS/config via `String.replace` **replacer functions**, not string replacements — a string replacement would interpret `` $` ``/`$'`/`$&`/`$$` in the inserted content as special patterns and corrupt the output.

**Do not introduce any other tooling or runtime dependencies.** No `npm`, no `package.json`, no `node_modules`, no Node.js, no Python. The entire toolchain is `esbuild` (single binary) + `bun` (single binary). This constraint is intentional and must be preserved.

## Testing

```bash
bun test                        # all tests
bun test tests/engine.test.ts   # specific file
bun test tests/bench.test.ts    # benchmark suite (p99 budgets in µs)
```

Test infrastructure:

| File | Purpose |
|------|---------|
| `tests/preload.ts` | DOM mocking (runs before every test via bunfig.toml) |
| `tests/helpers.ts` | `registerNoopCallbacks()`, `resetState()` |
| `tests/fixtures.ts` | `basicTopology()`, `routedTopology()`, `vlanTopology()`, `trunkTopology()` |
| `tests/bench-harness.ts` | Benchmark timing, p99 budgets, results formatting |
| `tests/bench-fixtures.ts` | Scalable topology generators for benchmarks |

**Benchmark new additions.** Performance is a project goal — any new hot-path code (engine handlers, lookups, routing, convergence) should get a matching `bench:` case in `tests/bench.test.ts` with a realistic p99 budget. Run `bun test tests/bench.test.ts` before and after a change to confirm no regression.

## Serving

```bash
bun test-server.ts          # default port 8767
bun test-server.ts 8765     # custom port
```

Open `http://localhost:8767/rs-main.html` for the local app (`/` redirects there), `/rs-web.html` for the read-only variant, `/test.html` for the test runner, `/benchmark.html` for benchmarks. The File System Access API (save/load config.json) requires HTTPS or localhost.

## Architecture

Single-page canvas app. All state lives in one `AppState` object (`state.ts`). Modules communicate through a callback registry (`sync()`) to avoid circular imports. No framework, no virtual DOM — imperative `render()` redraws the full canvas, `syncPanel()` rebuilds inspector HTML, `syncTerminal()` rebuilds terminal HTML.

### Module dependency flow

```
app.ts (entry)
  ├── state.ts       ← AppState, undo system, callback registry
  ├── dom.ts         ← getElementById refs (evaluated at load time)
  ├── ui.ts          ← event listeners, tool switching, keyboard shortcuts
  ├── canvas.ts      ← render loop, pan/zoom, device/link/transit drawing
  ├── inspector.ts   ← right panel: device details, link frame history
  ├── terminal.ts    ← bottom panel: per-device CLI, command dispatch
  ├── devices.ts     ← device/link CRUD, hit testing, LAN collapse/expand
  ├── config.ts      ← save/load config.json via File System Access API
  ├── engine.ts      ← simulation engine: step loop, per-device frame processing
  ├── simulation.ts  ← buildPingEvents(), L2 reachability, routing utilities
  ├── frame.ts       ← EthernetFrame factories, frame labels/colors
  ├── normalise.ts   ← config normalisation, device defaults, router MAC generation
  ├── utils.ts       ← escapeHtml, IPv4/MAC validation, CSS color helpers
  └── types.ts       ← all TypeScript interfaces
```

### Callback bridges

Two registration patterns break circular dependencies:

- **`registerCallbacks()`** in `state.ts` — provides `render`, `syncPanel`, `syncTerminal`, `resizeCanvas` to any module via `sync()`.
- **`registerDeviceCallbacks()`** in `devices.ts` — provides `setTool`, `setNetworkPanel` so devices.ts can trigger UI changes without importing ui.ts.

Both are wired in `app.ts` at startup.

## Key files

| File | Purpose |
|------|---------|
| `types.ts` | Every interface: `AppState`, `Device`, `Link`, `EthernetFrame`, `SimEvent`, `ActiveTransit`, `SimLogEntry`, `FrameHistoryEntry`, etc. |
| `state.ts` | Singleton `state` object, undo stack (80-deep snapshots), `networkSnapshot()` strips transient data (frameHistory) from undo payloads. |
| `engine.ts` | Two-phase simulation: **process phase** dequeues events → per-device handler → outgoing frames; **animate phase** rAF loop interpolates transit dots. Public API: `startSimulation`, `stopSimulation`, `pauseSimulation`, `resumeSimulation`, `stepOnce`. Per-device handlers: `processAtComputer`, `processAtSwitch`, `processAtRouter`. Routing: `buildRoutingTable`, `runRipConvergence`. |
| `simulation.ts` | `buildPingEvents()` — validates a ping command and returns initial `SimEvent[]` + `pendingArp` map for deferred ICMPs. Also has `l2Reachable`, `findRouterBetweenSubnets`. |
| `frame.ts` | Factory functions: `createArpRequest`, `createArpReply`, `createIcmpEchoRequest`, `createIcmpEchoReply`. Also `frameLabel()` and `frameColor()` for rendering. |
| `canvas.ts` | All drawing: grid, links, devices (icon rendering via SVG path data on canvas), frame transit dots with glow/labels, zoom/pan math. |
| `terminal.ts` | Per-device CLI. Computers: `ping`, `ip addr`, `arp -n`, etc. Routers: IOS-like `show ip interface brief`, `configure terminal`, etc. Switches: `show mac`, VLAN config. Command history (up/down arrow). |
| `inspector.ts` | Right panel. Device selection shows config fields; link selection shows frame history (color-coded ARP/ICMP entries with step numbers). |
| `devices.ts` | CRUD, hit testing (`findDeviceAt`, `findLinkAt`), port/interface enumeration, LAN collapse/expand (groups devices into a single node). |
| `normalise.ts` | Defensive normalisation for all config shapes. `normaliseRouterInterfaces` auto-generates deterministic MACs (`02:RR:00:00:II:01`). |
| `config.ts` | Persistence via File System Access API. Falls back to download. Config store holds named topologies in a single `config.json`. `refreshConfigStore()` prefers an embedded store (`readEmbeddedConfigStore()`) before fetching. `saveConfig()` is a no-op in read-only builds (`READONLY`). |
| `env.ts` | Build-time flags. Exports `READONLY` from the `__BUILD_READONLY__` esbuild define; defaults to `false` in dev/test. |
| `test-server.ts` | Dev server (Bun). Serves static files (`/` → `rs-main.html`) + `/api/tests` (list test suites) + `/api/run` (execute `bun test` with optional file/pattern filters). Powers `test.html` and `benchmark.html`. |
| `build-inline.ts` | Inlines CSS + bundled JS into `template.html` → named output file. Uses replacer functions to avoid `$`-pattern corruption. Called by `build.sh` per variant. |

## Simulation model

Ping generates real Ethernet frames (ARP + ICMP) that traverse the network hop by hop:

1. **Computer** issues ping → `buildPingEvents()` creates ARP request (if needed) + deferred ICMP in `pendingArp`.
2. **Switch** MAC-learns on ingress, then forwards (known unicast) or floods (broadcast/unknown).
3. **Router** matches ingress interface by peerId, handles ARP on-interface, routes IPv4 by longest /24 match, decrements TTL, rewrites L2 headers, may ARP-resolve on egress (buffering the frame in `pendingArp`).
4. **Computer** receives ICMP echo reply → ping success.

Each hop is an animated dot on the canvas (amber = ARP, blue = ICMP request, green = ICMP reply, violet = DHCP). Speed is controlled by `simulation.speed` (ms per hop, default 1000).

### Routing

Routers forward IPv4 frames using a merged routing table built by `buildRoutingTable(router)` in `engine.ts`. The table combines three sources in priority order: connected routes (metric 0), static routes (metric 1), and RIP learned routes (metric 2+). `routingLookup(router, dstIp)` finds the best matching route and resolves the next-hop to an egress interface. Static routes are configured per-router via the `ip route` terminal command and stored in `config.staticRoutes`. The `RouteEntry` type (`types.ts`) holds `{ network, nextHop, interface, type: "C"|"S"|"R", metric }`.

### RIP

`runRipConvergence()` runs automatically before each simulation starts. It iterates up to 15 rounds, exchanging route advertisements between RIP-enabled routers until the network converges (no changes in a round). Split-horizon prevents re-advertising routes back toward the interface they were learned from. Metric 16 = unreachable. RIP config per router: `config.rip = { enabled, networks, passiveInterfaces, learnedRoutes }`.

### DHCP

`buildDhcpEvents(source)` in `simulation.ts` creates the initial DHCP Discover frame. The four-message exchange (Discover → Offer → Request → ACK) is handled by `processAtComputer` and `processAtRouter` in `engine.ts`. Frame factories in `frame.ts`: `createDhcpDiscover`, `createDhcpOffer`, `createDhcpRequest`, `createDhcpAck`. The router allocates IPs from the .100–.254 range of the interface subnet, avoiding existing leases and static IPs. On ACK, the computer assigns the IP and gateway, and learns the router's MAC in its ARP table.

### Frame history

Every link records frames that traverse it (`link.frameHistory[]`). Click a link in select mode to view the history in the inspector panel. History is capped at 200 entries per link and excluded from undo snapshots.

## State conventions

- `state.selectedId` — currently selected device (null if none).
- `state.selectedLinkId` — currently selected link (null if none). Mutually exclusive with selectedId.
- `state.configuringId` — device whose config fields are shown (requires double-click or configure tool).
- `state.simulation.status` — `"idle"` | `"running"` | `"paused"` | `"done"`.
- `state.terminal.history` / `historyIndex` — command history for up/down arrow.

## UI panels

- **Sim controls** — play/pause/step/stop/speed slider. Appears at bottom-center of canvas during simulation.
- **Sim log panel** — separate from terminal. Floats top-right during simulation. Color-coded frame processing log.
- **Terminal** — bottom panel. Per-device CLI with command history.
- **Inspector** — right panel. Shows device config or link frame history.
- **Port selection modal** — when connecting devices via the connect tool, `openPortSelectionModal()` in `devices.ts` shows a modal for choosing specific ports on switches/routers. `PortSelectionState` and `PortOption` types in `types.ts`. Computers (single-port) auto-select; two single-port devices skip the modal entirely.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `V` | Select tool |
| `C` | Add computer tool |
| `S` | Add switch tool |
| `R` | Add router tool |
| `L` | Connect tool |
| `W` | Configure tool |
| `Delete`/`Backspace` | Delete selected device |
| `Escape` | Cancel, return to select |
| `Ctrl/Cmd+Z` | Undo |
| Double-click device | Configure |
| Scroll wheel | Zoom |

## Common tasks

**Adding a device type**: Add icon paths to `deviceIcons` in `state.ts`, palette to `devicePalette` in `canvas.ts`, config shape to `normaliseDeviceConfig` / `defaultDeviceConfig` in `normalise.ts`, tool button in `template.html`, tool copy in `toolCopy` in `state.ts`.

**Adding a terminal command**: `runTerminalCommand()` in `terminal.ts` is the top-level dispatcher — it routes to `runRouterTerminalCommand()` for routers and `runSwitchTerminalCommand()` for switches. Computer commands (`ping`, `ip addr`, `arp`, `dhcp`) are handled inline in `runTerminalCommand()` itself.

**Adding a simulation protocol**: Create frame factories in `frame.ts`, handle in the appropriate `processAt*` function in `engine.ts`, update `frameLabel`/`frameColor` for display.

**Built-in topologies**: The topology chooser dropdown (`loadTopology` in `config.ts`) offers three built-in topologies: Basic Network, VLAN Router-on-a-Stick, and 5-Router Partial Mesh.

## Style notes

- **Commonwealth English** in all code and documentation. Use `-ise`/`-isation` (e.g. `normalise`, `initialise`), not `-ize`/`-ization`.
- **Prefer concrete types over `any`.** Function parameters take real types (`Device`, `Link`, …). The few intentional `any` exceptions — `Device.config` (discriminated-union refactor deferred), the File System Access API, and DOM `dataset` extensions — are documented where they occur.
- **Keep handlers focused.** When a `processAt*` or convergence function grows large, extract private helpers rather than inlining everything (e.g. `handleRouterArp`, `routeIpv4Frame`, `buildRipAdvertisements`).
- **Cover new behaviour with tests.** Add or extend a `tests/*.test.ts` suite when changing simulation logic.
- **Benchmark hot paths.** Add a `bench:` case in `tests/bench.test.ts` (with a p99 budget via `tests/bench-harness.ts`) for any new performance-sensitive code, and keep existing benchmarks within budget. Favour allocation-free, tight implementations on the simulation critical path.
- CSS variables for theming (dark/light). All colours are CSS custom properties.
- Terminal uses monospace font, dark background regardless of theme.
- Sim log line classes: `sim-arp` (amber), `sim-icmp` (green), `sim-learn` (grey), `sim-forward` (blue), `sim-drop` (red).
