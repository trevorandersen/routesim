/**
 * Global keyboard handler tests. handleGlobalKeydown was extracted from
 * setupUI() so the shortcut/Escape logic can be unit-tested by passing plain
 * event-shaped objects.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { state, THEMES, DEFAULT_THEME, undo as undoState, redo as redoState, restoreSnapshot, networkSnapshot } from "../src/state";
import { dom } from "../src/dom";
import { openPortSelectionModal, confirmPortSelection, cancelPortSelection, syncPortSelectionModal } from "../src/port-picker";
import { addLink } from "../src/devices";
import { applyConfigWithoutUndo, buildConfigPayload } from "../src/config";
import { normaliseConfig } from "../src/normalise";
import { handleGlobalKeydown, setTheme, toggleTheme } from "../src/ui";
import { runConsoleCommand as exec } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());

describe("themes", () => {
  beforeEach(() => resetState());

  it("registers three themes with warm-light as the default", () => {
    expect(THEMES.map(t => t.id)).toEqual(["warm-light", "dark", "blueprint"]);
    expect(DEFAULT_THEME).toBe("warm-light");
  });

  it("setTheme applies each id to state + the html data-theme attribute", () => {
    for (const { id } of THEMES) {
      setTheme(id);
      expect(state.theme).toBe(id);
      expect(document.documentElement.dataset.theme).toBe(id);
    }
  });

  it("treats 'light' as a back-compat alias for warm-light", () => {
    setTheme("light");
    expect(state.theme).toBe("warm-light");
  });

  it("falls back to the default theme for an unknown id", () => {
    setTheme("nope");
    expect(state.theme).toBe(DEFAULT_THEME);
  });

  it("toggleTheme cycles through the registry in order", () => {
    setTheme("warm-light");
    toggleTheme();
    expect(state.theme).toBe("dark");
    toggleTheme();
    expect(state.theme).toBe("blueprint");
    toggleTheme();
    expect(state.theme).toBe("warm-light");
  });
});

const key = (k: string, target: any = {}) => ({ key: k, target } as any);

describe("handleGlobalKeydown — Escape", () => {
  beforeEach(() => resetState());

  it("reverts to the select tool and clears selection state", () => {
    state.tool = "router";
    state.configuringId = "x";
    state.linkStartId = "y";
    state.selectedLinkId = "z";
    handleGlobalKeydown(key("Escape"));
    expect(state.tool).toBe("select");
    expect(state.configuringId).toBeNull();
    expect(state.linkStartId).toBeNull();
    expect(state.selectedLinkId).toBeNull();
  });

  it("cancels an open port-selection modal first", () => {
    state.portSelection = { fromId: "a", toId: "b" } as any;
    handleGlobalKeydown(key("Escape"));
    expect(state.portSelection).toBeNull();
  });

  it("fires even when a text input is focused", () => {
    state.tool = "computer";
    handleGlobalKeydown(key("Escape", { tagName: "INPUT" }));
    expect(state.tool).toBe("select");
  });
});

describe("handleGlobalKeydown — tool shortcuts", () => {
  beforeEach(() => resetState());

  it("maps letter keys to tools", () => {
    handleGlobalKeydown(key("r"));
    expect(state.tool).toBe("router");
    handleGlobalKeydown(key("s"));
    expect(state.tool).toBe("switch");
    handleGlobalKeydown(key("v"));
    expect(state.tool).toBe("select");
  });

  it("ignores letter shortcuts while typing in an input", () => {
    state.tool = "select";
    handleGlobalKeydown(key("r", { tagName: "INPUT" }));
    expect(state.tool).toBe("select");
  });
});

// R44: Ctrl+C armed the Computer tool, Cmd+F the Firewall tool, Ctrl+A the Red
// Team tool — while copying text from the packet list or a terminal's
// scrollback — and Delete behind the Guide or About modal deleted the device.
describe("handleGlobalKeydown — modifier keys and open dialogs (R44)", () => {
  beforeEach(() => {
    resetState();
    for (const id of ["helpOverlay", "aboutOverlay"]) document.getElementById(id)!.classList.remove("open");
  });

  it("a letter with Ctrl, Cmd or Alt held is not a tool shortcut", () => {
    for (const modifier of ["ctrlKey", "metaKey", "altKey"]) {
      for (const k of ["c", "f", "a", "s", "r", "l", "w"]) {
        state.tool = "select";
        handleGlobalKeydown({ key: k, target: {}, [modifier]: true } as any);
        expect(state.tool).toBe("select");
      }
    }
    handleGlobalKeydown({ key: "C", target: {}, shiftKey: true } as any);   // Shift is only a capital letter
    expect(state.tool).toBe("computer");
  });

  it("Delete with a modifier held does not delete the selection", () => {
    exec("add computer PC1 at 100 100");
    state.selectedId = state.devices[0].id;
    handleGlobalKeydown({ key: "Backspace", target: {}, metaKey: true } as any);
    handleGlobalKeydown({ key: "Delete", target: {}, ctrlKey: true } as any);
    expect(state.devices).toHaveLength(1);
    handleGlobalKeydown(key("Delete"));
    expect(state.devices).toHaveLength(0);
  });

  it("Delete and the tool letters do nothing behind the Guide, About or port dialog", () => {
    exec("add computer PC1 at 100 100");
    const open = [
      () => document.getElementById("helpOverlay")!.classList.add("open"),
      () => document.getElementById("aboutOverlay")!.classList.add("open"),
      () => { state.portSelection = { fromId: "a", toId: "b" } as any; },
    ];
    const close = () => {
      for (const id of ["helpOverlay", "aboutOverlay"]) document.getElementById(id)!.classList.remove("open");
      state.portSelection = null;
    };
    for (const show of open) {
      state.selectedId = state.devices[0].id;
      state.tool = "select";
      show();
      handleGlobalKeydown(key("Delete"));
      handleGlobalKeydown(key("r"));
      expect(state.devices).toHaveLength(1);
      expect(state.tool).toBe("select");
      close();
    }
    handleGlobalKeydown(key("Delete"));                       // with nothing open it deletes again
    expect(state.devices).toHaveLength(0);
  });
});

// R31: with the port dialog open, Ctrl+Z could remove one of the two devices it
// was about to cable; Confirm then made a link to a device that no longer
// existed, and the saved file was rejected ("Link 1 references a missing device").
describe("the port dialog pauses undo and never outlives its devices (R31)", () => {
  beforeEach(() => {
    resetState();
    registerNoopCallbacks({ syncPortPicker: syncPortSelectionModal });
    exec("add switch SW1 at 100 100");
    exec("add switch SW2 at 300 100");
  });
  afterAll(() => registerNoopCallbacks());

  const ids = () => state.devices.map(d => d.id);
  const openDialog = () => {
    const [a, b] = ids();
    openPortSelectionModal(a, b);
    state.portSelection!.selectedFrom = 2;
    state.portSelection!.selectedTo = 3;
  };
  const chord = (k: string, extra: any = {}) => ({ key: k, target: {}, ctrlKey: true, preventDefault() {}, ...extra } as any);

  it("Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z do nothing but say why", () => {
    openDialog();
    const before = { devices: state.devices.length, undo: state.undoStack.length, redo: state.redoStack.length };
    for (const event of [chord("z"), chord("y"), chord("Z", { shiftKey: true })]) {
      dom.modeLabel.textContent = "";
      handleGlobalKeydown(event);
      expect(dom.modeLabel.textContent).toContain("paused while the port dialog is open");
    }
    expect({ devices: state.devices.length, undo: state.undoStack.length, redo: state.redoStack.length }).toEqual(before);
    expect(state.portSelection).not.toBeNull();
  });

  it("the console's undo and redo are refused the same way, and Delete is ignored", () => {
    openDialog();
    state.selectedId = ids()[1];
    expect(exec("undo").ok).toBe(false);
    expect(exec("undo").output.join(" ")).toContain("port dialog is open");
    expect(exec("redo").ok).toBe(false);
    handleGlobalKeydown(key("Delete"));
    expect(state.devices).toHaveLength(2);
  });

  it("confirming after the attempts makes a cable between two devices that exist — and the save loads", () => {
    openDialog();
    handleGlobalKeydown(chord("z"));
    handleGlobalKeydown(key("Delete"));
    confirmPortSelection();
    expect(state.links).toHaveLength(1);
    expect(state.links.every(l => ids().includes(l.from) && ids().includes(l.to))).toBe(true);
    expect(() => normaliseConfig(JSON.parse(JSON.stringify(buildConfigPayload())))).not.toThrow();
  });

  it("once the dialog is closed, undo works again", () => {
    openDialog();
    cancelPortSelection();
    handleGlobalKeydown(chord("z"));
    expect(state.devices).toHaveLength(1);
  });

  it("a restore or a load takes the dialog down with the network it belonged to", () => {
    const overlay = document.getElementById("portSelectionOverlay")!;
    openDialog();
    expect(overlay.classList.contains("open")).toBe(true);
    restoreSnapshot(networkSnapshot());
    expect(state.portSelection).toBeNull();
    expect(overlay.classList.contains("open")).toBe(false);

    openDialog();
    applyConfigWithoutUndo(normaliseConfig(buildConfigPayload()));
    expect(state.portSelection).toBeNull();
    expect(overlay.classList.contains("open")).toBe(false);
  });

  it("a dialog whose device has gone closes itself; addLink refuses a missing end", () => {
    openDialog();
    const [a, b] = ids();
    state.devices = state.devices.filter(d => d.id !== b);
    syncPortSelectionModal();
    expect(state.portSelection).toBeNull();
    const result = addLink(a, b, 2, 3);
    expect(result.ok).toBe(false);
    expect(state.links).toHaveLength(0);
  });
});

// R104: the transport pill's tooltip said "Pause / resume (Space)"; nothing did.
describe("handleGlobalKeydown — Space pauses and resumes the run in flight (R104)", () => {
  beforeEach(() => resetState());
  const space = (target: any = {}, extra: any = {}) => ({ key: " ", code: "Space", target, preventDefault() {}, ...extra } as any);

  it("running → paused → resumed", () => {
    state.simulation.status = "running";
    handleGlobalKeydown(space());
    expect(state.simulation.status).toBe("paused");
    handleGlobalKeydown(space());
    expect(state.simulation.status).not.toBe("paused");     // resumed (an empty run then finishes at once)
    state.simulation.status = "idle";
  });

  it("does nothing while idle, in a field, on a focused button, with a modifier, or behind a dialog", () => {
    handleGlobalKeydown(space());
    expect(state.simulation.status).toBe("idle");
    state.simulation.status = "running";
    handleGlobalKeydown(space({ tagName: "INPUT" }));
    handleGlobalKeydown(space({ tagName: "BUTTON" }));
    handleGlobalKeydown(space({}, { ctrlKey: true }));
    state.portSelection = { fromId: "a", toId: "b" } as any;
    handleGlobalKeydown(space());
    state.portSelection = null;
    expect(state.simulation.status).toBe("running");
    state.simulation.status = "idle";
  });
});

describe("undo / redo", () => {
  beforeEach(() => resetState());

  it("redo restores an undone change; a new mutation clears the redo branch", () => {
    exec("add computer PC1 at 100 100");
    exec("add computer PC2 at 300 100");
    expect(state.devices).toHaveLength(2);

    undoState();
    expect(state.devices).toHaveLength(1);
    expect(state.redoStack.length).toBeGreaterThan(0);

    redoState();
    expect(state.devices).toHaveLength(2);
    expect(state.devices.map(d => d.name)).toContain("PC2");

    // Undo again, then mutate — redo branch must be invalidated.
    undoState();
    expect(state.devices).toHaveLength(1);
    exec("add switch SW1 at 200 200");
    expect(state.redoStack).toHaveLength(0);
    redoState(); // no-op
    expect(state.devices.map(d => d.name).sort()).toEqual(["PC1", "SW1"]);
  });

  it("redo with an empty stack is a no-op", () => {
    exec("add computer PC1");
    const before = state.devices.length;
    redoState();
    expect(state.devices).toHaveLength(before);
  });
});

describe("handleGlobalKeydown — Ctrl/Cmd+Z text-field guard", () => {
  beforeEach(() => resetState());
  const ctrlZ = (target: any) =>
    handleGlobalKeydown({ key: "z", metaKey: true, shiftKey: false, target, preventDefault() {} } as any);

  it("does NOT undo while typing in a field (native text-undo must win)", () => {
    exec("add computer PC1 at 0 0");
    exec("add computer PC2 at 100 0");
    expect(state.devices).toHaveLength(2);
    ctrlZ({ tagName: "INPUT" });
    expect(state.devices).toHaveLength(2); // topology unchanged
  });

  it("undoes when focus is not in a text field", () => {
    exec("add computer PC1 at 0 0");
    exec("add computer PC2 at 100 0");
    ctrlZ({});
    expect(state.devices).toHaveLength(1);
  });
});
