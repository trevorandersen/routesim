# `src/terminal.ts` — Per-device CLI

The bottom-panel terminal: a per-device command-line that emulates a Linux host shell, an IOS-style router CLI (with a mode state machine), and a managed-switch CLI. It contains three concerns — command **parsing/dispatch**, state **mutation**, and terminal **rendering**.

## Command dispatchers
- **`runTerminalCommand(rawCommand)`** — top-level entry. Reads the active device from `state.terminal.deviceId`, echoes the prompt, and dispatches: routers → `runRouterTerminalCommand`, switches → `runSwitchTerminalCommand`, computers handled inline (`ip addr`, `ip route`, `arp`, `ping`, `dhcp`, `help`, `clear`).
- **`runRouterTerminalCommand(router, command)`** — the IOS-like CLI. Implements a **mode state machine** (`exec → privileged → config → interface/rip`) and the commands within each mode: `enable`, `configure terminal`, `interface <name>`, `ip address`, `encapsulation dot1q`, `ip route`, `router rip` + `network`/`passive-interface`, `show ...`, `exit`/`end`. Decomposed into focused handlers (session/show/interface/RIP/static-route).
- **`runSwitchTerminalCommand(device, command)`** — managed-switch CLI: `show ...`, `config vlan add/del`, `config interface vlan add/remove`, `config interface mode access|trunk`, `config interface trunk native/allowed`. Rejects unmanaged switches.

The current mode and interface selection live on `state.terminal` (`mode`, `interfacePeerId`, `interfaceVlanTag`).

## State mutators
Pure-ish functions that change device config, `pushUndo`, and re-sync — reused by both the CLI **and** the inspector UI:
- Host: `setHostIp`, `flushHostIp`, `setHostGateway`.
- Router: `setRouterInterfaceIp`, `clearRouterInterfaceIp`.
- Switch: `addSwitchVlan`, `removeSwitchVlan`, `setSwitchPortVlan`, `setSwitchPortMode`, `setSwitchTrunkNative`, `modifySwitchTrunkAllowed`.

They return a result string (the message shown in the terminal); callers detect errors by prefix (`"Invalid…"`, `"Unknown…"`).

## Display helpers
`show*` functions that format read-only output: `showHostIp`/`Route`/`Arp`, `showRouterInterfaceBrief`/`Route`/`Arp`/`DhcpBindings`/`Rip`/`RipDatabase`/`RunningConfig`, `showSwitchInterfaces`/`Vlans`/`MacTable`/`RunningConfig`.

## Terminal UI
- **`openTerminalFor(device)` / `closeTerminal()`** — open/close the panel for a device.
- **`syncTerminal()`** — rebuild the terminal HTML (history + prompt).
- **`submitTerminalCommand()` / `handleTerminalKeydown()`** — handle Enter and up/down history navigation.
- **`terminalLine(kind, text)`** — push a line (used by every command); **`terminalPromptText(device)`** — the prompt string.

## How it fits

The terminal is a major surface area. The dispatchers parse user input and call the mutators/display helpers; the mutators are shared with `inspector.ts` so CLI and GUI edits are consistent. `ping`/`dhcp` build events via `simulation.ts` and start the run via `engine.startSimulation`. The mutators are unit-tested directly, and the dispatchers + mode machine have their own dispatcher test file.
