/**
 * Global keyboard handler tests. handleGlobalKeydown was extracted from
 * setupUI() so the shortcut/Escape logic can be unit-tested by passing plain
 * event-shaped objects.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state, THEMES, DEFAULT_THEME } from "../src/state";
import { handleGlobalKeydown, setTheme, toggleTheme } from "../src/ui";
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
