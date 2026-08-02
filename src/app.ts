import { state, registerCallbacks, DEFAULT_THEME } from "./state";
import { registerDeviceCallbacks } from "./devices";
import { dom } from "./dom";
import { render, resizeCanvas, syncZoomLevel } from "./canvas";
import { syncPanel, syncOptionControls, syncNetworkPanel, setNetworkPanel, setInspectorWidth } from "./inspector";
import { syncTerminal, openTerminalFor, canOpenTerminal } from "./terminal";
import { syncConsole } from "./console";
import { syncScenarioPanel } from "./scenario-ui";
import { setupUI, setTool, setTheme, syncCoordReadout } from "./ui";
import { loadDefaultConfig } from "./config";
import { runStpConvergence } from "./stp";
import { setupTutorial } from "./tutorial";
import { runConsoleCommand, runConsoleScript, exportTopologyScript } from "./commands";
import { syncSimLog } from "./engine";
import { parseSettingsFromUrl, buildSettingsQuery } from "./settings-url";
import { diagnoseRuntimeState } from "./diagnostics";
import * as io from "./io";

// Register the callback bridge so any module can trigger render/syncPanel/etc.
registerCallbacks({
  render,
  syncPanel,
  syncTerminal,
  resizeCanvas,
  syncScenarioPanel,
  syncCoordReadout,
  syncOptionControls,
  // Recompute the spanning tree, then redraw so blocked links/roles show live
  // (the sim path recomputes too — see startSimulation/runSimulationHeadless).
  recomputeStp: () => { runStpConvergence(); render(); },
  syncSimLog,
});

// Register UI callbacks that devices.ts needs without circular imports.
// (A new cable no longer auto-boots a host — hosts stay unassigned until the
// user starts the simulation; see engine.startNetworkBoot, wired to Play.)
registerDeviceCallbacks({
  setTool,
  setNetworkPanel,
  openTerminal: (device) => { if (canOpenTerminal(device)) openTerminalFor(device); }
});

// Wire all UI event listeners (ribbon, canvas, panels)
setupUI();
// Wire the faux-cursor tutorial (its launch button + control bar).
setupTutorial();

// Programmatic scripting / automation API — drive the simulator from the browser
// console or an external harness. See docs/scripting.md.
(window as any).routesim = {
  exec: (line: string) => runConsoleCommand(line),
  run: (script: string) => runConsoleScript(script),
  export: () => exportTopologyScript(),
  snapshot: () => ({ devices: state.devices, links: state.links, simulation: state.simulation }),
  diagnose: () => diagnoseRuntimeState(),
  exportConfig: io.exportConfig, importConfig: io.importConfig,
  exportScenarios: io.exportScenarios, importScenario: io.importScenario,
  exportScript: io.exportScript, importScript: io.importScript,
  exportLog: io.exportLog, importLog: io.importLog,
  // URL settings plumbing: inspect what the current query string would apply,
  // and build a shareable query string from the live settings.
  urlSettings: () => parseSettingsFromUrl(window.location.search),
  settingsQuery: () => buildSettingsQuery(),
};

// Initialise the application (no network requests — defaults are built in).
function initialiseApp(): void {
  // Settings supplied via the URL query string override the built-in defaults
  // before any UI sync, so the controls render in their requested state.
  const urlSettings = parseSettingsFromUrl(window.location.search);
  Object.assign(state.options, urlSettings.options);
  if (urlSettings.speed != null) state.simulation.speed = urlSettings.speed;

  resizeCanvas();
  setInspectorWidth(state.inspectorWidth);
  state.pan = { x: dom.canvas.getBoundingClientRect().width / 2, y: dom.canvas.getBoundingClientRect().height / 2 };
  syncZoomLevel();
  setTheme(urlSettings.theme ?? DEFAULT_THEME);
  syncOptionControls();
  dom.simSpeed.value = String(state.simulation.speed);
  syncNetworkPanel();
  syncTerminal();
  syncConsole();
  syncScenarioPanel();
  loadDefaultConfig();
  syncPanel();
  render();

  // Surface any unrecognised URL settings rather than dropping them silently.
  if (urlSettings.ignored.length) {
    dom.modeLabel.textContent = `Ignored unknown URL setting${urlSettings.ignored.length > 1 ? "s" : ""}: ${urlSettings.ignored.join(", ")}.`;
  }
}

initialiseApp();
