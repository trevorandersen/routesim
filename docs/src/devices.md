# `src/devices.ts` — Device/link CRUD, lookups, LAN grouping

Owns the device and link collections: creating, deleting, hit-testing, looking up, enumerating ports/interfaces, and the LAN collapse/expand feature. Also hosts the port-selection modal and a callback bridge back to the UI.

## Key areas

### CRUD
- **`addDevice(type, x, y, name?)`** — creates a device with a default config (`defaultDeviceConfig`) and auto-generated name (`PC-1`, `SW-1`, `RTR-1`, `RT-1`), selects it, returns it. Hosts get a MAC on creation — the set includes both offensive hosts: the hand-driven **Kali PC** (`kali`) and the autonomous **Red Team actor** (`attacker`). See [red-team.md](red-team.md).
- **`addLink(fromId, toId, fromPort?, toPort?)`** — connects two devices, optionally on specific ports. Hosts (computer/server), the passive **IDS** sensor, and both offensive hosts (the **Kali PC** `kali` and the **Red Team actor** `attacker`) model a **single NIC** and refuse a second cable (the `hostNicTaken` guard; the ribbon status line explains). Loaded topologies are unaffected — `normalise`/`applyConfig` build links directly. A new cable fires the **`linkUp`** callback so an unconfigured host can boot (DHCP → APIPA — see [engine.md](engine.md)).
- **`deleteLink(linkId)`** — remove a single link (undoable; clears the link selection). Backs the inspector's **Delete link** button.
- **`placeToolDevice(tool, x, y)` / `PLACEMENT_TOOLS`** — place the device for a drawing tool, resolving UI variants to real types: `managed-switch` (a Switch-group tool variant) becomes a `switch` with `config.managed = true`; `border-router` (a Router-group variant) becomes a `router` with `config.role = "border"` and a `Border-N` name (the edge archetype — a "B" badge, the natural place for NAT + a firewall; the plain `router` tool is an internal/core router with no role; the role is editable via the inspector Role select or the `role <router> border|internal` console command, and round-trips through JSON + the script export). The Router group's **Internet** entry places the `internet` cloud — a real `DeviceType` (so it falls through to `addDevice`, no preset), an **L3 transit** (`processAtInternet`) representing the public internet that routes between connected routers (each on its own public subnet) by destination, presenting a default gateway to each. `PLACEMENT_TOOLS` is the set the canvas treats as device-placement tools; it includes both offensive hosts — the **Kali PC** (`kali`, a Computer split-group tool alongside Client PC/Laptop, shortcut `K`) and the **Red Team actor** (`attacker`, a Security split-group tool alongside Firewall/IDS, shortcut `A`). Each places an ordinary single-NIC host (it has an IP/MAC/ARP cache, answers ARP, can be pinged — the attack logic lives in the engine, see [red-team.md](red-team.md)). Both also take a hostname (`hasHostname` includes `kali` and `attacker`).
- **`deleteSelection()` / `clearNetwork()`** — remove the selected device (and its links) or the selected link / wipe the topology.
- **`linkName(link)`** — a link's display name: the user-given `link.name` if set, else the derived endpoint combo (`"PC1 ↔ SW"`), which follows device renames. Used by the packet list's Link column, `list links`, and the link inspector.
- **Admin status** — a link may be `shutdown` (administratively down): it stays in the topology but the engine's traffic chokepoints (`findFirstHop`/`l2Reachable` in simulation.ts, the transit creation in engine.ts) skip it. **`toggleLinkShutdown(linkId)`** flips it (and selects the link) — the canvas double-click path; the link inspector toggle and the `shut`/`noshut` console commands set it too. Round-trips through config.

### Hit testing
- **`findDeviceAt(point)` / `findLinkAt(point)`** — translate a canvas coordinate to the device/link under it (used by `ui.ts` pointer handling).

### Lookups (with lazy indexes)
- **`getDevice(id)`** — O(1) lookup via a `Map` index.
- **`linksFor(id)`** — all links touching a device, via a `Map<deviceId, Link[]>` adjacency index.
- **`linkById(id)`** — O(1) link-by-id lookup via a `Map` index on the same lazy (ref, length) signal; replaces per-frame `state.links.find(l => l.id === …)` scans in the engine.
- **`connectedIds(id)`, `linkedPortsFor(id)`** — neighbours and per-port peer resolution, built on `linksFor`.
- **`isVisibleDevice(device)`** — type guard for "defined and not hidden".

> **Performance:** both indexes are **lazily rebuilt** when `state.devices`/`state.links` change, detected by an array **identity + length** guard (`ref !== state.devices || len !== state.devices.length`). No invalidation calls are needed at mutation sites because every add/remove either reassigns the array or pushes. In-place field changes (config, `hidden`, port number) are visible through the cached object references — which is why the adjacency stores **all** links and callers filter `hidden` themselves. These paths are benchmarked (`getDevice`, `linkedPortsFor`, `connectedIds`, `linkById`).

