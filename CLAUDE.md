# RouteSim

Interactive network topology simulator. Canvas-based editor with discrete frame-level ping simulation, animated hop-by-hop forwarding, and per-device CLI terminals.

## Goals & principles

RouteSim is a teaching tool: it makes the invisible parts of a network visible by simulating real Ethernet frames (ARP, ICMP, DHCP, DNS, TCP) and watching them hop through switches and routers. Design decisions follow from a few principles:

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
  ├── terminal/      ← bottom panel CLI: core (dispatch/UI) + host, server (dnsmasq), router (FRR), switch (SONiC), firewall (iptables)
  ├── devices.ts     ← device/link CRUD, hit testing, LAN collapse/expand
  ├── device-registry.ts ← per-type spec: label, name prefix, size, palette, icon, default config
  ├── config.ts      ← topology serialise/apply + in-code default topologies
  ├── io.ts          ← JSON import/export (config/scenario/script/log)
  ├── ribbon.ts      ← tabbed ribbon UI (File/Edit/View/Simulate/Scenarios/Help)
  ├── engine.ts      ← simulation engine: step loop, per-device frame processing
  ├── routing.ts     ← routing table, longest-match lookup, RIP convergence
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
| `engine.ts` | Two-phase simulation: **process phase** dequeues events → per-device handler (the `PROCESSORS` map) → outgoing frames; **animate phase** rAF loop interpolates transit dots. Public API: `startSimulation`, `stopSimulation`, `pauseSimulation`, `resumeSimulation`, `stepOnce`, `runSimulationHeadless`, `runTraceroute`. Per-device handlers: `processAtComputer/Switch/Router/Firewall`. |
| `routing.ts` | Routing table (`buildRoutingTable`: connected/static/RIP by metric), `routingLookup`, and `runRipConvergence` (split horizon, metric 16 = unreachable). Re-exported via `engine.ts` for compatibility. |
| `device-registry.ts` | `DEVICE_SPECS` — one entry per device type: label, name prefix, canvas size/palette/icon, default config, user-addable flag. Drives naming, drawing, inspector labels, and console validation. |
| `simulation.ts` | `buildPingEvents()` — validates a ping command and returns initial `SimEvent[]` + `pendingArp` map for deferred ICMPs. Does **not** pre-compute reachability: a destination IP with no device still emits a real ARP (to the target on-subnet, or the gateway off-subnet) and the simulation/router decides the outcome. Also has `l2Reachable`. |
| `frame.ts` | Factory functions: `createArpRequest`, `createArpReply`, `createIcmpEchoRequest`, `createIcmpEchoReply`. Also `frameLabel()` and `frameColor()` for rendering. |
| `canvas.ts` | All drawing: grid, links, devices (icon rendering via SVG path data on canvas), frame transit dots with glow/labels, zoom/pan math. |
| `terminal/` | Per-device CLI, one file per NOS (`core` dispatch/UI + `host`/`server`/`router`/`switch`/`firewall`), public API re-exported via `terminal/index.ts`. Each modelled on a real open-source NOS. Computers: Linux-ish (`ping`, `traceroute`, `nslookup`, `nc -z <host> <port>`, `ip addr`, `arp -n`, `cat`/`echo … > /etc/resolv.conf`, …). Servers: the host shell plus **dnsmasq** (`cat`/`echo … >> /etc/dnsmasq.conf` with `address=/name/ip`, `dhcp-range=…`, `dhcp-option=option:router,…`; `systemctl start|stop|status dnsmasq`). Routers: **FRRouting** (vtysh) — `configure terminal`, `interface`, `router rip`, `show ip route`, `do <show>`, with prefix abbreviation (`sh ip ro`) and context-sensitive `?` — plus `ip nat inside|outside`, `show ip nat translations`, and netfilter `iptables` (INPUT/FORWARD). Managed switches: **SONiC** — flat `config vlan add/del`, `config vlan member add [-t] <vid> <port>`, `show vlan brief`/`mac`/`interfaces status`. Firewalls: **iptables** — `iptables -A FORWARD … -j DROP`, `-L`/`-P`/`-F`. Command history (up/down arrow). |
| `inspector.ts` | Right panel. Device selection shows config fields; link selection shows frame history (color-coded ARP/ICMP entries with step numbers). |
| `devices.ts` | CRUD, hit testing (`findDeviceAt`, `findLinkAt`), port/interface enumeration, LAN collapse/expand (groups devices into a single node). |
| `normalise.ts` | Defensive normalisation for all config shapes. `normaliseRouterInterfaces` auto-generates deterministic MACs (`02:RR:00:00:II:01`). |
| `config.ts` | `buildConfigPayload()` (serialise topology), `parseConfig`/`applyConfig`, `loadTopology`, `loadDefaultConfig` (in-code defaults). No fetch/FSA — persistence is JSON import/export via `io.ts`. |
| `io.ts` | JSON import/export (download + file picker) for config, scenario, script, and log. Exposed on `window.routesim`. |
| `ribbon.ts` | Tabbed ribbon (File/Edit/View/Simulate/Scenarios/Help): tab switching + dynamic scenario buttons. Button clicks are wired by data attribute in `ui.ts`. |
| `commands.ts` | Text-command engine: parses a line, resolves device refs, dispatches to the action functions. `runConsoleCommand`/`runConsoleScript`/`exportTopologyScript`. Pure (no panel UI) so it's reused by the console, `window.routesim`, and tests. See `docs/scripting.md`. |
| `console.ts` | The command console panel UI (distinct from per-device terminals); drives `commands.ts`. |
| `scenarios.ts` | Guided-challenge scenarios: data model, `SCENARIOS` registry, `loadScenario`, and `checkScenario` (goal evaluation reusing `runSimulationHeadless`). The 11-scenario curriculum lives in `scenario-library.ts`; `scenario-ui.ts` renders the goal banner. See `docs/scenarios.md`. |
| `test-server.ts` | Dev server (Bun). Serves static files (`/` → `rs-web.html`) + `/api/tests` (list test suites) + `/api/run` (execute `bun test` with optional file/pattern filters). Powers `test.html` and `benchmark.html`. |
| `build-inline.ts` | Inlines CSS + bundled JS into `template.html` → named output file. Uses replacer functions to avoid `$`-pattern corruption. Called by `build.sh` per variant. |

