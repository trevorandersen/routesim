# RouteSim

A portable, single-file network topology simulator. Build a network of PCs, servers, switches, routers, and firewalls on an interactive canvas, then open device terminals to run CLI commands like `ping`, `arp -n`, `nslookup`, and `show ip interface brief`. The simulator models L2/L3 reachability with VLAN enforcement, ARP/MAC learning, subnet-aware routing, NAT, netfilter chains, and DNS/DHCP services.

The app builds into a single self-contained **`rs-web.html`** — no server, no runtime dependencies, no network requests. Just open it in a browser. Default topologies and scenarios are built in; configs, scenarios, scripts, and logs import/export as JSON files.

## Quick start

```bash
# Build (requires esbuild + bun, no npm/Node/Python)
./build.sh            # dev build  — produces rs-web.html
./build.sh --minify   # minified build

# Preview / serve locally (optional — rs-web.html also opens directly as a file)
bun test-server.ts            # serves on http://localhost:8767
# then open http://localhost:8767/rs-web.html
```

### Prerequisites

- **esbuild** — `brew install esbuild` (standalone binary, no Node.js required)
- **bun** — runtime + test runner; also runs the build inliner and dev server

## Project structure

```
routesim/
├── build.sh            # Build script: esbuild bundle + bun template assembly
├── build-inline.ts     # Inlines CSS + JS into template.html → output HTML
├── test-server.ts      # Dev server + test/benchmark API (bun)
├── tsconfig.json       # TypeScript config (strict, ES2022, no emit)
├── template.html       # HTML shell with {{STYLES}} and {{SCRIPT}} placeholders
├── styles.css          # All CSS (three themes via custom properties)
├── rs-web.html         # Build output — the single portable file
├── docs/               # Architecture, build, testing, scripting, scenario docs
├── scenario-solutions/ # Runnable console scripts that solve each built-in scenario
├── tests/              # Bun test suites + benchmark harness
└── src/
    ├── app.ts          # Entry point — wires callbacks, initialises the app
    ├── types.ts        # Interfaces and type definitions
    ├── dom.ts          # Typed references to DOM elements
    ├── utils.ts        # Pure utility functions (IP/subnet maths, MAC formatting)
    ├── normalise.ts    # Defensive config normalisation + per-type defaults
    ├── device-registry.ts # Per-type device spec (label, icon, palette, defaults)
    ├── state.ts        # Global state singleton, undo/redo, callback registry
    ├── devices.ts      # Device/link CRUD, LAN collapse/expand
    ├── engine.ts       # Simulation engine: per-device frame processing
    ├── routing.ts      # Routing table, longest-prefix match, RIP convergence
    ├── simulation.ts   # Event builders (ping/TCP/DNS/DHCP), L2 reachability
    ├── frame.ts        # Ethernet frame factories, labels, colours
    ├── terminal/       # Per-device CLIs: host, server (dnsmasq), router (FRR), switch (SONiC), firewall (iptables)
    ├── commands.ts     # Console command engine (also window.routesim + scripts)
    ├── console.ts      # Command console panel UI
    ├── scenarios.ts    # Scenario model, registry, goal checking
    ├── scenario-library.ts # The built-in 22-scenario curriculum
    ├── scenario-ui.ts  # Scenario goal banner
    ├── canvas.ts       # Canvas rendering (devices, links, labels, pan/zoom)
    ├── inspector.ts    # Right-side panel (device details, link history, options)
    ├── ribbon.ts       # Tabbed ribbon UI
    ├── io.ts           # JSON import/export (config/scenario/script/log)
    ├── config.ts       # Topology serialise/apply + built-in topologies
    └── ui.ts           # Event handlers, tools, keyboard shortcuts
```

## How the build works

The build uses only esbuild + bun (no Node.js, npm, or Python):

