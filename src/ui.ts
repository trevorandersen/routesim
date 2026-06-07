import { state, toolCopy, networkSnapshot, pushUndoSnapshot, undo } from "./state";
import { dom } from "./dom";
import { addDevice, addLink, deleteSelection, clearNetwork, findDeviceAt, findLinkAt, getDevice, configureDevice, openPortSelectionModal, confirmPortSelection, cancelPortSelection } from "./devices";
import { render, resizeCanvas, screenToWorld, setZoom, syncZoomLevel, fitNetwork } from "./canvas";
import { clearCssColorCache } from "./utils";
import { syncPanel, syncOptionControls, syncNetworkPanel, setNetworkPanel, setInspectorWidth, startInspectorResize, moveInspectorResize, stopInspectorResize } from "./inspector";
import { openTerminalFor, closeTerminal, syncTerminal, submitTerminalCommand, handleTerminalKeydown } from "./terminal";
import { openConsole, closeConsole, submitConsoleCommand, handleConsoleKeydown } from "./console";
import { loadScenario } from "./scenarios";
import { runActiveScenarioCheck, dismissScenario } from "./scenario-ui";
import { loadTopology } from "./config";
import { pauseSimulation, resumeSimulation, stepOnce, stopSimulation } from "./engine";
import { setupRibbon, renderScenarioButtons } from "./ribbon";
import * as io from "./io";

export function setTool(tool: string): void {
  state.tool = tool;
  state.linkStartId = null;
  dom.toolButtons.forEach(button => button.classList.toggle("active", (button as HTMLElement).dataset.tool === tool));
  dom.modeLabel.textContent = toolCopy[tool][0];
  dom.hint.textContent = toolCopy[tool][1];
  dom.canvas.style.cursor = tool === "select" ? "default" : tool === "configure" ? "pointer" : "crosshair";
  render();
}

// Bottom-right readout: cursor world coords (while over the canvas) plus the
// selected device's coords.
export function updateCoordReadout(world: { x: number; y: number } | null): void {
  const parts: string[] = [];
  if (world) parts.push(`⌖ ${Math.round(world.x)}, ${Math.round(world.y)}`);
  const selected = getDevice(state.selectedId);
  if (selected) parts.push(`${selected.name}: ${Math.round(selected.x)}, ${Math.round(selected.y)}`);
  dom.coordReadout.textContent = parts.join("    ·    ");
}

// Registry callback — refreshes the readout on selection changes (keeps the
// cursor coords if the pointer is still over the canvas).
export function syncCoordReadout(): void {
  updateCoordReadout(state.pointer ? screenToWorld(state.pointer) : null);
}

export function pointerFromEvent(event: MouseEvent): { x: number; y: number } {
  const rect = dom.canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

export function setTheme(theme: string): void {
  state.theme = theme === "light" ? "light" : "dark";
  if (state.theme === "light") {
    document.documentElement.dataset.theme = "light";
  } else {
    delete document.documentElement.dataset.theme;
  }
  dom.themeButton.setAttribute("aria-pressed", String(state.theme === "light"));
  dom.themeButton.title = state.theme === "light" ? "Toggle dark mode" : "Toggle light mode";
  dom.themeButton.setAttribute("aria-label", dom.themeButton.title);
  clearCssColorCache();
  render();
}

export function toggleTheme(): void {
  setTheme(state.theme === "light" ? "dark" : "light");
}

export function bindOptionToggle(input: HTMLInputElement, optionKey: string): void {
  input.addEventListener("change", () => {
    (state.options as any)[optionKey] = input.checked;
    render();
  });
}

// Global keyboard shortcuts. Extracted from setupUI() so it can be unit-tested.
export function openAbout(): void { dom.aboutOverlay.classList.add("open"); }
export function closeAbout(): void { dom.aboutOverlay.classList.remove("open"); }

export function handleGlobalKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undo();
    return;
  }
  // Escape is handled before the input guard so it also works while a field
  // is focused (it blurs the field and reverts to the select tool).
  if (event.key === "Escape") {
    if (dom.aboutOverlay.classList.contains("open")) {
      closeAbout();
      return;
    }
    if (state.portSelection) {
      cancelPortSelection();
      return;
    }
    (document.activeElement as HTMLElement)?.blur?.();
    state.configuringId = null;
    state.linkStartId = null;
    state.selectedLinkId = null;
    setTool("select");
    return;
  }
  if (["INPUT", "SELECT", "TEXTAREA"].includes((event.target as HTMLElement)?.tagName)) return;
  if (event.key === "Delete" || event.key === "Backspace") deleteSelection();
  if (event.key.toLowerCase() === "v") setTool("select");
  if (event.key.toLowerCase() === "c") setTool("computer");
  if (event.key.toLowerCase() === "s") setTool("switch");
  if (event.key.toLowerCase() === "r") setTool("router");
  if (event.key.toLowerCase() === "l") setTool("connect");
  if (event.key.toLowerCase() === "w") setTool("configure");
}