## Simulation model

Ping generates real Ethernet frames (ARP + ICMP) that traverse the network hop by hop:

1. **Computer** issues ping → `buildPingEvents()` creates ARP request (if needed) + deferred ICMP in `pendingArp`.
2. **Switch** MAC-learns on ingress, then forwards (known unicast) or floods (broadcast/unknown).
3. **Router** matches ingress interface by peerId, handles ARP on-interface, routes IPv4 by longest-prefix match, decrements TTL, rewrites L2 headers, may ARP-resolve on egress (buffering the frame in `pendingArp`).
4. **Computer** receives ICMP echo reply → ping success.

Each hop is an animated dot on the canvas (amber = ARP, blue = ICMP request, green = ICMP reply, red = ICMP Time-Exceeded/TCP RST/DNS NXDOMAIN, violet = DHCP, orange = TCP, cyan = DNS). Speed is controlled by `simulation.speed` (ms per hop, default 1000).

### TCP connect (L4)

`nc -z <host> <port>` (PC terminal) / `connect <src> <dst> <port>` (console) run a real **three-way handshake**: `buildConnectEvents` sends a SYN (ARP-ing the next hop first if needed), the destination answers SYN-ACK if listening (`config.openPorts` undefined = listen on all ports; a list = only those, others RST), and the origin completes with ACK (`sim.tcpSuccess`). RST → "connection refused"; silence → timeout. This is what makes firewall `-p tcp --dport` rules and future NAT/DNS meaningful.

### NAT / PAT

