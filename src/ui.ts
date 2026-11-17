import { state, toolCopy, networkSnapshot, pushUndoSnapshot, pushUndo, undo, redo, undoBlockReason, THEMES, DEFAULT_THEME } from "./state";
import type { DisplayOptions } from "./types";
import { dom } from "./dom";
import { addLink, deleteSelection, clearNetwork, findDeviceAt, findLinkAt, getDevice, configureDevice, placeToolDevice, PLACEMENT_TOOLS, toggleLinkShutdown, setDevicePower, linkName } from "./devices";
import { openPortSelectionModal, confirmPortSelection, cancelPortSelection } from "./port-picker";
import { showDialog, hideDialog } from "./dialog";
import { render, resizeCanvas, screenToWorld, setZoom, syncZoomLevel, fitNetwork, findTransitAt } from "./canvas";
import { clearCssColorCache, escapeHtml, mutationText } from "./utils";
import { syncPanel, syncOptionControls, syncNetworkPanel, setNetworkPanel, setInspectorWidth, startInspectorResize, moveInspectorResize, stopInspectorResize } from "./inspector";
import {
  openTerminalFor, syncTerminal, submitTerminalCommand, handleTerminalKeydown, terminalLine, canOpenTerminal,
  toggleDockTab, closeDock, handleDockTabClick, startDockResize, moveDockResize, stopDockResize,
} from "./terminal";
import { openConsole, consoleLine, submitConsoleCommand, handleConsoleKeydown } from "./console";
import { buildHelpHtml } from "./help";
import { loadScenario } from "./scenarios";
import { runActiveScenarioCheck, dismissScenario, collapseScenario, expandScenario } from "./scenario-ui";
import { loadTopology } from "./config";
import { pauseSimulation, resumeSimulation, stepOnce, stopSimulation, startNetworkBoot, captureEntriesFor } from "./engine";
import { launchRedTeam } from "./security/offensive/red-team";
import { syncSimLog } from "./simlog-view";
import { setupRibbon, renderScenarioOptions } from "./ribbon";
import * as io from "./io";

// Appended to the status line while a placement tool is armed, so the way out of
// place mode is always on screen (issue #3).
export const PLACEMENT_HINT = "click to place, right-click or Esc to stop";

// A press that is not the primary button: middle, right, or — on a Mac, where it
// is the one-button secondary click and is followed by `contextmenu` — Ctrl+click.
// Elsewhere Ctrl+click is an ordinary click. `platform` is a parameter for tests.
export function isSecondaryPress(
  event: { button?: number; ctrlKey?: boolean },
  platform: string = typeof navigator !== "undefined" ? navigator.platform || "" : "",
): boolean {
  if ((event.button ?? 0) > 0) return true;
  return !!event.ctrlKey && /Mac|iPhone|iPad/.test(platform);
}

