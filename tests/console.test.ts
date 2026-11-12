/**
 * The command console pane (console.ts) and the ribbon (ribbon.ts). Neither had
 * a test: the preload's DOM stub was a single shared object that could not
 * dispatch events, so there was nothing to drive them with (review R114). The
 * stub now gives one element per id with working listeners.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { state } from "../src/state";
import { dom } from "../src/dom";
import { openConsole, syncConsole, consoleLine, submitConsoleCommand, handleConsoleKeydown } from "../src/console";
import { setupRibbon, renderScenarioOptions } from "../src/ribbon";
import { SCENARIOS, registerScenario, unregisterScenario } from "../src/scenarios";
import { SCENARIO_GROUPS } from "../src/scenario-library";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());
beforeEach(() => { resetState(); dom.consoleInput.value = ""; dom.consoleOutput.innerHTML = ""; });

const submit = (command: string) => {
  dom.consoleInput.value = command;
  let prevented = false;
  submitConsoleCommand({ preventDefault() { prevented = true; } } as unknown as Event);
  return prevented;
};
const key = (name: string) => handleConsoleKeydown({ key: name, preventDefault() {} } as unknown as KeyboardEvent);
const texts = () => state.console.lines.map(l => l.text);

describe("the test DOM stub gives one element per id (R114)", () => {
  it("different ids are different elements with their own state; the same id is the same element", () => {
    expect(dom.consoleInput).not.toBe(dom.consoleOutput);
    expect(dom.modeLabel).not.toBe(dom.terminalInput);
    expect(document.getElementById("modeLabel")).toBe(dom.modeLabel);
    dom.modeLabel.textContent = "status";
    expect(dom.terminalInput.textContent).toBe("");
    dom.consoleInput.value = "typed";
    expect(dom.terminalInput.value).toBe("");
  });

  it("listeners run on dispatch, on the element they were added to", () => {
    const seen: string[] = [];
    const first = document.createElement("button"), second = document.createElement("button");
    first.addEventListener("click", () => seen.push("first"));
    second.addEventListener("click", () => seen.push("second"));
    first.click();
    expect(seen).toEqual(["first"]);
    const listener = () => seen.push("again");
    second.addEventListener("change", listener);
    second.removeEventListener("change", listener);
    second.dispatchEvent({ type: "change" } as any);
    expect(seen).toEqual(["first"]);
  });

  it("classList and attributes hold what was set", () => {
    const element = document.createElement("div");
    element.classList.toggle("active", true);
    expect(element.classList.contains("active")).toBe(true);
    element.classList.toggle("active");
    expect(element.classList.contains("active")).toBe(false);
    element.setAttribute("aria-expanded", "true");
    expect(element.getAttribute("aria-expanded")).toBe("true");
    expect(element.getAttribute("missing")).toBeNull();
  });

  it("URL is still the real constructor, with the object-URL statics added", () => {
    expect(new URL("http://localhost:8767/x?y=1").searchParams.get("y")).toBe("1");
    expect(URL.createObjectURL({} as any)).toBe("blob:stub");
  });
});

describe("console pane — submitting commands", () => {
  it("echoes the command, runs it, prints the result and clears the input", () => {
    expect(submit("add computer PC1 at 100 100")).toBe(true);     // the form submit is always prevented
    expect(texts()).toEqual(["routesim> add computer PC1 at 100 100", "Added computer PC1 at 100,100."]);
    expect(state.console.lines.map(l => l.kind)).toEqual(["command", ""]);
    expect(dom.consoleInput.value).toBe("");
    expect(state.devices.map(d => d.name)).toEqual(["PC1"]);
  });

  it("a failing command prints its reason as an error line", () => {
    submit("link NOPE NADA");
    expect(state.console.lines[1].kind).toBe("error");
    expect(state.console.lines[1].text).toContain("NOPE");
  });

  it("multi-line output becomes one line each, and the pane renders escaped HTML", () => {
    submit("add computer <b>PC</b>");
    submit("help");
    expect(state.console.lines.length).toBeGreaterThan(20);
    expect(dom.consoleOutput.innerHTML).toContain("&lt;b&gt;PC&lt;/b&gt;");
    expect(dom.consoleOutput.innerHTML).not.toContain("<b>PC</b>");
    expect(dom.consoleOutput.innerHTML).toContain('class="terminal-line command"');
  });

  it("an empty line runs nothing and adds nothing", () => {
    submit("   ");
    expect(state.console.lines).toEqual([]);
    expect(state.console.history).toEqual([]);
  });

  it("the scrollback is capped at 200 lines", () => {
    for (let i = 0; i < 12; i++) submit("help");
    expect(state.console.lines.length).toBe(200);
    expect(state.console.lines[199].text).not.toBe("");
  });
});

describe("console pane — history", () => {
  it("records each command once in a row, and walks it with the arrow keys", () => {
    submit("add computer A");
    submit("add computer B");
    submit("add computer B");                                     // an immediate repeat is not recorded twice
    expect(state.console.history).toEqual(["add computer A", "add computer B"]);
    key("ArrowUp");
    expect(dom.consoleInput.value).toBe("add computer B");
    key("ArrowUp");
    expect(dom.consoleInput.value).toBe("add computer A");
    key("ArrowUp");                                               // stays on the oldest
    expect(dom.consoleInput.value).toBe("add computer A");
    key("ArrowDown");
    expect(dom.consoleInput.value).toBe("add computer B");
    key("ArrowDown");                                             // past the newest: back to an empty line
    expect(dom.consoleInput.value).toBe("");
    expect(state.console.historyIndex).toBe(-1);
  });

  it("the arrows do nothing with no history, and other keys are left alone", () => {
    key("ArrowUp"); key("ArrowDown");
    expect(dom.consoleInput.value).toBe("");
    dom.consoleInput.value = "typing";
    key("a");
    expect(dom.consoleInput.value).toBe("typing");
  });

  it("history is capped at 100 commands", () => {
    for (let i = 0; i < 105; i++) submit(`speed ${500 + i}`);
    expect(state.console.history.length).toBe(100);
    expect(state.console.history[0]).toBe("speed 505");
  });
});

describe("console pane — opening and outside lines", () => {
  it("opens the dock on the console tab and greets once", () => {
    openConsole();
    expect(state.dock.open).toBe(true);
    expect(state.dock.activeTab).toBe("console");
    expect(texts()[0]).toContain("RouteSim console");
    openConsole();
    expect(texts().filter(t => t.includes("RouteSim console")).length).toBe(1);
  });

  it("consoleLine appends from outside the command flow and re-renders", () => {
    consoleLine("muted", "Shortcuts:\nV select");
    expect(texts()).toEqual(["Shortcuts:", "V select"]);
    syncConsole();
    expect(dom.consoleOutput.innerHTML).toContain("V select");
  });
});

describe("ribbon", () => {
  const realQueryAll = document.querySelectorAll;
  afterEach(() => { (document as any).querySelectorAll = realQueryAll; });

  // Stand-in tabs and panels, as the template has them: one per data-tab.
  function mountRibbon(names: string[]) {
    const make = (name: string) => { const element = document.createElement("div"); element.dataset.tab = name; return element; };
    const tabs = names.map(make), panels = names.map(make);
    (document as any).querySelectorAll = (selector: string) => selector === ".ribbon-tab" ? tabs : selector === ".ribbon-panel" ? panels : [];
    return { tabs, panels };
  }
  const active = (elements: any[]) => elements.filter(e => e.classList.contains("active")).map(e => e.dataset.tab);

  it("clicking a tab shows its panel and hides the others", () => {
    const { tabs, panels } = mountRibbon(["main", "file", "view", "help"]);
    setupRibbon();
    tabs[1].click();
    expect(active(tabs)).toEqual(["file"]);
    expect(active(panels)).toEqual(["file"]);
    tabs[3].click();
    expect(active(tabs)).toEqual(["help"]);
    expect(active(panels)).toEqual(["help"]);
  });

  it("the scenario menu lists every scenario exactly once, in the curated group order", () => {
    renderScenarioOptions();
    const html: string = dom.scenarioMenu.innerHTML;
    for (const scenario of SCENARIOS) {
      expect(html.split(`data-id="${scenario.id}"`).length - 1, scenario.id).toBe(1);
    }
    const label = (text: string) => `<span>${text.replace(/&/g, "&amp;")}</span>`;      // as escapeHtml writes it
    const positions = SCENARIO_GROUPS.map(group => html.indexOf(label(group.label)));
    expect(positions.every(p => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html).not.toContain("<span>Other</span>");            // every built-in scenario is grouped
  });

  it("an imported scenario outside the curated groups appears under its own group, or Other", () => {
    const base = { description: "", objective: "", topology: { devices: [], links: [] }, checks: [] };
    registerScenario({ ...base, id: "zz-imported-a", name: "Imported <A>", group: "My course" } as any);
    registerScenario({ ...base, id: "zz-imported-b", name: "Imported B" } as any);
    try {
      renderScenarioOptions();
      const html: string = dom.scenarioMenu.innerHTML;
      expect(html).toContain("<span>My course</span>");
      expect(html).toContain("<span>Other</span>");
      expect(html).toContain("Imported &lt;A&gt;");               // names are escaped
      const lastCurated = SCENARIO_GROUPS[SCENARIO_GROUPS.length - 1].label.replace(/&/g, "&amp;");
      expect(html.indexOf("<span>My course</span>")).toBeGreaterThan(html.indexOf(`<span>${lastCurated}</span>`));
    } finally {
      unregisterScenario("zz-imported-a"); unregisterScenario("zz-imported-b");
      renderScenarioOptions();
    }
  });
});
