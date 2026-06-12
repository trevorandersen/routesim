/**
 * Shared test helpers — state management and callback registration.
 */
import { state, registerCallbacks } from "../src/state";

/**
 * Register no-op callbacks so sync() never crashes.
 * Call once in a top-level beforeAll.
 */
export function registerNoopCallbacks(): void {
  registerCallbacks({
    render: () => {},
    syncPanel: () => {},
    syncTerminal: () => {},
    resizeCanvas: () => {},
    syncScenarioPanel: () => {},
    syncCoordReadout: () => {},
  });
}

/**
 * Reset global state to a clean baseline between tests.
 */
export function resetState(): void {
  state.devices = [];
  state.links = [];
  state.selectedId = null;
  state.selectedLinkId = null;
  state.configuringId = null;
  state.linkStartId = null;
  state.undoStack = [];
  state.redoStack = [];
  state.tool = "select";
  state.drag = null;
  state.panDrag = null;
  state.pointer = null;
  state.pan = { x: 0, y: 0 };
  state.scale = 1;
  state.simulation = {
    status: "idle",
    mode: "ping",
    events: [],
    log: [],
    capture: [],
    transits: [],
    pendingArp: {},
    speed: 1000,
    autoPlay: false,
    stepTimer: null,
    animFrame: null,
  } as any;
  state.terminal = {
    deviceId: null,
    mode: "exec",
    interfacePeerId: null,
    interfaceVlanTag: null,
    lines: [],
    history: [],
    historyIndex: -1,
  };
  state.terminalSessions = [];
  state.dock = { open: false, activeTab: "terminal", height: 280, logView: "packets" };
  state.console = { lines: [], history: [], historyIndex: -1 };
  state.activeScenarioId = null;
}
