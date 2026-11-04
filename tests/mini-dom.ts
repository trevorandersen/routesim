/**
 * A minimal, faithful element tree for tests that drive real inspector wiring
 * (syncPanel → listeners → a user edit). The preload stubs every element as one
 * inert object, which is fine for rendering-to-string tests but cannot show
 * whether a listener survives a partial re-render. This tree can:
 *
 * - `innerHTML` assignment parses the (well-formed, generated) markup into
 *   child elements, replacing the old children — exactly the partial
 *   re-render the inspector does;
 * - events dispatch on the target and bubble through `parentElement` (the
 *   non-bubbling `focus`/`blur` don't; `focus()`/`blur()` also fire the
 *   bubbling `focusin`/`focusout`, like a browser);
 * - `getElementById` / `querySelector(All)` / `closest` / `matches` take simple
 *   compound selectors (`tag`, `#id`, `.class`, `[attr]`, `[attr="v"]`) and
 *   comma lists — what the inspector uses.
 *
 * `installMiniDom()` swaps `globalThis.document` and mounts the panel root
 * behind `dom.detailsPanel` (via the preload's `__routesimDomMounts` hook);
 * it returns the root and an `uninstall()` that restores both.
 */

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function encodeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const kebab = (prop: string) => prop.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);

export class MiniEvent {
  target: MiniElement | null = null;
  currentTarget: MiniElement | null = null;
  defaultPrevented = false;
  private stopped = false;
  constructor(public type: string, public bubbles = true, init: Record<string, unknown> = {}) {
    Object.assign(this, init);
  }
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void { this.stopped = true; }
  get propagationStopped(): boolean { return this.stopped; }
}

type Listener = (event: MiniEvent) => void;

class MiniText {
  readonly nodeType = 3;
  parentElement: MiniElement | null = null;
  constructor(public data: string) {}
}

type MiniNode = MiniElement | MiniText;

interface SimpleSelector { tag?: string; id?: string; classes: string[]; attrs: { name: string; value?: string }[] }

function parseSelector(selector: string): SimpleSelector[] {
  return selector.split(",").map(part => {
    const s = part.trim();
    const out: SimpleSelector = { classes: [], attrs: [] };
    const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/gy;
    let m: RegExpExecArray | null;
    let consumed = 0;
    while ((m = re.exec(s))) {
      consumed = re.lastIndex;
      if (m[1]) out.tag = m[1].toLowerCase();
      else if (m[2]) out.id = m[2];
      else if (m[3]) out.classes.push(m[3]);
      else out.attrs.push({ name: m[4], value: m[5] });
    }
    if (consumed !== s.length) throw new Error(`mini-dom: unsupported selector "${s}"`);
    return out;
  });
}

export class MiniElement {
  readonly nodeType = 1;
  tagName: string;
  attributes = new Map<string, string>();
  childNodes: MiniNode[] = [];
  parentElement: MiniElement | null = null;
  style: Record<string, string> = {};
  validationMessage = "";
  ownerDocument: MiniDocument | null = null;
  private listeners = new Map<string, Listener[]>();
  private valueOverride: string | null = null;
  private checkedOverride: boolean | null = null;

  constructor(tag: string) { this.tagName = tag.toUpperCase(); }

