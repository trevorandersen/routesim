# `src/terminal/` — Per-device CLI

> Layout: `core.ts` (line buffer, prompt, CLI dispatch via `CLI_DISPATCH`, open/close/sync/submit UI) + one module per NOS — `host.ts` (Linux PC), `server.ts` (Linux + dnsmasq), `router.ts` (FRRouting), `switch.ts` (SONiC), `firewall.ts` (iptables) — plus `iptables.ts`, the shared netfilter command engine (firewall device: FORWARD; routers: INPUT + FORWARD). The public API is unchanged, re-exported through `terminal/index.ts`, so `import { … } from "./terminal"` still works everywhere.

The bottom-panel terminal: a per-device command-line that emulates a Linux host shell, a server shell, a router CLI, and a managed-switch CLI. It contains three concerns — command **parsing/dispatch**, state **mutation**, and terminal **rendering**.

**CLI lineage (open-source references):** the router CLI follows **FRRouting** (vtysh — Cisco-IOS-like, with a mode state machine); the managed-switch CLI follows **SONiC** (flat, mode-less `config …` / `show …`); the server follows **dnsmasq** conventions (append directives to `/etc/dnsmasq.conf`, manage the daemon with `systemctl`). Each device speaks the language of a real open-source NOS rather than an invented syntax.

