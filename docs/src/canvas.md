# `src/canvas.ts` — Canvas rendering & view transform

All `<canvas>` drawing and the pan/zoom view transform. The entire scene is redrawn imperatively each frame — there is no scene graph.

## Key exports

### View transform
- **`screenToWorld` / `worldToScreen`** — convert between screen pixels and world coordinates given `state.pan`/`state.scale`.
- **`setZoom(scale, anchor)`** — zoom toward a point; **`syncZoomLevel`** updates the readout.
- **`resizeCanvas`** — handle DPR and canvas sizing (re-renders).
- **`fitNetwork`** — auto-pan/zoom so the whole topology is visible.

### The render loop
- **`render()`** — clears, applies the pan/zoom transform, then draws the grid, links, devices, and any in-flight transit dots. Called directly by interaction code and via `sync().render()` by everything else.
- **`drawLink`, `drawDevice`, `drawComputer`/`drawSwitch`/`drawRouter`, `drawIconDevice`, `drawTablerIcon`, `drawManagedBadge`** — the drawing primitives. Device icons are rendered from SVG path data (`deviceIcons` in `state.ts`) via `Path2D`.
- **`linkColorFor`, `devicePalette`** — resolve themed colours; **`clampText`, `roundRect`** — drawing helpers.

## Performance

The draw loop is hot, so:
- It pulls colours through **`cssColor`** (`utils.ts`), which caches `getComputedStyle` results — the loop never forces a style recalc. The cache is cleared on theme change.
- Repeated `ctx.font` strings are hoisted to module-level constants (`FONT_LABEL`, `FONT_SECONDARY`, …) to avoid per-draw allocation.
- `render()` resolves devices via the `getDevice` index.

`render()` early-returns when there is **no 2D context** (`if (!ctx) return`). In the browser the context is always present; this makes the function a no-op under the headless test stub (where `dom.ctx` is `null`), so calling `setTool` — which renders — is safe in tests.

## How it fits

Reads `state` (devices, links, transform, selection, simulation transits) and draws. It never mutates app data — interaction lives in `ui.ts`, which calls back into `canvas.ts` for hit-testing transforms and re-renders. `frame.ts`'s `frameColor`/`frameLabel` style the transit dots.
