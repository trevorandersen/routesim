/**
 * Ribbon tab switching + dynamic scenario buttons. Per-button click wiring lives
 * in ui.ts (setupUI) via data-action / data-tool / data-topology / data-scenario.
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
    if (tab === "scenarios") renderScenarioButtons();
  };
  tabs.forEach(t => t.addEventListener("click", () => activate(t.dataset.tab!)));
  renderScenarioButtons();
}

// Rebuilds the Scenarios-tab load buttons from the (possibly imported) registry.
export function renderScenarioButtons(): void {
  dom.ribbonScenarioList.innerHTML = SCENARIOS.map(s =>
    `<button class="ribbon-btn" data-scenario="${escapeHtml(s.id)}" type="button">` +
    `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4v16"></path><path d="M4 5h13l-2 3l2 3H4"></path></svg>` +
    `<span>${escapeHtml(s.name)}</span></button>`
  ).join("");
}
