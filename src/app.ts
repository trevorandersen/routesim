import { state, registerCallbacks, defaultConfig } from "./state";
import { registerDeviceCallbacks } from "./devices";
import { dom } from "./dom";
import { normaliseConfig } from "./normalise";
import { render, resizeCanvas, screenToWorld, syncZoomLevel, fitNetwork } from "./canvas";
import { syncPanel, syncOptionControls, syncNetworkPanel, setNetworkPanel, setInspectorWidth } from "./inspector";
import { syncTerminal } from "./terminal";
import { setupUI, setTool, setTheme } from "./ui";
import { loadDefaultConfig, applyConfigWithoutUndo } from "./config";
import { runConsoleCommand, runConsoleScript, exportTopologyScript } from "./commands";

// Register the callback bridge so any module can trigger render/syncPanel/syncTerminal
registerCallbacks({
  render,
  syncPanel,
  syncTerminal,
  resizeCanvas
});

// Register UI callbacks that devices.ts needs without circular imports
registerDeviceCallbacks({
  setTool,
  setNetworkPanel
});

// Wire all UI event listeners
setupUI();

// Programmatic scripting API — drive the simulator from the browser console or
// an external harness. See docs/scripting.md.
(window as any).routesim = {
  exec: (line: string) => runConsoleCommand(line),
  run: (script: string) => runConsoleScript(script),
  export: () => exportTopologyScript(),
  snapshot: () => ({ devices: state.devices, links: state.links, simulation: state.simulation }),
};

// Initialise the application
async function initialiseApp() {
  resizeCanvas();
  setInspectorWidth(state.inspectorWidth);
  state.pan = { x: dom.canvas.getBoundingClientRect().width / 2, y: dom.canvas.getBoundingClientRect().height / 2 };
  syncZoomLevel();
  setTheme("dark");
  syncOptionControls();
  syncNetworkPanel();
  syncTerminal();
  try {
    await loadDefaultConfig();
  } catch (error) {
    applyConfigWithoutUndo(normaliseConfig(defaultConfig));
    dom.hint.textContent = "Loaded default topology.";
  }
  syncPanel();
  render();
}

initialiseApp();
