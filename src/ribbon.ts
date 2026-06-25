/**
 * Ribbon tab switching + the scenario chooser options. Per-button click wiring
 * lives in ui.ts (setupUI) via data-action / data-tool / data-theme-id.
 */
import { dom } from "./dom";
import { escapeHtml } from "./utils";
import { SCENARIOS } from "./scenarios";
import { SCENARIO_GROUPS } from "./scenario-library";

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

// Rebuilds the File-tab scenario chooser from the (possibly imported) registry,
// as a flyout menu: each category (SCENARIO_GROUPS order) is a group row that
// opens a submenu of its scenarios. A scenario not in any curated group — an
// imported one, or its self-declared `group` — falls into that group, or
// "Other", rather than being dropped. The open/close + submenu wiring lives in
// ui.ts (delegated on #scenarioMenu, so it survives this rebuild).
const RIGHT_CHEVRON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6l-6 6"></path></svg>`;

export function renderScenarioOptions(): void {
  const byId = new Map(SCENARIOS.map(s => [s.id, s]));
  const placed = new Set<string>();
  const groupBlock = (label: string, scenarios: { id: string; name: string }[]) => scenarios.length ? (
    `<button class="scenario-group" type="button" aria-haspopup="true" aria-expanded="false"><span>${escapeHtml(label)}</span>${RIGHT_CHEVRON}</button>` +
    `<div class="scenario-submenu" hidden>${scenarios.map(s =>
      `<button class="scenario-item" type="button" data-id="${escapeHtml(s.id)}">${escapeHtml(s.name)}</button>`
    ).join("")}</div>`
  ) : "";

  // The curated groups, in order.
  let html = SCENARIO_GROUPS.map(g => {
    const scenarios = g.ids.map(id => byId.get(id)).filter(Boolean) as { id: string; name: string }[];
    scenarios.forEach(s => placed.add(s.id));
    return groupBlock(g.label, scenarios);
  }).join("");

  // Anything not in a curated group (imported scenarios, or a new one not yet
  // grouped): bucket by its own `group` field, else "Other".
  const leftovers = SCENARIOS.filter(s => !placed.has(s.id));
  const extraGroups = new Map<string, { id: string; name: string }[]>();
  for (const s of leftovers) {
    const label = (s as any).group || "Other";
    if (!extraGroups.has(label)) extraGroups.set(label, []);
    extraGroups.get(label)!.push(s);
  }
  for (const [label, scenarios] of extraGroups) html += groupBlock(label, scenarios);

  dom.scenarioMenu.innerHTML = html;
}
