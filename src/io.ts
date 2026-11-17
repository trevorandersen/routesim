/**
 * JSON import/export for configs, scenarios, scripts, and logs. The app is a
 * single self-contained file (no server, no File System Access) — persistence is
 * download (Blob + <a download>) and import is a hidden <input type=file>.
 * A network can also travel as a link (share-link.ts is the codec; the two
 * actions that use it are at the end of this file).
 */
import { state, pushUndo, undoBlockReason } from "./state";
import { dom } from "./dom";
import { buildConfigPayload, parseConfig, applyConfig, applyConfigWithoutUndo } from "./config";
import { encodeShare, decodeShare, shareTokenFromHash, shareUrl, pageBase, SHARE_LONG_LINK } from "./share-link";
import { buildSettingsQuery } from "./settings-url";
import { exportTopologyScript, runConsoleScript } from "./commands";
import { SCENARIOS, registerScenario, unregisterScenario, scenarioIssue, loadScenario } from "./scenarios";
import { normaliseConfig } from "./normalise";
import { syncSimLog } from "./simlog-view";
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
    input.addEventListener("cancel", () => resolve(null));   // a dismissed picker used to leave the promise pending forever
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
    const skipped: string[] = [];
    for (const s of list) {
      // Validate EVERYTHING loadScenario will touch BEFORE registering, so a
      // malformed scenario never poisons the global registry/dropdown — its
      // own fields and every check (scenarioIssue: the banner and `scenario
      // goal` read them on load; a missing objective or a null check threw
      // there, leaving a permanently broken selectable entry) AND the topology
      // (the throw-prone normalise).
      let issue = scenarioIssue(s);
      if (!issue) { try { normaliseConfig(s.topology); } catch { issue = `"${s.id}" has a topology that does not load`; } }
      if (issue) { skipped.push(issue); continue; }
      registerScenario(s);
      lastId = s.id;
    }
    if (!lastId) { dom.modeLabel.textContent = `No valid scenarios in file${skipped.length ? ` — ${skipped[0]}` : ""}.`; return; }
    // Belt and braces: if a validated scenario still fails to load, roll the
    // registration back rather than leave an entry that throws on re-select.
    try {
      loadScenario(lastId);
      dom.modeLabel.textContent = `Imported scenario "${lastId}".${skipped.length ? ` Skipped ${skipped.length}: ${skipped[0]}.` : ""}`;
    } catch (e) {
      unregisterScenario(lastId);
      throw e;
    }
  } catch {
    dom.modeLabel.textContent = "Invalid scenario JSON.";
  }
}

// ── Scripts ──────────────────────────────────────────────────────────────────

export function exportScript(): void {
  downloadText(exportTopologyScript(), "topology.routesim.txt");
  dom.modeLabel.textContent = "Exported topology script.";
}

// Run an imported script as ONE undo point (each line used to push its own —
// 30 lines, 30 entries, never reversible in one step) and report honestly (the
// results used to be discarded, so every import said "Ran imported script.").
// Returns the status line; exported so the behaviour is testable without a
// file picker.
export function runImportedScript(text: string): string {
  pushUndo();
  // Restore the flag rather than clearing it: an import fired while another
  // composite change is open (the tutorial) must not end that one early.
  const wasComposite = state.isApplyingCompositeChange;
  state.isApplyingCompositeChange = true;
  let results;
  try { results = runConsoleScript(text); } finally { state.isApplyingCompositeChange = wasComposite; }
  const rejected = results.filter(r => !r.ok);
  if (!rejected.length) return `Ran imported script (${results.length} lines).`;
  return `Imported script: ${rejected.length} of ${results.length} lines rejected — first: ${rejected[0].output.join(" ")}`;
}

export async function importScript(): Promise<void> {
  const text = await pickFile("text/plain,.txt,.routesim,.json");
  if (text == null) return;
  dom.modeLabel.textContent = runImportedScript(text);
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
    // Keep only well-formed entries (renderEventLog reads entry.summary as a
    // string — a shapeless entry would render the literal "undefined").
    const clean = log.filter((e) => e && typeof e === "object" && typeof e.summary === "string");
    if (log.length && !clean.length) { dom.modeLabel.textContent = "Invalid log JSON."; return; }
    state.simulation.log = clean;
    state.dock.logView = "events"; // imported logs are event entries, not captures
    openDock("simlog");
    syncSimLog();
    dom.modeLabel.textContent = "Imported simulation log.";
  } catch {
    dom.modeLabel.textContent = "Invalid log JSON.";
  }
}

// ── Share links ──────────────────────────────────────────────────────────────

// A link that opens the current network: this page's address, the settings
// that differ from the defaults, and the network in the fragment.
export async function buildShareLink(base = pageBase(window.location.href)): Promise<string> {
  const token = await encodeShare(JSON.stringify(buildConfigPayload()));
  return shareUrl(base, buildSettingsQuery(), token);
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* blocked (permissions, an insecure context): try the old way */ }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

const sizeText = (chars: number) => chars < 1000 ? `${chars} characters` : `${(chars / 1000).toFixed(1)}k characters`;

// File → Copy link. Says what happened on the status line — including when the
// clipboard is out of reach (the link then goes in the address bar) and when
// the link is long enough that a chat or mail app may cut it.
export async function copyShareLink(): Promise<void> {
  let url: string;
  try {
    url = await buildShareLink();
  } catch {
    dom.modeLabel.textContent = "Could not build a link for this network — File → Export → Config saves it as a file instead.";
    return;
  }
  const long = url.length > SHARE_LONG_LINK ? " That is long for a chat or mail app, which may cut it — File → Export → Config is the sturdier way to send a large network." : "";
  if (await copyText(url)) {
    dom.modeLabel.textContent = `Link copied (${sizeText(url.length)}) — it holds this whole network, any passwords and keys in it included.${long}`;
    return;
  }
  try { window.history.replaceState(null, "", url); } catch { /* a sandboxed page: nothing more to try */ }
  dom.modeLabel.textContent = `Could not reach the clipboard — the link (${sizeText(url.length)}) is in the address bar; copy it from there.${long}`;
}

// Open the network a link carries (`hash` is a location hash). Resolves to
// true when a network was loaded, false when the hash names none or the link
// could not be read — the network on the canvas is then left untouched, and
// the status line says why. `undo: true` makes the load an undo point (a link
// opened over a network the learner was working on); a boot-time load over
// the built-in default needs none.
export async function openSharedNetwork(hash: string, options: { undo: boolean } = { undo: true }): Promise<boolean> {
  const token = shareTokenFromHash(hash);
  if (token == null) return false;
  const blocked = undoBlockReason();
  if (blocked) { dom.modeLabel.textContent = `The link was not opened: ${blocked}`; return false; }
  try {
    const config = parseConfig(await decodeShare(token));
    if (options.undo) applyConfig(config); else applyConfigWithoutUndo(config);
    const count = config.devices.length;
    dom.modeLabel.textContent = `Opened the network from the link (${count} device${count === 1 ? "" : "s"}).${options.undo ? " Undo returns to what was here." : ""}`;
    return true;
  } catch (error) {
    const reason = error instanceof Error && error.message ? error.message.replace(/\.$/, "") : "it could not be read";
    dom.modeLabel.textContent = `This link could not be opened: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}.`;
    return false;
  }
}
