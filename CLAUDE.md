# RouteSim

Interactive network topology simulator. Canvas-based editor with discrete frame-level ping simulation, animated hop-by-hop forwarding, and per-device CLI terminals.

## Goals & principles

RouteSim is a teaching tool: it makes the invisible parts of a network visible by simulating real Ethernet frames (ARP, ICMP, DHCP) and watching them hop through switches and routers. Design decisions follow from a few principles:

- **Zero-install, single file.** The whole app builds to one portable `rs-web.html` that runs offline by opening it in a browser with **zero runtime requests** — default topologies and scenarios are compiled in; persistence is JSON import/export.
- **Minimal toolchain.** Only two binaries: `esbuild` (bundle) and `bun` (run, test, serve, inline). No Node.js, no npm, no `package.json`, no `node_modules`, no Python. Hard constraint — see Build.
- **Faithful to the protocols.** Simulated behaviour should match how real ARP, switching, routing, RIP, and DHCP work — down to frame fields and the order of operations. Correctness over shortcuts.
- **Typed, tested, and small.** Prefer concrete types over `any`, keep per-device handlers focused, and cover new behaviour with tests.
- **Performance is a feature.** The simulation engine runs hot — device/port lookup, per-device frame processing, routing, and RIP convergence are all on the critical path. Keep them fast, and add a benchmark with a p99 budget for any new performance-sensitive code so regressions are caught early.
- **Keep everything fresh.** Documentation (`docs/`), the `README`, tests, and benchmarks are part of every change, not an afterthought — update them in lockstep with the code so they never drift. New behaviour ships with matching docs and tests; new hot-path code ships with a benchmark; removed or renamed things get scrubbed from the docs/README the same commit.
- **Scoped work.** When exploring or searching the codebase, stay within this repository — don't scan the home directory or the wider filesystem.

## Build

```bash
bash build.sh          # dev build  → rs-web.html
bash build.sh --minify # minified build
```

The project uses only two tools: `esbuild` (bundler) and `bun` (runtime, test runner, test server, build inlining). The build bundles `src/app.ts` into an IIFE via esbuild, then `bun build-inline.ts rs-web.html` inlines the JS + CSS into `template.html`. The result is a **single self-contained** `rs-web.html` with **no runtime requests**: default topologies (`state.ts`) and scenarios (`scenarios.ts`) are compiled in, and persistence is JSON import/export (`io.ts`). There is no `config.json`, no fetch, no File System Access, and no build-time flags.

**`build-inline.ts` gotcha:** it inserts CSS/JS via `String.replace` **replacer functions**, not string replacements — a string replacement would interpret `` $` ``/`$'`/`$&`/`$$` in the bundle as special patterns and corrupt the output.

**Do not introduce any other tooling or runtime dependencies.** No `npm`, no `package.json`, no `node_modules`, no Node.js, no Python. The entire toolchain is `esbuild` (single binary) + `bun` (single binary). This constraint is intentional and must be preserved.

## Testing

```bash
bun test                        # all tests
bun test tests/engine.test.ts   # specific file
bun test tests/bench.test.ts    # benchmark suite (p99 budgets in µs)
bunx tsc --noEmit               # type-check (the codebase is kept tsc-clean)
```

