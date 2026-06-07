import { state, registerCallbacks, DEFAULT_THEME } from "./state";
import { registerDeviceCallbacks } from "./devices";
import { dom } from "./dom";
import { render, resizeCanvas, syncZoomLevel } from "./canvas";
import { syncPanel, syncOptionControls, syncNetworkPanel, setNetworkPanel, setInspectorWidth } from "./inspector";
import { syncTerminal } from "./terminal";
import { syncConsole } from "./console";
import { syncScenarioPanel } from "./scenario-ui";
import { setupUI, setTool, setTheme, syncCoordReadout } from "./ui";
import { loadDefaultConfig } from "./config";
import { runConsoleCommand, runConsoleScript, exportTopologyScript } from "./commands";
import * as io from "./io";

// Register the callback bridge so any module can trigger render/syncPanel/etc.
registerCallbacks({
  render,
  syncPanel,
  syncTerminal,
  resizeCanvas,
  syncScenarioPanel,
  syncCoordReadout
});

// Register UI callbacks that devices.ts needs without circular imports
registerDeviceCallbacks({
  setTool,
  setNetworkPanel
});

// Wire all UI event listeners (ribbon, canvas, panels)
setupUI();

// Programmatic scripting / automation API — drive the simulator from the browser
// console or an external harness. See docs/scripting.md.
(window as any).routesim = {
  exec: (line: string) => runConsoleCommand(line),
  run: (script: string) => runConsoleScript(script),
  export: () => exportTopologyScript(),
  snapshot: () => ({ devices: state.devices, links: state.links, simulation: state.simulation }),
  exportConfig: io.exportConfig, importConfig: io.importConfig,
  exportScenarios: io.exportScenarios, importScenario: io.importScenario,
  exportScript: io.exportScript, importScript: io.importScript,
  exportLog: io.exportLog, importLog: io.importLog,
};

// Initialise the application (no network requests — defaults are built in).
function initialiseApp(): void {
  resizeCanvas();
  setInspectorWidth(state.inspectorWidth);
  state.pan = { x: dom.canvas.getBoundingClientRect().width / 2, y: dom.canvas.getBoundingClientRect().height / 2 };
  syncZoomLevel();
  setTheme(DEFAULT_THEME);
  syncOptionControls();
  syncNetworkPanel();
  syncTerminal();
  syncConsole();
  syncScenarioPanel();
  loadDefaultConfig();
  syncPanel();
  render();
}

initialiseApp();
