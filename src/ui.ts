import { state, toolCopy, networkSnapshot, pushUndoSnapshot, undo, redo, THEMES, DEFAULT_THEME } from "./state";
import type { DisplayOptions } from "./types";
import { dom } from "./dom";
import { addLink, deleteSelection, clearNetwork, findDeviceAt, findLinkAt, getDevice, configureDevice, openPortSelectionModal, confirmPortSelection, cancelPortSelection, placeToolDevice, PLACEMENT_TOOLS, toggleLinkShutdown, linkName } from "./devices";
import { render, resizeCanvas, screenToWorld, setZoom, syncZoomLevel, fitNetwork, findTransitAt } from "./canvas";
import { clearCssColorCache } from "./utils";
import { syncPanel, syncOptionControls, syncNetworkPanel, setNetworkPanel, setInspectorWidth, startInspectorResize, moveInspectorResize, stopInspectorResize } from "./inspector";
import {
  openTerminalFor, syncTerminal, submitTerminalCommand, handleTerminalKeydown,
  toggleDockTab, closeDock, handleDockTabClick, startDockResize, moveDockResize, stopDockResize,
} from "./terminal";
import { openConsole, consoleLine, submitConsoleCommand, handleConsoleKeydown } from "./console";
import { loadScenario } from "./scenarios";
import { runActiveScenarioCheck, dismissScenario } from "./scenario-ui";
import { loadTopology } from "./config";
import { pauseSimulation, resumeSimulation, stepOnce, stopSimulation, syncSimLog, startNetworkBoot } from "./engine";
import { setupRibbon, renderScenarioOptions } from "./ribbon";
import * as io from "./io";

export function setTool(tool: string): void {
  state.tool = tool;
  state.linkStartId = null;
  syncToolGroups(tool); // reflect the active variant on its split-button face first
  dom.toolButtons.forEach(button => button.classList.toggle("active", (button as HTMLElement).dataset.tool === tool));
  dom.modeLabel.textContent = toolCopy[tool][0];
  dom.canvas.style.cursor = tool === "select" ? "default" : tool === "configure" ? "pointer" : "crosshair";
  render();
}

// Split-button tool groups (Endpoint / Switch / Security): when a grouped
// variant becomes active — by face click, menu pick, or keyboard shortcut —
// the owning group's face adopts that variant's icon + data-tool, and its menu
// marks the active item. Tools outside any group leave the faces untouched, so
// each group remembers its last-chosen variant.
function syncToolGroups(tool: string): void {
  const splits = [...document.querySelectorAll<HTMLElement>(".tool-split")];
  const split = splits.find(s => [...s.querySelectorAll<HTMLElement>(".tool-menu-item")].some(i => i.dataset.tool === tool));
  if (!split) return;
  const match = split.querySelector<HTMLElement>(`.tool-menu-item[data-tool="${tool}"]`)!;
  split.querySelectorAll<HTMLElement>(".tool-menu-item").forEach(i => i.classList.toggle("active", i === match));
  const face = split.querySelector<HTMLElement>(".tool-face");
  const faceSvg = face?.querySelector("svg");
  const itemSvg = match.querySelector("svg");
  if (face && faceSvg && itemSvg) {
    faceSvg.replaceWith(itemSvg.cloneNode(true));
    face.dataset.tool = tool;
  }
}

function closeToolMenus(): void {
  document.querySelectorAll<HTMLElement>(".tool-menu").forEach(m => { m.hidden = true; });
  document.querySelectorAll<HTMLElement>(".tool-caret").forEach(c => c.setAttribute("aria-expanded", "false"));
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
  // "light" is a back-compat alias for the default warm-light theme.
  const id = theme === "light" ? "warm-light" : theme;
  const known = THEMES.find(t => t.id === id) ? id : DEFAULT_THEME;
  state.theme = known;
  document.documentElement.dataset.theme = known;
  for (const btn of dom.themeButtons) {
    const active = btn.dataset.themeId === known;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  }
  clearCssColorCache();
  render();
}

// Cycle to the next theme in the registry (used by non-button callers).
export function toggleTheme(): void {
  const i = THEMES.findIndex(t => t.id === state.theme);
  setTheme(THEMES[(i + 1) % THEMES.length].id);
}

export function bindOptionToggle(input: HTMLInputElement, optionKey: keyof DisplayOptions): void {
  input.addEventListener("change", () => {
    state.options[optionKey] = input.checked;
    render();
  });
}

export function openAbout(): void {
  // Reset any drag position so it re-centres each time it opens.
  dom.aboutModal.style.position = "";
  dom.aboutModal.style.left = "";
  dom.aboutModal.style.top = "";
  dom.aboutModal.style.margin = "";
  dom.aboutOverlay.classList.add("open");
}
export function closeAbout(): void { dom.aboutOverlay.classList.remove("open"); }

