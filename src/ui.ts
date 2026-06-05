import { state, toolCopy, networkSnapshot, pushUndoSnapshot, undo } from "./state";
import { dom } from "./dom";
import { addDevice, addLink, deleteSelection, clearNetwork, findDeviceAt, findLinkAt, getDevice, configureDevice, openPortSelectionModal, confirmPortSelection, cancelPortSelection } from "./devices";
import { render, resizeCanvas, screenToWorld, setZoom, syncZoomLevel, fitNetwork } from "./canvas";
import { clearCssColorCache } from "./utils";
import { syncPanel, syncOptionControls, syncNetworkPanel, setNetworkPanel, toggleDisplayOptions, setInspectorWidth, startInspectorResize, moveInspectorResize, stopInspectorResize } from "./inspector";
import { openTerminalFor, closeTerminal, syncTerminal, submitTerminalCommand, handleTerminalKeydown } from "./terminal";
import { saveConfig, loadConfig, loadTopology, loadDefaultConfig, applyConfigWithoutUndo } from "./config";
import { normaliseConfig } from "./normalise";
import { defaultConfig } from "./state";
import { pauseSimulation, resumeSimulation, stepOnce, stopSimulation, updateSimControls, syncSimLog } from "./engine";
import { READONLY } from "./env";

export function setTool(tool: string): void {
  state.tool = tool;
  state.linkStartId = null;
  dom.toolButtons.forEach(button => button.classList.toggle("active", (button as HTMLElement).dataset.tool === tool));
  dom.modeLabel.textContent = toolCopy[tool][0];
  dom.hint.textContent = toolCopy[tool][1];
  dom.canvas.style.cursor = tool === "select" ? "default" : tool === "configure" ? "pointer" : "crosshair";
  render();
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
export function handleGlobalKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undo();
    return;
  }
  // Escape is handled before the input guard so it also works while a field
  // is focused (it blurs the field and reverts to the select tool).
  if (event.key === "Escape") {
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
    if (state.tool === "connect" && state.linkStartId) render();
  });

  dom.canvas.addEventListener("wheel", (event: WheelEvent) => {
    event.preventDefault();
    const pointer = pointerFromEvent(event);
    const factor = Math.exp(-event.deltaY * 0.0015);
    setZoom(state.scale * factor, pointer);
  }, { passive: false });

  window.addEventListener("keydown", handleGlobalKeydown);

  dom.loadButton.addEventListener("click", loadConfig);
  if (READONLY) {
    dom.saveButton.style.display = "none";
  } else {
    dom.saveButton.addEventListener("click", saveConfig);
  }
  dom.undoButton.addEventListener("click", undo);
  dom.clearButton.addEventListener("click", clearNetwork);
  dom.topologyButton.addEventListener("click", () => {
    const open = dom.topologyMenu.classList.toggle("open");
    dom.topologyButton.setAttribute("aria-expanded", String(open));
  });
  dom.topologyMenu.querySelectorAll(".topology-option").forEach((btn: Element) => {
    btn.addEventListener("click", () => {
      const name = (btn as HTMLElement).dataset.topology || "basic";
      dom.topologyMenu.classList.remove("open");
      dom.topologyButton.setAttribute("aria-expanded", "false");
      loadTopology(name);
    });
  });
  document.addEventListener("click", (event) => {
    if (!dom.topologyMenu.classList.contains("open")) return;
    const chooser = document.getElementById("topologyChooser");
    if (chooser && !chooser.contains(event.target as Node)) {
      dom.topologyMenu.classList.remove("open");
      dom.topologyButton.setAttribute("aria-expanded", "false");
    }
  });
  dom.fitButton.addEventListener("click", fitNetwork);
  dom.themeButton.addEventListener("click", toggleTheme);
  dom.terminalOpenButton.addEventListener("click", () => openTerminalFor(getDevice(state.selectedId)));
  dom.terminalCloseButton.addEventListener("click", closeTerminal);
  dom.terminalForm.addEventListener("submit", submitTerminalCommand);
  dom.terminalInput.addEventListener("keydown", handleTerminalKeydown);
  dom.inspectorOpenButton.addEventListener("click", () => setNetworkPanel(!state.options.networkPanelOpen));
  dom.inspectorCloseButton.addEventListener("click", () => setNetworkPanel(false));
  dom.inspectorResizeHandle.addEventListener("pointerdown", startInspectorResize as any);
  window.addEventListener("pointermove", moveInspectorResize as any);
  window.addEventListener("pointerup", stopInspectorResize);
  window.addEventListener("pointercancel", stopInspectorResize);
  dom.displayOptionsButton.addEventListener("click", toggleDisplayOptions);
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
}
