/**
 * Shared test helpers — state management and callback registration.
 */
import { state, registerCallbacks, freshOptions, freshDockState, freshSimulationState, freshTerminalSession, DEFAULT_THEME, type SyncCallbacks } from "../src/state";
import { freshNameCounters } from "../src/device-registry";
import { setSeedOverride } from "../src/prng";

/**
 * Register no-op callbacks so sync() never crashes.
 * Call once in a top-level beforeAll. Pass the real implementation of any view
 * a suite asserts on — e.g. `registerNoopCallbacks({ syncTerminal })` for tests
 * of the terminal input lock: the engine reaches the views only through this
 * bridge, exactly as in the app.
 */
export function registerNoopCallbacks(real: Partial<SyncCallbacks> = {}): void {
  registerCallbacks({
    render: () => {},
    syncPanel: () => {},
    syncTerminal: () => {},
    resizeCanvas: () => {},
    syncScenarioPanel: () => {},
    syncCoordReadout: () => {},
    syncOptionControls: () => {},
    recomputeStp: () => {},
    syncSimLog: () => {},
    ...real,
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
  state.isApplyingCompositeChange = false;   // never let an aborted composite change (tutorial, import) leak
  state.tutorialActive = false;
  state.tool = "select";
  state.drag = null;
  state.panDrag = null;
  state.pointer = null;
  state.pan = { x: 0, y: 0 };
  state.scale = 1;
  state.portSelection = null;
  state.inspectedFrame = null;
  state.inspectedCapture = null;
  // The pieces below come from the app's own factories (state.ts), so the test
  // baseline IS the app's default and cannot drift from it.
  state.simulation = freshSimulationState();
  state.terminal = freshTerminalSession();
  state.terminalSessions = [];
  state.dock = freshDockState();
  state.savedCaptures = [];
  state.console = { lines: [], history: [], historyIndex: -1 };
  state.activeScenarioId = null;
  // Settings, auto-name counters, the config store and the pinned PRNG seed are
  // process-wide: a suite that turned on Auto-DHCP, added fifteen switches or
  // pinned a seed used to hand all of that to whichever file ran next.
  state.options = freshOptions();
  state.nameCounters = freshNameCounters();
  state.configStore = { version: 1, configs: {} };
  state.theme = DEFAULT_THEME;
  setSeedOverride(null);
}
