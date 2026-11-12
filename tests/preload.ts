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
// One element PER ID, each with its own state and working listeners. The stub
// used to be a single shared object: every `document.getElementById(...)` and
// every `dom.*` returned the same thing, so `dom.modeLabel.textContent` and
// `dom.terminalInput.value` were one field wearing different names, a test
// could not tell which element a message was written to, and nothing could
// dispatch an event — so the console pane, the ribbon and most `bind*` wiring
// had no tests (review R114). For a real parsed tree (innerHTML, bubbling,
// selectors) mount tests/mini-dom.ts; this stub is the cheap default.
function makeElement(id = ""): any {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const element: any = {
    id,
    disabled: false,
    readOnly: false,
    hidden: false,
    textContent: "",
    innerHTML: "",
    placeholder: "",
    classList: {
      add(...names: string[]) { names.forEach(n => classes.add(n)); },
      remove(...names: string[]) { names.forEach(n => classes.delete(n)); },
      toggle(name: string, force?: boolean) {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
      contains(name: string) { return classes.has(name); },
    },
    setAttribute(name: string, value: string) { attributes.set(name, String(value)); },
    getAttribute(name: string) { return attributes.has(name) ? attributes.get(name) : null; },
    removeAttribute(name: string) { attributes.delete(name); },
    hasAttribute(name: string) { return attributes.has(name); },
    style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ""; } },
    dataset: {},
    checked: false,
    value: "",
    click() { element.dispatchEvent({ type: "click" }); },
    focus() {},
    blur() {},
    select() {},
    addEventListener(type: string, fn: (event: any) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: (event: any) => void) { listeners.get(type)?.delete(fn); },
    // Runs this element's listeners for the event's type (no bubbling — use
    // mini-dom for that). Fills in target/currentTarget/preventDefault.
    dispatchEvent(event: any) {
      const e = event ?? {};
      if (e.target === undefined) e.target = element;
      e.currentTarget = element;
      if (typeof e.preventDefault !== "function") e.preventDefault = () => { e.defaultPrevented = true; };
      if (typeof e.stopPropagation !== "function") e.stopPropagation = () => {};
      for (const fn of [...(listeners.get(e.type) ?? [])]) fn(e);
      return !e.defaultPrevented;
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };
    },
    getContext() { return null; },
    scrollTop: 0,
    scrollHeight: 0,
    offsetWidth: 0,
    offsetHeight: 0,
    tagName: "DIV",
    parentElement: null,
    children: [],
    querySelectorAll() { return []; },
    querySelector() { return null; },
    closest() { return null; },
    contains() { return false; },
    append() {},
    appendChild() {},
    remove() {},
    reportValidity() { return true; },
    setCustomValidity() {},
  };
  return element;
}

// The same id always gives the same element — as in a page.
const elementsById = new Map<string, any>();
function elementFor(id: string): any {
  if (!elementsById.has(id)) elementsById.set(id, makeElement(id));
  return elementsById.get(id);
}
// An element for lookups that name no id (querySelector): shared, inert.
const el: any = makeElement();

// ---------------------------------------------------------------------------
// Global stubs
// ---------------------------------------------------------------------------
(globalThis as any).document = {
  getElementById: (id: string) => elementFor(String(id)),
  querySelector: () => el,
  querySelectorAll: () => [],
  createElement: (tag = "div") => Object.assign(makeElement(), { tagName: String(tag).toUpperCase(), href: "", download: "" }),
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
// Keep the real URL constructor (code and tests parse URLs with it) and add the
// two object-URL statics a browser has. The stub used to REPLACE `URL` with a
// plain object, so `new URL(...)` threw in every test.
(globalThis as any).URL.createObjectURL = () => "blob:stub";
(globalThis as any).URL.revokeObjectURL = () => {};
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
      // dom.<name> is the element with id <name> (dom.ts names them so) — one
      // element per name, never a shared one.
      return elementFor(String(prop));
    },
  }),
}));

// terminal.ts imports dom.ts (already mocked above) and engine.ts.
// The circular import (terminal ↔ engine) resolves in ESM because all
// cross-module references are function declarations, not top-level calls.
// No mock needed — dom.ts mock is sufficient.
