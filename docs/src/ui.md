# `src/ui.ts` — Event wiring, tools, theme, shortcuts

Wires every DOM event listener and owns the interaction model: tool switching, canvas pointer handling (place/select/drag/connect/pan), the theme toggle, and global keyboard shortcuts.

## Key exports

- **`setupUI()`** — called once from `app.ts`. Calls `setupRibbon()` and attaches all listeners: a delegated handler for ribbon buttons (`data-action`/`data-theme-id`), the drawing tools (`data-tool`), the **Topologies and Scenarios `<select>`s** (`#topologySelect` → `loadTopology`, `#scenarioSelect` → `loadScenario`; both reset to their placeholder), canvas pointer/wheel events, the terminal/console inputs, the **dock** (tab-strip clicks/close buttons, the drag-resize handle, the sim-log Packets/Events toggle, and packet-row clicks — a row opens the frame breakdown and pauses the sim), the inspector resize handle, the sim controls, and the global keydown handler.
- **`updateCoordReadout(world)` / `syncCoordReadout()`** — the bottom-right `#coordReadout`: cursor world coords (from pointermove) + the selected device's coords. `syncCoordReadout` is a registry callback so selection changes refresh it.
- **`setTool(tool)`** — switch the active tool (`select`/`computer`/`server`/`switch`/`router`/`firewall`/`connect`/`configure`), update button states, the mode label/hint, and the cursor, then re-render. Exposed to `devices.ts` via the device-callback bridge.
- **`setTheme(id)` / `toggleTheme()`** — switch the colour theme. Themes are a named registry (`THEMES` in `state.ts`): **Warm Light** (default), **Dark**, **Blueprint**. `setTheme` validates the id (with `light` kept as a back-compat alias for `warm-light`, and an unknown id falling back to the default), writes it to the `<html data-theme>` attribute, highlights the matching ribbon button, **clears the `cssColor` cache** (so themed canvas colours refresh), and re-renders. `toggleTheme` cycles to the next theme in the registry. The app boots in **Warm Light** (`initialiseApp` calls `setTheme("warm-light")`). The three theme buttons carry `data-theme-id` and are handled by the delegated ribbon click handler.
- **`openAbout()` / `closeAbout()`** — the Help → About modal. `openAbout` resets any drag offset so the modal re-centres each time. The modal is **draggable** by its header (`startAboutDrag`/`moveAboutDrag`/`endAboutDrag` via pointer capture, clamped to the viewport) and dismissable via the close button, a backdrop click, or Escape. Modals use a solid per-theme `--modal-bg` background.
- **`handleGlobalKeydown(event)`** — the global keyboard handler (extracted from `setupUI` so it can be unit-tested):
  - `Ctrl/Cmd+Z` → undo; `Ctrl/Cmd+Shift+Z` / `Ctrl/Cmd+Y` → redo.
  - `Escape` → cancel an open port-selection modal, else blur the focused field and revert to the select tool. Handled **before** the input guard so it works even while typing in a field.
  - `Delete`/`Backspace` → delete the selected device or link; `V/C/E/S/R/F/L/W` → tool shortcuts (select/computer/server/switch/router/firewall/connect/configure). These are suppressed while a text input/select/textarea is focused.
- **`pointerFromEvent`, `bindOptionToggle`** — internal helpers for pointer math and display-option checkboxes.

## How it fits

`ui.ts` is the bridge between raw browser events and the app: it reads pointer positions (via `canvas.ts` transforms), calls `devices.ts` for hit-testing and CRUD, mutates `state` (selection, drag, pan), and calls `render()`/`syncPanel()` to reflect changes. It depends on most other modules but is depended on only by `app.ts` (directly) and `devices.ts` (via the callback bridge), keeping the graph acyclic.

## Notes

- `handleGlobalKeydown` is registered by reference in `setupUI`, so the live handler and the unit-tested function are identical.
- Ribbon buttons are wired by a single delegated click handler over `data-action`/`data-theme-id`; the drawing tools use `data-tool`; built-in topologies and scenarios load from their File-tab `<select>`s. Tab switching lives in [ribbon.ts](ribbon.md).
