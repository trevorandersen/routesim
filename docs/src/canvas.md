# `src/canvas.ts` — Canvas rendering & view transform

All `<canvas>` drawing and the pan/zoom view transform. The entire scene is redrawn imperatively each frame — there is no scene graph.

## Key exports

### View transform
- **`screenToWorld`** — converts screen pixels to world coordinates given `state.pan`/`state.scale`.
- **`setZoom(scale, anchor)`** — zoom toward a point; **`syncZoomLevel`** updates the readout.
- **`resizeCanvas`** — handle DPR and canvas sizing (re-renders).
- **`fitNetwork`** — auto-pan/zoom so the whole topology is visible.

### The render loop
- **`render()`** — clears, applies the pan/zoom transform, then draws the grid, links, devices, any in-flight transit dots, and — in place mode — the placement ghost. Called directly by interaction code and via `sync().render()` by everything else.
- **`drawLink`, `drawDevice`, `drawIconDevice`, `drawTablerIcon`, `drawManagedBadge`, `drawRootBridgeBadge`, `drawBorderBadge`** — the drawing primitives. Every device body/icon is drawn by `drawIconDevice` from its `DEVICE_SPECS` entry (`device-registry.ts`: size, corner radius, palette var, Tabler `Path2D` paths); a managed switch adds the cog badge (top-right), the spanning-tree root bridge (`isRootBridge`) adds an indigo "R" badge top-left (indigo ties it to the BPDU frame colour), and a **border/edge router** (`config.role === "border"`) adds an amber "B" badge top-right.
- **`findTransitAt(world)`** — hit-tests a click against the in-flight transit dots (click-a-packet inspector); the inspected frame gets a selection ring.
- **Transits through a collapsed LAN** — a collapsed LAN still carries traffic (collapse is presentation, review R4), so a dot's endpoints go through `transitEndpoints`/`drawnDevice`: a hidden device is drawn as the LAN cloud standing in for it (followed outward through nested collapses), so a frame from a hidden switch to a router travels the cloud ↔ router proxy line, and one that stays inside the cloud isn't drawn (or hit-tested) at all. The packet list still shows every hop.
- **Packet-list cross-link** — when a packet-list row is selected (`state.inspectedCapture`), `drawLink` glows that wire amber (with a shadow) and `drawDeviceIcon` rings both endpoint devices, so the sim log and the canvas point at each other.
- **Placement ghost** (`drawPlacementGhost`, last in `render()` so it sits above everything) — while a placement tool is armed and the cursor is on the canvas (`state.pointer`), draws the device `placementPreview(state.tool, x, y)` (`devices.ts`) describes at `PLACEMENT_GHOST_ALPHA` (0.55), centred on the cursor — exactly where a click would drop it: body and icon via `drawIconDevice`, the managed / border badge, and — when device names are shown — the name it will get, which is what tells the server presets apart. Two cases keep it from fighting what is already drawn: it is **not drawn at all while the cursor is still exactly on a device's centre** (straight after a click the ghost's translucent body would wash out the device just placed, until the cursor moves), and the **name is left off while the cursor is anywhere on an existing device** (two names would overprint). The ghost is drawing only — it is not in `state.devices`, cannot be hit-tested, and never reaches a snapshot.
- **Link state/labels** — `drawLink` renders an administratively-down link (`link.shutdown`) dashed, faint, and danger-coloured, and draws a midpoint label for an explicitly-named link (the name, plus a "down" marker when shut). A spanning-tree-blocked link (`link.stpBlocked`, an alternate port breaking a loop) draws dashed amber (`--stp-block`, faint, with a wider dash than shut's — distinct from the shutdown/failed red) and adds a "STP blocked" marker to the label.
- **`linkColorFor`, `devicePalette`** — resolve themed colours; **`clampText`, `roundRect`** — drawing helpers.

## Performance

The draw loop is hot, so:
- It pulls colours through **`cssColor`** (`utils.ts`), which caches `getComputedStyle` results — the loop never forces a style recalc. The cache is cleared on theme change.
- Repeated `ctx.font` strings are hoisted to module-level constants (`FONT_LABEL`, `FONT_SECONDARY`, …) to avoid per-draw allocation.
- `render()` resolves devices via the `getDevice` index.
- Static Tabler icon `Path2D`s are built **once** and cached (`path2dFor`) rather than reallocated per path per device per frame.
- The per-frame port-map reads (`isTrunkLink`, and `getVlanForDevice` in `simulation.ts`) use the **memoised** `memoPortModes`/`memoPortVlans` (`normalise.ts`) — read-only, keyed on the stored config object's identity, so a switch's port maps are normalised once and reused until an edit (mutators replace the object). The router interface-label list is only built when a label toggle that would render it is on. Both helpers are benchmarked (`bench: render-path helpers`).

`render()` early-returns when there is **no 2D context** (`if (!ctx) return`). In the browser the context is always present; this makes the function a no-op under the headless test stub (where `dom.ctx` is `null`), so calling `setTool` — which renders — is safe in tests.

## How it fits

Reads `state` (devices, links, transform, selection, simulation transits) and draws. It never mutates app data — interaction lives in `ui.ts`, which calls back into `canvas.ts` for hit-testing transforms and re-renders. `frame.ts`'s `frameColor`/`frameLabel` style the transit dots.
