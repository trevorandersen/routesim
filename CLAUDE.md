# RouteSim

Interactive network topology simulator. Canvas-based editor with discrete frame-level ping simulation, animated hop-by-hop forwarding, and per-device CLI terminals.

## Goals & principles

RouteSim is a teaching tool: it makes the invisible parts of a network visible by simulating real Ethernet frames (ARP, ICMP, DHCP, DNS, TCP) and watching them hop through switches and routers. Design decisions follow from a few principles:

- **Zero-install, single file.** The whole app builds to one portable `rs-web.html` that runs offline by opening it in a browser with **zero runtime requests** — default topologies and scenarios are compiled in; persistence is JSON import/export.
- **Minimal toolchain.** Only two binaries: `esbuild` (bundle) and `bun` (run, test, serve, inline). No Node.js, no npm, no `package.json`, no `node_modules`, no Python. Hard constraint — see Build.
- **Faithful to the protocols.** Simulated behaviour should match how real ARP, switching, routing, RIP, and DHCP work — down to frame fields and the order of operations. Correctness over shortcuts.
- **Typed, tested, and small.** Prefer concrete types over `any`, keep per-device handlers focused, and cover new behaviour with tests.
- **Performance is a feature.** The simulation engine runs hot — device/port lookup, per-device frame processing, routing, and RIP convergence are all on the critical path. Keep them fast, and add a benchmark with a p99 budget for any new performance-sensitive code so regressions are caught early.
- **Keep everything fresh.** Documentation (`docs/`), the `README`, tests, and benchmarks are part of every change, not an afterthought — update them in lockstep with the code so they never drift. New behaviour ships with matching docs and tests; new hot-path code ships with a benchmark; removed or renamed things get scrubbed from the docs/README the same commit. Where to update: a module change → its `docs/src/<module>.md`; a new test file → the coverage map in `docs/testing.md`; a new benchmark → the cases table in `docs/benchmarking.md`; a new scenario → `docs/scenarios.md` + the solvability suite in `tests/scenarios.test.ts`; user-visible behaviour → the relevant section of this file and `README.md`.
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