1. **esbuild** bundles all TypeScript modules in `src/` into a single IIFE (`.bundle.js`)
2. **`bun build-inline.ts rs-web.html`** reads `template.html` and inlines the CSS from `styles.css` and the JS bundle
3. The temporary `.bundle.js` is deleted

The result, `rs-web.html`, has everything inlined — styles in a `<style>` tag, script in a `<script>` — and makes no network requests. See [docs/build.md](docs/build.md) and [docs/scripting.md](docs/scripting.md) for the JSON import/export.

## Module architecture

Modules are organized to keep concerns separate while producing a flat IIFE bundle:

| Module | Responsibility |
|---|---|
| `types.ts` | Shared interfaces (`Device`, `Link`, `AppState`, frame payloads, etc.) |
| `dom.ts` | Cached `getElementById` references, typed |
| `utils.ts` | Pure functions — IP/MAC validation, subnet/prefix maths |
| `normalise.ts` | Sanitise and normalise device configs, ARP/MAC/VLAN/DNS tables |
| `device-registry.ts` | One spec per device type: label, name prefix, size, palette, icon, defaults |
| `state.ts` | The single `state` object, undo/redo stacks, and a **callback registry** for breaking circular deps |
| `devices.ts` | Add/remove/move devices and links, LAN group logic |
| `engine.ts` + `routing.ts` | Frame-level simulation: per-device processors, headless runs, traceroute, routing/RIP |
| `simulation.ts` | Event builders (`buildPingEvents`/`buildConnectEvents`/`buildResolveEvents`/`buildDhcpEvents`), L2 BFS reachability |
| `terminal/` | Per-device-type CLIs (PC: Linux; server: dnsmasq; router: FRRouting; switch: SONiC; firewall: iptables) |
| `canvas.ts` | `<canvas>` rendering loop — device icons, link lines, labels, transit dots, grid |
| `inspector.ts` | Right panel DOM — device details, service config, MAC/ARP table views |
| `config.ts` + `io.ts` | Topology serialise/apply, built-in topologies, JSON import/export |
| `ui.ts` | Mouse/keyboard event wiring, tool switching, drag, zoom, undo shortcuts |
| `app.ts` | Boots everything — registers cross-module callbacks, loads config, starts render loop |

### Circular dependency pattern

Several modules need to call each other (e.g., `engine` needs the canvas to `render`, `devices` needs `inspector.syncPanel`). Instead of circular imports, `state.ts` exposes a **callback registry**:

```typescript
// state.ts
const callbacks = { render: () => {}, syncPanel: () => {}, syncTerminal: () => {}, ... };
export function registerCallbacks(cbs) { Object.assign(callbacks, cbs); }
export function sync() { return callbacks; }

// app.ts — wires everything at startup
registerCallbacks({ render, syncPanel, syncTerminal, resizeCanvas, syncScenarioPanel, syncCoordReadout });

// engine.ts — calls without importing canvas/inspector
sync().render();
```

## Features

