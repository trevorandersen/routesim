# `src/devices.ts` — Device/link CRUD, lookups, LAN grouping

Owns the device and link collections: creating, deleting, hit-testing, looking up, enumerating ports/interfaces, and the LAN collapse/expand feature. Also hosts the port-selection modal and a callback bridge back to the UI.

## Key areas

### CRUD
- **`addDevice(type, x, y, name?)`** — creates a device with a default config (`defaultDeviceConfig`) and auto-generated name (`PC-1`, `SW-1`, `RTR-1`), selects it, returns it.
- **`addLink(fromId, toId, fromPort?, toPort?)`** — connects two devices, optionally on specific ports.
- **`deleteSelection()` / `clearNetwork()`** — remove the selected device (and its links) / wipe the topology.

### Hit testing
- **`findDeviceAt(point)` / `findLinkAt(point)`** — translate a canvas coordinate to the device/link under it (used by `ui.ts` pointer handling).

### Lookups (with lazy indexes)
- **`getDevice(id)`** — O(1) lookup via a `Map` index.
- **`linksFor(id)`** — all links touching a device, via a `Map<deviceId, Link[]>` adjacency index.
- **`connectedIds(id)`, `linkedDevicesFor(id)`, `linkedPortsFor(id)`** — neighbours and per-port peer resolution, built on `linksFor`.
- **`isVisibleDevice(device)`** — type guard for "defined and not hidden".

> **Performance:** both indexes are **lazily rebuilt** when `state.devices`/`state.links` change, detected by an array **identity + length** guard (`ref !== state.devices || len !== state.devices.length`). No invalidation calls are needed at mutation sites because every add/remove either reassigns the array or pushes. In-place field changes (config, `hidden`, port number) are visible through the cached object references — which is why the adjacency stores **all** links and callers filter `hidden` themselves. These paths are benchmarked (`getDevice`, `linkedPortsFor`, `connectedIds`).

### Interface enumeration
- **`routerInterfacesWithNames`, `routerInterfaceFor`, `routerInterfaceByName`** — resolve a router's interfaces (including VLAN sub-interfaces) to names like `Ethernet1`.
- **`switchInterfacesWithNames`** — a switch's ports with their VLAN/mode/peer, named `Ethernet1..N`. Port numbers derive from link order (see [testing.md](../testing.md)).

### LAN grouping
- **`collapseLan` / `expandLan` / `collectLanMembers`** — collapse a switch and its hosts into a single "LAN" cloud node and back. Collapsing sets `hidden`/`collapsedBy` on members in place.

### Port-selection modal & callback bridge
- **`openPortSelectionModal`, `syncPortSelectionModal`, `confirmPortSelection`, `cancelPortSelection`** — when connecting to a multi-port device, prompt for the specific port (computers auto-select).
- **`registerDeviceCallbacks({ setTool, setNetworkPanel })`** — lets `devices.ts` trigger UI changes (e.g. switch to select tool after creating a device) without importing `ui.ts`. Wired in `app.ts`.
- **`configureDevice(device)`** — selects a device and switches to the configure tool.

## How it fits

The data layer beneath the UI: `canvas.ts` renders `state.devices`/`state.links`, `ui.ts` calls the CRUD/hit-testing functions on pointer events, and `engine.ts`/`simulation.ts` traverse the topology through `getDevice`/`linksFor`/`linkedPortsFor`. The lookup indexes here are the single biggest steady-state performance lever.