export function setupUI(): void {
  dom.toolButtons.forEach(button => {
    button.addEventListener("click", () => setTool((button as HTMLElement).dataset.tool!));
  });

  dom.canvas.addEventListener("pointerdown", (event: PointerEvent) => {
    dom.canvas.setPointerCapture(event.pointerId);
    const pointer = pointerFromEvent(event);
    const world = screenToWorld(pointer);
    const device = findDeviceAt(world);

    if (state.tool === "computer" || state.tool === "switch" || state.tool === "router") {
      addDevice(state.tool, world.x, world.y);
      return;
    }

    if (state.tool === "connect") {
      if (!device) {
        state.linkStartId = null;
        render();
        return;
      }
      state.selectedLinkId = null;
      if (!state.linkStartId) {
        state.linkStartId = device.id;
        state.selectedId = device.id;
        dom.hint.textContent = `Connect ${device.name} to another device.`;
      } else {
        openPortSelectionModal(state.linkStartId, device.id);
        dom.hint.textContent = toolCopy.connect[1];
      }
      syncPanel();
      render();
      return;
    }

    if (state.tool === "configure") {
      state.selectedLinkId = null;
      if (device) {
        configureDevice(device);
      } else {
        state.selectedId = null;
        state.configuringId = null;
        syncPanel();
        render();
      }
      return;
    }

    if (device) {
      state.selectedId = device.id;
      state.selectedLinkId = null;
      state.configuringId = null;
      const dragSnapshot = networkSnapshot();
      state.drag = {
        id: device.id,
        dx: world.x - device.x,
        dy: world.y - device.y,
        undoSnapshot: dragSnapshot
      };
      state.panDrag = null;
    } else {
      const link = (state.tool === "select") ? findLinkAt(world) : null;
      if (link) {
        state.selectedId = null;
        state.selectedLinkId = link.id;
        state.configuringId = null;
        state.drag = null;
        state.panDrag = null;
        if (!state.options.networkPanelOpen) setNetworkPanel(true);
      } else {
        state.selectedId = null;
        state.selectedLinkId = null;
        state.configuringId = null;
        state.drag = null;
        state.panDrag = {
          startX: pointer.x,
          startY: pointer.y,
          panX: state.pan.x,
          panY: state.pan.y
        };
        dom.canvas.style.cursor = "grabbing";
      }
    }
    syncPanel();
    render();
  });

  dom.canvas.addEventListener("pointermove", (event: PointerEvent) => {
    state.pointer = pointerFromEvent(event);
    const world = screenToWorld(state.pointer);
    updateCoordReadout(world);

    if (state.drag) {
      const device = getDevice(state.drag.id);
      if (device) {
        device.x = world.x - state.drag.dx;
        device.y = world.y - state.drag.dy;
        render();
      }
      return;
    }

    if (state.panDrag) {
      state.pan.x = state.panDrag.panX + state.pointer.x - state.panDrag.startX;
      state.pan.y = state.panDrag.panY + state.pointer.y - state.panDrag.startY;
      dom.canvas.style.cursor = "grabbing";
      render();
      return;
    }

    const hovering = findDeviceAt(world);
    if (state.tool === "select") {
      const hoveringLink = !hovering ? findLinkAt(world) : null;
      dom.canvas.style.cursor = hovering ? "grab" : hoveringLink ? "pointer" : "move";
    } else if (state.tool === "connect") {
      dom.canvas.style.cursor = hovering ? "pointer" : "crosshair";
    } else if (state.tool === "configure") {
      dom.canvas.style.cursor = hovering ? "pointer" : "default";
    }
    if (state.tool === "connect" && state.linkStartId) render();
  });

  dom.canvas.addEventListener("dblclick", (event: MouseEvent) => {
    const device = findDeviceAt(screenToWorld(pointerFromEvent(event)));
    if (device) configureDevice(device);
  });

  dom.canvas.addEventListener("pointerup", () => {
    if (state.drag?.undoSnapshot && state.drag.undoSnapshot !== networkSnapshot()) {
      pushUndoSnapshot(state.drag.undoSnapshot);
    }
    state.drag = null;
    state.panDrag = null;
  });

  dom.canvas.addEventListener("pointerleave", () => {
    if (state.drag?.undoSnapshot && state.drag.undoSnapshot !== networkSnapshot()) {
      pushUndoSnapshot(state.drag.undoSnapshot);
    }
    state.pointer = null;
    state.drag = null;
    state.panDrag = null;
    updateCoordReadout(null);
    if (state.tool === "connect" && state.linkStartId) render();
  });

  dom.canvas.addEventListener("wheel", (event: WheelEvent) => {
    event.preventDefault();
    const pointer = pointerFromEvent(event);
    const factor = Math.exp(-event.deltaY * 0.0015);
    setZoom(state.scale * factor, pointer);
  }, { passive: false });

  window.addEventListener("keydown", handleGlobalKeydown);

  // ── Ribbon ──────────────────────────────────────────────────────────────────
  setupRibbon();

  // Most ribbon buttons are wired by data attribute (delegated so dynamically
  // rendered buttons — scenarios — work without re-binding).
  const ribbonActions: Record<string, () => void> = {
    "new": clearNetwork,
    "undo": undo,
    "delete": deleteSelection,
    "import-config": () => { void io.importConfig(); },
    "export-config": io.exportConfig,
    "import-scenario": () => { void io.importScenario().then(renderScenarioButtons); },
    "export-scenario": io.exportScenarios,
    "import-script": () => { void io.importScript(); },
    "export-script": io.exportScript,
    "import-log": () => { void io.importLog(); },
    "export-log": io.exportLog,
    "panel-network": () => setNetworkPanel(!state.options.networkPanelOpen),
    "panel-terminal": () => { closeConsole(); openTerminalFor(getDevice(state.selectedId)); },
    "panel-console": () => { closeTerminal(); openConsole(); },
    "panel-simlog": () => dom.simLogPanel.classList.toggle("active"),
    "theme": toggleTheme,
    "fit": fitNetwork,
    "scenario-check": runActiveScenarioCheck,
    "scenario-dismiss": dismissScenario,
    "help-shortcuts": () => { dom.hint.textContent = "Shortcuts: V select · C computer · S switch · R router · L connect · W configure · Del delete · Esc cancel · Ctrl/Cmd+Z undo · scroll to zoom."; },
    "help-commands": () => { closeTerminal(); openConsole(); },
    "help-about": openAbout,
  };
  document.addEventListener("click", (event) => {
    const el = (event.target as HTMLElement)?.closest?.("[data-action],[data-topology],[data-scenario]") as HTMLElement | null;
    if (!el) return;
    if (el.dataset.topology) { loadTopology(el.dataset.topology); return; }
    if (el.dataset.scenario) { loadScenario(el.dataset.scenario); return; }
    if (el.dataset.action) ribbonActions[el.dataset.action]?.();
  });

  // Scenario goal banner.
  dom.scenarioCheckButton.addEventListener("click", runActiveScenarioCheck);
  dom.scenarioCloseButton.addEventListener("click", dismissScenario);

  // Bottom panels: terminal & console share the bottom slot.
  dom.terminalCloseButton.addEventListener("click", closeTerminal);
  dom.terminalForm.addEventListener("submit", submitTerminalCommand);
  dom.terminalInput.addEventListener("keydown", handleTerminalKeydown);
  dom.consoleCloseButton.addEventListener("click", closeConsole);
  dom.consoleForm.addEventListener("submit", submitConsoleCommand);
  dom.consoleInput.addEventListener("keydown", handleConsoleKeydown);

  // Inspector (network) panel.
  dom.inspectorCloseButton.addEventListener("click", () => setNetworkPanel(false));
  dom.inspectorResizeHandle.addEventListener("pointerdown", startInspectorResize as any);
  window.addEventListener("pointermove", moveInspectorResize as any);
  window.addEventListener("pointerup", stopInspectorResize);
  window.addEventListener("pointercancel", stopInspectorResize);
  bindOptionToggle(dom.showDeviceNames, "showDeviceNames");
  bindOptionToggle(dom.showIpAddresses, "showIpAddresses");
  bindOptionToggle(dom.showMacAddresses, "showMacAddresses");
  window.addEventListener("resize", resizeCanvas);

  // Simulation controls
  dom.simPlayPause.addEventListener("click", () => {
    const sim = state.simulation;
    if (sim.status === "running") pauseSimulation();
    else if (sim.status === "paused") resumeSimulation();
  });
  dom.simStep.addEventListener("click", stepOnce);
  dom.simStop.addEventListener("click", () => {
    stopSimulation();
    dom.terminalInput.disabled = false;
  });
  dom.simSpeed.addEventListener("input", () => {
    state.simulation.speed = Number(dom.simSpeed.value) || 1000;
  });

  // Simulation log panel
  dom.simLogCloseButton.addEventListener("click", () => {
    dom.simLogPanel.classList.remove("active");
  });

  // Port selection modal
  dom.portSelectionConfirm.addEventListener("click", confirmPortSelection);
  dom.portSelectionCancel.addEventListener("click", cancelPortSelection);
  dom.portSelectionOverlay.addEventListener("click", (event) => {
    if (event.target === dom.portSelectionOverlay) cancelPortSelection();
  });

  // About modal
  dom.aboutClose.addEventListener("click", closeAbout);
  dom.aboutOverlay.addEventListener("click", (event) => {
    if (event.target === dom.aboutOverlay) closeAbout();
  });
}
