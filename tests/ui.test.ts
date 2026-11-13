/**
 * Global keyboard handler tests. handleGlobalKeydown was extracted from
 * setupUI() so the shortcut/Escape logic can be unit-tested by passing plain
 * event-shaped objects.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state, THEMES, DEFAULT_THEME, undo as undoState, redo as redoState } from "../src/state";
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
