/**
 * Offensive inspector panel (the Red Team actor's config section).
 *
 * The right-panel section for a Red Team (`attacker`) device: a target field, the
 * enabled-attacks checkboxes, a Launch button, and the last run's findings. Moved
 * out of inspector.ts with the rest of the offensive code. inspector.ts imports
 * these for its INSPECTOR_SECTIONS registry; this module imports only lower-layer
 * helpers and the engine, never inspector.ts, so no cycle forms.
 */
import { escapeHtml } from "../../utils";
import { captureUndoOnFocus, pushUndo } from "../../state";
import { ensureConfig } from "../../normalise";
import { dom } from "../../dom";
import { startSimulation, animatedRunBlockReason } from "../../engine";
import { buildAttackEvents } from "./attacks";

// The Red Team panel: a target, the enabled attacks, a Launch button, and the
// last run's findings. Wired by bindAttackerControls.
export function renderAttackerSection(device: any): string {
  const cfg = device.config || {};
  const has = (k: string) => (cfg.attacks || []).includes(k);
  const log: string[] = cfg.attackLog || [];
  return `
    <p class="field-note">A Red Team (Kali) host. Set a target, choose attacks, then Launch (or just press Play). It generates real attack traffic an IDS can detect; a passive victim can't steer it.</p>
    <div class="field">
      <label for="selectedAttackTarget">Target (IP or device)</label>
      <input id="selectedAttackTarget" value="${escapeHtml(cfg.attackTarget || "")}" placeholder="e.g. 10.0.0.10 or SRV" autocomplete="off">
    </div>
    <div class="field">
      <label>Attacks</label>
      <div class="attack-checks">
        <label class="stp-check"><input type="checkbox" class="attack-check" data-attack="scan" ${has("scan") ? "checked" : ""}> Port scan</label>
        <label class="stp-check"><input type="checkbox" class="attack-check" data-attack="sweep" ${has("sweep") ? "checked" : ""}> Ping sweep</label>
        <label class="stp-check"><input type="checkbox" class="attack-check" data-attack="arp-spoof" ${has("arp-spoof") ? "checked" : ""}> ARP spoof</label>
      </div>
    </div>
    <button class="wide-button" id="launchAttack">Launch attacks</button>
    ${log.length ? `<div class="field"><label>Last run</label><pre class="ids-alerts attack-log">${escapeHtml(log.join("\n"))}</pre></div>` : ""}
  `;
}

// Wires the Red Team target field, attack checkboxes, and Launch button.
export function bindAttackerControls(device: any): void {
  const target = document.getElementById("selectedAttackTarget") as HTMLInputElement | null;
  if (target) {
    captureUndoOnFocus(target);
    target.addEventListener("change", () => { device.config.attackTarget = target.value.trim(); });
  }
  document.querySelectorAll(".attack-check").forEach(el => el.addEventListener("change", () => {
    pushUndo();   // ticking an attack is an edit like any other — it had no undo point
    ensureConfig(device);
    device.config.attacks = Array.from(document.querySelectorAll<HTMLInputElement>(".attack-check"))
      .filter(c => c.checked).map(c => c.dataset.attack);
  }));
  document.getElementById("launchAttack")?.addEventListener("click", () => {
    const busy = animatedRunBlockReason();   // another run owns the simulator (engine beginRun)
    if (busy) { dom.modeLabel.textContent = busy; return; }
    if (target) device.config.attackTarget = target.value.trim();   // commit before launching
    const setup = buildAttackEvents(device);
    if (typeof setup === "string") { dom.modeLabel.textContent = setup; return; }
    startSimulation(setup, device.id, "", "attack");
  });
}
