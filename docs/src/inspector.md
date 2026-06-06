# `src/inspector.ts` — Right panel (device config & link history)

Builds the right-hand inspector panel: device configuration forms, the device list, link frame history, and display options. Like the rest of the UI it rebuilds HTML imperatively into `dom.detailsPanel` and re-binds event handlers each sync.

## Key exports

### Panel orchestration
- **`syncPanel()`** — the entry point. Rebuilds the panel for the current selection: a link (frame history), nothing, or a device. For a device it emits the name field plus type-specific config fields and wires all the inputs/buttons. Called via `sync().syncPanel()` whenever selection or config changes.
- **`syncDeviceList()`** — rebuilds the network device list (each row selects its device).

### Render helpers (return HTML strings)
- **`renderSwitchPorts(device)`** — per-port rows for a managed switch with an access/trunk **mode dropdown** and an **access-VLAN** or **trunk-native-VLAN** dropdown; unmanaged switches get a simpler peer/remove row.
- **`renderSwitchVlans(device)`** — the VLAN list (a chip per VLAN with remove) plus an "Add VLAN" control.
- **`renderRouterInterfaces(device)`** — router interface rows with editable IPs.
- **`renderArpTable`, `renderMacAddressTable`** — read-only tables.

### Binding & misc
- **`bindSwitchPortControls(device)`** — wires the VLAN/mode dropdowns and add/remove buttons to the `terminal.ts` mutators (`setSwitchPortVlan`/`setSwitchPortMode`/`setSwitchTrunkNative`/`add`/`removeSwitchVlan`), which `pushUndo` and re-sync.
- **`bindPortRemoveButtons`** — wires the per-port link-remove buttons.
- **Options & layout** — `syncOptionControls`, `syncNetworkPanel`, `setNetworkPanel`, `toggleDisplayOptions`, plus the inspector-resize drag handlers (`setInspectorWidth`, `start`/`move`/`stopInspectorResize`).

## Behaviour notes

- **Config shows on selection** for all device types (selecting a device reveals its editable config — IP/MAC for computers, ports/VLANs for switches, interfaces for routers). The Configure tool/double-click still work but are now equivalent to selecting.
- Editing a text input calls `captureUndoOnFocus` so the whole edit is one undo step.
- All dynamic values (device/interface/VLAN names) are passed through `escapeHtml` before insertion.

## How it fits

`inspector.ts` reads `state` (selection + config), mutates config directly (or via `terminal.ts` mutators for VLAN edits), and re-renders. It reuses `devices.ts` interface enumeration (`switchInterfacesWithNames`, `routerInterfacesWithNames`), `frame.ts` for link history rendering, and `normalise.ts` for VLAN data. Its render helpers are unit-tested for the expected HTML.
