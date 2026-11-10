# `src/state.ts` — Global state, undo, callback registry

The heart of the app. Holds the single mutable `state` object, the cross-module callback registry, the undo system, and static data (tool copy, colours, device icons, built-in topologies).

## Key exports

### The state singleton
- **`state: AppState`** — one mutable object holding everything: `devices`, `links`, `configStore`, selection (`selectedId`, `selectedLinkId`, `configuringId`), the active `tool`, view transform (`pan`, `scale`), interaction state (`drag`, `panDrag`, `pointer`, `inspectorResize`, `portSelection`), display `options`, `theme`, the `undoStack`, the `simulation` sub-state, and the dock/terminal model — `terminalSessions` (one `TerminalSession` per open device CLI, in tab order), `terminal` (the active session pointer all CLI handlers write to), `dock` (`open`/`activeTab`/`height`/`logView`/`logFilter`/`captureView`/`compareBaseId` — the packet-list display filter and multi-run capture view), `savedCaptures` (archived completed runs, for the side-by-side compare), and `console`.

### Terminal sessions
- **`freshTerminalSession(deviceId)`** — a blank session (empty scrollback/history, exec mode).
- **`dropTerminalSessions(deviceIds | null)`** — drop the sessions for deleted devices (or all of them on a topology load), repairing the active pointer and closing the dock when the terminal tab empties.

### Callback registry
- **`registerCallbacks(cb)` / `sync()`** — the bridge that lets any module call `sync().render()`, `sync().syncPanel()`, `sync().syncTerminal()`, `sync().resizeCanvas()` without importing `canvas.ts`/`inspector.ts`/`terminal/`. Wired in `app.ts`; no-op'd in tests. See [architecture.md](../architecture.md).

### Undo system
- **`networkSnapshot()`** — deep-copies only the persistent network (`devices`, `links`), stripping transient data like per-link frame history, so snapshots stay small.
- **`pushUndo()` / `pushUndoSnapshot(snap)`** — push the current (or a pre-captured) snapshot onto an 80-deep stack.
- **`captureUndoOnFocus(input)`** — used by the inspector: captures a snapshot when a text field gains focus, so a whole edit is one undo step (not one per keystroke).
- **`captureUndoOnFocusWithin(container, selector)`** — the delegated form, bound once on a stable container through the bubbling `focusin`/`focusout`, so it covers inputs the container re-renders (the router interface rows).
- **`restoreSnapshot()` / `undo()`** — pop and apply; `syncUndoButton()` toggles the toolbar button's enabled state.

### Static data
- **`toolCopy`** — per-tool label + hint strings shown in the header.
- **`colors`** — shared palette names used by `canvas.ts`. (Per-device icon paths live in `device-registry.ts` as `DEVICE_SPECS[type].iconPaths`.)
- **`defaultConfig`, `vlanRoasConfig`, `routerMeshConfig`** — the three built-in topologies offered in the topology chooser (Basic Network, VLAN Router-on-a-Stick, 5-Router Partial Mesh).

## How it fits

Almost every module imports `state`. Mutations are made directly on `state.*`; the convention is to follow a mutation with the appropriate `sync().*()` call (and `pushUndo()` first if it's an undoable edit). Reassigning `state.devices`/`state.links` (rather than mutating in place) is what the `devices.ts` lookup indexes detect to invalidate themselves.

## Notes

- `state` mixes persistent and transient data deliberately — the undo system, not the type, decides what's persistent (via `networkSnapshot`).
- The built-in topology objects here are raw (un-normalised); they pass through `normaliseConfig` before being applied.


## Undo can be refused: `undoBlockReason()`

`undo()` and `redo()` return without acting while `undoBlockReason()` is non-null. Today the one cause is the tutorial (`state.tutorialActive`): its single undo snapshot is the only copy of the learner's network, so the stack is frozen until it exits (see [tutorial.md](tutorial.md)). Callers that report to the user — the console's `undo`/`redo`, the keyboard shortcut — ask for the reason and show it rather than failing silently.

## Lifecycle: an active run is torn down before the topology is replaced

`SyncCallbacks` carries **`stopSimulation`** — the engine's own run teardown (animation loop, boot queue, transport pill, queues, conntrack), bridged because `state.ts` cannot import `engine.ts`. **`undo()` and `redo()`** call it first when a run is running or paused (`cancelActiveRun`). The hand-rolled block `undo` used to carry stopped the *status* but not the animation loop, the boot queue, or the transport pill — and `redo` had no guard at all (reproduced: redo mid-run left a transit in flight over a replaced topology). Note that starting an animated run pushes an undo entry of its own (so the tables a run learns can be undone — except a network-boot run: `startNetworkBoot` pushes one entry for the whole Play press, not one per booted host) and, like any push, clears the redo stack — so redo-during-a-run is unreachable through the UI; the guard is defence.

## Derived-state invalidation: `linksChanged`

A bridge's MAC table is learnt state derived from the cabling it was learnt over, so it is invalidated whenever that cabling changes (review R1). **`linksChanged(deviceIds?)`** is the one hook for "the cabling changed": it calls **`flushLearnedMacs(deviceIds)`**, then the `recomputeStp` bridge (spanning tree + render). It is fired from every link-change site — `addLink`, `deleteLink`, `toggleLinkShutdown`, `deleteSelection` (the removed device's neighbours) ([devices.ts](devices.md)), the `shut`/`noshut` console commands, the link inspector's shut toggle — and with no ids from `restoreSnapshot` (undo/redo). LAN collapse/expand do **not** fire it: collapse hides cables, it doesn't unplug them (review R4); `applyConfigWithoutUndo` ([config.ts](config.md)) calls `flushLearnedMacs()` directly beside its own STP convergence.

- **Why every entry, not just the changed port.** Implicit ports are numbered densely, so removing one cable renames every later port on that switch; and a host moved to another switch is still "behind" the old port on every bridge in between. Hosts' ARP caches stay warm, so no broadcast would re-learn it — the frame used to be dropped as "dest port is ingress" or misdelivered.
- **Which bridges.** A BFS from the given devices over every link (shut and hidden included — over-flushing costs one flood, under-flushing strands unicast), stopping at routers and the internet cloud (the same L3 boundary `l2Reachable` uses). This mirrors a real topology-change flush (802.1D TCN shortens ageing across the broadcast domain; 802.1w TC flushes). Omit `deviceIds` to flush every bridge.
- **What is kept.** Only learnt `DYNAMIC` entries go; `STATIC` entries are configuration. A device with no table (hub, internet cloud) is untouched.
- **Backstop.** `processAtSwitch` treats an entry naming a port with no cable as stale — forgets it, logs why, and floods as unknown unicast ([engine.md](engine.md)).

Covered by `tests/mac-flush.test.ts`; benchmarked as `flushLearnedMacs — 30 switches`.

**`restoreSnapshot`** now drops terminal sessions whose device the restored topology lacks (`dropTerminalSessions` with just those ids), so undoing an add cannot leave a tab — or the active terminal — pointing at a vanished device. `tests/lifecycle.test.ts` pins all of this with `diagnoseState`.
