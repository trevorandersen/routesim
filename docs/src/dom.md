# `src/dom.ts` — Cached DOM references

A thin module that resolves and caches every `getElementById` reference the app uses, plus the canvas 2D context.

## Key export

- **`dom`** — an object of typed element references (`dom.canvas`, `dom.ctx`, `dom.hint`, `dom.detailsPanel`, `dom.terminalInput`, `dom.toolButtons`, `dom.saveButton`, …), resolved **once at module load**.

## How it fits

Centralising element lookups keeps the rest of the codebase free of `document.getElementById` calls and gives a single typed surface for the DOM. UI modules (`ui.ts`, `canvas.ts`, `inspector.ts`, `terminal.ts`) read and write through `dom`.

## Notes

- Because references resolve at **load time**, the matching elements must exist in `template.html` when the bundle runs. They do (the script tag is at the end of `<body>`).
- In tests, `dom.ts` is replaced wholesale by a `Proxy` mock in `tests/preload.ts` that returns a stub element for any property (and `null` for `ctx`, `[]` for `toolButtons`). This is why importing DOM-touching modules works headlessly. See [testing.md](../testing.md).
