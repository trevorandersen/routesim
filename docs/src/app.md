# `src/app.ts` — Entry point

The bundle's entry point (esbuild bundles `app.ts` and everything it transitively imports). It has **no exports**; importing it for its side effects boots the application.

## What it does

1. **Wires the callback bridges** so modules can call each other without circular imports:
   - `registerCallbacks({ render, syncPanel, syncTerminal, resizeCanvas })` (from `state.ts`).
   - `registerDeviceCallbacks({ setTool, setNetworkPanel })` (from `devices.ts`).
2. **`setupUI()`** (`ui.ts`) — attaches all DOM event listeners.
3. **`initialiseApp()`** — sizes the canvas, sets the inspector width, centres the pan, applies the dark theme, syncs the panels, then `loadDefaultConfig()` to load the built-in Basic Network. Finishes with `syncPanel()` + `render()`. No network request.

It also exposes the `window.routesim` API (`exec`/`run`/`export`/`snapshot` + the io import/export functions) for automation.

## How it fits

`app.ts` is the only module that knows about *all* the others; it's the composition root. The callback registration here is what makes the rest of the codebase able to stay decoupled (see [architecture.md](../architecture.md)).

## Notes

- Startup is fully synchronous — defaults are compiled in, so there's nothing to fetch.
- Tests never import `app.ts`; they import individual modules and register no-op callbacks instead.
