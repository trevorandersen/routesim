# `src/app.ts` — Entry point

The bundle's entry point (esbuild bundles `app.ts` and everything it transitively imports). It has **no exports**; importing it for its side effects boots the application.

## What it does

1. **Wires the callback bridges** so modules can call each other without circular imports:
   - `registerCallbacks({ render, syncPanel, syncTerminal, resizeCanvas, syncScenarioPanel, syncCoordReadout, syncOptionControls, recomputeStp, syncSimLog, stopSimulation })` (from `state.ts`). `recomputeStp` runs spanning-tree convergence then renders; `stopSimulation` is the engine's run teardown that undo and redo call first.
   - `registerDeviceCallbacks({ setTool, setNetworkPanel, openTerminal, stopSimulation })` (from `devices.ts`) — `openTerminal` opens a device's CLI when `canOpenTerminal` allows (so configuring a CLI device auto-opens its terminal). (Cabling no longer auto-boots a host — that's now `engine.startNetworkBoot`, wired to the Play button.)
2. **`setupUI()`** (`ui.ts`) — attaches all DOM event listeners.
3. **`initialiseApp()`** — sizes the canvas, sets the inspector width, centres the pan, applies the default Warm Light theme (switch to Dark or Blueprint in the View tab), syncs the panels, then `loadDefaultConfig()` to load the built-in Basic Network. Finishes with `syncPanel()` + `render()`. No network request.

It also exposes the `window.routesim` API (`exec`/`run`/`export`/`snapshot`/`diagnose`/`urlSettings`/`settingsQuery`/`shareLink`/`openLink` + the io import/export functions) for automation. Before the first sync it applies any settings from the URL query string (`parseSettingsFromUrl`) and reports unknown keys on the status line. See [architecture.md](../architecture.md) for how the modules it wires fit together.

## How it fits

`app.ts` is the only module that knows about *all* the others; it's the composition root. The callback registration here is what makes the rest of the codebase able to stay decoupled (see [architecture.md](../architecture.md)).

## Notes

- Startup is fully synchronous — defaults are compiled in, so there's nothing to fetch.
- Tests never import `app.ts`; they import individual modules and register no-op callbacks instead.

After the first render `initialiseApp` opens a network carried in the address bar's fragment (`#net=…`, [share-link.md](share-link.md)) and listens for `hashchange`, so a link pasted into an open tab loads too; `openLinkInAddressBar` removes the fragment once the network is in, so a refresh does not load the link again over later work.

Between loading the built-in network and the first render it starts autosave ([autosave.md](autosave.md)): `initAutosave` (baseline + stored preference, or the URL's `autosave` for this visit), `restoreAutosave` (the last session, if any), `startAutosave` (the poll, the page-hide flush, the Settings switch). When a session was restored, a `#net=…` link in the address bar is opened over it as an undo point rather than silently replacing it.
