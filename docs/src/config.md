# `src/config.ts` — Persistence & topology loading

Loads and saves topologies. A "config store" (`{ version, configs: { name → topology } }`) is persisted as `config.json`; this module reads it (from an embedded block, a fetch, or a file picker), applies a chosen topology to the live `state`, and writes it back.

## Loading
- **`loadDefaultConfig()`** — startup load (called from `app.ts`): refreshes the store, ensures a `default` config exists, and applies it.
- **`refreshConfigStore(pickIfNeeded?)`** — populates `state.configStore`, in priority order: a previously-picked file handle → an **embedded** store (`readEmbeddedConfigStore`) → a `fetch("./config.json")` → (optionally) a file picker.
- **`readEmbeddedConfigStore()`** — parses the JSON inlined in `<script id="embeddedConfig">` (present only in `rs-web.html`), returning a normalised store or `null` when absent/empty/invalid. This is what makes the web build a self-contained single file with no runtime requests.
- **`loadConfig()`** — user-facing: refresh, prompt for a config name, apply it.
- **`loadTopology(name)`** — load one of the three built-in topologies (`defaultConfig`/`vlanRoasConfig`/`routerMeshConfig` from `state.ts`).

## Applying
- **`applyConfig(config)` / `applyConfigWithoutUndo(config)`** — replace `state.devices`/`state.links` with a (normalised) topology, reset selection/terminal/interaction state, recompute device-name counters, fit the view, and re-render. `applyConfig` pushes an undo point first.
- **`parseConfig(text)`** — parse + normalise a raw JSON string.

## Saving
- **`saveConfig()`** — user-facing: in read-only builds (`READONLY`) it no-ops with a message; otherwise it prompts for a name, builds the payload, and persists.
- **`buildConfigPayload()`** — serialises the current network (devices + links) to the on-disk shape, normalising each device's config and trimming transient data.
- **`persistConfigStore(payload)`** — writes via the **File System Access API** (`showSaveFilePicker` + `createWritable`), caching the handle for subsequent saves; falls back to **`downloadConfigStore`** (a blob download) when the API is unavailable.
- **`readConfigStoreFromHandle`, `routerInterfacesForPayload`, `suggestedConfigName`** — supporting helpers.

## How it fits

`config.ts` connects the file/store world to the live `state`. It leans on `normalise.ts` for every load (so untrusted JSON becomes well-formed), `state.ts` for the built-in topologies and undo, and `devices.ts`/`canvas.ts`/`inspector.ts`/`terminal.ts` (via `sync()` and direct calls) to refresh the UI after applying a config.

## Notes

- The File System Access API requires a secure context (`localhost` or HTTPS) — hence serving via `bun test-server.ts` for local use rather than `file://`.
- Variant behaviour: `rs-main.html` fetches/writes `config.json`; `rs-web.html` reads the embedded store and disables saving. See [build.md](../build.md).
