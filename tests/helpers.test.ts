/**
 * The test baseline itself (review R113). Bun runs every test file in one
 * process, sharing module state, so whatever `resetState()` leaves alone leaks
 * from one file into the next. It used to leave the settings, the auto-name
 * counters, the config store and the pinned PRNG seed alone, and it rebuilt the
 * simulation from a hand-written literal (cast `as any`) that had drifted from
 * the app's. It is now built from the app's own factories.
 */
import { describe, it, expect } from "bun:test";
import { state, freshOptions, freshDockState, freshSimulationState, freshTerminalSession, DEFAULT_THEME } from "../src/state";
import { freshNameCounters } from "../src/device-registry";
import { getSeedOverride, setSeedOverride } from "../src/prng";
import { runConsoleScript } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

registerNoopCallbacks();

describe("resetState restores the app's defaults (R113)", () => {
  it("every setting, the theme, the name counters, the config store and the seed", () => {
    for (const key of Object.keys(state.options) as (keyof typeof state.options)[]) (state.options as any)[key] = !freshOptions()[key];
    state.theme = "dark";
    runConsoleScript("add switch\nadd switch\nadd computer");            // auto-named: advances the counters
    state.configStore = { version: 1, configs: { saved: {} as any } };
    setSeedOverride(1234);
    expect(state.nameCounters.switch).toBeGreaterThan(freshNameCounters().switch);

    resetState();

    expect(state.options).toEqual(freshOptions());
    expect(state.theme).toBe(DEFAULT_THEME);
    expect(state.nameCounters).toEqual(freshNameCounters());
    expect(state.configStore).toEqual({ version: 1, configs: {} });
    expect(getSeedOverride()).toBeNull();
  });

  it("the simulation, dock and terminal are the app's own fresh state — no hand-written copy to drift", () => {
    state.simulation.status = "running";
    state.simulation.speed = 5;
    (state.simulation as any).leftover = true;
    state.dock.open = true;
    state.dock.logFilter.expr = "arp";
    state.terminal.mode = "config";

    resetState();

    expect(state.simulation).toEqual(freshSimulationState());
    expect(Object.keys(state.simulation).sort()).toEqual(Object.keys(freshSimulationState()).sort());
    expect(state.dock).toEqual(freshDockState());
    expect(state.terminal).toEqual(freshTerminalSession());
    expect(state.terminalSessions).toEqual([]);
  });

  it("the topology, selection, undo history and transient UI state are cleared", () => {
    runConsoleScript("add computer PC at 0 0\nadd switch SW at 100 0\nlink PC SW");
    state.selectedId = state.devices[0].id;
    state.isApplyingCompositeChange = true;
    state.tutorialActive = true;
    state.activeScenarioId = "connect-lan";
    state.savedCaptures = [{ id: "cap-1", index: 1, label: "x", mode: "ping", entries: [] }];

    resetState();

    expect(state.devices).toEqual([]);
    expect(state.links).toEqual([]);
    expect([state.selectedId, state.selectedLinkId, state.configuringId, state.linkStartId]).toEqual([null, null, null, null]);
    expect([state.undoStack.length, state.redoStack.length]).toEqual([0, 0]);
    expect([state.isApplyingCompositeChange, state.tutorialActive, state.activeScenarioId]).toEqual([false, false, null]);
    expect(state.savedCaptures).toEqual([]);
  });

  it("the factories hand out independent objects (a test cannot poison the default)", () => {
    const first = freshOptions(); first.autoDhcp = true;
    freshSimulationState().log.push({} as any);
    freshDockState().logFilter.protocols.push("arp");
    expect(freshOptions().autoDhcp).toBe(false);
    expect(freshSimulationState().log).toEqual([]);
    expect(freshDockState().logFilter.protocols).toEqual([]);
  });
});
