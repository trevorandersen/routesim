# `src/inspector.ts` — Right panel (device config & link history)

Builds the right-hand inspector panel: device configuration forms, the device list, link frame history, and display options. Like the rest of the UI it rebuilds HTML imperatively into `dom.detailsPanel` and re-binds event handlers each sync.

## Key exports

### Panel orchestration
- **`renderFramePanel(frame)`** — the click-a-packet view: a full field table (Ethernet/ARP/IPv4/ICMP/TCP/DNS/DHCP) for a transit dot clicked mid-flight or a packet-list row; shown while `state.inspectedFrame` is set (the simulation pauses on capture). A packet-list row additionally sets `state.inspectedCapture`, which cross-links the canvas (its wire + endpoints glow — see [canvas.md](canvas.md)); the frame-panel Close clears both. The EtherType row labels the control sentinels `0x888e` (802.1X / EAPOL / 802.11) and `0x0802` (Spanning Tree / BPDU), and the payload table dispatches on `payload.type` for `dot11` (802.11 subtype + SSID), `dot1x` (802.1X subtype + identity), and `bpdu` (Configuration/TCN flavour, root/sending bridge id, root path cost, sending port). This also fixed a latent bug where `dot11`/`dot1x` frames fell through to the IPv4 branch and mis-rendered as IPv4.
- **`syncPanel()`** — the entry point. Rebuilds the panel for the current selection: a link (editable name — empty reverts to the derived default — an **admin-status** shut toggle, **bandwidth/latency/loss** number fields, a **Delete link** button, and the frame history), nothing, or a device. Every panel opens with `panelHeading(title)` — the title (Selection/Configure/Link/Frame) plus the inspector close button, on one line and sticky at the top, so the close affordance stays in line with the heading as the panel scrolls. For a device it emits the name field, a **Terminal** button (CLI devices), a compact **Power / Delete** button row, then type-specific config fields, and wires all the inputs/buttons. Called via `sync().syncPanel()` whenever selection or config changes.
- **`syncDeviceList()`** — rebuilds the network device list (each row selects its device).

