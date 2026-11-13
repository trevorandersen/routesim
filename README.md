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
    ├── device-registry.ts # Per-type device spec (label, icon, palette, defaults, capability roles)
    ├── state.ts        # Global state singleton, undo/redo, callback registry
    ├── devices.ts      # Device/link CRUD, LAN collapse/expand
    ├── engine.ts       # Simulation engine: per-device frame processing
    ├── routing.ts      # Routing table, longest-prefix match, RIP convergence
    ├── stp.ts          # Spanning Tree (802.1D): root election, port roles, loop-breaking
    ├── snort.ts        # Snort rule parse/match for the passive IDS sensor
    ├── simulation.ts   # Event builders (ping/TCP/DNS/DHCP, Red Team attacks), L2 reachability
    ├── frame.ts        # Ethernet frame factories, labels, colours
    ├── terminal/       # Per-device CLIs: host, server (dnsmasq), router (FRR), switch (SONiC), firewall (iptables), IDS (Snort), attacker (Kali)
    ├── commands.ts     # Console command engine (also window.routesim + scripts)
    ├── console.ts      # Command console panel UI
    ├── scenarios.ts    # Scenario model, registry, goal checking
    ├── scenario-library.ts # The built-in 28-scenario curriculum
    ├── scenario-ui.ts  # Scenario goal banner
    ├── canvas.ts       # Canvas rendering (devices, links, labels, pan/zoom)
    ├── inspector.ts    # Right-side panel (device details, link history, options)
    ├── ribbon.ts       # Tabbed ribbon UI
    ├── io.ts           # JSON import/export (config/scenario/script/log)
    ├── config.ts       # Topology serialise/apply + built-in topologies
    ├── tutorial.ts     # Tutorial mode: auto-playing faux-cursor demo
    └── ui.ts           # Event handlers, tools, keyboard shortcuts
