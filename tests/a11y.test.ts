/**
 * Keyboard and assistive-technology reach (review R103): the surfaces that
 * were mouse-only or invisible to a screen reader — the packet list's rows, a
 * dock tab's close control, cables (no keyboard path to a link's inspector),
 * and the modal dialogs (no role, no focus handling).
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { state } from "../src/state";
import { dom } from "../src/dom";
import { runConsoleScript } from "../src/commands";
import { syncDock, ensureSession } from "../src/terminal";
import { syncDeviceList } from "../src/inspector";
import { syncSimLog } from "../src/simlog-view";
import { handlePacketRowKeydown, inspectPacketRow } from "../src/ui";
import { showDialog, hideDialog } from "../src/dialog";
import { createIcmpEchoRequest } from "../src/frame";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());
beforeEach(() => resetState());

describe("modal dialogs are announced as dialogs (R103)", () => {
  const template = readFileSync(join(import.meta.dir, "..", "template.html"), "utf8");

  it("the Guide, About and port-picker modals carry role, aria-modal and a label that exists", () => {
    for (const title of ["helpTitle", "aboutTitle", "portSelectionTitle"]) {
      expect(template).toContain(`role="dialog" aria-modal="true" aria-labelledby="${title}"`);
      expect(template).toContain(`<h3 id="${title}">`);
    }
  });
});

describe("showDialog / hideDialog manage focus (R103)", () => {
  // A minimal element: classList, focus tracking through document.activeElement.
  function element(name: string): any {
    const classes = new Set<string>();
    const listeners: Record<string, ((e: any) => void)[]> = {};
    const el: any = {
      name, isConnected: true, children: [] as any[],
      classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c) },
      addEventListener: (type: string, fn: (e: any) => void) => { (listeners[type] ||= []).push(fn); },
      dispatch: (type: string, event: any) => (listeners[type] || []).forEach(fn => fn(event)),
      focus: () => { (document as any).activeElement = el; },
      querySelectorAll: () => el.children,
      contains: (other: any) => el.children.includes(other),
    };
    return el;
  }

  it("opening moves focus into the dialog; closing gives it back to the opener", () => {
    const opener = element("opener"), overlay = element("overlay"), close = element("close");
    opener.focus();
    showDialog(overlay, close);
    expect(overlay.classList.contains("open")).toBe(true);
    expect((document as any).activeElement).toBe(close);
    hideDialog(overlay);
    expect(overlay.classList.contains("open")).toBe(false);
    expect((document as any).activeElement).toBe(opener);
  });

  it("Tab wraps inside the open dialog, in both directions", () => {
    const overlay = element("overlay"), first = element("first"), last = element("last");
    overlay.children = [first, last];
    showDialog(overlay, first);
    let prevented = 0;
    const tab = (shiftKey: boolean) => overlay.dispatch("keydown", { key: "Tab", shiftKey, preventDefault: () => { prevented++; } });
    last.focus(); tab(false);
    expect((document as any).activeElement).toBe(first);
    tab(true);
    expect((document as any).activeElement).toBe(last);
    first.focus(); tab(false);                                  // mid-list: the browser's own Tab
    expect(prevented).toBe(2);
    hideDialog(overlay);
  });

  it("hiding a dialog that is not open moves no focus", () => {
    const overlay = element("overlay"), elsewhere = element("elsewhere");
    elsewhere.focus();
    hideDialog(overlay);
    expect((document as any).activeElement).toBe(elsewhere);
  });
});

describe("a dock tab's close control is a button with a name (R103)", () => {
  it("renders the tab and its close control as two buttons, not a span inside a button", () => {
    runConsoleScript("add computer PC1 at 0 0");
    const pc = state.devices[0];
    state.terminal = ensureSession(pc);
    state.dock.open = true; state.dock.activeTab = "terminal";
    syncDock();
    const html = dom.dockTabs.innerHTML;
    expect(html).toContain(`<button class="dock-tab-close" data-close="${pc.id}" type="button" title="Close session" aria-label="Close PC1 terminal session">`);
    expect(html).toContain(`<button class="dock-tab-label" type="button" aria-pressed="true">PC1</button>`);
    expect(html).not.toContain("<span class=\"dock-tab-close\"");
    // The session tab is no longer a <button> wrapping another control.
    expect(html).toMatch(/<div class="dock-tab dock-tab-session active" data-session="[^"]+">/);
  });
});

describe("cables are listed, so a link has a keyboard path to its inspector (R103)", () => {
  it("the device list ends with a Cables section: one button per cable, marked when selected", () => {
    runConsoleScript(`
      add switch SW at 0 0
      add computer PC1 at 100 0
      add computer PC2 at 200 0
      link PC1 SW
      link PC2 SW
      linkset PC2 SW name "uplink two"
      shut PC2 SW
    `);
    state.selectedId = null;
    state.selectedLinkId = state.links[0].id;
    syncDeviceList();
    const html = dom.deviceList.innerHTML;
    expect(html).toContain("Cables");
    const rows = [...html.matchAll(/<button class="device-row link-row ([a-z]*)" data-link-id="([^"]+)" type="button" aria-pressed="(true|false)">/g)];
    expect(rows.map(r => r[2])).toEqual(state.links.map(l => l.id));
    expect(rows.map(r => r[3])).toEqual(["true", "false"]);
    expect(html).toContain("uplink two");
    expect(html).toContain(">Down<");
  });

  it("with no cables there is no Cables section", () => {
    runConsoleScript("add computer PC1 at 0 0");
    syncDeviceList();
    expect(dom.deviceList.innerHTML).not.toContain("Cables");
  });
});

describe("packet-list rows are focusable and open from the keyboard (R103)", () => {
  function capture() {
    runConsoleScript("add switch SW at 0 0\nadd computer PC1 at 100 0\nlink PC1 SW");
    const link = state.links[0];
    const frame = createIcmpEchoRequest("02:00:00:00:00:01", "02:00:00:00:00:02", "10.0.0.1", "10.0.0.2", 64);
    state.simulation.capture = [
      { no: 1, step: 1, frame, linkId: link.id, fromId: link.from, toId: link.to, macsec: false },
      { no: 2, step: 2, frame: { ...frame, id: "f2" }, linkId: link.id, fromId: link.from, toId: link.to, macsec: false },
    ] as any;
    state.dock.logView = "packets";
  }
  const row = (no: number, siblings: any = {}): any => ({
    dataset: { no: String(no), cap: "live" },
    closest: function () { return this; },
    matches: () => true,
    focus() { focused = this; },
    ...siblings,
  });
  let focused: any = null;
  const key = (k: string, target: any) => {
    let prevented = false, stopped = false;
    handlePacketRowKeydown({ key: k, target, preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } } as any);
    return { prevented, stopped };
  };

  it("each row carries tabindex and aria-selected", () => {
    capture();
    syncSimLog();
    const html = dom.simLogOutput.innerHTML;
    expect((html.match(/<tr class="pkt-row[^>]* tabindex="0" aria-selected="false">/g) || []).length).toBe(2);
    inspectPacketRow(row(2));
    syncSimLog();
    expect(dom.simLogOutput.innerHTML).toMatch(/data-no="2" data-cap="live" tabindex="0" aria-selected="true"/);
  });

  it("Enter and Space open the focused row's frame; Space does not reach the global pause shortcut", () => {
    capture();
    for (const k of ["Enter", " "]) {
      state.inspectedCapture = null;
      const result = key(k, row(2));
      expect((state.inspectedCapture as any)?.no).toBe(2);
      expect(result).toEqual({ prevented: true, stopped: true });
    }
  });

  it("the arrow keys move focus between rows and stop at the ends", () => {
    const second = row(2), first = row(1, { nextElementSibling: second, previousElementSibling: null });
    second.previousElementSibling = first; second.nextElementSibling = null;
    focused = null;
    expect(key("ArrowDown", first).prevented).toBe(true);
    expect(focused).toBe(second);
    expect(key("ArrowUp", second).prevented).toBe(true);
    expect(focused).toBe(first);
    focused = null;
    expect(key("ArrowUp", first).prevented).toBe(false);
    expect(focused).toBeNull();
  });
});
