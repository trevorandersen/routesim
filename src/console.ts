/**
 * Command console panel — the dedicated UI for the app-level command language.
 * Mirrors the per-device terminal's plumbing (output, input, history) but drives
 * the command engine (commands.ts) instead of a device CLI. See docs/scripting.md.
 */
import { state } from "./state";
import { dom } from "./dom";
import { escapeHtml } from "./utils";
import { runConsoleCommand } from "./commands";
import { openDock, closeDock } from "./terminal";

export function openConsole(): void {
  if (state.console.lines.length === 0) {
    state.console.lines.push({
      kind: "muted",
      text: 'RouteSim console — type "help" for commands, "export" to dump the topology.',
    });
  }
  openDock("console");
  syncConsole();
  if (!dom.consoleInput.disabled) dom.consoleInput.focus();
}

export function closeConsole(): void {
  if (state.dock.open && state.dock.activeTab === "console") closeDock();
}

export function syncConsole(): void {
  dom.consoleOutput.innerHTML = state.console.lines.map(line =>
    `<p class="terminal-line ${escapeHtml(line.kind || "")}">${escapeHtml(line.text)}</p>`
  ).join("");
  dom.consoleOutput.scrollTop = dom.consoleOutput.scrollHeight;
}

function pushConsole(kind: string, text: string): void {
  for (const part of text.split("\n")) state.console.lines.push({ kind, text: part });
  if (state.console.lines.length > 200) {
    state.console.lines.splice(0, state.console.lines.length - 200);
  }
}

// Push a line from outside the command flow (e.g. the Help → Shortcuts button).
export function consoleLine(kind: string, text: string): void {
  pushConsole(kind, text);
  syncConsole();
}

export function submitConsoleCommand(event: Event): void {
  event.preventDefault();
  const command = dom.consoleInput.value;
  dom.consoleInput.value = "";
  if (command.trim()) {
    const h = state.console.history;
    if (h.length === 0 || h[h.length - 1] !== command) {
      h.push(command);
      if (h.length > 100) h.shift();
    }
  }
  state.console.historyIndex = -1;
  if (!command.trim()) { syncConsole(); return; }

  pushConsole("command", `routesim> ${command}`);
  const result = runConsoleCommand(command);
  for (const line of result.output) pushConsole(result.ok ? "" : "error", line);
  syncConsole();
}

export function handleConsoleKeydown(event: KeyboardEvent): void {
  const h = state.console.history;
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (h.length === 0) return;
    if (state.console.historyIndex === -1) state.console.historyIndex = h.length - 1;
    else if (state.console.historyIndex > 0) state.console.historyIndex--;
    dom.consoleInput.value = h[state.console.historyIndex];
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    if (state.console.historyIndex === -1) return;
    if (state.console.historyIndex < h.length - 1) {
      state.console.historyIndex++;
      dom.consoleInput.value = h[state.console.historyIndex];
    } else {
      state.console.historyIndex = -1;
      dom.consoleInput.value = "";
    }
  }
}
