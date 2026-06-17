# `src/devices.ts` — Device/link CRUD, lookups, LAN grouping

Owns the device and link collections: creating, deleting, hit-testing, looking up, enumerating ports/interfaces, and the LAN collapse/expand feature. Also hosts the port-selection modal and a callback bridge back to the UI.

## Key areas

### CRUD
- **`addDevice(type, x, y, name?)`** — creates a device with a default config (`defaultDeviceConfig`) and auto-generated name (`PC-1`, `SW-1`, `RTR-1`), selects it, returns it.
- **`addLink(fromId, toId, fromPort?, toPort?)`** — connects two devices, optionally on specific ports. Hosts (computer/server) model a **single NIC** and refuse a second cable (the `hostNicTaken` guard; the ribbon status line explains). Loaded topologies are unaffected — `normalise`/`applyConfig` build links directly. A new cable fires the **`linkUp`** callback so an unconfigured host can boot (DHCP → APIPA — see [engine.md](engine.md)).
- **`deleteLink(linkId)`** — remove a single link (undoable; clears the link selection). Backs the inspector's **Delete link** button.
- **`placeToolDevice(tool, x, y)` / `PLACEMENT_TOOLS`** — place the device for a drawing tool, resolving UI variants to real types: `managed-switch` (a Switch-group tool variant) becomes a `switch` with `config.managed = true`. `PLACEMENT_TOOLS` is the set the canvas treats as device-placement tools.
- **`deleteSelection()` / `clearNetwork()`** — remove the selected device (and its links) or the selected link / wipe the topology.
- **`linkName(link)`** — a link's display name: the user-given `link.name` if set, else the derived endpoint combo (`"PC1 ↔ SW"`), which follows device renames. Used by the packet list's Link column, `list links`, and the link inspector.
- **Admin status** — a link may be `shutdown` (administratively down): it stays in the topology but the engine's traffic chokepoints (`findFirstHop`/`l2Reachable` in simulation.ts, the transit creation in engine.ts) skip it. **`toggleLinkShutdown(linkId)`** flips it (and selects the link) — the canvas double-click path; the link inspector toggle and the `shut`/`noshut` console commands set it too. Round-trips through config.

### Hit testing
- **`findDeviceAt(point)` / `findLinkAt(point)`** — translate a canvas coordinate to the device/link under it (used by `ui.ts` pointer handling).

### Lookups (with lazy indexes)
- **`getDevice(id)`** — O(1) lookup via a `Map` index.
- **`linksFor(id)`** — all links touching a device, via a `Map<deviceId, Link[]>` adjacency index.
- **`connectedIds(id)`, `linkedDevicesFor(id)`, `linkedPortsFor(id)`** — neighbours and per-port peer resolution, built on `linksFor`.
- **`isVisibleDevice(device)`** — type guard for "defined and not hidden".

> **Performance:** both indexes are **lazily rebuilt** when `state.devices`/`state.links` change, detected by an array **identity + length** guard (`ref !== state.devices || len !== state.devices.length`). No invalidation calls are needed at mutation sites because every add/remove either reassigns the array or pushes. In-place field changes (config, `hidden`, port number) are visible through the cached object references — which is why the adjacency stores **all** links and callers filter `hidden` themselves. These paths are benchmarked (`getDevice`, `linkedPortsFor`, `connectedIds`).

### Interface enumeration
- **`routerInterfacesWithNames`, `routerInterfaceFor`, `routerInterfaceByName`** — resolve a router's interfaces (including VLAN sub-interfaces) to names like `Ethernet1`. Connected ports key by peer id; unconnected ports surface a saved by-name config when one exists.
- **`routerInterfaceForName(router, name)`** — find/create the config entry for an **unconnected** port (keyed by name, e.g. `Ethernet3`), so a pre-assigned IP persists before any cable exists (`normaliseRouterInterfaces` keeps it because it has a name). Once a cable occupies the port, the by-peer entry takes over.
- **`switchInterfacesWithNames`** — a switch's ports with their VLAN/mode/peer, named `Ethernet1..N`. Port numbers derive from link order (see [testing.md](../testing.md)).

### LAN grouping
- **`collapseLan` / `expandLan` / `collectLanMembers`** — collapse a switch and its hosts into a single "LAN" cloud node and back. Collapsing sets `hidden`/`collapsedBy` on members in place.

### Port-selection modal & callback bridge
- **`openPortSelectionModal`, `syncPortSelectionModal`, `confirmPortSelection`, `cancelPortSelection`** — when connecting to a multi-port device, prompt for the specific port (computers auto-select).
- **`registerDeviceCallbacks({ setTool, setNetworkPanel, linkUp, openTerminal })`** — lets `devices.ts` trigger UI/engine work without importing `ui.ts`/`engine.ts`/`terminal/`: `setTool`/`setNetworkPanel` (UI changes after CRUD), `linkUp` (first-boot autoconf when a cable comes up), `openTerminal` (open a device's CLI). Wired in `app.ts`; tests register the pieces they need.
- **`configureDevice(device)`** — selects a device, shows its config, and **reverts to the select tool** (configuring is a one-shot action, not a sticky mode — so the configure tool is single-use and double-clicking from any tool lands back in select). Also fires `openTerminal` — which `app.ts` gates on `canOpenTerminal` (see [terminal.md](terminal.md)), so configuring a CLI device auto-opens its terminal while unmanaged switches/LANs just show their config.

## How it fits

The data layer beneath the UI: `canvas.ts` renders `state.devices`/`state.links`, `ui.ts` calls the CRUD/hit-testing functions on pointer events, and `engine.ts`/`simulation.ts` traverse the topology through `getDevice`/`linksFor`/`linkedPortsFor`. The lookup indexes here are the single biggest steady-state performance lever.
