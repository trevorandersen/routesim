# `src/config.ts` — Topology serialisation & loading

Serialises the live network to a portable payload, applies a payload back to the live `state`, and loads the built-in topologies. There is **no** `config.json`, fetch, or File System Access — file persistence is JSON import/export (see [io.ts](../scripting.md) / [scripting.md](../scripting.md)).

## Serialise & apply
- **`buildConfigPayload()`** — serialises `state.devices` + `state.links` to `{ version, devices, links }`, normalising each device's config and dropping transient data (frame history, RIP `learnedRoutes` — derived state recomputed at each convergence, so only the RIP configuration round-trips). User-given link names round-trip; unnamed links serialise without a `name` key. Used by export and the console `save`.
- **Interface retention is structural, not visual.** `routerInterfacesForPayload` keeps a peer-bound interface when the peer is reachable over a *physical* cable (`physicalPeerIds` — hidden-by-collapse links count, a LAN's proxy links don't). It used to consult `connectedIds`, which excludes hidden links, so saving while a LAN was collapsed silently dropped every router interface facing it — address, prefix, NAT role, tables — and expanding couldn't recover them.
- **Every registered device type has a payload branch**, including `hub` and `internet` (their configurable `ethernetPorts`). An exhaustiveness test iterates `DEVICE_TYPES` and fails the moment a new type is added to the registry without one.
- **`parseConfig(text)`** — parse + `normaliseConfig` a raw JSON string (throws on invalid JSON).
- **`applyConfig(config)` / `applyConfigWithoutUndo(config)`** — stop the current simulation, clear its topology-specific references, replace `state.devices`/`state.links` with a normalised topology, reset selection/interaction state (including `selectedLinkId` — it was the one selection field left dangling), drop all terminal sessions (`dropTerminalSessions`), recompute name counters, fit the view, and re-render. `applyConfig` pushes an undo point first; both clear any active scenario.

## Loading built-ins
- **`loadDefaultConfig()`** — startup: `applyConfigWithoutUndo(normaliseConfig(defaultConfig))` (the Basic Network). No network request.
- **`loadTopology(name)`** — load one of the three built-in topologies (`defaultConfig`/`vlanRoasConfig`/`routerMeshConfig` from `state.ts`); wired to the File-tab Topologies `<select>`.

## How it fits

`config.ts` is the bridge between topology data and the live `state`. It leans on `normalise.ts` (so untrusted JSON becomes well-formed), `state.ts` (built-in topologies + undo), and the `sync()` callbacks to refresh the UI. `io.ts` calls `buildConfigPayload`/`parseConfig`/`applyConfig` to export/import topology JSON; the console `save`/`load` commands use the in-memory `state.configStore`.