```

## How the build works

The build uses only esbuild + bun (no Node.js, npm, or Python):

1. **esbuild** bundles all TypeScript modules in `src/` into a single IIFE (`.bundle.js`)
2. **`bun build-inline.ts rs-web.html`** reads `template.html` and inlines the CSS from `styles.css` and the JS bundle
3. The temporary `.bundle.js` is deleted

The result, `rs-web.html`, has everything inlined — styles in a `<style>` tag, script in a `<script>` — and makes no network requests. See [docs/build.md](docs/build.md) and [docs/scripting.md](docs/scripting.md) for the JSON import/export.

For repeatable bug hunting, run `bun test tests/stress.test.ts`, or enter `stress 20260706 500` in RouteSim's command console to exercise the same seeded command mutations and invariants through the live UI callbacks. This uses only the existing Bun test/runtime path and adds no dependencies.

## Module architecture

Modules are organized to keep concerns separate while producing a flat IIFE bundle:

| Module | Responsibility |
|---|---|
| `types.ts` | Shared interfaces (`Device`, `Link`, `AppState`, frame payloads, etc.) |
| `dom.ts` | Cached `getElementById` references, typed |
| `utils.ts` | Pure functions — IP/MAC validation, subnet/prefix maths |
| `normalise.ts` | Sanitise and normalise device configs, ARP/MAC/VLAN/DNS tables |
| `device-registry.ts` | One spec per device type: label, name prefix, size, palette, icon, defaults, default port count, and capability roles (host, single NIC, bootable, 802.1X supplicant, hostname, terminal) |
| `state.ts` | The single `state` object, undo/redo stacks, and a **callback registry** for breaking circular deps |
| `devices.ts` | Add/remove/move devices and links, LAN group logic |
| `engine.ts` + `routing.ts` | Frame-level simulation: per-device processors, headless runs, traceroute, routing/RIP |
| `stp.ts` | Spanning Tree (802.1D): root election, port roles/states, loop-breaking + broadcast-storm detection |
| `simulation.ts` | Event builders (`buildPingEvents`/`buildConnectEvents`/`buildResolveEvents`/`buildDhcpEvents`), L2 BFS reachability |
| `diagnostics.ts` + `stress.ts` | Runtime state invariants and deterministic command-mutation stress testing |
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

- **Packet callouts** — an optional View-tab toggle (off by default) draws a small field callout beside each frame in flight (ARP who-has/is-at, IPv4 src→dst, TCP flags/ports, the MAC pair); a field the last hop **rewrote** — MACs at a router, the source address at a NAT router — is underlined, marked `✎` and pulsed, so you can see what changed at each hop.
- **Man-in-the-middle** — `arpspoof [-r] [-t <victim>] <gateway>` poisons one victim (or the whole segment), and with `-r` the gateway too; a Kali host with `sysctl -w net.ipv4.ip_forward=1` then **forwards** the intercepted traffic to its true next hop (from its own unpoisoned ARP cache) instead of black-holing it, so the ping still succeeds and the extra hop shows in the packet list — the silent MITM, paired with the IDS for red-vs-blue.
- **Canvas editor** — pan, zoom, drag devices, auto-grid snapping; with a device tool armed a translucent preview of the device follows the cursor — left-click places (and stays armed for the next), right-click or Esc leaves place mode; right-click a device for a quick menu (Terminal / Configure / Power / Delete), and a floating play/pause/step/stop pill appears over the canvas while a simulation runs (Ctrl+C in a terminal cancels it). One run at a time: while a run animates the terminal that started it is busy (other devices' shells stay usable for `arp -n` or `show ip route` mid-run), a second animated run is refused with the reason, a headless check (`run`, traceroute, scenario Check) stops it first and says so, and a manual run takes over from a network boot (one Play press is one undo step)
- **Device types** — computers (PC/laptop), servers, switches (managed/unmanaged), routers (internal/core or border/edge — a "B" badge), an **internet cloud** (an L3 transit that routes between connected routers, each on its own public subnet — multi-site over the WAN), firewalls (transparent inline packet filter, iptables **or** nftables syntax), hubs (layer-1 repeater — every device hears every frame, but a router routes only frames addressed to its own interface MAC), IDS sensors, Kali PCs (a hand-driven pentest box), Red Team actors (an autonomous Kali attacker)
- **Server tool** — its own ribbon group with role-preset entries: a generic **Server** (dnsmasq: DNS + DHCP), a **DNS server**, a **DHCP server**, a **RADIUS server** (the 802.1X back-end), and a **Web server** (an HTTP service answering GET with 200 OK on TCP/80). All are the one `server` type, pre-named (`DNS-1`, `RAD-1`, …) and role-flagged; configure DNS records, the DHCP range, **RADIUS users**, the **HTTP service** (+ page title), and **listening ports** in the inspector
- **PC terminal** — `ip addr`, `ip route`, `ping`, `traceroute`, `nslookup`, `nc -z`, `curl http://…`, `arp -n`, `ip neigh flush all` (a stale ARP entry — a cached MAC no cabled device presents — is named when a ping fails; routers take the same command in privileged mode), `/etc/resolv.conf`, `hostname` / `hostnamectl set-hostname`
- **Hostname = canvas name** — a CLI device's name on the canvas *is* its hostname (also its prompt and the name it resolves as). Set it the real way — `hostname <name>` / `hostnamectl set-hostname <name>` / `echo <name> > /etc/hostname` on a host, `hostname <name>` (config mode) on a router, `config hostname <name>` on a managed switch — or just edit the **Hostname** field in the inspector
- **Server terminal** — Linux shell + dnsmasq (`/etc/dnsmasq.conf` directives, `systemctl`)
- **Router terminal** — FRRouting (vtysh): `hostname`, interfaces, static routes, RIP, NAT/PAT (incl. `ip nat inside source static tcp …` port-forwarding), iptables INPUT/FORWARD
- **Switch terminal** — SONiC: `config hostname`, VLANs, port membership, MAC tables, `show spanning_tree` / `config spanning_tree`, `config mirror_session span add` (SPAN)
- **IDS terminal** — Snort 3 on Linux: `snort -V` / `snort -T`, edit `/etc/snort/rules/local.rules`, read `/var/log/snort/alert`
- **Kali terminal** — Kali Linux (the Kali PC and the Red Team actor): `nmap -sS <target>` (SYN scan), `nmap -sn <subnet>` (ping sweep), `arpspoof [-t <victim>] <gateway>` (ARP poisoning); falls through to the standard Linux net tools (`ip`, `ping`, `traceroute`, `nc`)
- **DNS** — hosts resolve names via real UDP/53 frames before they ping/connect; NXDOMAIN, option 6 via DHCP. A DNS server **auto-resolves every device's hostname** (an automatic zone) on top of any manual `address=` records, so `ping PC-A1` / `nslookup PC-A1` issue a real, watchable query. The **Instant DNS** setting (on by default in topologies, off in scenarios) instead resolves a device name straight to its IP with no query — a built-in hosts file; turn it off to require real DNS, like the real world
- **HTTP** — `curl http://<host>[:port][/path]` (or `http <src> <host>`) runs a real HTTP GET **on top of** the TCP handshake: SYN/SYN-ACK/ACK, then `GET /` and `200 OK` animate as HTTP frames in the packet list. A server answers only when its **web service** is on (`web <host> on`, the inspector toggle, or the Web-server tool) — an open port with no service connects but gives an "empty reply", a closed port is "connection refused"
- **Subnet-aware ping** — same-subnet uses L2 BFS; cross-subnet routes through a gateway router
- **VLAN enforcement** — managed switches enforce VLAN membership on L2 paths
- **Spanning Tree (802.1D)** — managed switches run STP by default: they elect a root bridge (lowest priority + MAC), assign port roles, and **block one redundant port** to break an L2 loop (drawn dashed-amber "STP blocked"; the root carries an "R" badge). `stp` animates the BPDU exchange; turn it off (`stp <switch> off`) on a looped topology and watch the **broadcast storm** form instead — the sim log names the wire where a frame came back round the loop, and the verdict is the same on animated and headless runs (a large loop-free LAN never trips it). Bridge priority and per-port Root/Designated/Blocking roles show in the inspector and `show spanning_tree`
- **ARP/MAC learning** — ping populates ARP tables on hosts and routers, MAC tables on switches; adding, removing or shutting a cable flushes the learnt MAC entries on that LAN (like a spanning-tree topology change), so a moved host is re-learnt rather than stranded
- **Failures explain themselves** — a run that fails says why, in the terminal, the console and the sim log: "Network is unreachable" names the real cause (a shut cable, a wrong WiFi password, an unauthorized 802.1X port, a failed MACsec link, a spanning-tree block, a powered-off peer) instead of "no link"; an ARP nobody answered is called out at the end of the run, naming the default gateway when that is the culprit, or the real cause when the ARP was dropped on the way (an unauthorized 802.1X port, a failed MACsec link, a shut cable, link loss); a traceroute that goes silent says why after the hop list; a failed ping prints `From … Time to live exceeded` / `Destination Port Unreachable` / `Destination Host Unreachable` like Linux; a broadcast storm is reported by headless `run`s and `traceroute` too; and `nc` to a router port with no service is refused rather than timing out
- **Firewall editing** — add/delete iptables rules and set the chain policy from the Configure pane (routers: INPUT + FORWARD; firewall: FORWARD), or via the terminal
- **Stateful firewall** — `-m state --state ESTABLISHED,RELATED` (connection tracking) lets the return traffic of an allowed flow back without an explicit inbound rule, so "default-drop + allow the inside out" blocks unsolicited inbound scans while inside hosts still browse. **REJECT** answers back (a TCP RST → a scan reads the port as *closed*; an ICMP unreachable otherwise) instead of a silent DROP timeout
- **802.1X port authentication** — `dot1x <host>` animates the supplicant → authenticator (switch `auto` port) → RADIUS server EAP/RADIUS exchange; an `auto` port blocks data until EAP-Success, and a bad credential gets Access-Reject → EAP-Failure. Port control belongs to the switch port, so a locked port blocks whatever is plugged in — a Kali box, a Red Team host or a hub gets no further than a PC
- **MACsec (802.1AE)** — `macsec <device> <peer> <key>` encrypts a link with a pre-shared key; matching keys secure it (frames show encrypted in the packet list), a `must`-secure key mismatch drops traffic, and `should`-secure falls back to plaintext. `macsec <device> <peer> dot1x` instead **derives the key from 802.1X** (MKA): the link stays unsecured until the port authenticates, then auto-keys from the EAP exchange — the full enterprise "authenticate, then encrypt" story
- **IDS (Snort) + port mirroring** — a passive **Snort** sensor watches a copy of traffic from a managed switch's **SPAN/monitor port** (`mirror <switch> <port>`) and raises alerts on Snort rule matches (`alert tcp any any -> any 23 (msg:"Telnet"; sid:…)`) — a real `local.rules` editor + a fast-alert log in the inspector and the `snort` CLI. Passive, so it watches but never blocks
- **Offensive hosts (Kali PC + Red Team actor)** — two **Kali Linux** boxes sharing one attack engine. A **Kali PC** (Computer group, monitor-with-prompt icon) is a pentest workstation you drive by hand; a **Red Team actor** (Security group, skull icon) is an autonomous adversary that launches its plan on Play (an unconfigured one is network-booted first, like any host). Both run an **nmap SYN port scan** (a SYN to each common port; open answers SYN-ACK, closed RST), a **ping sweep** (host discovery across a subnet, routed via the gateway for a remote one), and **ARP spoofing** (a gratuitous reply that poisons victims' ARP caches — MITM), reporting an nmap-style `PORT STATE SERVICE` table. Run `attack <host> scan <target>` or use the terminal; pair with an IDS to practise detection (red vs blue)
- **Packet list (Wireshark-style)** — every animated run fills a sim-log packet list (No./Step/Source/Destination/Protocol/Info/Link); click a row to see the full frame breakdown and glow its wire on the canvas. **Filter it** with clickable protocol chips, a per-device dropdown, and a real **display-filter expression** — `dns || icmp && !arp`, `ip.addr == 10.0.0.0/24`, `tcp.port == 22 && device contains PC` (with `&&`/`||`/`!`/parens, `==`/`!=`/`<`/`>`/`contains`, and CIDR) — all ANDed, with a live "Showing N of M" count
- **Multi-run captures** — each run is archived; switch between past runs, or **Compare** two side by side (before vs after) to see exactly what a fix changed — both panes honour the display filter
- **Silent protocols** — optionally resolve ARP/DHCP/DNS instantly with no animation or packet-list rows, to keep the higher-layer flow uncluttered
- **In-app guide** — Help -> Guide opens a reference for every device you can place and every simulation setting, with each device's own icon and a plain-language description of what it does and how you drive it
- **Tutorial mode** — Help -> Tutorial plays a hands-off demo: a faux cursor builds two LANs joined by a router, configures the addresses and gateways **in the inspector**, and pings across it **from a device terminal**, narrating each step. Step through it at your own pace with back / pause / forward / replay / exit controls (or the arrow keys); back and forward deterministically rebuild the topology so you can scrub. It drives the real UI underneath, so it shows exactly what you would do by hand
- **Scenarios** — a 29-entry guided curriculum with goal checking, every entry solvable (tested) — including WiFi joins, 802.1X port authentication, MACsec link encryption, breaking an L2 loop with spanning tree, catching an intruder with an IDS, writing a Snort rule to detect a Red Team port scan, publishing a web page, and building a stateful firewall that blocks inbound scans while letting hosts browse out
- **Undo/redo** — snapshot-based history for topology and config changes
- **Persistence** — import/export configs, scenarios, scripts, and logs as JSON files
- **WiFi** — a WiFi-only **laptop** that associates to an **access point** (a transparent L2 bridge) over a matching **SSID** (with an optional password); the wireless link is drawn dotted, and ARP/DHCP/IP work through the AP onto the wired LAN. `associate <laptop>` animates the real **802.11 join** — probe / authentication / association, plus the WPA2 4-way (EAPOL) key handshake on a secured network. A **wrong password** still associates but fails the key handshake (the AP deauthenticates), leaving the link unauthenticated and carrying no data until the password is fixed
- **URL settings** — share a pre-configured link, e.g. `?theme=dark&names=0&autodhcp=on&silentarp=1&speed=400` (see [docs/scripting.md](docs/scripting.md#url-settings))
- **Dark/light theme** — toggle via toolbar, implemented with CSS custom properties
- **LAN grouping** — collapse multiple devices into a LAN cloud (a view only: routing, forwarding and pings across it behave exactly as when expanded)

## Licence

RouteSim is released into the **public domain** under the [CC0 1.0 Universal Public Domain Dedication](LICENSE). No rights reserved: copy, modify, distribute, and use it for any purpose (including commercial) without asking permission. The dedication is irrevocable, so the work can never be clawed back out of the public domain. See [`LICENSE`](LICENSE) for the full text.