export function setTool(tool: string): void {
  state.tool = tool;
  state.linkStartId = null;
  syncToolGroups(tool); // reflect the active variant on its split-button face first
  dom.toolButtons.forEach(button => {
    const active = (button as HTMLElement).dataset.tool === tool;
    button.classList.toggle("active", active);
    // The armed tool is a toggle state: say so, not only by colour.
    button.setAttribute("aria-pressed", String(active));
  });
  dom.modeLabel.textContent = PLACEMENT_TOOLS.has(tool) ? `${toolCopy[tool][0]} — ${PLACEMENT_HINT}` : toolCopy[tool][0];
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

// Close the scenario flyout (the top menu and any open submenu).
function closeScenarioMenu(): void {
  dom.scenarioMenu.hidden = true;
  dom.scenarioMenu.querySelectorAll<HTMLElement>(".scenario-submenu").forEach(s => { s.hidden = true; });
  dom.scenarioMenu.querySelectorAll<HTMLElement>(".scenario-group").forEach(g => g.setAttribute("aria-expanded", "false"));
  dom.scenarioMenuButton.setAttribute("aria-expanded", "false");
}

// Ctrl+C in a terminal/console cancels a running (or paused) simulation, like a
// shell sending SIGINT — echoes ^C and stops. Only intercepts when there's a sim
// to interrupt (so an idle terminal's Ctrl+C, and Mac's Cmd+C copy, are untouched).
function interruptSimOnCtrlC(event: KeyboardEvent, pane: "terminal" | "console"): boolean {
  if (event.key !== "c" || !event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
  const status = state.simulation.status;
  if (status !== "running" && status !== "paused") return false;
  event.preventDefault();
  const input = pane === "terminal" ? dom.terminalInput : dom.consoleInput;
  const echo = `${input.value}^C`;
  input.value = "";
  if (pane === "terminal") terminalLine("", echo); else consoleLine("error", echo);
  stopSimulation();   // syncTerminal unlocks the input (the lock follows sim.status)
  return true;
}

// Play/pause: while running pause, while paused resume; idle boots any
// unconfigured cabled hosts (animated DHCP) or, with nothing to boot, lets a
// ready Red Team host launch its attacks. Shared by the ribbon + the floating pill.
function handleSimPlayPause(): void {
  const sim = state.simulation;
  if (sim.status === "running") pauseSimulation();
  else if (sim.status === "paused") resumeSimulation();
  else if (!startNetworkBoot()) launchRedTeam();
}

// Right-click device context menu (Terminal / Configure / Power / Delete) —
// quick access to the actions otherwise reached via the inspector/ribbon.
let contextActions: (() => void)[] = [];

function closeContextMenu(): void { dom.contextMenu.hidden = true; }

function openDeviceContextMenu(device: any, clientX: number, clientY: number): void {
  const items: { label: string; action: () => void; danger?: boolean }[] = [];
  if (canOpenTerminal(device)) items.push({ label: "Terminal", action: () => openTerminalFor(device) });
  if (device.type !== "lan") {
    items.push({ label: "Configure", action: () => configureDevice(device) });
    items.push({ label: device.poweredOff ? "Power on" : "Power off", action: () => toggleDevicePower(device) });
  }
  items.push({ label: "Delete", danger: true, action: () => { state.selectedId = device.id; state.selectedLinkId = null; deleteSelection(); } });
  contextActions = items.map(it => it.action);
  dom.contextMenu.innerHTML = items.map((it, i) =>
    `<button class="context-item${it.danger ? " danger" : ""}" data-i="${i}" type="button">${escapeHtml(it.label)}</button>`).join("");
  dom.contextMenu.hidden = false;
  // Position at the cursor, clamped inside the viewport.
  const w = dom.contextMenu.offsetWidth, h = dom.contextMenu.offsetHeight;
  dom.contextMenu.style.left = `${Math.min(clientX, window.innerWidth - w - 8)}px`;
  dom.contextMenu.style.top = `${Math.min(clientY, window.innerHeight - h - 8)}px`;
}

function toggleDevicePower(device: any): void {
  dom.modeLabel.textContent = mutationText(setDevicePower(device, !!device.poweredOff));
}

// Reset every dimension of the sim-log packet-list display filter.
function clearLogFilter(): void {
  state.dock.logFilter = { protocols: [], device: "", link: "", expr: "" };
  syncSimLog();
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
  showDialog(dom.aboutOverlay, document.getElementById("aboutClose"));
}
export function closeAbout(): void { hideDialog(dom.aboutOverlay); }

// The reference guide (Help → Guide): device + settings docs, rebuilt from
// help.ts on open so it always reflects the current registries.
export function openHelp(): void {
  // (Only the About modal is draggable — the Guide has no positioning to reset.)
  dom.helpBody.innerHTML = buildHelpHtml();
  dom.helpBody.scrollTop = 0;
  showDialog(dom.helpOverlay, document.getElementById("helpClose"));
}
export function closeHelp(): void { hideDialog(dom.helpOverlay); }

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
// Open a packet-list row's frame in the inspector (and glow its wire on the
// canvas). Shared by the click and the keyboard path; `refocus` puts focus back
// on the row afterwards, because the list is rebuilt and a keyboard user would
// otherwise be dropped at the top of the page.
export function inspectPacketRow(row: HTMLElement, refocus = false): void {
  // Rows carry data-cap so a click resolves against the right capture (the live
  // run, or a saved one shown via the capture selector / in compare mode).
  const capId = row.dataset.cap || "live";
  const no = row.dataset.no;
  const entry = captureEntriesFor(capId).find(c => c.no === Number(no));
  if (!entry) return;
  state.inspectedFrame = entry.frame;
  state.inspectedCapture = entry; // cross-link: highlight this wire + its endpoints on the canvas
  pauseSimulation();
  if (!state.options.networkPanelOpen) setNetworkPanel(true);
  syncPanel();
  render();
  syncSimLog();
  if (refocus) dom.simLogOutput.querySelector<HTMLElement>(`tr[data-no="${no}"][data-cap="${capId}"]`)?.focus?.();
}

// The packet list by keyboard: Enter or Space opens the focused row, the arrow
// keys move between rows. (Rows are focusable — tabindex in simlog-view.)
export function handlePacketRowKeydown(event: KeyboardEvent): void {
  const row = (event.target as HTMLElement)?.closest?.("tr[data-no]") as HTMLElement | null;
  if (!row) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    event.stopPropagation();          // Space here is "open", not the global pause shortcut
    inspectPacketRow(row, true);
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const next = (event.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null;
    if (next?.matches?.("tr[data-no]")) { event.preventDefault(); next.focus(); }
  }
}

// A modal dialog is up — the Guide, About, or the port picker. (The Settings
// pane is docked beside the canvas, not modal, so the canvas shortcuts stay.)
function modalDialogOpen(): boolean {
  return dom.helpOverlay.classList.contains("open")
    || dom.aboutOverlay.classList.contains("open")
    || state.portSelection !== null;
}

export function handleGlobalKeydown(event: KeyboardEvent): void {
  const inField = ["INPUT", "SELECT", "TEXTAREA"].includes((event.target as HTMLElement)?.tagName);
  // The tutorial owns the keyboard while it plays (its own listener handles Esc
  // and the arrow keys): the editing shortcuts would act on the demo network
  // behind the click-catcher, and an undo would pull the learner's saved network
  // out from under the demo. Typing in a field is left alone.
  if (state.tutorialActive) {
    const key = event.key.toLowerCase();
    if (!inField && (event.metaKey || event.ctrlKey) && (key === "z" || key === "y")) {
      event.preventDefault();
      dom.modeLabel.textContent = undoBlockReason() ?? "";
    }
    return;
  }
  // Undo/redo — but NOT while typing in a field: there, Ctrl/Cmd+Z must drive
  // the browser's native text undo, not revert an unrelated topology change.
  const undoKey = !inField && (event.metaKey || event.ctrlKey) && ["z", "y"].includes(event.key.toLowerCase());
  if (undoKey) {
    event.preventDefault();
    // Paused (the port dialog is open): say why instead of doing nothing.
    const paused = undoBlockReason();
    if (paused) dom.modeLabel.textContent = paused;
    else if (event.key.toLowerCase() === "y" || event.shiftKey) redo();
    else undo();
    return;
  }
  // Escape is handled before the input guard so it also works while a field
  // is focused (it blurs the field and reverts to the select tool).
  if (event.key === "Escape") {
    if (dom.helpOverlay.classList.contains("open")) {
      closeHelp();
      return;
    }
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
    closeScenarioMenu();
    closeContextMenu();
    (document.activeElement as HTMLElement)?.blur?.();
    state.configuringId = null;
    state.linkStartId = null;
    state.selectedLinkId = null;
    setTool("select");
    return;
  }
  if (inField) return;
  // A held Ctrl/Cmd/Alt makes the key a browser or OS shortcut, not one of
  // ours: Ctrl+C on text selected in the packet list or a terminal's scrollback
  // must copy, not arm the Computer tool (Cmd+F armed the Firewall tool, Ctrl+A
  // the Red Team one). Undo/redo, the only chords this handler owns, returned above.
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  // An open dialog owns the keyboard: Delete behind the Guide or About modal
  // deleted the selected device, unseen, and a letter armed a tool behind it.
  if (modalDialogOpen()) return;
  // Space pauses or resumes the run in flight — the shortcut the transport
  // pill's tooltip has always advertised and nothing implemented. Only while a
  // run is active (idle Space must not start a network boot), and not when a
  // button has focus, where Space is that button's own activation.
  if (event.key === " " || event.code === "Space") {
    const status = state.simulation.status;
    const onControl = ["BUTTON", "A", "SUMMARY"].includes((event.target as HTMLElement)?.tagName);
    if (!onControl && (status === "running" || status === "paused")) {
      event.preventDefault?.();   // do not scroll the page
      handleSimPlayPause();
    }
    return;
  }
  if (event.key === "Delete" || event.key === "Backspace") deleteSelection();
  if (event.key.toLowerCase() === "v") setTool("select");
  if (event.key.toLowerCase() === "c") setTool("computer");
  if (event.key.toLowerCase() === "e") setTool("server");
  if (event.key.toLowerCase() === "s") setTool("switch");
  if (event.key.toLowerCase() === "r") setTool("router");
  if (event.key.toLowerCase() === "f") setTool("firewall");
  if (event.key.toLowerCase() === "i") setTool("ids");
  if (event.key.toLowerCase() === "a") setTool("attacker");
  if (event.key.toLowerCase() === "k") setTool("kali");
  if (event.key.toLowerCase() === "h") setTool("hub");
  if (event.key.toLowerCase() === "l") setTool("connect");
  if (event.key.toLowerCase() === "w") setTool("configure");
}

// A press on the canvas: place, connect, configure, pick a packet, select, drag
// or pan, by the armed tool. A named export (like handleGlobalKeydown) so tests
// can drive it with event-shaped objects; setupUI registers it by reference.
export function handleCanvasPointerDown(event: PointerEvent): void {
  // Synthetic events (UI automation/tests) carry pointer ids the browser
  // doesn't know — capture is best-effort, never fatal.
  try { dom.canvas.setPointerCapture(event.pointerId); } catch { /* synthetic event */ }
  const pointer = pointerFromEvent(event);
  // A press is also where the cursor is. A mouse always moves here first, but a
  // touch or a scripted click does not, and the placement ghost and the connect
  // rubber band are drawn at state.pointer — so it must not be left stale.
  state.pointer = pointer;
  const world = screenToWorld(pointer);
  const device = findDeviceAt(world);

  if (PLACEMENT_TOOLS.has(state.tool)) {
    // Only the primary button places (issue #3). A right-click cancels place
    // mode — handled on `contextmenu`, which every platform fires for it (on
    // press on macOS/Linux, on release on Windows) — and a middle-click does
    // nothing rather than dropping a device.
    if (!isSecondaryPress(event)) placeToolDevice(state.tool, world.x, world.y);
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
      dom.modeLabel.textContent = `Connect ${device.name} to another device (Shift-click to choose ports).`;
    } else if (event.shiftKey) {
      // Shift-click: pick the exact ports by hand.
      openPortSelectionModal(state.linkStartId, device.id);
      dom.modeLabel.textContent = toolCopy.connect[1];
    } else {
      // Default: auto-pick the first available port on each end (addLink
      // resolves them) — no dialog. The status line shows what addLink
      // reports: the cable made, a warning, or why it was refused.
      dom.modeLabel.textContent = mutationText(addLink(state.linkStartId, device.id));
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
}

// Right-click on the canvas. With a placement tool armed it cancels place mode
// (back to the select tool) and opens nothing — the click that leaves place mode
// should not also act on whatever was under it. Otherwise: a device → its
// context menu; empty canvas closes the menu.
export function handleCanvasContextMenu(event: MouseEvent): void {
  event.preventDefault();
  if (PLACEMENT_TOOLS.has(state.tool)) {
    closeContextMenu();
    setTool("select");
    return;
  }
  const device = findDeviceAt(screenToWorld(pointerFromEvent(event)));
  if (!device) { closeContextMenu(); return; }
  state.selectedId = device.id;
  state.selectedLinkId = null;
  syncPanel();
  render();
  openDeviceContextMenu(device, event.clientX, event.clientY);
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
  document.addEventListener("click", () => { closeToolMenus(); closeScenarioMenu(); closeContextMenu(); });

  dom.canvas.addEventListener("pointerdown", handleCanvasPointerDown);

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
    // The connect rubber band and the placement ghost both follow the cursor.
    if ((state.tool === "connect" && state.linkStartId) || PLACEMENT_TOOLS.has(state.tool)) render();
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
    // Off the canvas there is no cursor to draw the rubber band or the ghost at.
    if ((state.tool === "connect" && state.linkStartId) || PLACEMENT_TOOLS.has(state.tool)) render();
  });

  dom.canvas.addEventListener("wheel", (event: WheelEvent) => {
    event.preventDefault();
    closeContextMenu();
    const pointer = pointerFromEvent(event);
    const factor = Math.exp(-event.deltaY * 0.0015);
    setZoom(state.scale * factor, pointer);
  }, { passive: false });

  dom.canvas.addEventListener("contextmenu", handleCanvasContextMenu);
  dom.contextMenu.addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest("[data-i]") as HTMLElement | null;
    if (!btn) return;
    const action = contextActions[Number(btn.dataset.i)];
    closeContextMenu();
    action?.();
  });

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
    "copy-link": () => { void io.copyShareLink(); },
    "panel-network": () => setNetworkPanel(!state.options.networkPanelOpen),
    "panel-terminal": () => openTerminalFor(getDevice(state.selectedId)),
    "panel-console": () => openConsole(),
    "panel-simlog": () => toggleDockTab("simlog"),
    "fit": fitNetwork,
    "help-shortcuts": () => { openConsole(); consoleLine("output", "Shortcuts: V select · C computer · E server · S switch · R router · F firewall · I IDS · K Kali PC · A Red Team · H hub · L connect · W configure · Del delete · Esc cancel · Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y redo · double-click a link to shut/unshut · scroll to zoom."); },
    "help-commands": () => openConsole(),
    "help-guide": openHelp,
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

  // Scenarios chooser (File tab): the button opens a fixed-position menu of group
  // rows (escaping the ribbon's scroll clip); hovering or clicking a group flies
  // out its submenu of scenarios; a scenario loads on click. The rows/items are
  // rebuilt by renderScenarioOptions, so the handlers are delegated on the static
  // container/button to survive a rebuild.
  dom.scenarioMenuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const willOpen = dom.scenarioMenu.hidden;
    closeToolMenus();
    closeScenarioMenu();
    if (willOpen) {
      const rect = dom.scenarioMenuButton.getBoundingClientRect();
      dom.scenarioMenu.style.left = `${rect.left}px`;
      dom.scenarioMenu.style.top = `${rect.bottom + 4}px`;
      dom.scenarioMenu.hidden = false;
      dom.scenarioMenuButton.setAttribute("aria-expanded", "true");
    }
  });
  const openScenarioSubmenu = (group: HTMLElement): void => {
    dom.scenarioMenu.querySelectorAll<HTMLElement>(".scenario-submenu").forEach(s => { s.hidden = true; });
    dom.scenarioMenu.querySelectorAll<HTMLElement>(".scenario-group").forEach(g => g.setAttribute("aria-expanded", "false"));
    const sub = group.nextElementSibling as HTMLElement | null;
    if (!sub || !sub.classList.contains("scenario-submenu")) return;
    const rect = group.getBoundingClientRect();
    sub.style.left = `${rect.right - 2}px`;
    sub.style.top = `${rect.top}px`;
    sub.hidden = false;
    group.setAttribute("aria-expanded", "true");
    // Flip left / clamp up if the submenu would overflow the viewport.
    const sr = sub.getBoundingClientRect();
    if (sr.right > window.innerWidth - 8) sub.style.left = `${Math.max(8, rect.left - sr.width + 2)}px`;
    if (sr.bottom > window.innerHeight - 8) sub.style.top = `${Math.max(8, window.innerHeight - 8 - sr.height)}px`;
  };
  dom.scenarioMenu.addEventListener("click", (event) => {
    event.stopPropagation();
    const target = event.target as HTMLElement;
    const item = target.closest<HTMLElement>(".scenario-item");
    if (item) { loadScenario(item.dataset.id!); closeScenarioMenu(); return; }
    const group = target.closest<HTMLElement>(".scenario-group");
    if (group) openScenarioSubmenu(group);
  });
  dom.scenarioMenu.addEventListener("mouseover", (event) => {
    const group = (event.target as HTMLElement).closest<HTMLElement>(".scenario-group");
    if (group && group.getAttribute("aria-expanded") !== "true") openScenarioSubmenu(group);
  });

  // Scenario goal banner.
  dom.scenarioCheckButton.addEventListener("click", runActiveScenarioCheck);
  dom.scenarioCloseButton.addEventListener("click", collapseScenario); // collapse to a pill, not abandon
  dom.scenarioPillExpand.addEventListener("click", expandScenario);
  dom.scenarioPillDismiss.addEventListener("click", dismissScenario);

  // The bottom dock: terminal sessions, console, and sim log share one panel.
  dom.dockTabs.addEventListener("click", handleDockTabClick);
  dom.dockClose.addEventListener("click", closeDock);
  dom.dockResizeHandle.addEventListener("pointerdown", startDockResize);
  window.addEventListener("pointermove", moveDockResize);
  window.addEventListener("pointerup", stopDockResize);
  window.addEventListener("pointercancel", stopDockResize);
  dom.terminalForm.addEventListener("submit", submitTerminalCommand);
  dom.terminalInput.addEventListener("keydown", (event) => {
    if (interruptSimOnCtrlC(event, "terminal")) return;
    handleTerminalKeydown(event);
  });
  dom.consoleForm.addEventListener("submit", submitConsoleCommand);
  dom.consoleInput.addEventListener("keydown", (event) => {
    if (interruptSimOnCtrlC(event, "console")) return;
    handleConsoleKeydown(event);
  });

  // Sim log: Packets/Events view toggle + click-a-row → frame breakdown
  // (same behaviour as clicking the transit dot on the canvas).
  document.querySelectorAll<HTMLElement>("[data-logview]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.dock.logView = btn.dataset.logview as "packets" | "events";
      syncSimLog();
    });
  });
  dom.simLogOutput.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-action='clear-log-filter']")) { clearLogFilter(); return; }
    const row = target.closest("tr[data-no]") as HTMLElement | null;
    if (row) inspectPacketRow(row);
  });
  dom.simLogOutput.addEventListener("keydown", (event) => handlePacketRowKeydown(event as KeyboardEvent));

  // Packet-list display filter: the expression input, the device select, the
  // protocol chips, and Clear. All three dimensions are ANDed (packet-filter.ts).
  dom.simLogFilterInput.addEventListener("input", () => {
    state.dock.logFilter.expr = dom.simLogFilterInput.value;
    syncSimLog();
  });
  dom.simLogDeviceFilter.addEventListener("change", () => {
    state.dock.logFilter.device = dom.simLogDeviceFilter.value;
    syncSimLog();
  });
  dom.simLogLinkFilter.addEventListener("click", () => {
    state.dock.logFilter.link = "";   // the pill clears just the link dimension
    syncSimLog();
  });
  dom.simLogChips.addEventListener("click", (event) => {
    const chip = (event.target as HTMLElement).closest("[data-proto]") as HTMLElement | null;
    if (!chip) return;
    const token = chip.dataset.proto || "";
    const active = state.dock.logFilter.protocols;
    const i = active.indexOf(token);
    if (i >= 0) active.splice(i, 1); else active.push(token);
    syncSimLog();
  });
  dom.simLogFilterClear.addEventListener("click", clearLogFilter);

  // Multi-run captures: pick which archived run to view, and compare two runs
  // side by side (a baseline on the left, the selected run on the right).
  dom.simLogCaptureSelect.addEventListener("change", () => {
    state.dock.captureView = dom.simLogCaptureSelect.value;
    if (state.dock.compareBaseId === state.dock.captureView) state.dock.compareBaseId = "";
    syncSimLog();
  });
  dom.simLogCompareToggle.addEventListener("click", () => {
    if (state.dock.compareBaseId) {
      state.dock.compareBaseId = "";
    } else {
      const others = state.savedCaptures.filter(c => c.id !== state.dock.captureView);
      state.dock.compareBaseId = others.length ? others[others.length - 1].id : "";
    }
    syncSimLog();
  });
  dom.simLogCompareSelect.addEventListener("change", () => {
    state.dock.compareBaseId = dom.simLogCompareSelect.value;
    syncSimLog();
  });

  // Inspector (network) panel. The close button lives in the panel heading,
  // which is rebuilt each sync, so it's wired by delegation.
  dom.detailsPanel.addEventListener("click", (event) => {
    if ((event.target as HTMLElement)?.closest?.("#inspectorCloseButton")) setNetworkPanel(false);
  });
  dom.inspectorResizeHandle.addEventListener("pointerdown", startInspectorResize);
  window.addEventListener("pointermove", moveInspectorResize);
  window.addEventListener("pointerup", stopInspectorResize);
  window.addEventListener("pointercancel", stopInspectorResize);
  bindOptionToggle(dom.showDeviceNames, "showDeviceNames");
  bindOptionToggle(dom.showIpAddresses, "showIpAddresses");
  bindOptionToggle(dom.showMacAddresses, "showMacAddresses");
  bindOptionToggle(dom.packetCallouts, "packetCallouts");
  bindOptionToggle(dom.optAutoDhcp, "autoDhcp");
  bindOptionToggle(dom.optApipa, "apipaFallback");
  bindOptionToggle(dom.optSilentArp, "silentArp");
  bindOptionToggle(dom.optSilentDhcp, "silentDhcp");
  bindOptionToggle(dom.optSilentDns, "silentDns");
  bindOptionToggle(dom.optSilentWifi, "silentWifi");
  bindOptionToggle(dom.optSilentStp, "silentStp");
  bindOptionToggle(dom.optInstantDns, "instantDns");
  window.addEventListener("resize", resizeCanvas);

  // Simulation controls — wired on the Main-tab ribbon and the floating
  // on-canvas transport pill (reachable from any tab while a sim runs).
  dom.simPlayPause.addEventListener("click", handleSimPlayPause);
  dom.simStep.addEventListener("click", stepOnce);
  dom.simStop.addEventListener("click", stopSimulation);
  dom.simTransportPlayPause.addEventListener("click", handleSimPlayPause);
  dom.simTransportStep.addEventListener("click", stepOnce);
  dom.simTransportStop.addEventListener("click", stopSimulation);
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
  dom.helpClose.addEventListener("click", closeHelp);
  dom.helpOverlay.addEventListener("click", (event) => {
    if (event.target === dom.helpOverlay) closeHelp();
  });
  dom.settingsClose.addEventListener("click", closeSettings);
  dom.aboutHeader.addEventListener("pointerdown", startAboutDrag);
  dom.aboutHeader.addEventListener("pointermove", moveAboutDrag);
  dom.aboutHeader.addEventListener("pointerup", endAboutDrag);
  dom.aboutHeader.addEventListener("pointercancel", endAboutDrag);
}
