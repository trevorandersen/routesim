/**
 * Ribbon tab switching + the scenario chooser options. Per-button click wiring
 * lives in ui.ts (setupUI) via data-action / data-tool / data-theme-id.
 */
import { dom } from "./dom";
import { escapeHtml } from "./utils";
import { SCENARIOS } from "./scenarios";

export function setupRibbon(): void {
  const tabs = Array.from(document.querySelectorAll<HTMLElement>(".ribbon-tab"));
  const panels = Array.from(document.querySelectorAll<HTMLElement>(".ribbon-panel"));
  const activate = (tab: string) => {
    tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
    panels.forEach(p => p.classList.toggle("active", p.dataset.tab === tab));
  };
  tabs.forEach(t => t.addEventListener("click", () => activate(t.dataset.tab!)));
  renderScenarioOptions();
}

// Rebuilds the File-tab scenario chooser from the (possibly imported) registry.
export function renderScenarioOptions(): void {
  dom.scenarioSelect.innerHTML = `<option value="">Load scenario…</option>` + SCENARIOS.map(s =>
    `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`
  ).join("");
}
