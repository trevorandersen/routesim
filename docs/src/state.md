# `src/state.ts` — Global state, undo, callback registry

The heart of the app. Holds the single mutable `state` object, the cross-module callback registry, the undo system, and static data (tool copy, colours, device icons, built-in topologies).

## Key exports

### The state singleton
- **`state: AppState`** — one mutable object holding everything: `devices`, `links`, `configStore`, selection (`selectedId`, `selectedLinkId`, `configuringId`), the active `tool`, view transform (`pan`, `scale`), interaction state (`drag`, `panDrag`, `pointer`, `inspectorResize`, `portSelection`), display `options`, `theme`, the `undoStack`, and the `simulation` + `terminal` sub-states.

### Callback registry
- **`registerCallbacks(cb)` / `sync()`** — the bridge that lets any module call `sync().render()`, `sync().syncPanel()`, `sync().syncTerminal()`, `sync().resizeCanvas()` without importing `canvas.ts`/`inspector.ts`/`terminal.ts`. Wired in `app.ts`; no-op'd in tests. See [architecture.md](../architecture.md).

### Undo system
- **`networkSnapshot()`** — deep-copies only the persistent network (`devices`, `links`), stripping transient data like per-link frame history, so snapshots stay small.
- **`pushUndo()` / `pushUndoSnapshot(snap)`** — push the current (or a pre-captured) snapshot onto an 80-deep stack.
- **`captureUndoOnFocus(input)`** — used by the inspector: captures a snapshot when a text field gains focus, so a whole edit is one undo step (not one per keystroke).
- **`restoreSnapshot()` / `undo()`** — pop and apply; `syncUndoButton()` toggles the toolbar button's enabled state.

### Static data
- **`toolCopy`** — per-tool label + hint strings shown in the header.
- **`colors`, `deviceIcons`** — palette names and the SVG path data used by `canvas.ts` to draw device icons.
- **`defaultConfig`, `vlanRoasConfig`, `routerMeshConfig`** — the three built-in topologies offered in the topology chooser (Basic Network, VLAN Router-on-a-Stick, 5-Router Partial Mesh).

## How it fits

Almost every module imports `state`. Mutations are made directly on `state.*`; the convention is to follow a mutation with the appropriate `sync().*()` call (and `pushUndo()` first if it's an undoable edit). Reassigning `state.devices`/`state.links` (rather than mutating in place) is what the `devices.ts` lookup indexes detect to invalidate themselves.

## Notes

- `state` mixes persistent and transient data deliberately — the undo system, not the type, decides what's persistent (via `networkSnapshot`).
- The built-in topology objects here are raw (un-normalised); they pass through `normaliseConfig` before being applied.
