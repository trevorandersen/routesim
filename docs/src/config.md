# `src/config.ts` — Topology serialisation & loading

Serialises the live network to a portable payload, applies a payload back to the live `state`, and loads the built-in topologies. There is **no** `config.json`, fetch, or File System Access — file persistence is JSON import/export (see [io.ts](../scripting.md) / [scripting.md](../scripting.md)).

## Serialise & apply
- **`buildConfigPayload()`** — serialises `state.devices` + `state.links` to `{ version, devices, links }`, normalising each device's config and dropping transient data (frame history). Used by export and the console `save`.
- **`parseConfig(text)`** — parse + `normaliseConfig` a raw JSON string (throws on invalid JSON).
- **`applyConfig(config)` / `applyConfigWithoutUndo(config)`** — replace `state.devices`/`state.links` with a normalised topology, reset selection/terminal/interaction state, recompute name counters, fit the view, and re-render. `applyConfig` pushes an undo point first; both clear any active scenario.

## Loading built-ins
- **`loadDefaultConfig()`** — startup: `applyConfigWithoutUndo(normaliseConfig(defaultConfig))` (the Basic Network). No network request.
- **`loadTopology(name)`** — load one of the three built-in topologies (`defaultConfig`/`vlanRoasConfig`/`routerMeshConfig` from `state.ts`); wired to the File-tab topology buttons.

## How it fits

`config.ts` is the bridge between topology data and the live `state`. It leans on `normalise.ts` (so untrusted JSON becomes well-formed), `state.ts` (built-in topologies + undo), and the `sync()` callbacks to refresh the UI. `io.ts` calls `buildConfigPayload`/`parseConfig`/`applyConfig` to export/import topology JSON; the console `save`/`load` commands use the in-memory `state.configStore`.
