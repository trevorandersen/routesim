/**
 * Every path that replaces the topology or runs over the simulation state must
 * tear an active run down through the engine's own stopSimulation (bridged via
 * the callback registry) and leave diagnoseState clean. F13 closed clearNetwork
 * and applyConfigWithoutUndo; these pin the remaining doors — undo, redo,
 * scenario Check — plus the two lifecycle leaks found alongside them.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { state, registerCallbacks, undo, redo, networkSnapshot } from "../src/state";
import { registerNoopCallbacks, resetState } from "./helpers";
import { basicTopology } from "./fixtures";
import { startSimulation, stopSimulation, runSimulationHeadless } from "../src/engine";
import { buildPingEvents } from "../src/simulation";
import { diagnoseState } from "../src/diagnostics";
import { runConsoleCommand as exec } from "../src/commands";
import { applyConfig } from "../src/config";
import { normaliseConfig } from "../src/normalise";
import { checkScenario } from "../src/scenarios";
import { runActiveScenarioCheck } from "../src/scenario-ui";
import { registerScenario, unregisterScenario } from "../src/scenarios";

let raf: any;
// The no-op set, plus the REAL engine teardown on the bridge. Registered after
// every resetState (which re-installs the plain no-op set).
const bridge = () => registerCallbacks({ render() {}, syncPanel() {}, syncTerminal() {}, resizeCanvas() {}, syncScenarioPanel() {}, syncCoordReadout() {}, syncOptionControls() {}, recomputeStp() {}, syncSimLog() {}, stopSimulation });
beforeAll(() => { registerNoopCallbacks(); raf = (globalThis as any).requestAnimationFrame; (globalThis as any).requestAnimationFrame = () => 0; });
afterAll(() => { (globalThis as any).requestAnimationFrame = raf; registerNoopCallbacks(); });
beforeEach(() => { resetState(); bridge(); });

function loadBasic() {
  const t = basicTopology(); state.devices = t.devices as any; state.links = t.links as any;
  return state.devices.find(d => d.id === "pc1")!;
}
function startRun(pc1: any) {
  startSimulation(buildPingEvents(pc1, "192.168.1.20") as any, pc1.id, "192.168.1.20");
  expect(state.simulation.status).toBe("running");
}
const settled = () => {
  expect(state.simulation.status).toBe("idle");
  expect(state.simulation.transits).toEqual([]);
  expect(state.simulation.events).toEqual([]);
  expect(diagnoseState(state)).toEqual([]);
};

describe("undo / redo tear an active run down first", () => {
  it("undo mid-run", () => {
    const pc1 = loadBasic();
    exec("add computer X at 900 900");
    startRun(pc1);                          // (a run start pushes its own undo entry — by design)
    undo();
    settled();
  });
  it("redo mid-run (it had no guard at all)", () => {
    // Starting a run clears the redo stack (any push does), so redo-during-a-run
    // is unreachable through the UI; the guard is defence — exercise it directly.
    const pc1 = loadBasic();
    startRun(pc1);
    state.redoStack.push(networkSnapshot());
    redo();
    settled();
  });
});

describe("restoreSnapshot drops terminal sessions for devices the topology lacks", () => {
  it("undoing an add removes its session and repoints the active terminal", () => {
    exec("add computer Y at 0 0");
    const y = state.devices.find(d => d.name === "Y")!;
    state.terminalSessions.push({ deviceId: y.id, mode: "exec", interfacePeerId: null, interfaceVlanTag: null, lines: [], history: [], historyIndex: -1 } as any);
    state.terminal = state.terminalSessions[0];
    undo();
    expect(state.terminalSessions).toEqual([]);
    expect(state.terminal.deviceId).toBeNull();
    expect(diagnoseState(state)).toEqual([]);
  });
});

describe("a topology load clears the link selection too", () => {
  it("selectedLinkId does not dangle", () => {
    const t = basicTopology(); state.devices = t.devices as any; state.links = t.links as any;
    state.selectedLinkId = state.links[0].id;
    applyConfig(normaliseConfig({ devices: [{ id: "a", type: "computer", name: "A", x: 0, y: 0, config: {} }], links: [] } as any));
    expect(state.selectedLinkId).toBeNull();
    expect(diagnoseState(state)).toEqual([]);
  });
});

describe("scenario Check and headless runs", () => {
  it("a headless run does not leave headless=true on the shared state", () => {
    const t = basicTopology(); state.devices = t.devices as any; state.links = t.links as any;
    const pc1 = state.devices.find(d => d.id === "pc1")!;
    runSimulationHeadless(buildPingEvents(pc1, "192.168.1.20") as any, pc1.id, "192.168.1.20");
    expect(state.simulation.headless).toBe(false);
  });
  it("Check during an animated run stops it through the bridge instead of replacing it", () => {
    startRun(loadBasic());
    registerScenario({ id: "__lc", name: "lc", objective: "", topology: {}, checks: [{ kind: "ping", from: "pc2", to: "pc1", label: "l" }] } as any);
    state.activeScenarioId = "__lc";
    try {
      runActiveScenarioCheck();
      // the checker's own headless run finishes as "done"; what matters is the
      // animated run was torn down first and nothing dangles
      expect(["idle", "done"]).toContain(state.simulation.status);
      expect(state.simulation.transits).toEqual([]);
      expect(state.simulation.headless).toBe(false);
      expect(diagnoseState(state)).toEqual([]);
    } finally { unregisterScenario("__lc"); state.activeScenarioId = null; }
  });
});