**Animated-path tests.** The test preload's `requestAnimationFrame` stub is synchronous, so `startSimulation` must not run against it as-is (the animation loop would recurse). Tests cover the engine via the `processAt*` handlers or `runSimulationHeadless`; the few tests of genuinely animated behaviour (packet capture, dock auto-open) stub rAF to a no-op and pump the loop with `stepOnce()` — see `tests/capture.test.ts`.

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
  ├── terminal/      ← bottom dock (sessions/tabs/panes) + CLIs: core (dispatch/dock UI) + host, server (dnsmasq), router (FRR), switch (SONiC), firewall (iptables)
  ├── devices.ts     ← device/link CRUD, hit testing, LAN collapse/expand
  ├── device-registry.ts ← per-type spec: label, name prefix, size, palette, icon, default config
  ├── config.ts      ← topology serialise/apply + in-code default topologies
  ├── io.ts          ← JSON import/export (config/scenario/script/log)
  ├── ribbon.ts      ← tabbed ribbon UI (Main/File/View/Help) + scenario chooser options
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
- **`registerDeviceCallbacks()`** in `devices.ts` — provides `setTool`, `setNetworkPanel`, `linkUp` (first-boot autoconf when a cable comes up), and `openTerminal` (configure auto-opens a CLI device's terminal, gated by `canOpenTerminal`) so devices.ts can trigger UI/engine work without importing ui.ts/engine.ts/terminal/.

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
| `types.ts` | Every interface; `DeviceConfig` is the permissive all-optional superset. See `docs/src/types.md`. |
| `state.ts` | Singleton `state`, undo stack, callback registry, terminal sessions/dock state. See `docs/src/state.md`. |
| `engine.ts` | Two-phase sim (process/animate), the `processAt*` handlers (`PROCESSORS` map), headless runner, traceroute, first-boot autoconf, packet capture. See `docs/src/engine.md`. |
| `routing.ts` | `buildRoutingTable` (connected/static/RIP), `routingLookup`, `runRipConvergence`; re-exported via `engine.ts`. See `docs/src/engine.md`. |
| `device-registry.ts` | `DEVICE_SPECS` — per-type label/size/palette/icon/defaults; drives naming, drawing, inspector labels, and validation. |
| `simulation.ts` | `buildPingEvents`/`buildDhcpEvents`/`buildConnectEvents`/`buildResolveEvents`, `l2Reachable`. Does **not** pre-compute reachability — a destination with no device still ARPs and the sim decides. See `docs/src/simulation.md`. |
| `frame.ts` | Frame factories for every protocol (ARP/ICMP/DHCP/TCP/DNS), `frameLabel`/`frameColor`, `packetColumns`. See `docs/src/frame.md`. |
| `canvas.ts` | All drawing, pan/zoom, transit dots, `findTransitAt`. See `docs/src/canvas.md`. |
| `terminal/` | Per-device CLIs, one module per NOS — Linux host, dnsmasq server, FRRouting router, SONiC switch, iptables firewall — plus the dock/session UI in `core.ts`; public API re-exported via `terminal/index.ts`. See `docs/src/terminal.md` and `docs/src/dns.md`. |
| `inspector.ts` | Right panel: device config, link name/history/Delete link, the frame breakdown. See `docs/src/inspector.md`. |
| `devices.ts` | Device/link CRUD (single-NIC host guard), hit testing, lazy lookup indexes, LAN collapse/expand, device-callback bridge. See `docs/src/devices.md`. |
| `normalise.ts` | Defensive normalisation for all config shapes; deterministic router MACs (`02:RR:00:00:II:01`). See `docs/src/normalise.md`. |
| `config.ts` | Topology serialise/apply + built-in topologies; persistence is JSON import/export only (no fetch/FSA). See `docs/src/config.md`. |
| `io.ts` | JSON import/export (config/scenario/script/log), exposed on `window.routesim`. See `docs/scripting.md`. |
| `settings-url.ts` | URL query-string settings (`parseSettingsFromUrl` applied in `app.ts` on load; `buildSettingsQuery` inverse). One-row registry to add a setting. See `docs/src/settings-url.md`. |
| `ribbon.ts` | Tabbed ribbon; button clicks are wired by data attribute in `ui.ts`. |
| `commands.ts` | Text-command engine, pure (no panel UI) — reused by the console, `window.routesim`, and scripts. See `docs/scripting.md`. |
| `console.ts` | The command console pane; drives `commands.ts`. |
| `scenarios.ts` | Scenario data model + goal checking over headless runs; the curriculum lives in `scenario-library.ts`, the banner in `scenario-ui.ts`. See `docs/scenarios.md`. |
| `test-server.ts` | Bun dev server: static files + `/api/tests` + `/api/run`; powers `test.html`/`benchmark.html`. |
| `build-inline.ts` | Inlines CSS/JS into the template with replacer functions (see the Build gotcha). |

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

**Network boot**: adding/cabling/powering a host does **not** auto-configure it — an unconfigured host stays "unassigned" until the user **starts the simulation**. Clicking **Play** while idle (or `startNetworkBoot()`) boots every unconfigured, cabled, powered-on host with an **animated** DHCP exchange in turn (`bootQueue` chained through `finishSimulation` so they boot one at a time), self-assigning **APIPA** (`169.254.x.y/16`, no gateway) only **after** the simulated DHCP times out — like a real machine on carrier detect, but visible (`ipSource` = `dhcp`/`apipa`). `unconfiguredBootableHosts()` is the qualifying set (excludes configured, powered-off, and uncabled hosts). The `dhcp` terminal/console command boots a single host the same animated way. (This replaced the old silent, instant headless boot on cable-up/power-on.) Two **independent global toggles** gate this (pedagogical, in the **Settings** pane opened by the cog button on the Main tab, **both off by default** — `state.options.autoDhcp`/`apipaFallback`): with **Auto-DHCP on**, Play runs the animated DHCP exchange, self-assigning **APIPA** on timeout only if APIPA fallback is also on; with **Auto-DHCP off but APIPA on**, Play skips the DHCP frames entirely and the host self-assigns a link-local address **directly** (`assignApipa`, instant — no run); with **both off**, Play does nothing and the host stays unassigned. (So APIPA no longer depends on Auto-DHCP — clearing Auto-DHCP while APIPA is on still yields a 169.254 address.) The manual `dhcp` command always attempts DHCP regardless of the toggles.

`buildDhcpEvents(source)` in `simulation.ts` creates the initial DHCP Discover frame. The four-message exchange (Discover → Offer → Request → ACK) is handled by `processAtComputer`, `processAtRouter`, and `processAtServer` in `engine.ts`. Frame factories in `frame.ts`: `createDhcpDiscover`, `createDhcpOffer`, `createDhcpRequest`, `createDhcpAck`. The router allocates IPs from the .100–.254 range of the interface subnet; a server allocates from its configured `dhcp-range` and additionally hands out the router option (`option:router`, defaulting to the server itself, as dnsmasq does) and itself as nameserver (option 6). On ACK, the client assigns IP/prefix/gateway (+ nameserver if offered) and learns the server's MAC. Multi-server segments behave correctly: the client takes the **first Offer** (`sim.dhcpOfferTaken`), and a server/router only ACKs Requests whose `serverIp` names it.

### Frame history

Every link records frames that traverse it (`link.frameHistory[]`). Click a link in select mode to view the history in the inspector panel. History is capped at 200 entries per link and excluded from undo snapshots.

## State conventions

- `state.selectedId` — currently selected device (null if none).
- `state.selectedLinkId` — currently selected link (null if none). Mutually exclusive with selectedId.
- `state.configuringId` — device whose config fields are shown (requires double-click or configure tool).
- `state.simulation.status` — `"idle"` | `"running"` | `"paused"` | `"done"`.
- `state.terminal` — the **active terminal session** (a member of `state.terminalSessions`, or a detached placeholder with `deviceId: null`). Per-session: `mode`, `lines`, `history`/`historyIndex`.
- `state.dock` — `{ open, activeTab: "terminal"|"console"|"simlog", height, logView: "packets"|"events" }`.

## UI panels

- **Ribbon** — the top toolbar: tabs **Main / File / View / Help**, each swapping a strip of grouped buttons (`ribbon.ts` + `template.html`). **Main** is the default tab and the whole build-and-run workflow: the drawing tools, the edit actions (undo/redo/delete/**Clear** — wipes the topology, undoable), and the sim transport. Related device tools are **split-button groups** (`.tool-split`): **Computer** (Client PC/Server), **Switch** (Basic/Managed), **Security** (Firewall), **Legacy** (Hub — a layer-1 repeater, placed last after Configure) — a face button plus a caret-menu of variants; the face remembers the last-chosen variant (`syncToolGroups`), and `managed-switch` places a switch with management on (`placeToolDevice`). File holds the topology and scenario dropdowns (`#topologySelect`/`#scenarioSelect`, each resetting to its placeholder after loading) + import/export; goal check/dismiss live on the scenario banner, not the ribbon. Buttons are wired by data attribute in `ui.ts` (`data-tool`/`data-theme-id`/`data-action`). The status text right of the tabs (`#modeLabel`) shows the mode label and transient feedback (imports, link guards, first-boot outcomes) — there is no separate hint bar. No brand text, no left tool rail.
- **Frame inspector** — clicking a transit dot in select mode (or a packet-list row in the sim log) pauses the simulation and shows the frame's full field breakdown in the inspector (`findTransitAt` in `canvas.ts`, `renderFramePanel` in `inspector.ts`, `state.inspectedFrame`). Cleared by clicking elsewhere, Close, or starting a new run.
- **Coordinate readout** — `#coordReadout`, bottom-right of the canvas: cursor world coords (on move) + the selected device's coords. Updated from the pointermove handler and the `syncCoordReadout` callback (refreshes on selection).
- **Sim controls** — play/pause/step/stop/speed live in the Main ribbon tab, alongside the tools. A **Settings** cog button (`data-action="open-settings"` → `openSettings`, a right-docked pane that shares the inspector's grid cell — toggled by a `body.settings-open` class, not a modal) holds the boot toggles (Auto-DHCP, APIPA fallback — both **off by default**; `optAutoDhcp`/`optApipa` → `state.options.autoDhcp`/`apipaFallback`, still wired via `bindOptionToggle`). **Play while idle** boots any unconfigured cabled hosts (`startNetworkBoot` — animated DHCP → APIPA, gated by those toggles); while running/paused it pauses/resumes.
- **Bottom dock** — one resizable panel (`#dock`, drag its top edge) hosting three pane kinds behind a tab strip: **per-device terminal sessions** (one tab per open device CLI — each session keeps its own scrollback, history, and CLI mode, so router config mode survives switching; close a tab to end the session, an exec-level `exit` does the same), the **command console**, and the **sim log**. Starting an animated simulation opens the dock on the Sim Log pane if it's closed, and never steals the active tab if it's open (the tab carries a live count badge). Session state: `state.terminalSessions` (tab order) + `state.terminal` (the active session pointer all CLI handlers write to) + `state.dock` (`open`/`activeTab`/`height`/`logView`). Sim results land in the *origin device's* session even if another tab is active when the run finishes. Sessions are dropped when their device is deleted or a topology loads (`dropTerminalSessions` in state.ts).
- **Sim log = packet list** — the Sim Log pane defaults to a **Wireshark-style packet list**: one row per frame per wire traversal (`sim.capture`, filled in `deliverCompletedTransits`, animated runs only, capped at 1000), columns No./Step/Source/Destination/Protocol/Info/Link with Wireshark-conventional Info strings (`packetColumns` in frame.ts) and protocol-coloured rows (`.pkt-*` classes; RST/NXDOMAIN/TTL-exceeded read red). The Link column shows the wire's name — links are nameable in the link inspector, defaulting to the endpoint combo (`linkName` in devices.ts), and the name round-trips with config JSON. **Clicking a row opens the frame breakdown** in the inspector and **cross-links to the canvas**: `state.inspectedCapture` (the selected `CaptureEntry`) glows that row's wire and both endpoint devices amber (`drawLink`/`drawDeviceIcon` in canvas.ts), so the list and the topology point at each other. The selected row highlights by capture `no` (precise); a canvas-dot pick falls back to frame reference and sets no `inspectedCapture`. `inspectedCapture` clears on a new run, stop, click-elsewhere, and the frame-panel Close. A **Packets/Events toggle** (`state.dock.logView`) switches to the narrative event log (`sim.log` — MAC learns, routing decisions, verdicts); imported logs open in Events. Display-filtering and multi-run captures are roadmap items.
- **Inspector** — right panel: each view opens with a sticky `panelHeading` (title + close button on one line; the close button is wired by delegation since the heading is rebuilt each sync), then the Selection/Configure details, then the device list (no standalone "Network" header subpane — removed as empty chrome). A device shows a Terminal button (CLI devices) and a compact **Power / Delete** button row, then config, or link name + frame history (links rename here; empty input reverts to the derived default; a **Delete link** button removes it — links also delete via the Delete key / ribbon when selected, through `deleteSelection`; an **Administratively down (shut)** toggle takes a link out of service without deleting it — `link.shutdown` blocks traffic at the transit/`findFirstHop`/`l2Reachable` chokepoints (frames dropped with a `sim-drop` log), draws the link dashed-red with a "name · down" label, and round-trips via config + the `shut`/`noshut` console commands. Shut/un-shut from the inspector toggle, the console commands, or **double-clicking the link on the canvas** (`toggleLinkShutdown`). Links also carry **bandwidth/latency/loss** (`link.bandwidth`/`latency`/`loss`): latency stretches the transit animation via `linkLatencyFactor` (ms/10, clamped 0.25–20×, stored as `ActiveTransit.latencyFactor`), loss probabilistically drops forwarded frames **in animated runs only** (headless stays deterministic), bandwidth is metadata for the future streams mode — all editable in the link inspector and round-tripped through config). Router interface rows are stacked (name + peer on top, the `address/prefix` input full-width below) so they don't overlap at narrow widths; a connected port has a `×` unlink button, an unconnected port reads "not connected" (greyed) and still accepts an address (persisted by interface name via `routerInterfaceForName`, by peer once cabled). Ethernet/Serial port counts share one row. Configuring a CLI device (double-click or the configure tool) **auto-opens its terminal** (`canOpenTerminal` gate — not for unmanaged switches, powered-off, or LANs; wired via the `openTerminal` device callback). Hosts (computer/server) model a **single NIC** so they accept at most one cable (`addLink` guard; switches/routers are unrestricted) — multi-NIC hosts are a ROADMAP item. display options (names/IPs/MACs) live in the View ribbon tab. A host's **static-config fields (IP / gateway / DNS / MAC) drive the device CLI**: committing a field (blur/Enter) or a clear/random button runs the matching Linux command in the host's terminal via `runDeviceCommand` (`ip addr add … dev eth0`, `ip route add default via …`, `echo nameserver … > /etc/resolv.conf`, `ip link set dev eth0 address …`, and their flush/del/`rm` clears), flagged **`injected`** (a dark-grey band — simulator-issued, not user-typed). There's **no client-side clipping** — an invalid value runs the real command and its failure shows in the terminal, then the panel re-renders to the device's actual config. IPv4 fields (host and router interface) display and accept **`address/prefix`** — a bare address keeps the existing prefix — with the derived subnet shown beneath the host field (and as the interface input's tooltip). A host's IP carries an **address-source** pill (`config.ipSource`: `static`/`dhcp`/`apipa`, set at each assignment site — static edit, DHCP ACK, APIPA boot; a bare IP reads as static) shown beside the inspector field; an unassigned host shows `0.0.0.0` as the field placeholder and **"unassigned"** on the canvas label. Canvas IP labels, `show`, `show ip interface brief`, and the script export all carry the `/prefix` too.
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
| `H` | Add hub tool (Legacy) |
| `L` | Connect tool |
| `W` | Configure tool |
| `Delete`/`Backspace` | Delete selected device or link |
| `Escape` | Cancel, return to select |
| `Ctrl/Cmd+Z` | Undo |
| `Ctrl/Cmd+Shift+Z` / `Ctrl/Cmd+Y` | Redo |
| Double-click device | Configure |
| Double-click link | Toggle admin status (up ⇄ shut) |
| Scroll wheel | Zoom |

## Common tasks

**Adding a device type**: (1) add the `DeviceType` union member + config interface in `types.ts`; (2) add a `DeviceSpec` entry to `DEVICE_SPECS` in `device-registry.ts` (label, name prefix, size, palette var, icon paths, default config) — this drives naming, drawing, inspector labels, and `add`/`tool` validation automatically; (3) add the `--<paletteVar>-fill/-stroke/-accent/-icon` vars to **each theme** in `styles.css` (the parity test enforces this); (4) add a normalise branch in `normaliseDeviceConfig`; (5) implement `processAt<Type>` in `engine.ts` and register it in the `PROCESSORS` map; (6) optionally add a CLI in `src/terminal/` and register it in `CLI_DISPATCH` (`terminal/core.ts`); (7) add the tool button in `template.html` + `toolCopy` entry and keyboard shortcut in `ui.ts` — either a plain `tool-button` or a variant inside an existing **split-button group** (`.tool-split`: Computer / Switch / Security / Legacy), whose face + menu are driven by `syncToolGroups`; placement resolves through `placeToolDevice`/`PLACEMENT_TOOLS` in `devices.ts`. The **firewall** is the worked example — see [docs/src/firewall.md](docs/src/firewall.md). The **hub** (a layer-1 repeater under the **Legacy** tool group — floods every frame, no MAC learning; `processAtHub`) is a second, minimal worked example.

**Adding a terminal command**: `runTerminalCommand()` in `terminal/core.ts` dispatches via the `CLI_DISPATCH` map — computers → `runHostTerminalCommand` (`terminal/host.ts`), servers → `runServerTerminalCommand` (`terminal/server.ts`, falls through to the host shell), routers → `runRouterTerminalCommand` (`terminal/router.ts` — also add the command to the `ROUTER_COMMANDS` registry so abbreviation and `?` help pick it up), switches → `terminal/switch.ts`, firewalls → `terminal/firewall.ts`. **Match the device's reference NOS** — FRRouting (vtysh) for routers, SONiC for switches, Linux/dnsmasq for hosts/servers — so new commands stay faithful to a real CLI rather than inventing syntax.

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