// Settings is a right-docked pane (like the device-config inspector), not a
// modal: toggle a body class and reflow the canvas so the stage gives up width.
export function openSettings(): void {
  document.body.classList.add("settings-open");
  requestAnimationFrame(resizeCanvas);
}
export function closeSettings(): void {
  document.body.classList.remove("settings-open");
  requestAnimationFrame(resizeCanvas);
}

let aboutDrag: { dx: number; dy: number } | null = null;

function startAboutDrag(event: PointerEvent): void {
  if ((event.target as HTMLElement)?.closest("button")) return; // let the close button work
  const rect = dom.aboutModal.getBoundingClientRect();
  aboutDrag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
  // Pin the modal to its current spot, then move it freely.
  dom.aboutModal.style.position = "fixed";
  dom.aboutModal.style.margin = "0";
  dom.aboutModal.style.left = `${rect.left}px`;
  dom.aboutModal.style.top = `${rect.top}px`;
  dom.aboutHeader.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function moveAboutDrag(event: PointerEvent): void {
  if (!aboutDrag) return;
  const maxX = window.innerWidth - dom.aboutModal.offsetWidth;
  const maxY = window.innerHeight - dom.aboutModal.offsetHeight;
  const x = Math.min(Math.max(0, event.clientX - aboutDrag.dx), Math.max(0, maxX));
  const y = Math.min(Math.max(0, event.clientY - aboutDrag.dy), Math.max(0, maxY));
  dom.aboutModal.style.left = `${x}px`;
  dom.aboutModal.style.top = `${y}px`;
}

function endAboutDrag(event: PointerEvent): void {
  if (!aboutDrag) return;
  aboutDrag = null;
  try { dom.aboutHeader.releasePointerCapture(event.pointerId); } catch { /* already released */ }
}

// Global keyboard shortcuts. Extracted from setupUI() so it can be unit-tested.
export function handleGlobalKeydown(event: KeyboardEvent): void {
  const inField = ["INPUT", "SELECT", "TEXTAREA"].includes((event.target as HTMLElement)?.tagName);
  // Undo/redo — but NOT while typing in a field: there, Ctrl/Cmd+Z must drive
  // the browser's native text undo, not revert an unrelated topology change.
  if (!inField && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) redo(); else undo();
    return;
  }
  if (!inField && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redo();
    return;
  }
  // Escape is handled before the input guard so it also works while a field
  // is focused (it blurs the field and reverts to the select tool).
  if (event.key === "Escape") {
    if (dom.aboutOverlay.classList.contains("open")) {
      closeAbout();
      return;
    }
    if (document.body.classList.contains("settings-open")) {
      closeSettings();
      return;
    }
    if (state.portSelection) {
      cancelPortSelection();
      return;
    }
    closeToolMenus();
    (document.activeElement as HTMLElement)?.blur?.();
    state.configuringId = null;
    state.linkStartId = null;
    state.selectedLinkId = null;
    setTool("select");
    return;
  }
  if (inField) return;
  if (event.key === "Delete" || event.key === "Backspace") deleteSelection();
  if (event.key.toLowerCase() === "v") setTool("select");
  if (event.key.toLowerCase() === "c") setTool("computer");
  if (event.key.toLowerCase() === "e") setTool("server");
  if (event.key.toLowerCase() === "s") setTool("switch");
  if (event.key.toLowerCase() === "r") setTool("router");
  if (event.key.toLowerCase() === "f") setTool("firewall");
  if (event.key.toLowerCase() === "h") setTool("hub");
  if (event.key.toLowerCase() === "l") setTool("connect");
  if (event.key.toLowerCase() === "w") setTool("configure");
}

