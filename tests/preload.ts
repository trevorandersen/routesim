/**
 * Bun test preload — runs before every test file.
 *
 * Stubs browser globals (document, window, requestAnimationFrame) and
 * mocks DOM-dependent modules so that importing source modules that
 * transitively touch dom.ts or terminal.ts doesn't crash.
 */
import { mock } from "bun:test";

// ---------------------------------------------------------------------------
// Minimal DOM element stub
// ---------------------------------------------------------------------------
const el: any = {
  disabled: false,
  textContent: "",
  innerHTML: "",
  classList: {
    add() {},
    remove() {},
    toggle() { return false; },
    contains() { return false; },
  },
  setAttribute() {},
  getAttribute() { return null; },
  style: {},
  checked: false,
  value: "",
  click() {},
  focus() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  setPointerCapture() {},
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };
  },
  getContext() { return null; },
  scrollTop: 0,
  tagName: "DIV",
  parentElement: null,
  children: [],
  querySelectorAll() { return []; },
  querySelector() { return null; },
  append() {},
  remove() {},
};

// ---------------------------------------------------------------------------
// Global stubs
// ---------------------------------------------------------------------------
(globalThis as any).document = {
  getElementById: () => el,
  querySelector: () => el,
  querySelectorAll: () => [],
  createElement: () => ({ ...el, href: "", download: "" }),
  documentElement: {
    dataset: {},
    style: {
      setProperty() {},
      getPropertyValue() { return ""; },
    },
  },
  body: {
    classList: { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } },
    appendChild() {},
  },
  addEventListener() {},
};

(globalThis as any).window = {
  addEventListener() {},
  removeEventListener() {},
  getComputedStyle() {
    return { getPropertyValue() { return ""; } };
  },
  showOpenFilePicker: undefined,
  showSaveFilePicker: undefined,
};

(globalThis as any).requestAnimationFrame = (cb: any) => { cb(0); return 0; };
(globalThis as any).cancelAnimationFrame = () => {};
(globalThis as any).URL = {
  createObjectURL() { return "blob:stub"; },
  revokeObjectURL() {},
};
(globalThis as any).Blob = class Blob {
  constructor() {}
};

// crypto.randomUUID is available in Bun natively — no stub needed.

// ---------------------------------------------------------------------------
// Module mocks — must be called before any test file imports source modules
// ---------------------------------------------------------------------------

// dom.ts evaluates document.getElementById at module scope.
// Replace the entire module with a Proxy that returns the stub element for
// any property access (e.g. dom.canvas, dom.hint, etc.).
mock.module("../src/dom", () => ({
  dom: new Proxy({} as any, {
    get(_target, prop) {
      // A test can mount a real element tree (tests/mini-dom.ts) behind a
      // dom.* name, e.g. the inspector panel, to drive its listeners.
      const mounted = (globalThis as any).__routesimDomMounts?.[prop];
      if (mounted) return mounted;
      if (prop === "toolButtons") return [];
      if (prop === "themeButtons") return [];
      if (prop === "ctx") return null;
      return el;
    },
  }),
}));

// terminal.ts imports dom.ts (already mocked above) and engine.ts.
// The circular import (terminal ↔ engine) resolves in ESM because all
// cross-module references are function declarations, not top-level calls.
// No mock needed — dom.ts mock is sufficient.