### Interface enumeration
- **`routerInterfacesWithNames`, `routerInterfaceFor`, `routerInterfaceByName`** — resolve a router's interfaces (including VLAN sub-interfaces) to names like `Ethernet1`. Connected ports key by peer id; unconnected ports surface a saved by-name config when one exists. Every normalise pass here passes the **router id** so `generateRouterIfaceMac` seeds per router (omitting it once made every console-built router share `02:00:00:00:0i:01` MACs), and `routerInterfaceFor`/`routerInterfaceForName` **re-normalise after creating an entry**, so a new interface carries its deterministic MAC and empty tables from birth — no window where an ARP reply could leak an undefined MAC.
- **`routerInterfaceForName(router, name)`** — find/create the config entry for an **unconnected** port (keyed by name, e.g. `Ethernet3`), so a pre-assigned IP persists before any cable exists (`normaliseRouterInterfaces` keeps it because it has a name). Once a cable occupies the port, the by-peer entry takes over.
- **Identity invariant (pinned by `tests/devices.test.ts`):** interface **names are positional** — derived from link order, so removing an earlier link renumbers later ports (`Ethernet2` → `Ethernet1`) — while interface **config keys on the peer** and follows it through any renumbering (IP, `natRole`, sub-interfaces are safe). The caveat: anything that references an interface **by name** (`rip.passiveInterfaces`, a saved by-name entry for an unconnected port) does *not* follow a renumbering — re-cabling can silently detach such references. Prefer peer-keyed state for new features.
- **`switchInterfacesWithNames`** — a switch's ports with their VLAN/mode/peer, named `Ethernet1..N`. Port numbers derive from link order (see [testing.md](../testing.md)).

### LAN grouping
- **`collapseLan` / `expandLan` / `collectLanMembers`** — collapse a switch and its hosts into a single "LAN" cloud node and back. Collapsing sets `hidden`/`collapsedBy` on members in place.

### Port-selection modal & callback bridge
- **`openPortSelectionModal`, `syncPortSelectionModal`, `confirmPortSelection`, `cancelPortSelection`** — the manual port picker, opened only when the user **Shift-clicks** the second device with the Connect tool. A plain Connect click skips it and calls `addLink`, which resolves the first free port on each end; the modal also auto-links host↔host / wireless pairs that have nothing to pick. The single-NIC host branch of `buildPortList`/`openPortSelectionModal` now covers both offensive hosts — `kali` and `attacker` (the latter previously fell through and showed an empty, un-confirmable column).
- **`registerDeviceCallbacks({ setTool, setNetworkPanel, linkUp, openTerminal })`** — lets `devices.ts` trigger UI/engine work without importing `ui.ts`/`engine.ts`/`terminal/`: `setTool`/`setNetworkPanel` (UI changes after CRUD), `linkUp` (first-boot autoconf when a cable comes up), `openTerminal` (open a device's CLI). Wired in `app.ts`; tests register the pieces they need.
- **`configureDevice(device)`** — selects a device, shows its config, and **reverts to the select tool** (configuring is a one-shot action, not a sticky mode — so the configure tool is single-use and double-clicking from any tool lands back in select). Also fires `openTerminal` — which `app.ts` gates on `canOpenTerminal` (see [terminal.md](terminal.md)), so configuring a CLI device auto-opens its terminal while unmanaged switches/LANs just show their config.

## How it fits

The data layer beneath the UI: `canvas.ts` renders `state.devices`/`state.links`, `ui.ts` calls the CRUD/hit-testing functions on pointer events, and `engine.ts`/`simulation.ts` traverse the topology through `getDevice`/`linksFor`/`linkedPortsFor`. The lookup indexes here are the single biggest steady-state performance lever.


## Teardown order and port bounds

- **`clearNetwork()`** calls the `stopSimulation` device callback **first**, then deletes devices/links, drops sessions and captures, and clears `selectedId`/`selectedLinkId`. Before this the animation loop kept running against deleted devices (status stuck on `running`, a transit pointing at a missing link — `diagnoseState` reported four issues). Engine-owned work reaches devices.ts through the callback bridge because a direct `devices → engine` import would be a cycle.
- **Physical port numbers are bounded** by `MAX_PHYSICAL_PORT` (utils.ts, 64 — a sanity ceiling above every device's real cap). `resolvePort` rejects a requested port above it (falls back to the next free port) and `linkedPortsFor` treats an out-of-range stored port as implicit rather than growing its sparse array to it. The normaliser enforces the same bound on import (see normalise.md); the two later checks are defence in depth.

- **`physicalPeerIds(id)`** — peers over physical cables, *including* those a collapsed LAN has hidden and *excluding* the LAN's proxy links. The persistence layer asks this rather than `connectedIds` (which is the drawn set): collapse is presentation, and a save must not depend on it.