### Render helpers (return HTML strings)
- **`renderSwitchPorts(device)`** — per-port rows for a managed switch with an access/trunk **mode dropdown** and an **access-VLAN** or **trunk-native-VLAN** dropdown; unmanaged switches get a simpler peer/remove row. When spanning tree is on, each port also carries a **Root/Desig/Block** badge from `config.stp.ports[iface]` (`role`/`state`) — a `blocking` port reads "Block".
- **`renderSwitchVlans(device)`** — the VLAN list (a chip per VLAN with remove) plus an "Add VLAN" control.
- **`renderRouterInterfaces(device)`** — router interface rows, each stacked two lines: the interface name + peer name on top (peer right-aligned, ellipsised), the editable `address/prefix` input full-width below (a bare address keeps the prefix; the subnet shows as the tooltip). Stacking avoids the cramped horizontal layout that overlapped at narrow inspector widths. A **connected** port carries a `×` **unlink** button (deletes that port's cable, keeping the router selected); an **unconnected** port reads "not connected" (greyed) and still accepts an address — persisted by interface name via `routerInterfaceForName` ([devices.md](devices.md)), keyed by peer once a cable exists.
- **`renderDnsmasqSection(device)`** — the server's service panel: dnsmasq daemon state (start/stop), DNS A-records (add/remove), the DHCP range/router-option fields, a **RADIUS users** editor (identity/password add/remove for the 802.1X back end), and a **listening TCP ports** field (comma-separated, 1–65535). `bindDnsmasqControls` wires them all.
- **`renderStpSection(device)`** — the managed-switch **Spanning-tree** section: an **Enabled** toggle, a **bridge priority** field (0–61440, step 4096, default 32768), and a one-line **status** (disabled / "this switch is the root bridge" / `root <id> · path cost <n>` from the derived `config.stp.bridgeId`/`rootId`/`rootCost`). See [stp.md](stp.md).
- **`renderMirrorSection(device)`** — the managed-switch **SPAN (port mirroring)** section: a **monitor-port dropdown** that picks the session destination from the switch's interfaces (a blank option turns mirroring off). Writes `config.mirror` (sources empty = mirror every port — see [ids.md](ids.md)). Only managed switches carry it.
- **`renderIdsSection(device)`** — the IDS sensor's panel: a **`local.rules` textarea** (`config.idsRules`, one raw Snort line per row) plus the **alert log** (`config.alerts`, the runtime fast-alert lines — not serialised) with a **Clear** button. See [ids.md](ids.md).
- **`renderArpTable`, `renderMacAddressTable`** — read-only tables.

### Binding & misc
- **`bindSwitchPortControls(device)`** — wires the VLAN/mode dropdowns and add/remove buttons to the `terminal/` mutators (`setSwitchPortVlan`/`setSwitchPortMode`/`setSwitchTrunkNative`/`add`/`removeSwitchVlan`), which `pushUndo` and re-sync.
- **`bindStpControls(device)`** — wires the Spanning-tree enable toggle and bridge-priority field to `setSwitchStp`, which `pushUndo` and reconverges (the `recomputeStp` callback re-runs `runStpConvergence` — see [stp.md](stp.md)).
- **`bindMirrorControl(device)`** — wires the monitor-port dropdown to `setSwitchMirror` ([terminal/switch.ts](terminal.md)), which `pushUndo` and re-syncs (a blank selection clears the session).
- **`bindIdsControls(device)`** — wires the `local.rules` textarea (commits the edited rule lines into `config.idsRules`) and the alert-log **Clear** button (empties `config.alerts`), each `pushUndo` and re-sync.
- **`bindPortRemoveButtons`** — wires the per-port link-remove buttons.
- **Options & layout** — `syncOptionControls`, `syncNetworkPanel`, `setNetworkPanel`, `toggleDisplayOptions`, plus the inspector-resize drag handlers (`setInspectorWidth`, `start`/`move`/`stopInspectorResize`).

## Behaviour notes

- **Config shows on selection** for all device types (selecting a device reveals its editable config — IP/MAC for computers, ports/VLANs for switches, interfaces for routers). The Configure tool/double-click select too, and additionally auto-open the device's terminal when it has one (the `openTerminal` callback, gated by `canOpenTerminal`).
- **Host IPv4 fields show and accept `address/prefix`** (a bare address keeps the existing prefix), with the derived subnet displayed live beneath the field (`refreshSubnetNote`). A pill beside the label shows the **address source** — `static` / `DHCP` / `APIPA`, or `unassigned` when there's none (`ipSourceInfo`/`config.ipSource`; a bare IP with no recorded source reads as static). When unassigned the field placeholder reads `0.0.0.0`. Hosts also expose a **DNS nameserver** field (`config.dnsServerIp`, the `/etc/resolv.conf` equivalent).
- The **power button** on hosts toggles power state only — an unconfigured host stays "unassigned" until the simulation is started (Play boots it via animated DHCP — see [engine.md](engine.md)).
- A host's **IP / gateway / DNS / MAC** fields don't mutate config directly — committing one (blur/Enter), or a clear/random button, runs the matching device-CLI command via `terminal.runDeviceCommand` (e.g. `ip addr add 10.0.0.5/24 dev eth0`). The command appears in the host's terminal flagged **`injected`** (dark-grey styling — simulator-issued), validates server-side (no client-side clipping — an invalid value shows the command's error), and the command's mutator pushes undo + re-syncs.
- Other text inputs call `captureUndoOnFocus` so the whole edit is one undo step.
- All dynamic values (device/interface/VLAN names) are passed through `escapeHtml` before insertion.

## How it fits

`inspector.ts` reads `state` (selection + config), mutates config directly (or via `terminal/` mutators for VLAN edits), and re-renders. It reuses `devices.ts` interface enumeration (`switchInterfacesWithNames`, `routerInterfacesWithNames`), `frame.ts` for link history rendering, and `normalise.ts` for VLAN data. Its render helpers are unit-tested for the expected HTML.
