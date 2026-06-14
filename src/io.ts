/**
 * JSON import/export for configs, scenarios, scripts, and logs. The app is a
 * single self-contained file (no server, no File System Access) — persistence is
 * download (Blob + <a download>) and import is a hidden <input type=file>.
 */
import { state } from "./state";
import { dom } from "./dom";
import { buildConfigPayload, parseConfig, applyConfig } from "./config";
import { exportTopologyScript, runConsoleScript } from "./commands";
import { SCENARIOS, registerScenario, loadScenario } from "./scenarios";
import { syncSimLog } from "./engine";
import { openDock } from "./terminal";

// ── Generic helpers ──────────────────────────────────────────────────────────

function downloadBlob(content: string, filename: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function downloadJson(data: unknown, filename: string): void {
  downloadBlob(JSON.stringify(data, null, 2), filename, "application/json");
}

export function downloadText(text: string, filename: string): void {
  downloadBlob(text, filename, "text/plain");
}

export function pickFile(accept = "application/json,.json,.txt"): Promise<string | null> {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.click();
  });
}

// ── Config ───────────────────────────────────────────────────────────────────

export function exportConfig(): void {
  downloadJson(buildConfigPayload(), "topology.json");
  dom.modeLabel.textContent = "Exported topology.json.";
}

export async function importConfig(): Promise<void> {
  const text = await pickFile();
  if (text == null) return;
  try {
    applyConfig(parseConfig(text));
    dom.modeLabel.textContent = "Imported topology.";
  } catch (error: any) {
    dom.modeLabel.textContent = error.message || "Import failed.";
  }
}

// ── Scenarios ────────────────────────────────────────────────────────────────

export function exportScenarios(): void {
  downloadJson(SCENARIOS, "scenarios.json");
  dom.modeLabel.textContent = "Exported scenarios.json.";
}

export async function importScenario(): Promise<void> {
  const text = await pickFile();
  if (text == null) return;
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    let lastId = "";
    for (const s of list) {
      if (s && typeof s.id === "string" && s.topology && Array.isArray(s.checks)) {
        registerScenario(s);
        lastId = s.id;
      }
    }
    if (lastId) { loadScenario(lastId); dom.modeLabel.textContent = `Imported scenario "${lastId}".`; }
    else dom.modeLabel.textContent = "No valid scenarios in file.";
  } catch {
    dom.modeLabel.textContent = "Invalid scenario JSON.";
  }
}

// ── Scripts ──────────────────────────────────────────────────────────────────

export function exportScript(): void {
  downloadText(exportTopologyScript(), "topology.routesim.txt");
  dom.modeLabel.textContent = "Exported topology script.";
}

export async function importScript(): Promise<void> {
  const text = await pickFile("text/plain,.txt,.routesim,.json");
  if (text == null) return;
  runConsoleScript(text);
  dom.modeLabel.textContent = "Ran imported script.";
}

// ── Logs ─────────────────────────────────────────────────────────────────────

export function exportLog(): void {
  downloadJson(state.simulation.log, "simlog.json");
  dom.modeLabel.textContent = "Exported simlog.json.";
}

export async function importLog(): Promise<void> {
  const text = await pickFile();
  if (text == null) return;
  try {
    const log = JSON.parse(text);
    if (!Array.isArray(log)) { dom.modeLabel.textContent = "Invalid log JSON."; return; }
    state.simulation.log = log;
    state.dock.logView = "events"; // imported logs are event entries, not captures
    openDock("simlog");
    syncSimLog();
    dom.modeLabel.textContent = "Imported simulation log.";
  } catch {
    dom.modeLabel.textContent = "Invalid log JSON.";
  }
}