esbuild does not type-check, so run `bunx tsc --noEmit` to catch type errors (it pulls TypeScript into bun's cache transiently — nothing is added to the repo). Keep it at zero errors.

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

Open `http://localhost:8767/rs-web.html` for the app (`/` redirects there), `/test.html` for the test runner, `/benchmark.html` for benchmarks.

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
  ├── config.ts      ← topology serialise/apply + in-code default topologies
  ├── io.ts          ← JSON import/export (config/scenario/script/log)
  ├── ribbon.ts      ← tabbed ribbon UI (File/Edit/View/Simulate/Scenarios/Help)
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

**Sync convention after a mutation:** call `sync().syncPanel()` when inspector
content changes; additionally call `sync().render()` only when the change
affects the canvas (device/link add/remove/move, power, port mode/trunk
lines). Pure inspector-data edits (e.g. adding a VLAN) need only `syncPanel()`.
Reassigning `state.devices`/`state.links` always implies a `render()`.

**HTML safety:** all user-controlled text (device/port/peer names, terminal
command text, config values) must pass through `escapeHtml()` before being
placed in an `innerHTML` template. Only system-generated ids, numbers, and
fixed enums may be interpolated raw.

## Key files

| File | Purpose |
|------|---------|
| `types.ts` | Every interface: `AppState`, `Device`, `Link`, `EthernetFrame`, `SimEvent`, `ActiveTransit`, `SimLogEntry`, `FrameHistoryEntry`, etc. |
| `state.ts` | Singleton `state` object, undo stack (80-deep snapshots), `networkSnapshot()` strips transient data (frameHistory) from undo payloads. |
| `engine.ts` | Two-phase simulation: **process phase** dequeues events → per-device handler → outgoing frames; **animate phase** rAF loop interpolates transit dots. Public API: `startSimulation`, `stopSimulation`, `pauseSimulation`, `resumeSimulation`, `stepOnce`. Per-device handlers: `processAtComputer`, `processAtSwitch`, `processAtRouter`. Routing: `buildRoutingTable`, `runRipConvergence`. |
| `simulation.ts` | `buildPingEvents()` — validates a ping command and returns initial `SimEvent[]` + `pendingArp` map for deferred ICMPs. Does **not** pre-compute reachability: a destination IP with no device still emits a real ARP (to the target on-subnet, or the gateway off-subnet) and the simulation/router decides the outcome. Also has `l2Reachable`. |
| `frame.ts` | Factory functions: `createArpRequest`, `createArpReply`, `createIcmpEchoRequest`, `createIcmpEchoReply`. Also `frameLabel()` and `frameColor()` for rendering. |
| `canvas.ts` | All drawing: grid, links, devices (icon rendering via SVG path data on canvas), frame transit dots with glow/labels, zoom/pan math. |
| `terminal.ts` | Per-device CLI, each modelled on a real open-source NOS. Computers: Linux-ish (`ping`, `ip addr`, `arp -n`, …). Routers: **FRRouting** (vtysh) — `configure terminal`, `interface`, `router rip`, `show ip route`, `do <show>`, with prefix abbreviation (`sh ip ro`) and context-sensitive `?`. Managed switches: **SONiC** — flat `config vlan add/del`, `config vlan member add [-t] <vid> <port>`, `show vlan brief`/`mac`/`interfaces status`. Command history (up/down arrow). |
| `inspector.ts` | Right panel. Device selection shows config fields; link selection shows frame history (color-coded ARP/ICMP entries with step numbers). |
| `devices.ts` | CRUD, hit testing (`findDeviceAt`, `findLinkAt`), port/interface enumeration, LAN collapse/expand (groups devices into a single node). |
| `normalise.ts` | Defensive normalisation for all config shapes. `normaliseRouterInterfaces` auto-generates deterministic MACs (`02:RR:00:00:II:01`). |
| `config.ts` | `buildConfigPayload()` (serialise topology), `parseConfig`/`applyConfig`, `loadTopology`, `loadDefaultConfig` (in-code defaults). No fetch/FSA — persistence is JSON import/export via `io.ts`. |
| `io.ts` | JSON import/export (download + file picker) for config, scenario, script, and log. Exposed on `window.routesim`. |
| `ribbon.ts` | Tabbed ribbon (File/Edit/View/Simulate/Scenarios/Help): tab switching + dynamic scenario buttons. Button clicks are wired by data attribute in `ui.ts`. |
| `commands.ts` | Text-command engine: parses a line, resolves device refs, dispatches to the action functions. `runConsoleCommand`/`runConsoleScript`/`exportTopologyScript`. Pure (no panel UI) so it's reused by the console, `window.routesim`, and tests. See `docs/scripting.md`. |
| `console.ts` | The command console panel UI (distinct from per-device terminals); drives `commands.ts`. |
| `scenarios.ts` | Guided-challenge scenarios: data model, `SCENARIOS` registry, `loadScenario`, and `checkScenario` (goal evaluation reusing `runSimulationHeadless`). `scenario-ui.ts` renders the goal banner. See `docs/scenarios.md`. |
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

- **Ribbon** — the top toolbar: tabs **File / Edit / View / Simulate / Scenarios / Help**, each swapping a strip of grouped buttons (`ribbon.ts` + `template.html`). The drawing tools live in Edit. Buttons are wired by data attribute in `ui.ts` (`data-tool`/`data-topology`/`data-scenario`/`data-action`). No left tool rail.
- **Coordinate readout** — `#coordReadout`, bottom-right of the canvas: cursor world coords (on move) + the selected device's coords. Updated from the pointermove handler and the `syncCoordReadout` callback (refreshes on selection).
- **Sim controls** — play/pause/step/stop/speed live in the Simulate ribbon tab.
- **Sim log panel** — floats top-right during simulation. Color-coded frame processing log.
- **Terminal** — bottom panel. Per-device CLI with command history. **Command console** — bottom panel, app-level commands (`commands.ts`). They share the bottom slot.
- **Inspector** — right panel. Device config or link frame history; display options (names/IPs/MACs) live in the View ribbon tab.
- **Scenario goal banner** — floats top-left when a scenario is active (`scenario-ui.ts`).
- **Port selection modal** — `openPortSelectionModal()` (`devices.ts`) for choosing ports when connecting switches/routers.
- **About modal** — Help → About (`openAbout`/`closeAbout` in `ui.ts`): project blurb + CC0 dedication. Draggable by its header; dismiss via close button, backdrop click, or Escape.
- **Modals** use a solid per-theme `--modal-bg` background, never transparent.
- **Themes** — a named registry (`THEMES` in `state.ts`): **Warm Light** (default), **Dark**, **Blueprint**. Switched via three `data-theme-id` buttons in the View tab or the `theme` console command; `setTheme(id)` (`ui.ts`) writes `<html data-theme>` and clears the `cssColor` cache. Each theme is a full CSS custom-property block in `styles.css`; add a new theme by appending to `THEMES` + a matching `:root[data-theme="…"]` block (define every colour var, including the `--pc/-switch/-router/-lan-*` device vars the canvas reads). The app boots in Warm Light.

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

**Adding a terminal command**: `runTerminalCommand()` in `terminal.ts` is the top-level dispatcher — it routes to `runRouterTerminalCommand()` for routers and `runSwitchTerminalCommand()` for switches. Computer commands (`ping`, `ip addr`, `arp`, `dhcp`) are handled inline in `runTerminalCommand()` itself. **Match the device's reference NOS** — router commands should follow FRRouting (vtysh), managed-switch commands should follow SONiC — so new commands stay faithful to a real CLI rather than inventing syntax.

**Adding a simulation protocol**: Create frame factories in `frame.ts`, handle in the appropriate `processAt*` function in `engine.ts`, update `frameLabel`/`frameColor` for display.

**Adding a console command**: Add a handler to the `COMMANDS` registry (and a `HELP` entry) in `commands.ts`, reusing existing action functions. It's automatically available in the console panel, `window.routesim`, and scripts. For commands that build/observe state, prefer the headless `runSimulationHeadless` (engine.ts) over the animated path. See `docs/scripting.md`.

**Adding a scenario**: Append a `Scenario` (initial `topology` + a `checks` goal) to `SCENARIOS` in `scenarios.ts`. It appears automatically in the chooser, the console (`scenario list/load/check`), and the goal banner. Checks reuse the headless runner. See `docs/scenarios.md`.

**Built-in topologies**: The topology chooser dropdown (`loadTopology` in `config.ts`) offers three built-in topologies: Basic Network, VLAN Router-on-a-Stick, and 5-Router Partial Mesh.

## Style notes

- **Commonwealth English** in all code and documentation. Use `-ise`/`-isation` (e.g. `normalise`, `initialise`), not `-ize`/`-ization`.
- **No emoji in user-facing messages** (status text, banners, terminal/console output, log lines). Emoji used as functional glyphs/icons (e.g. status marks like `✓`/`✗`/`○`) are fine.
- **Prefer concrete types over `any`.** Function parameters take real types (`Device`, `Link`, …). `Device.config` is `DeviceConfig` — a permissive superset of the per-type `ComputerConfig`/`SwitchConfig`/`RouterConfig`/`LanConfig` shapes (every field optional) so `device.config?.x` access stays ergonomic while typos are caught; the strict per-type interfaces type the `normalise.ts` layer. The codebase is **tsc-clean** (`bunx tsc --noEmit`) — keep it that way. Remaining intentional `any`: the File System Access API and DOM `dataset` extensions, documented where they occur.
- **Keep handlers focused.** When a `processAt*` or convergence function grows large, extract private helpers rather than inlining everything (e.g. `handleRouterArp`, `routeIpv4Frame`, `buildRipAdvertisements`).
- **Cover new behaviour with tests.** Add or extend a `tests/*.test.ts` suite when changing simulation logic.
- **Benchmark hot paths.** Add a `bench:` case in `tests/bench.test.ts` (with a p99 budget via `tests/bench-harness.ts`) for any new performance-sensitive code, and keep existing benchmarks within budget. Favour allocation-free, tight implementations on the simulation critical path.
- CSS variables for theming (dark/light). All colours are CSS custom properties.
- Terminal uses monospace font, dark background regardless of theme.
- Sim log line classes: `sim-arp` (amber), `sim-icmp` (green), `sim-learn` (grey), `sim-forward` (blue), `sim-drop` (red).
