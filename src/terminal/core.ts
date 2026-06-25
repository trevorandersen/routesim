/**
 * Terminal core — per-device terminal sessions, the bottom dock that hosts
 * them (alongside the console and sim-log panes), and the CLI dispatch.
 * The per-NOS command handlers live in host.ts (Linux), server.ts (dnsmasq),
 * router.ts (FRRouting), switch.ts (SONiC), and firewall.ts (iptables).
 *
 * Session model: each device terminal is a session (own scrollback, history,
 * and CLI mode — router config mode survives switching tabs). The sessions
 * are the dock's tabs; `state.terminal` always points at the session shown in
 * the terminal pane.
 */
import type { Device, DeviceType, DockTab, TerminalSession } from "../types";
import { state, sync, freshTerminalSession } from "../state";
import { dom } from "../dom";
import { escapeHtml } from "../utils";
import { getDevice } from "../devices";
import { runHostTerminalCommand } from "./host";
import { runServerTerminalCommand } from "./server";
import { runRouterTerminalCommand } from "./router";
import { runSwitchTerminalCommand } from "./switch";
import { runFirewallTerminalCommand } from "./firewall";
import { runIdsTerminalCommand } from "./ids";
import { runAttackerTerminalCommand } from "./attacker";

// While true, lines pushed are flagged `injected` — the simulator typed them
// (a GUI inspector edit driving the device CLI), not the user. See runDeviceCommand.
let injectedMode = false;

// Write a line into a specific session (sim results target the session of the
// device that started the run, even if another tab is active by then).
export function terminalLineFor(session: TerminalSession, kind: string, text: string): void {
  session.lines.push(injectedMode ? { kind, text, injected: true } : { kind, text });
  if (session.lines.length > 120) session.lines.splice(0, session.lines.length - 120);
}

export function terminalLine(kind: string, text: string): void {
  terminalLineFor(state.terminal, kind, text);
}

