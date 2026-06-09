/**
 * Terminal core — the shared terminal panel: line buffer, prompt, the
 * per-device-type CLI dispatch, and the open/close/sync/submit UI plumbing.
 * The per-NOS command handlers live in host.ts (Linux), router.ts (FRRouting),
 * switch.ts (SONiC), and firewall.ts (iptables).
 */
import type { Device, DeviceType } from "../types";
import { state, sync } from "../state";
import { dom } from "../dom";
import { escapeHtml } from "../utils";
import { getDevice } from "../devices";
import { runHostTerminalCommand } from "./host";
import { runRouterTerminalCommand } from "./router";
import { runSwitchTerminalCommand } from "./switch";
import { runFirewallTerminalCommand } from "./firewall";

export function terminalLine(kind: string, text: string): void {
  state.terminal.lines.push({ kind, text });
  if (state.terminal.lines.length > 120) state.terminal.lines.splice(0, state.terminal.lines.length - 120);
}

export function terminalPromptText(device: Device): string {
  if (device.type === "computer") return `${device.name}$`;
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
  router: runRouterTerminalCommand,
  switch: runSwitchTerminalCommand,
  firewall: runFirewallTerminalCommand,
};

export function hasTerminal(device: Device | undefined): boolean {
  return !!device && device.type in CLI_DISPATCH;
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
    state.terminal.open = true;
    state.terminal.deviceId = null;
    state.terminal.mode = "exec";
    state.terminal.interfacePeerId = null;
    state.terminal.interfaceVlanTag = null;
    state.terminal.lines = [{ kind: "error", text: "Select a PC, router, or managed switch to open its terminal." }];
  } else if (device.poweredOff) {
    state.terminal.open = true;
    state.terminal.deviceId = null;
    state.terminal.mode = "exec";
    state.terminal.interfacePeerId = null;
    state.terminal.interfaceVlanTag = null;
    state.terminal.lines = [{ kind: "error", text: `${device.name} is powered off.` }];
  } else if (device.type === "switch" && !device.config?.managed) {
    state.terminal.open = true;
    state.terminal.deviceId = null;
    state.terminal.mode = "exec";
    state.terminal.interfacePeerId = null;
    state.terminal.interfaceVlanTag = null;
    state.terminal.lines = [{ kind: "error", text: "This switch is unmanaged. Enable managed mode to use a switch terminal." }];
  } else {
    state.selectedId = device.id;
    state.terminal.open = true;
    state.terminal.deviceId = device.id;
    state.terminal.mode = "exec";
    state.terminal.interfacePeerId = null;
    state.terminal.interfaceVlanTag = null;
    state.terminal.lines = [
      { kind: "muted", text: `Connected to ${device.name}. Type "${device.type === "switch" || device.type === "router" ? "?" : "help"}" for commands.` }
    ];
  }
  sync().syncPanel();
  syncTerminal();
  if (!dom.terminalInput.disabled) dom.terminalInput.focus();
}

export function closeTerminal(): void {
  state.terminal.open = false;
  syncTerminal();
}

export function syncTerminal(): void {
  const host = getDevice(state.terminal.deviceId);
  if (!hasTerminal(host)) {
    state.terminal.deviceId = null;
    state.terminal.mode = "exec";
    state.terminal.interfacePeerId = null;
    state.terminal.interfaceVlanTag = null;
    if (state.terminal.open) {
      state.terminal.lines = [{ kind: "error", text: "Select a PC, router, or managed switch before opening the terminal." }];
    }
  }
  const activeHost = getDevice(state.terminal.deviceId);
  document.body.classList.toggle("terminal-closed", !state.terminal.open);
  dom.terminalOpenButton.setAttribute("aria-expanded", String(state.terminal.open));
  dom.terminalTitle.textContent = activeHost ? `${activeHost.name} terminal` : "Device terminal";
  dom.terminalPrompt.textContent = activeHost ? terminalPromptText(activeHost) : "device$";
  dom.terminalInput.disabled = !activeHost;
  dom.terminalInput.placeholder = activeHost ? (activeHost.type === "router" ? "?" : "help") : "Select a device";
  dom.terminalOutput.innerHTML = state.terminal.lines.map(line => (
    `<p class="terminal-line ${escapeHtml(line.kind || "")}">${escapeHtml(line.text)}</p>`
  )).join("");
  dom.terminalOutput.scrollTop = dom.terminalOutput.scrollHeight;
  requestAnimationFrame(() => sync().resizeCanvas());
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
