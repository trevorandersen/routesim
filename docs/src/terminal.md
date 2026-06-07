# `src/terminal.ts` — Per-device CLI

The bottom-panel terminal: a per-device command-line that emulates a Linux host shell, a router CLI, and a managed-switch CLI. It contains three concerns — command **parsing/dispatch**, state **mutation**, and terminal **rendering**.

**CLI lineage (open-source references):** the router CLI follows **FRRouting** (vtysh — Cisco-IOS-like, with a mode state machine); the managed-switch CLI follows **SONiC** (flat, mode-less `config …` / `show …`). Each device speaks the language of a real open-source NOS rather than an invented syntax.

## Command dispatchers
- **`runTerminalCommand(rawCommand)`** — top-level entry. Reads the active device from `state.terminal.deviceId`, echoes the prompt, and dispatches: routers → `runRouterTerminalCommand`, switches → `runSwitchTerminalCommand`, computers handled inline (`ip addr`, `ip route`, `arp`, `ping`, `dhcp`, `help`, `clear`).
- **`runRouterTerminalCommand(router, command)`** — the **FRRouting**-style CLI. Implements a **mode state machine** (`exec → privileged → config → interface/rip`) and the commands within each mode: `enable`, `configure terminal`, `interface <name>`, `ip address`, `encapsulation dot1q`, `ip route`, `router rip` + `network <cidr|ifname>`/`passive-interface`, `show ip route [rip]`, `show ip rip [status]`, `do <show …>`, `exit`/`end`. Decomposed into focused handlers (session/show/interface/RIP/static-route). A small command **registry** (`ROUTER_COMMANDS`) drives two vtysh conveniences: **command abbreviation** (`expandRouterCommand` expands any unambiguous prefix — `sh ip ro` → `show ip route`, `conf t` → `configure terminal`; ambiguous prefixes error) and a **context-sensitive `?`** (`routerHelp` lists the commands valid in the current mode, filtered by what's typed). Expansion is additive — a command missing from the registry just isn't abbreviated; typed in full it still dispatches.
- **`runSwitchTerminalCommand(device, command)`** — the **SONiC**-style managed-switch CLI (flat, no modes): `show vlan brief`, `show mac`, `show interfaces status`, `show runningconfiguration all`, `config vlan add/del <vid>`, `config vlan member add [-t] <vid> <port>` (untagged/tagged), `config vlan member del <vid> <port>`. Rejects unmanaged switches. VLAN membership maps onto the internal access/trunk model: an untagged member is the port's access/native VLAN; a tagged member makes the port a trunk carrying that VLAN. The `sonicVlanMemberAdd`/`Del` helpers apply this in a single undo snapshot. The switch CLI is **exact** (no prefix abbreviation or `?` completion) — SONiC's `config`/`show` CLI is click-based and exact, so matching it keeps fidelity; abbreviation lives only on the FRR router side.

The current mode and interface selection live on `state.terminal` (`mode`, `interfacePeerId`, `interfaceVlanTag`).

## State mutators
Pure-ish functions that change device config, `pushUndo`, and re-sync — shared across the terminal, the inspector GUI, and the console scripting engine (`commands.ts`):
- Host: `setHostIp`, `flushHostIp`, `setHostGateway`.
- Router: `setRouterInterfaceIp`, `clearRouterInterfaceIp`.
- Switch: `addSwitchVlan`, `removeSwitchVlan`, `setSwitchPortVlan`, `setSwitchPortMode`, `setSwitchTrunkNative`, `modifySwitchTrunkAllowed` (the inspector + console use these directly; the SONiC switch terminal applies membership via `sonicVlanMemberAdd`/`Del`).

They return a result string (the message shown in the terminal); callers detect errors by prefix (`"Invalid…"`, `"Unknown…"`).

## Display helpers
`show*` functions that format read-only output: `showHostIp`/`Route`/`Arp`, `showRouterInterfaceBrief`/`Route`/`RouteRip`/`Arp`/`DhcpBindings`/`Rip`(status)/`RipRoutes`/`RunningConfig`, `showSwitchInterfaces`/`Vlans`/`MacTable`/`RunningConfig` (the switch running-config is emitted as replayable SONiC `config …` commands).

## Terminal UI
- **`openTerminalFor(device)` / `closeTerminal()`** — open/close the panel for a device.
- **`syncTerminal()`** — rebuild the terminal HTML (history + prompt).
- **`submitTerminalCommand()` / `handleTerminalKeydown()`** — handle Enter and up/down history navigation.
- **`terminalLine(kind, text)`** — push a line (used by every command); **`terminalPromptText(device)`** — the prompt string.

## How it fits

The terminal is a major surface area. The dispatchers parse user input and call the mutators/display helpers; the mutators are shared with `inspector.ts` so CLI and GUI edits are consistent. `ping`/`dhcp` build events via `simulation.ts` and start the run via `engine.startSimulation`. The mutators are unit-tested directly, and the dispatchers + mode machine have their own dispatcher test file.