// Run a CLI command on a device's terminal as if the simulator typed it — the
// GUI inspector uses this so every static assignment is a real, visible CLI
// command. Surfaces the device's terminal, echoes the command, runs it, and
// flags the command + its output `injected` (distinct styling). Synchronous
// (config commands don't animate); not for ping/dhcp/etc.
export function runDeviceCommand(device: Device, command: string): void {
  const run = CLI_DISPATCH[device.type];
  const trimmed = command.trim();
  if (!run || !trimmed) return;
  state.terminal = ensureSession(device);
  openDock("terminal");
  injectedMode = true;
  try {
    terminalLine("command", `${terminalPromptText(device)} ${trimmed}`);
    run(device, trimmed);
  } finally {
    injectedMode = false; // never leak the flag if a handler throws
  }
  sync().syncTerminal();
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export function sessionFor(deviceId: string | null | undefined): TerminalSession | undefined {
  if (!deviceId) return undefined;
  return state.terminalSessions.find(s => s.deviceId === deviceId);
}

// Find or create the session for a device. `greet` adds the connection banner
// on creation (the console's `cli` command attaches silently).
export function ensureSession(device: Device, greet = false): TerminalSession {
  let session = sessionFor(device.id);
  if (!session) {
    session = freshTerminalSession(device.id);
    if (greet) {
      session.lines.push({
        kind: "muted",
        text: `Connected to ${device.name}. Type "${device.type === "switch" || device.type === "router" ? "?" : "help"}" for commands.`
      });
    }
    state.terminalSessions.push(session);
  }
  return session;
}

// Close one session tab. The active pointer falls back to the most recent
// remaining session; with none left the terminal pane shows its placeholder.
export function closeSession(deviceId: string | null): void {
  const idx = state.terminalSessions.findIndex(s => s.deviceId === deviceId);
  if (idx >= 0) state.terminalSessions.splice(idx, 1);
  if (state.terminal.deviceId === deviceId) {
    state.terminal = state.terminalSessions[Math.min(idx, state.terminalSessions.length - 1)]
      ?? freshTerminalSession();
  }
  // Closing the last terminal tab while the terminal pane is showing closes
  // the dock (there is nothing left to look at).
  if (state.terminalSessions.length === 0 && state.dock.activeTab === "terminal") {
    state.dock.open = false;
  }
  syncTerminal();
}

// ── Dock ─────────────────────────────────────────────────────────────────────

export function openDock(tab: DockTab): void {
  state.dock.open = true;
  state.dock.activeTab = tab;
  syncDock();
}

export function closeDock(): void {
  state.dock.open = false;
  syncDock();
}

// Ribbon toggles: clicking the active tab's button closes the dock.
export function toggleDockTab(tab: DockTab): void {
  if (state.dock.open && state.dock.activeTab === tab) closeDock();
  else openDock(tab);
}

export function setDockTab(tab: DockTab): void {
  state.dock.activeTab = tab;
  syncDock();
  if (tab === "terminal" && !dom.terminalInput.disabled) dom.terminalInput.focus();
  if (tab === "console" && !dom.consoleInput.disabled) dom.consoleInput.focus();
}

// Rebuild the dock chrome: tab strip, pane visibility, height, ribbon state.
export function syncDock(): void {
  const dock = state.dock;
  document.body.classList.toggle("dock-closed", !dock.open);
  document.documentElement.style.setProperty("--terminal-height", `${dock.height}px`);
  dom.terminalOpenButton.setAttribute("aria-expanded", String(dock.open && dock.activeTab === "terminal"));
  dom.consoleButton.setAttribute("aria-expanded", String(dock.open && dock.activeTab === "console"));

  const sessionTabs = state.terminalSessions.map(s => {
    const device = getDevice(s.deviceId);
    const name = device ? device.name : "(removed)";
    const active = dock.activeTab === "terminal" && s === state.terminal;
    return `<button class="dock-tab ${active ? "active" : ""}" data-session="${escapeHtml(s.deviceId || "")}" type="button">
      <span class="dock-tab-label">${escapeHtml(name)}</span><span class="dock-tab-close" data-close="${escapeHtml(s.deviceId || "")}" title="Close session">&times;</span>
    </button>`;
  });
  // A detached placeholder (failed open) still needs a visible terminal tab.
  if (state.terminalSessions.length === 0 && dock.activeTab === "terminal") {
    sessionTabs.push(`<button class="dock-tab active" data-pane="terminal" type="button"><span class="dock-tab-label">Terminal</span></button>`);
  }
  dom.dockTabs.innerHTML = [
    ...sessionTabs,
    `<button class="dock-tab ${dock.activeTab === "console" ? "active" : ""}" data-pane="console" type="button"><span class="dock-tab-label">Console</span></button>`,
    `<button class="dock-tab ${dock.activeTab === "simlog" ? "active" : ""}" data-pane="simlog" type="button"><span class="dock-tab-label">Sim Log</span><span class="dock-badge" id="simLogBadge"></span></button>`,
  ].join("");

  dom.terminalPane.classList.toggle("active", dock.activeTab === "terminal");
  dom.consolePane.classList.toggle("active", dock.activeTab === "console");
  dom.simLogPane.classList.toggle("active", dock.activeTab === "simlog");
  syncSimLogBadge();
  requestAnimationFrame(() => sync().resizeCanvas());
}

// Tab-strip click handling (delegated — the strip is rebuilt on every sync).
export function handleDockTabClick(event: Event): void {
  const target = event.target as HTMLElement;
  const close = target.closest("[data-close]") as HTMLElement | null;
  if (close) {
    closeSession(close.dataset.close || null);
    return;
  }
  const tab = target.closest("[data-session],[data-pane]") as HTMLElement | null;
  if (!tab) return;
  if (tab.dataset.session) {
    const session = sessionFor(tab.dataset.session);
    if (session) state.terminal = session;
    // syncTerminal first so the input's disabled state is up to date before
    // setDockTab tries to focus it (otherwise a placeholder→real switch leaves
    // the input unfocused).
    syncTerminal();
    setDockTab("terminal");
    return;
  }
  setDockTab(tab.dataset.pane as DockTab);
}

// The sim-log tab badge: live capture count while a simulation is active
// (falls back to the event count for event-only logs).
export function syncSimLogBadge(): void {
  const badge = document.getElementById("simLogBadge");
  if (!badge) return;
  const sim = state.simulation;
  const count = sim.capture.length || sim.log.length;
  badge.textContent = sim.status !== "idle" && count ? String(count) : "";
}

// ── Dock resize (drag the top edge, like the inspector's handle) ─────────────

let dockResize: { startY: number; startHeight: number } | null = null;

export function startDockResize(event: PointerEvent): void {
  event.preventDefault();
  dockResize = { startY: event.clientY, startHeight: state.dock.height };
  document.body.classList.add("resizing-dock");
}

export function moveDockResize(event: PointerEvent): void {
  if (!dockResize) return;
  state.dock.height = Math.min(Math.round(window.innerHeight * 0.8),
    Math.max(140, dockResize.startHeight + dockResize.startY - event.clientY));
  document.documentElement.style.setProperty("--terminal-height", `${state.dock.height}px`);
}

export function stopDockResize(): void {
  if (!dockResize) return;
  dockResize = null;
  document.body.classList.remove("resizing-dock");
  requestAnimationFrame(() => sync().resizeCanvas());
}

export function terminalPromptText(device: Device): string {
  if (device.type === "computer" || device.type === "laptop" || device.type === "kali" || device.type === "attacker") return `${device.name}$`;
  if (device.type === "server") return `root@${device.name}:~#`;
  if (device.type === "switch") return `${device.name}#`;
  if (device.type === "firewall") return `root@${device.name}#`;
  if (state.terminal.mode === "config") return `${device.name}(config)#`;
  if (state.terminal.mode === "interface") return `${device.name}(config-if)#`;
  if (state.terminal.mode === "rip") return `${device.name}(config-router)#`;
  if (state.terminal.mode === "privileged") return `${device.name}#`;
  return `${device.name}>`;
}
// One CLI per device type; a type absent here has no terminal.
const CLI_DISPATCH: Partial<Record<DeviceType, (device: Device, command: string) => void>> = {
  computer: runHostTerminalCommand,
  laptop: runHostTerminalCommand,
  server: runServerTerminalCommand,
  router: runRouterTerminalCommand,
  switch: runSwitchTerminalCommand,
  firewall: runFirewallTerminalCommand,
  ids: runIdsTerminalCommand,
  attacker: runAttackerTerminalCommand,
  kali: runAttackerTerminalCommand,     // a Kali PC: the same Kali shell, driven by hand
};

export function hasTerminal(device: Device | undefined): boolean {
  return !!device && device.type in CLI_DISPATCH;
}

// Whether openTerminalFor would actually attach a working session (vs show an
// error placeholder): a CLI device that is powered on and, for switches,
// managed. Used to auto-open a terminal when configuring.
export function canOpenTerminal(device: Device | undefined): boolean {
  return hasTerminal(device) && !device!.poweredOff
    && !(device!.type === "switch" && !device!.config?.managed);
}

export function runTerminalCommand(rawCommand: string): void {
  const host = getDevice(state.terminal.deviceId);
  const command = rawCommand.trim();
  const run = host ? CLI_DISPATCH[host.type] : undefined;
  if (!host || !run) {
    terminalLine("error", "No device is attached to this terminal.");
    return;
  }
  if (!command) return;
  terminalLine("command", `${terminalPromptText(host)} ${command}`);
  run(host, command);
}

export function openTerminalFor(device: Device | undefined): void {
  if (!device || !hasTerminal(device)) {
    state.terminal = withErrorLine("Select a PC, server, router, or managed switch to open its terminal.");
  } else if (device.poweredOff) {
    state.terminal = withErrorLine(`${device.name} is powered off.`);
  } else if (device.type === "switch" && !device.config?.managed) {
    state.terminal = withErrorLine("This switch is unmanaged. Enable managed mode to use a switch terminal.");
  } else {
    state.selectedId = device.id;
    state.terminal = ensureSession(device, true);
  }
  openDock("terminal");
  sync().syncPanel();
  syncTerminal();
  if (!dom.terminalInput.disabled) dom.terminalInput.focus();
}

// A detached placeholder session carrying an open-failure message.
function withErrorLine(text: string): TerminalSession {
  const session = freshTerminalSession();
  session.lines.push({ kind: "error", text });
  return session;
}

export function syncTerminal(): void {
  // A session whose device vanished (or lost its CLI) detaches.
  if (state.terminal.deviceId && !hasTerminal(getDevice(state.terminal.deviceId))) {
    closeSession(state.terminal.deviceId);
    return; // closeSession re-enters syncTerminal with a valid pointer
  }
  const activeHost = getDevice(state.terminal.deviceId);
  dom.terminalPrompt.textContent = activeHost ? terminalPromptText(activeHost) : "device$";
  dom.terminalInput.disabled = !activeHost;
  dom.terminalInput.placeholder = activeHost ? (activeHost.type === "router" ? "?" : "help") : "Select a device";
  dom.terminalOutput.innerHTML = state.terminal.lines.length
    ? state.terminal.lines.map(line => (
        `<p class="terminal-line ${escapeHtml(line.kind || "")}${line.injected ? " injected" : ""}">${escapeHtml(line.text)}</p>`
      )).join("")
    : `<p class="terminal-line muted">No device terminal attached — select a device and open its terminal, or use the device list.</p>`;
  dom.terminalOutput.scrollTop = dom.terminalOutput.scrollHeight;
  syncDock();
}

export function submitTerminalCommand(event: Event): void {
  event.preventDefault();
  const command = dom.terminalInput.value;
  dom.terminalInput.value = "";
  if (command.trim()) {
    const h = state.terminal.history;
    if (h.length === 0 || h[h.length - 1] !== command) {
      h.push(command);
      if (h.length > 100) h.shift();
    }
  }
  state.terminal.historyIndex = -1;
  runTerminalCommand(command);
  syncTerminal();
}

export function handleTerminalKeydown(event: KeyboardEvent): void {
  const h = state.terminal.history;
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (h.length === 0) return;
    if (state.terminal.historyIndex === -1) {
      state.terminal.historyIndex = h.length - 1;
    } else if (state.terminal.historyIndex > 0) {
      state.terminal.historyIndex--;
    }
    dom.terminalInput.value = h[state.terminal.historyIndex];
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    if (state.terminal.historyIndex === -1) return;
    if (state.terminal.historyIndex < h.length - 1) {
      state.terminal.historyIndex++;
      dom.terminalInput.value = h[state.terminal.historyIndex];
    } else {
      state.terminal.historyIndex = -1;
      dom.terminalInput.value = "";
    }
  }
}
