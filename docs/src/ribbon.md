# `src/ribbon.ts` — Tabbed ribbon

The MS-Office-style ribbon: a row of tabs (**Main · File · View · Help**) that swap a strip of grouped buttons below them. Replaces the old top bar + left tool rail. **Main** is the default tab and the whole build-and-run workflow: the drawing tools, the edit actions (undo/redo/delete/Clear), and the simulation transport (play/step/stop/speed). Scenarios load from a **dropdown** in the File tab, not a tab of their own; goal check/dismiss live on the floating goal banner.

## Key exports

- **`setupRibbon()`** — called from `setupUI()`. Wires tab switching: clicking a `.ribbon-tab` toggles the matching `.ribbon-panel` active and deactivates the others.
- **`renderScenarioOptions()`** — (re)builds the File-tab scenario chooser (`#scenarioSelect`) from the `SCENARIOS` registry (scenarios.ts), so imported scenarios appear. Called at setup and after a scenario import.

## How it fits

The ribbon is **markup-driven**: `template.html` holds the tabs and panels, and individual buttons carry data attributes that `ui.ts` wires by delegation:

- `data-tool` → `setTool` (the drawing tools, on the Main tab). Related device tools are grouped into **split buttons** (`.tool-split`): a face button (`.tool-face`, a `tool-button` whose `data-tool` is the active variant) plus a caret that opens a `.tool-menu` of variants. Groups: **Computer** (Client PC / Server, Client PC default), **Switch** (Basic switch / Managed switch), **Security** (Firewall, room for more), **Legacy** (Hub — a layer-1 repeater, last after Configure). Picking a variant — or a keyboard shortcut — re-points the face via `syncToolGroups` in `ui.ts`, so each group remembers its last choice; the `managed-switch` variant is the switch tool with management on (`placeToolDevice`). The menu is `position: fixed` (the ribbon scrolls horizontally, which would clip an absolute menu) and `ui.ts` anchors it under its caret on open.
- Built-in topologies load from the **Topologies `<select>`** (`#topologySelect` → `loadTopology`, File tab); scenarios load from the **Scenarios `<select>`** (`#scenarioSelect` → `loadScenario`, File tab) — both reset to their placeholder after loading.
- `data-theme-id` → `setTheme` (View tab; the three theme buttons).
- `data-action` → a small action map in `setupUI` (clear/undo/delete, import-*/export-* via `io.ts`, panel toggles, fit, scenario check/dismiss, help).

A few buttons keep ids because sync functions read them (`undoButton`, `terminalOpenButton`/`consoleButton`/`inspectorOpenButton` for aria, `simPlayPause`/`simStep`/`simStop`/`simSpeed`). The theme buttons are looked up by `[data-theme-id]` (`dom.themeButtons`) so the active one can be highlighted. `ribbon.ts` itself only owns tab switching and the scenario-button rendering; all click behaviour lives in `ui.ts`.

Main holds the tools, edit actions, and sim transport; File holds the topology and scenario choosers + import/export; View holds panel toggles + display options + theme + fit. The status line (`#modeLabel` — mode label + transient feedback) and zoom readout sit on the tab row; the bottom-right cursor/selected-device coordinate readout is `#coordReadout` (see [ui.md](ui.md)).