Routers do Cisco-style source NAT with overload: mark interfaces `ip nat inside` / `ip nat outside` (interface mode) and every inside→outside flow is translated onto the outside interface address (`natTranslateOutbound`), recorded in `config.natTranslations`, and restored on the return path (`natRestoreInbound`, checked before the router's self-IP handling). TCP flows map by allocated source port, ICMP echo by sequence-as-flow-id. `show ip nat translations` / `clear ip nat translation *`. Routers also carry netfilter INPUT/FORWARD chains (`iptables …` in the router terminal, shared engine in `terminal/iptables.ts`) — INPUT guards the router itself, FORWARD filters routed traffic; the transparent firewall device stays FORWARD-only. See docs/src/nat.md.

### DNS & the server device

A **server** is a host that also runs **dnsmasq** (DNS A-records + DHCP, one daemon — `systemctl stop` kills both). Hosts resolve via their `/etc/resolv.conf` nameserver (`config.dnsServerIp`, set by terminal/inspector/console or learned from DHCP option 6). `ping`/`nc`/`traceroute` with a hostname **resolve first, then act**: a real UDP/53 query frame (`DnsPayload { op, id, name, address }`, protocol 17) travels to the nameserver — through switches, routers, firewalls (`-p udp`), and NAT (PAT keyed by the transaction id, `protocol: "udp"`) — and on the answer the origin launches the ICMP/TCP flow (`buildFollowOnFrames`); `address: null` = NXDOMAIN. `nslookup <name>` runs the lookup alone (sim mode `"dns"`). Device names still ping without DNS (the /etc/hosts-style convenience); only non-device names need a nameserver. `processAtServer` answers service frames and falls through to `processAtComputer`. See docs/src/dns.md.

### Traceroute / TTL

A router checks the TTL **before** the forwarding decision: when a packet's TTL reaches 0 it drops it and (if the ingress interface has an address) sends an **ICMP Time-Exceeded** (type 11) back to the source — `createIcmpTimeExceeded` in `frame.ts`, handled in `routeIpv4Frame`. `runTraceroute(source, target)` (engine.ts) drives this: it warms ARP along the path, then sends probes with increasing TTL (1..30), recording who answered each round (a router's Time-Exceeded = intermediate hop; the destination's Echo Reply = final hop). Exposed as the `traceroute`/`tracert` command in the PC terminal and the console. It runs over `runSimulationHeadless`, which sets `sim.headless` so per-step rendering and terminal output are skipped.

### Routing

Routers forward IPv4 frames using a merged routing table built by `buildRoutingTable(router)` in `routing.ts`. The table combines three sources in priority order: connected routes (metric 0), static routes (metric 1), and RIP learned routes (metric 2+). `routingLookup(router, dstIp)` finds the best matching route and resolves the next-hop to an egress interface. Static routes are configured per-router via the `ip route` terminal command and stored in `config.staticRoutes`. The `RouteEntry` type (`types.ts`) holds `{ network, nextHop, interface, type: "C"|"S"|"R", metric }`.

### RIP

`runRipConvergence()` runs automatically before each simulation starts. It iterates up to 15 rounds, exchanging route advertisements between RIP-enabled routers until the network converges (no changes in a round). Split-horizon prevents re-advertising routes back toward the interface they were learned from. Metric 16 = unreachable. RIP config per router: `config.rip = { enabled, networks, passiveInterfaces, learnedRoutes }`.

### DHCP

`buildDhcpEvents(source)` in `simulation.ts` creates the initial DHCP Discover frame. The four-message exchange (Discover → Offer → Request → ACK) is handled by `processAtComputer`, `processAtRouter`, and `processAtServer` in `engine.ts`. Frame factories in `frame.ts`: `createDhcpDiscover`, `createDhcpOffer`, `createDhcpRequest`, `createDhcpAck`. The router allocates IPs from the .100–.254 range of the interface subnet; a server allocates from its configured `dhcp-range` and additionally hands out the router option (`option:router`, defaulting to the server itself, as dnsmasq does) and itself as nameserver (option 6). On ACK, the client assigns IP/prefix/gateway (+ nameserver if offered) and learns the server's MAC. Multi-server segments behave correctly: the client takes the **first Offer** (`sim.dhcpOfferTaken`), and a server/router only ACKs Requests whose `serverIp` names it.

### Frame history

Every link records frames that traverse it (`link.frameHistory[]`). Click a link in select mode to view the history in the inspector panel. History is capped at 200 entries per link and excluded from undo snapshots.

## State conventions

- `state.selectedId` — currently selected device (null if none).
- `state.selectedLinkId` — currently selected link (null if none). Mutually exclusive with selectedId.
- `state.configuringId` — device whose config fields are shown (requires double-click or configure tool).
- `state.simulation.status` — `"idle"` | `"running"` | `"paused"` | `"done"`.
- `state.terminal.history` / `historyIndex` — command history for up/down arrow.

## UI panels

- **Ribbon** — the top toolbar: tabs **File / Edit / View / Simulate / Scenarios / Help**, each swapping a strip of grouped buttons (`ribbon.ts` + `template.html`). The drawing tools live in Edit. Buttons are wired by data attribute in `ui.ts` (`data-tool`/`data-scenario`/`data-theme-id`/`data-action`); built-in topologies load from a `<select>` (`#topologySelect`). No brand text, no left tool rail.
- **Frame inspector** — in select mode, clicking a transit dot pauses the simulation and shows the frame's full field breakdown in the inspector (`findTransitAt` in `canvas.ts`, `renderFramePanel` in `inspector.ts`, `state.inspectedFrame`). Cleared by clicking elsewhere, Close, or starting a new run.
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
| `E` | Add server tool |
| `S` | Add switch tool |
| `R` | Add router tool |
| `F` | Add firewall tool |
| `L` | Connect tool |
| `W` | Configure tool |
| `Delete`/`Backspace` | Delete selected device |
| `Escape` | Cancel, return to select |
| `Ctrl/Cmd+Z` | Undo |
| `Ctrl/Cmd+Shift+Z` / `Ctrl/Cmd+Y` | Redo |
| Double-click device | Configure |
| Scroll wheel | Zoom |

## Common tasks

**Adding a device type**: (1) add the `DeviceType` union member + config interface in `types.ts`; (2) add a `DeviceSpec` entry to `DEVICE_SPECS` in `device-registry.ts` (label, name prefix, size, palette var, icon paths, default config) — this drives naming, drawing, inspector labels, and `add`/`tool` validation automatically; (3) add the `--<paletteVar>-fill/-stroke/-accent/-icon` vars to **each theme** in `styles.css` (the parity test enforces this); (4) add a normalise branch in `normaliseDeviceConfig`; (5) implement `processAt<Type>` in `engine.ts` and register it in the `PROCESSORS` map; (6) optionally add a CLI in `src/terminal/` and register it in `CLI_DISPATCH` (`terminal/core.ts`); (7) add the tool button in `template.html` + `toolCopy` entry and keyboard shortcut in `ui.ts`. The **firewall** is the worked example — see [docs/src/firewall.md](docs/src/firewall.md).

**Adding a terminal command**: `runTerminalCommand()` in `terminal.ts` is the top-level dispatcher — it routes to `runRouterTerminalCommand()` for routers and `runSwitchTerminalCommand()` for switches. Computer commands (`ping`, `ip addr`, `arp`, `dhcp`) are handled inline in `runTerminalCommand()` itself. **Match the device's reference NOS** — router commands should follow FRRouting (vtysh), managed-switch commands should follow SONiC — so new commands stay faithful to a real CLI rather than inventing syntax.

**Adding a simulation protocol**: Create frame factories in `frame.ts`, handle in the appropriate `processAt*` function in `engine.ts`, update `frameLabel`/`frameColor` for display.

**Adding a console command**: Add a handler to the `COMMANDS` registry (and a `HELP` entry) in `commands.ts`, reusing existing action functions. It's automatically available in the console panel, `window.routesim`, and scripts. For commands that build/observe state, prefer the headless `runSimulationHeadless` (engine.ts) over the animated path. See `docs/scripting.md`.

**Adding a scenario**: Add a `Scenario` (initial `topology` + a `checks` goal) to `src/scenario-library.ts`. Check kinds: `link`, `config`, `ping`, `ping-fail` (isolation), `tcp`/`tcp-fail` (port reachability), `dns` (name resolution, optionally to a given address), `dhcp`. It appears automatically in the chooser, the console (`scenario list/load/check`), and the goal banner; checks reuse the headless runner. Add a reference solution to the solvability suite in `tests/scenarios.test.ts` (each scenario must start unsolved and pass after its solution). See `docs/scenarios.md`.

**Built-in topologies**: The File-tab Topologies `<select>` (`loadTopology` in `config.ts`) offers three built-in topologies: Basic Network, VLAN Router-on-a-Stick, and 5-Router Partial Mesh. Their coordinates are spaced so label text (name/IP/MAC/VLAN + router interface lines) never overlaps another device — keep ≥150px vertical spacing for stacked computers when editing them.

## Style notes

- **Commonwealth English** in all code and documentation. Use `-ise`/`-isation` (e.g. `normalise`, `initialise`), not `-ize`/`-ization`.
- **No emoji in user-facing messages** (status text, banners, terminal/console output, log lines). Emoji used as functional glyphs/icons (e.g. status marks like `✓`/`✗`/`○`) are fine.
- **Prefer concrete types over `any`.** Function parameters take real types (`Device`, `Link`, …). `Device.config` is `DeviceConfig` — a permissive superset of the per-type `ComputerConfig`/`SwitchConfig`/`RouterConfig`/`LanConfig` shapes (every field optional) so `device.config?.x` access stays ergonomic while typos are caught; the strict per-type interfaces type the `normalise.ts` layer. The codebase is **tsc-clean** (`bunx tsc --noEmit`) — keep it that way. Remaining intentional `any`: the File System Access API and DOM `dataset` extensions, documented where they occur.
- **Keep handlers focused.** When a `processAt*` or convergence function grows large, extract private helpers rather than inlining everything (e.g. `handleRouterArp`, `routeIpv4Frame`, `buildRipAdvertisements`).
- **Cover new behaviour with tests.** Add or extend a `tests/*.test.ts` suite when changing simulation logic.
- **Benchmark hot paths.** Add a `bench:` case in `tests/bench.test.ts` (with a p99 budget via `tests/bench-harness.ts`) for any new performance-sensitive code, and keep existing benchmarks within budget. Favour allocation-free, tight implementations on the simulation critical path.
- CSS variables for theming (dark/light). All colours are CSS custom properties.
- Terminal uses monospace font, dark background regardless of theme.
- Sim log line classes: `sim-arp` (amber), `sim-icmp` (green), `sim-learn` (grey), `sim-forward` (blue), `sim-drop` (red), `sim-tcp` (orange), `sim-nat` (teal), `sim-dns` (cyan).