## Command dispatchers
- **`runTerminalCommand(rawCommand)`** (`core.ts`) — top-level entry. Reads the active device from `state.terminal.deviceId`, echoes the prompt, and dispatches via the `CLI_DISPATCH` map: computers → `runHostTerminalCommand` (`ip addr`, `ip route`, `arp`, `cat /etc/resolv.conf`, `echo nameserver <ip> > /etc/resolv.conf`, `ping`, `traceroute`/`tracert`, `nslookup`/`host`/`dig <name>`, `nc -z <host> <port>`, `dhcp`, `help`, `clear`), servers → `runServerTerminalCommand`, routers → `runRouterTerminalCommand`, switches → `runSwitchTerminalCommand`, firewalls → `runFirewallTerminalCommand`. `hasTerminal(device)` derives the "has a CLI" check from the same map.
- **`runServerTerminalCommand(server, command)`** (`server.ts`) — the **dnsmasq** server shell: `cat /etc/dnsmasq.conf`, `echo <directive> >> /etc/dnsmasq.conf` (directives `address=/name/ip` — appending an existing name replaces it; `dhcp-range=start,end` — enables DHCP; `dhcp-option=option:router,ip`), and `systemctl start|stop|restart|status dnsmasq` (stopping stops both DNS and DHCP — one daemon). Everything else falls through to the host handler, so a server is also a full Linux endpoint. See [dns.md](dns.md).
- **`runRouterTerminalCommand(router, command)`** — the **FRRouting**-style CLI. Implements a **mode state machine** (`exec → privileged → config → interface/rip`) and the commands within each mode: `enable`, `configure terminal`, `interface <name>`, `ip address`, `encapsulation dot1q`, `ip route`, `router rip` + `network <cidr|ifname>`/`passive-interface`, `show ip route [rip]`, `show ip rip [status]`, `do <show …>`, `exit`/`end`; **NAT**: `ip nat inside|outside` (interface mode), `show ip nat translations`, `clear ip nat translation *`; **netfilter**: `iptables …` on INPUT/FORWARD (privileged mode, shared engine). Decomposed into focused handlers (session/show/interface/RIP/static-route). A small command **registry** (`ROUTER_COMMANDS`) drives two vtysh conveniences: **command abbreviation** (`expandRouterCommand` expands any unambiguous prefix — `sh ip ro` → `show ip route`, `conf t` → `configure terminal`; ambiguous prefixes error) and a **context-sensitive `?`** (`routerHelp` lists the commands valid in the current mode, filtered by what's typed). Expansion is additive — a command missing from the registry just isn't abbreviated; typed in full it still dispatches.
- **`runFirewallTerminalCommand(device, command)`** — the **iptables**-style firewall CLI (FORWARD chain): `iptables -L/-A/-I/-D/-P/-F`, matches `-s`/`-d`/`-p`/`--icmp-type`, targets `ACCEPT`/`DROP`/`REJECT`. Parses into `FirewallRule`s; `showFirewallRules` renders `-L`. See [firewall.md](firewall.md).
- **`runSwitchTerminalCommand(device, command)`** — the **SONiC**-style managed-switch CLI (flat, no modes): `show vlan brief`, `show mac`, `show interfaces status`, `show runningconfiguration all`, `config vlan add/del <vid>`, `config vlan member add [-t] <vid> <port>` (untagged/tagged), `config vlan member del <vid> <port>`. Rejects unmanaged switches. VLAN membership maps onto the internal access/trunk model: an untagged member is the port's access/native VLAN; a tagged member makes the port a trunk carrying that VLAN. The `sonicVlanMemberAdd`/`Del` helpers apply this in a single undo snapshot. The switch CLI is **exact** (no prefix abbreviation or `?` completion) — SONiC's `config`/`show` CLI is click-based and exact, so matching it keeps fidelity; abbreviation lives only on the FRR router side.

The current mode and interface selection live on the **session** (`state.terminal` — the active `TerminalSession`): `mode`, `interfacePeerId`, `interfaceVlanTag`. Every open device terminal is a session in `state.terminalSessions` with its own scrollback, history, and mode, so the router's config mode survives switching tabs; the console's `cli` command attaches to the same sessions (silently creating one when needed), which is why multi-line vtysh scripts work.

## State mutators
Pure-ish functions that change device config, `pushUndo`, and re-sync — shared across the terminal, the inspector GUI, and the console scripting engine (`commands.ts`):
- Host: `setHostIp`, `flushHostIp`, `setHostGateway`, `setHostDns` (the resolver).
- Server: `applyDnsmasqConfLine` (parses/applies one conf directive), `showDnsmasqConf`.
- Router: `setRouterInterfaceIp`, `clearRouterInterfaceIp`.
- Switch: `addSwitchVlan`, `removeSwitchVlan`, `setSwitchPortVlan`, `setSwitchPortMode`, `setSwitchTrunkNative`, `modifySwitchTrunkAllowed` (the inspector + console use these directly; the SONiC switch terminal applies membership via `sonicVlanMemberAdd`/`Del`).

They return a result string (the message shown in the terminal); callers detect errors by prefix (`"Invalid…"`, `"Unknown…"`).

## Display helpers
`show*` functions that format read-only output: `showHostIp`/`Route`/`Arp`, `showRouterInterfaceBrief`/`Route`/`RouteRip`/`Arp`/`DhcpBindings`/`Rip`(status)/`RipRoutes`/`RunningConfig`, `showSwitchInterfaces`/`Vlans`/`MacTable`/`RunningConfig` (the switch running-config is emitted as replayable SONiC `config …` commands).

## Dock & terminal UI
The bottom **dock** (`core.ts`) hosts three pane kinds behind one tab strip: the per-device terminal sessions (one tab each, closable), the command console, and the sim log (with a live entry-count badge). It is drag-resizable via its top edge (`startDockResize` → `--terminal-height`).

- **`openTerminalFor(device)`** — find-or-create the device's session (`ensureSession`, greeting on creation), make it active, open the dock on the terminal pane. Open failures (powered off, unmanaged switch) show a detached placeholder instead of creating a session.
- **`closeSession(deviceId)`** — close one tab; the active pointer falls back to a neighbour, and closing the last tab closes the dock. A router's exec-level `exit` calls this (logout).
- **`openDock(tab)` / `closeDock()` / `toggleDockTab(tab)` / `setDockTab(tab)`** — dock state; `syncDock()` rebuilds the tab strip and pane visibility.
- **`syncTerminal()`** — render the active session into the terminal pane (a session whose device vanished is closed automatically).
- **`submitTerminalCommand()` / `handleTerminalKeydown()`** — handle Enter and up/down history navigation (per-session history).
- **`terminalLine(kind, text)`** — push a line to the active session; **`terminalLineFor(session, …)`** targets a specific one (simulation results go to the *origin device's* session even if another tab is active when the run finishes); **`terminalPromptText(device)`** — the prompt string.

## How it fits

The terminal is a major surface area. The dispatchers parse user input and call the mutators/display helpers; the mutators are shared with `inspector.ts` so CLI and GUI edits are consistent. `ping`/`dhcp` build events via `simulation.ts` and start the run via `engine.startSimulation`. The mutators are unit-tested directly, and the dispatchers + mode machine have their own dispatcher test file.
