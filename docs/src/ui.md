# `src/ui.ts` — Event wiring, tools, theme, shortcuts

Wires every DOM event listener and owns the interaction model: tool switching, canvas pointer handling (place/select/drag/connect/pan), the theme toggle, and global keyboard shortcuts.

## Key exports

- **`setupUI()`** — called once from `app.ts`. Calls `setupRibbon()` and attaches all listeners: a delegated handler for ribbon buttons (`data-action`/`data-topology`/`data-scenario`), the drawing tools (`data-tool`), canvas pointer/wheel events, the terminal/console inputs, the inspector resize handle, the sim controls, and the global keydown handler.
- **`updateCoordReadout(world)` / `syncCoordReadout()`** — the bottom-right `#coordReadout`: cursor world coords (from pointermove) + the selected device's coords. `syncCoordReadout` is a registry callback so selection changes refresh it.
- **`setTool(tool)`** — switch the active tool (`select`/`computer`/`switch`/`router`/`connect`/`configure`), update button states, the mode label/hint, and the cursor, then re-render. Exposed to `devices.ts` via the device-callback bridge.
- **`setTheme(theme)` / `toggleTheme()`** — switch dark/light. `setTheme` sets the `data-theme` attribute, **clears the `cssColor` cache** (so themed colours refresh), and re-renders.
- **`handleGlobalKeydown(event)`** — the global keyboard handler (extracted from `setupUI` so it can be unit-tested):
  - `Ctrl/Cmd+Z` → undo.
  - `Escape` → cancel an open port-selection modal, else blur the focused field and revert to the select tool. Handled **before** the input guard so it works even while typing in a field.
  - `Delete`/`Backspace` → delete selection; `V/C/S/R/L/W` → tool shortcuts. These are suppressed while a text input/select/textarea is focused.
- **`pointerFromEvent`, `bindOptionToggle`** — internal helpers for pointer math and display-option checkboxes.

## How it fits

`ui.ts` is the bridge between raw browser events and the app: it reads pointer positions (via `canvas.ts` transforms), calls `devices.ts` for hit-testing and CRUD, mutates `state` (selection, drag, pan), and calls `render()`/`syncPanel()` to reflect changes. It depends on most other modules but is depended on only by `app.ts` (directly) and `devices.ts` (via the callback bridge), keeping the graph acyclic.

## Notes

- `handleGlobalKeydown` is registered by reference in `setupUI`, so the live handler and the unit-tested function are identical.
- Ribbon buttons are wired by a single delegated click handler over `data-action`/`data-topology`/`data-scenario`; the drawing tools use `data-tool`. Tab switching lives in [ribbon.ts](ribbon.md).