  // ----- attributes ---------------------------------------------------------
  getAttribute(name: string): string | null { return this.attributes.has(name) ? this.attributes.get(name)! : null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  get id(): string { return this.getAttribute("id") ?? ""; }
  set id(value: string) { this.setAttribute("id", value); }
  get className(): string { return this.getAttribute("class") ?? ""; }
  set className(value: string) { this.setAttribute("class", value); }
  get title(): string { return this.getAttribute("title") ?? ""; }
  set title(value: string) { this.setAttribute("title", value); }
  get classList() {
    const classes = () => this.className.split(/\s+/).filter(Boolean);
    const write = (list: string[]) => this.setAttribute("class", list.join(" "));
    return {
      contains: (c: string) => classes().includes(c),
      add: (...cs: string[]) => write([...new Set([...classes(), ...cs])]),
      remove: (...cs: string[]) => write(classes().filter(c => !cs.includes(c))),
      toggle: (c: string, force?: boolean) => {
        const on = force ?? !classes().includes(c);
        write(on ? [...new Set([...classes(), c])] : classes().filter(x => x !== c));
        return on;
      },
    };
  }
  // A live view of the data-* attributes, as DOMStringMap is.
  get dataset(): Record<string, string | undefined> {
    return new Proxy({}, {
      get: (_t, prop) => typeof prop === "string" ? this.getAttribute(`data-${kebab(prop)}`) ?? undefined : undefined,
      set: (_t, prop, value) => { this.setAttribute(`data-${kebab(String(prop))}`, String(value)); return true; },
      deleteProperty: (_t, prop) => { this.removeAttribute(`data-${kebab(String(prop))}`); return true; },
      has: (_t, prop) => this.hasAttribute(`data-${kebab(String(prop))}`),
    });
  }

  // ----- form state -----------------------------------------------------------
  get value(): string {
    if (this.valueOverride != null) return this.valueOverride;
    if (this.tagName === "SELECT") {
      const options = this.querySelectorAll("option");
      const chosen = options.find(o => o.hasAttribute("selected")) ?? options[0];
      return chosen ? (chosen.getAttribute("value") ?? chosen.textContent) : "";
    }
    if (this.tagName === "TEXTAREA") return this.textContent;
    return this.getAttribute("value") ?? "";
  }
  set value(v: string) { this.valueOverride = String(v); }
  get checked(): boolean { return this.checkedOverride ?? this.hasAttribute("checked"); }
  set checked(v: boolean) { this.checkedOverride = Boolean(v); }
  setCustomValidity(message: string): void { this.validationMessage = message; }
  reportValidity(): boolean { return this.validationMessage === ""; }
  checkValidity(): boolean { return this.validationMessage === ""; }

  // ----- tree -----------------------------------------------------------------
  get children(): MiniElement[] { return this.childNodes.filter((n): n is MiniElement => n instanceof MiniElement); }
  get textContent(): string {
    return this.childNodes.map(n => n instanceof MiniText ? n.data : n.textContent).join("");
  }
  set textContent(text: string) { this.replaceChildren(); this.appendNode(new MiniText(String(text))); }
  get innerHTML(): string {
    return this.childNodes.map(n => n instanceof MiniText ? n.data : n.outerHTML).join("");
  }
  set innerHTML(html: string) {
    this.replaceChildren();
    parseInto(this, String(html));
  }
  get outerHTML(): string {
    const tag = this.tagName.toLowerCase();
    const attrs = [...this.attributes].map(([k, v]) => ` ${k}="${encodeAttr(v)}"`).join("");
    return VOID_TAGS.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${this.innerHTML}</${tag}>`;
  }
  appendNode(node: MiniNode): void {
    node.parentElement = this;
    this.childNodes.push(node);
  }
  append(...nodes: (MiniElement | string)[]): void {
    nodes.forEach(n => this.appendNode(typeof n === "string" ? new MiniText(n) : n));
  }
  appendChild(node: MiniElement): MiniElement { this.appendNode(node); return node; }
  replaceChildren(): void {
    this.childNodes.forEach(n => { n.parentElement = null; });
    this.childNodes = [];
  }
  remove(): void {
    const parent = this.parentElement;
    if (!parent) return;
    parent.childNodes = parent.childNodes.filter(n => n !== this);
    this.parentElement = null;
  }
  contains(other: MiniElement | null): boolean {
    for (let node = other; node; node = node.parentElement) if (node === this) return true;
    return false;
  }
  private descendants(): MiniElement[] {
    return this.children.flatMap(child => [child, ...child.descendants()]);
  }
  matches(selector: string): boolean {
    return parseSelector(selector).some(sel =>
      (!sel.tag || sel.tag === this.tagName.toLowerCase()) &&
      (!sel.id || sel.id === this.id) &&
      sel.classes.every(c => this.classList.contains(c)) &&
      sel.attrs.every(a => this.hasAttribute(a.name) && (a.value == null || this.getAttribute(a.name) === a.value)));
  }
  closest(selector: string): MiniElement | null {
    for (let node: MiniElement | null = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector: string): MiniElement[] { return this.descendants().filter(el => el.matches(selector)); }
  querySelector(selector: string): MiniElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  getElementById(id: string): MiniElement | null { return this.descendants().find(el => el.id === id) ?? null; }

  // ----- events ---------------------------------------------------------------
  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(f => f !== fn));
  }
  listenerCount(type: string): number { return this.listeners.get(type)?.length ?? 0; }
  dispatchEvent(event: MiniEvent): boolean {
    event.target = this;
    for (let node: MiniElement | null = this; node; node = event.bubbles ? node.parentElement : null) {
      event.currentTarget = node;
      for (const fn of [...(node.listeners.get(event.type) ?? [])]) fn(event);
      if (event.propagationStopped) break;
    }
    event.currentTarget = null;
    return !event.defaultPrevented;
  }
  focus(): void {
    const doc = this.ownerDocument;
    if (doc?.activeElement === this) return;
    doc?.activeElement?.blur();
    if (doc) doc.activeElement = this;
    this.dispatchEvent(new MiniEvent("focus", false));
    this.dispatchEvent(new MiniEvent("focusin"));
  }
  blur(): void {
    const doc = this.ownerDocument;
    if (doc && doc.activeElement !== this) return;
    if (doc) doc.activeElement = null;
    this.dispatchEvent(new MiniEvent("blur", false));
    this.dispatchEvent(new MiniEvent("focusout"));
  }
  click(): void { this.dispatchEvent(new MiniEvent("click")); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; }
  scrollIntoView(): void {}
}

// Parses generated markup into `parent`. Handles comments, void elements,
// `/>` self-closing, quoted/bare attributes, and recovers from a stray end tag
// by closing back to its matching open element (as the HTML parser would).
function parseInto(parent: MiniElement, html: string): void {
  const doc = parent.ownerDocument;
  const stack: MiniElement[] = [parent];
  const token = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[1]) {
      const tag = m[1].toUpperCase();
      const at = stack.map(e => e.tagName).lastIndexOf(tag);
      if (at > 0) stack.length = at;
    } else if (m[2]) {
      const el = new MiniElement(m[2]);
      el.ownerDocument = doc;
      const attr = /([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a: RegExpExecArray | null;
      while ((a = attr.exec(m[3] ?? ""))) el.setAttribute(a[1], decodeEntities(a[2] ?? a[3] ?? a[4] ?? ""));
      top.appendNode(el);
      if (!m[4] && !VOID_TAGS.has(m[2].toLowerCase())) stack.push(el);
    } else if (m[5]) {
      top.appendNode(new MiniText(decodeEntities(m[5])));
    }
  }
}

export class MiniDocument {
  activeElement: MiniElement | null = null;
  readonly body: MiniElement;
  constructor(readonly root: MiniElement) {
    this.body = new MiniElement("body");
    this.body.ownerDocument = this;
    root.ownerDocument = this;
    this.body.appendNode(root);
  }
  getElementById(id: string): MiniElement | null { return this.body.getElementById(id); }
  querySelectorAll(selector: string): MiniElement[] { return this.body.querySelectorAll(selector); }
  querySelector(selector: string): MiniElement | null { return this.body.querySelector(selector); }
  createElement(tag: string): MiniElement {
    const el = new MiniElement(tag);
    el.ownerDocument = this;
    return el;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

/** Types `text` into `input` the way a user does: focus, set value, input event. */
export function typeInto(input: MiniElement, text: string): void {
  input.focus();
  input.value = text;
  input.dispatchEvent(new MiniEvent("input"));
}

// App chrome outside the inspector that panel edits reach for (the undo/redo
// buttons sync their disabled state on every push). Created as siblings of
// the panel so lookups find a real element, as they would in the page.
const CHROME_IDS = ["undoButton", "redoButton"];

export function installMiniDom(): { panel: MiniElement; document: MiniDocument; uninstall: () => void } {
  const g = globalThis as any;
  const previousDocument = g.document;
  const previousMounts = g.__routesimDomMounts;
  const panel = new MiniElement("div");
  panel.setAttribute("id", "detailsPanel");
  const document = new MiniDocument(panel);
  for (const id of CHROME_IDS) {
    const button = document.createElement("button");
    button.setAttribute("id", id);
    document.body.appendNode(button);
  }
  // Keep the stub's document-level extras (documentElement, body class toggles)
  // that other modules reach for; only element lookup goes through the tree.
  g.document = Object.assign(Object.create(previousDocument), {
    getElementById: (id: string) => document.getElementById(id),
    querySelectorAll: (selector: string) => document.querySelectorAll(selector),
    querySelector: (selector: string) => document.querySelector(selector),
    get activeElement() { return document.activeElement; },
  });
  g.__routesimDomMounts = { detailsPanel: panel };
  return {
    panel,
    document,
    uninstall: () => {
      g.document = previousDocument;
      g.__routesimDomMounts = previousMounts;
    },
  };
}