export function setupUI(): void {
  dom.toolButtons.forEach(button => {
    button.addEventListener("click", () => setTool((button as HTMLElement).dataset.tool!));
  });

  // Split-button tool groups: the caret opens its variant menu; a menu item
  // activates that variant. Any other click (incl. a face/canvas click) closes
  // the menus via the document handler below.
  document.querySelectorAll<HTMLElement>(".tool-caret").forEach(caret => {
    const split = caret.parentElement!;
    const menu = split.querySelector<HTMLElement>(".tool-menu");
    caret.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!menu) return;
      const willOpen = menu.hidden;
      closeToolMenus();
      if (willOpen) {
        // The menu is position:fixed (escapes the ribbon's scroll clip), so
        // anchor it under the split each time it opens.
        const rect = split.getBoundingClientRect();
        menu.style.left = `${rect.left}px`;
        menu.style.top = `${rect.bottom + 4}px`;
        menu.hidden = false;
        caret.setAttribute("aria-expanded", "true");
      }
    });
  });
  document.querySelectorAll<HTMLElement>(".tool-menu-item").forEach(item => {
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      setTool(item.dataset.tool!);
      closeToolMenus();
    });
  });
  document.addEventListener("click", () => closeToolMenus());

  dom.canvas.addEventListener("pointerdown", (event: PointerEvent) => {
    // Synthetic events (UI automation/tests) carry pointer ids the browser
    // doesn't know — capture is best-effort, never fatal.
    try { dom.canvas.setPointerCapture(event.pointerId); } catch { /* synthetic event */ }
    const pointer = pointerFromEvent(event);
    const world = screenToWorld(pointer);
    const device = findDeviceAt(world);

    if (PLACEMENT_TOOLS.has(state.tool)) {
      placeToolDevice(state.tool, world.x, world.y);
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
        dom.modeLabel.textContent = `Connect ${device.name} to another device.`;
      } else {
        openPortSelectionModal(state.linkStartId, device.id);
        dom.modeLabel.textContent = toolCopy.connect[1];
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

    // Click-a-packet: in select mode a transit dot takes priority. Capture the
    // frame, pause the simulation, and show the field breakdown.
    if (state.tool === "select") {
      const transit = findTransitAt(world);
      if (transit) {
        state.inspectedFrame = transit.frame;
        state.inspectedCapture = null; // a canvas-dot pick is not a packet-list row
        pauseSimulation();
        if (!state.options.networkPanelOpen) setNetworkPanel(true);
        syncPanel();
        render();
        syncSimLog(); // highlight the frame's packet-list row
        return;
      }
    }
    if (state.inspectedFrame) {
      state.inspectedFrame = null; // clicking elsewhere dismisses the frame panel
      state.inspectedCapture = null;
      syncSimLog();
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
    const world = screenToWorld(pointerFromEvent(event));
    const device = findDeviceAt(world);
    if (device) { configureDevice(device); return; }
    // Double-clicking a link toggles its admin status (up ⇄ shut).
    const link = findLinkAt(world);
    if (link) {
      const updated = toggleLinkShutdown(link.id);
      if (updated) dom.modeLabel.textContent = `${linkName(updated)} is now ${updated.shutdown ? "administratively down (shut)" : "up"}.`;
    }
  });

  const endCanvasDrag = () => {
    if (state.drag?.undoSnapshot && state.drag.undoSnapshot !== networkSnapshot()) {
      pushUndoSnapshot(state.drag.undoSnapshot);
    }
    state.drag = null;
    state.panDrag = null;
  };
  dom.canvas.addEventListener("pointerup", endCanvasDrag);
  // A browser-cancelled (touch/pen) gesture won't fire pointerup — clean up too,
  // or the drag latches and the cursor sticks at "grabbing".
  dom.canvas.addEventListener("pointercancel", endCanvasDrag);

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
    "clear": clearNetwork,
    "undo": undo,
    "redo": redo,
    "delete": deleteSelection,
    "import-config": () => { void io.importConfig(); },
    "export-config": io.exportConfig,
    "import-scenario": () => { void io.importScenario().then(renderScenarioOptions); },
    "export-scenario": io.exportScenarios,
    "import-script": () => { void io.importScript(); },
    "export-script": io.exportScript,
    "import-log": () => { void io.importLog(); },
    "export-log": io.exportLog,
    "panel-network": () => setNetworkPanel(!state.options.networkPanelOpen),
    "panel-terminal": () => openTerminalFor(getDevice(state.selectedId)),
    "panel-console": () => openConsole(),
    "panel-simlog": () => toggleDockTab("simlog"),
    "fit": fitNetwork,
    "help-shortcuts": () => { openConsole(); consoleLine("output", "Shortcuts: V select · C computer · E server · S switch · R router · F firewall · H hub · L connect · W configure · Del delete · Esc cancel · Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z redo · scroll to zoom."); },
    "help-commands": () => openConsole(),
    "help-about": openAbout,
    "open-settings": openSettings,
  };
  document.addEventListener("click", (event) => {
    const el = (event.target as HTMLElement)?.closest?.("[data-action],[data-theme-id]") as HTMLElement | null;
    if (!el) return;
    if (el.dataset.themeId) { setTheme(el.dataset.themeId); return; }
    if (el.dataset.action) ribbonActions[el.dataset.action]?.();
  });

  // Topologies dropdown (File tab).
  dom.topologySelect.addEventListener("change", () => {
    const name = dom.topologySelect.value;
    if (name) loadTopology(name);
    dom.topologySelect.value = ""; // reset to the placeholder
  });

  // Scenarios dropdown (File tab).
  dom.scenarioSelect.addEventListener("change", () => {
    const id = dom.scenarioSelect.value;
    if (id) loadScenario(id);
    dom.scenarioSelect.value = ""; // reset to the placeholder
  });

  // Scenario goal banner.
  dom.scenarioCheckButton.addEventListener("click", runActiveScenarioCheck);
  dom.scenarioCloseButton.addEventListener("click", dismissScenario);

  // The bottom dock: terminal sessions, console, and sim log share one panel.
  dom.dockTabs.addEventListener("click", handleDockTabClick);
  dom.dockClose.addEventListener("click", closeDock);
  dom.dockResizeHandle.addEventListener("pointerdown", startDockResize as any);
  window.addEventListener("pointermove", moveDockResize as any);
  window.addEventListener("pointerup", stopDockResize);
  window.addEventListener("pointercancel", stopDockResize);
  dom.terminalForm.addEventListener("submit", submitTerminalCommand);
  dom.terminalInput.addEventListener("keydown", handleTerminalKeydown);
  dom.consoleForm.addEventListener("submit", submitConsoleCommand);
  dom.consoleInput.addEventListener("keydown", handleConsoleKeydown);

  // Sim log: Packets/Events view toggle + click-a-row → frame breakdown
  // (same behaviour as clicking the transit dot on the canvas).
  document.querySelectorAll<HTMLElement>("[data-logview]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.dock.logView = btn.dataset.logview as "packets" | "events";
      syncSimLog();
    });
  });
  dom.simLogOutput.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest("tr[data-no]") as HTMLElement | null;
    if (!row) return;
    const entry = state.simulation.capture.find(c => c.no === Number(row.dataset.no));
    if (!entry) return;
    state.inspectedFrame = entry.frame;
    state.inspectedCapture = entry; // cross-link: highlight this wire + its endpoints on the canvas
    pauseSimulation();
    if (!state.options.networkPanelOpen) setNetworkPanel(true);
    syncPanel();
    render();
    syncSimLog();
  });

  // Inspector (network) panel. The close button lives in the panel heading,
  // which is rebuilt each sync, so it's wired by delegation.
  dom.detailsPanel.addEventListener("click", (event) => {
    if ((event.target as HTMLElement)?.closest?.("#inspectorCloseButton")) setNetworkPanel(false);
  });
  dom.inspectorResizeHandle.addEventListener("pointerdown", startInspectorResize as any);
  window.addEventListener("pointermove", moveInspectorResize as any);
  window.addEventListener("pointerup", stopInspectorResize);
  window.addEventListener("pointercancel", stopInspectorResize);
  bindOptionToggle(dom.showDeviceNames, "showDeviceNames");
  bindOptionToggle(dom.showIpAddresses, "showIpAddresses");
  bindOptionToggle(dom.showMacAddresses, "showMacAddresses");
  bindOptionToggle(dom.optAutoDhcp, "autoDhcp");
  bindOptionToggle(dom.optApipa, "apipaFallback");
  bindOptionToggle(dom.optSilentArp, "silentArp");
  bindOptionToggle(dom.optSilentDhcp, "silentDhcp");
  bindOptionToggle(dom.optSilentDns, "silentDns");
  bindOptionToggle(dom.optSilentWifi, "silentWifi");
  bindOptionToggle(dom.optSilentStp, "silentStp");
  bindOptionToggle(dom.optInstantDns, "instantDns");
  window.addEventListener("resize", resizeCanvas);

  // Simulation controls
  dom.simPlayPause.addEventListener("click", () => {
    const sim = state.simulation;
    if (sim.status === "running") pauseSimulation();
    else if (sim.status === "paused") resumeSimulation();
    // Idle: starting the sim boots any unconfigured cabled hosts (animated DHCP);
    // startNetworkBoot sets the status hint (incl. when auto-DHCP is off).
    else startNetworkBoot();
  });
  dom.simStep.addEventListener("click", stepOnce);
  dom.simStop.addEventListener("click", () => {
    stopSimulation();
    dom.terminalInput.disabled = false;
  });
  dom.simSpeed.addEventListener("input", () => {
    state.simulation.speed = Number(dom.simSpeed.value) || 1000;
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
  dom.settingsClose.addEventListener("click", closeSettings);
  dom.aboutHeader.addEventListener("pointerdown", startAboutDrag);
  dom.aboutHeader.addEventListener("pointermove", moveAboutDrag);
  dom.aboutHeader.addEventListener("pointerup", endAboutDrag);
  dom.aboutHeader.addEventListener("pointercancel", endAboutDrag);
}