- **Canvas editor** — pan, zoom, drag devices, auto-grid snapping
- **Device types** — computers (PC/laptop), servers, switches (managed/unmanaged), routers, firewalls (transparent inline iptables filter), hubs (layer-1 repeater)
- **Server tool** — its own ribbon group with role-preset entries: a generic **Server** (dnsmasq: DNS + DHCP), a **DNS server**, a **DHCP server**, a **RADIUS server** (the 802.1X back-end), and a **Web server** (listening on TCP/80). All are the one `server` type, pre-named (`DNS-1`, `RAD-1`, …) and role-flagged; configure DNS records, the DHCP range, **RADIUS users**, and **listening ports** in the inspector
- **PC terminal** — `ip addr`, `ip route`, `ping`, `traceroute`, `nslookup`, `nc -z`, `arp -n`, `/etc/resolv.conf`, `hostname` / `hostnamectl set-hostname`
- **Hostname = canvas name** — a CLI device's name on the canvas *is* its hostname (also its prompt and the name it resolves as). Set it the real way — `hostname <name>` / `hostnamectl set-hostname <name>` / `echo <name> > /etc/hostname` on a host, `hostname <name>` (config mode) on a router, `config hostname <name>` on a managed switch — or just edit the **Hostname** field in the inspector
- **Server terminal** — Linux shell + dnsmasq (`/etc/dnsmasq.conf` directives, `systemctl`)
- **Router terminal** — FRRouting (vtysh): `hostname`, interfaces, static routes, RIP, NAT/PAT, iptables INPUT/FORWARD
- **Switch terminal** — SONiC: `config hostname`, VLANs, port membership, MAC tables
- **DNS** — hosts resolve names via real UDP/53 frames before they ping/connect; NXDOMAIN, option 6 via DHCP. A DNS server **auto-resolves every device's hostname** (an automatic zone) on top of any manual `address=` records, so `ping PC-A1` / `nslookup PC-A1` issue a real, watchable query. The **Instant DNS** setting (on by default in topologies, off in scenarios) instead resolves a device name straight to its IP with no query — a built-in hosts file; turn it off to require real DNS, like the real world
- **Subnet-aware ping** — same-subnet uses L2 BFS; cross-subnet routes through a gateway router
- **VLAN enforcement** — managed switches enforce VLAN membership on L2 paths
- **ARP/MAC learning** — ping populates ARP tables on hosts and routers, MAC tables on switches
- **Firewall editing** — add/delete iptables rules and set the chain policy from the Configure pane (routers: INPUT + FORWARD; firewall: FORWARD), or via the terminal
- **802.1X port authentication** — `dot1x <host>` animates the supplicant → authenticator (switch `auto` port) → RADIUS server EAP/RADIUS exchange; an `auto` port blocks data until EAP-Success, and a bad credential gets Access-Reject → EAP-Failure
- **MACsec (802.1AE)** — `macsec <device> <peer> <key>` encrypts a link with a pre-shared key; matching keys secure it (frames show encrypted in the packet list), a `must`-secure key mismatch drops traffic, and `should`-secure falls back to plaintext. `macsec <device> <peer> dot1x` instead **derives the key from 802.1X** (MKA): the link stays unsecured until the port authenticates, then auto-keys from the EAP exchange — the full enterprise "authenticate, then encrypt" story
- **Silent protocols** — optionally resolve ARP/DHCP/DNS instantly with no animation or packet-list rows, to keep the higher-layer flow uncluttered
- **Scenarios** — a 22-entry guided curriculum with goal checking, every entry solvable (tested) — including WiFi joins, 802.1X port authentication, and MACsec link encryption
- **Undo/redo** — snapshot-based history for topology and config changes
- **Persistence** — import/export configs, scenarios, scripts, and logs as JSON files
- **WiFi** — a WiFi-only **laptop** that associates to an **access point** (a transparent L2 bridge) over a matching **SSID** (with an optional password); the wireless link is drawn dotted, and ARP/DHCP/IP work through the AP onto the wired LAN. `associate <laptop>` animates the real **802.11 join** — probe / authentication / association, plus the WPA2 4-way (EAPOL) key handshake on a secured network. A **wrong password** still associates but fails the key handshake (the AP deauthenticates), leaving the link unauthenticated and carrying no data until the password is fixed
- **URL settings** — share a pre-configured link, e.g. `?theme=dark&names=0&autodhcp=on&silentarp=1&speed=400` (see [docs/scripting.md](docs/scripting.md#url-settings))
- **Dark/light theme** — toggle via toolbar, implemented with CSS custom properties
- **LAN grouping** — collapse multiple devices into a LAN cloud

## Licence

RouteSim is released into the **public domain** under the [CC0 1.0 Universal Public Domain Dedication](LICENSE). No rights reserved: copy, modify, distribute, and use it for any purpose (including commercial) without asking permission. The dedication is irrevocable, so the work can never be clawed back out of the public domain. See [`LICENSE`](LICENSE) for the full text.
