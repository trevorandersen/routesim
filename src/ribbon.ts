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
// grouped into <optgroup>s by category (SCENARIO_GROUPS order). A scenario that
// isn't in any group — e.g. an imported one, or its self-declared `group` — falls
// into that group, or "Other", rather than being dropped.
export function renderScenarioOptions(): void {
  const byId = new Map(SCENARIOS.map(s => [s.id, s]));
  const placed = new Set<string>();
  const option = (s: { id: string; name: string }) =>
    `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`;
  const optgroup = (label: string, scenarios: { id: string; name: string }[]) =>
    scenarios.length ? `<optgroup label="${escapeHtml(label)}">${scenarios.map(option).join("")}</optgroup>` : "";

  // The curated groups, in order.
  let html = SCENARIO_GROUPS.map(g => {
    const scenarios = g.ids.map(id => byId.get(id)).filter(Boolean) as { id: string; name: string }[];
    scenarios.forEach(s => placed.add(s.id));
    return optgroup(g.label, scenarios);
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
  for (const [label, scenarios] of extraGroups) html += optgroup(label, scenarios);

  dom.scenarioSelect.innerHTML = `<option value="">Load scenario…</option>` + html;
}
