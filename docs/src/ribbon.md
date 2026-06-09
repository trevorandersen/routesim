# `src/ribbon.ts` — Tabbed ribbon

The MS-Office-style ribbon: a row of tabs (**File · Edit · View · Simulate · Scenarios · Help**) that swap a strip of grouped buttons below them. Replaces the old top bar + left tool rail.

## Key exports

- **`setupRibbon()`** — called from `setupUI()`. Wires tab switching: clicking a `.ribbon-tab` toggles the matching `.ribbon-panel` active and deactivates the others. Activating the Scenarios tab re-renders its scenario buttons (so imported scenarios appear).
- **`renderScenarioButtons()`** — (re)builds the Scenarios-tab "Load" buttons from the `SCENARIOS` registry (scenarios.ts). Called after a scenario import.

## How it fits

The ribbon is **markup-driven**: `template.html` holds the tabs and panels, and individual buttons carry data attributes that `ui.ts` wires by delegation:

- `data-tool` → `setTool` (the drawing tools, folded into the Edit tab).
- Built-in topologies load from the **Topologies `<select>`** (`#topologySelect` → `loadTopology`, File tab).
- `data-scenario` → `loadScenario` (dynamic, Scenarios tab).
- `data-theme-id` → `setTheme` (View tab; the three theme buttons).
- `data-action` → a small action map in `setupUI` (new/undo/delete, import-*/export-* via `io.ts`, panel toggles, fit, scenario check/dismiss, help).

A few buttons keep ids because sync functions read them (`undoButton`, `terminalOpenButton`/`consoleButton`/`inspectorOpenButton` for aria, `simPlayPause`/`simStep`/`simStop`/`simSpeed`). The theme buttons are looked up by `[data-theme-id]` (`dom.themeButtons`) so the active one can be highlighted. `ribbon.ts` itself only owns tab switching and the scenario-button rendering; all click behaviour lives in `ui.ts`.

The Edit/View/Simulate/Scenarios tabs surface the drawing tools, panel toggles + display options + theme, the simulation controls, and scenario load/check. The mode label and zoom readout sit on the tab row; the bottom-right cursor/selected-device coordinate readout is `#coordReadout` (see [ui.md](ui.md)).
