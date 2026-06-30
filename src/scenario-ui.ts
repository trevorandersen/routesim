/**
 * Scenario goal banner — the floating panel showing the active scenario's
 * objective, a live checklist, and a Check button. Pure UI on top of
 * scenarios.ts. Registered as `syncScenarioPanel` in the callback bridge.
 */
import { state } from "./state";
import { dom } from "./dom";
import { escapeHtml } from "./utils";
import { getScenario, checkScenario, type ScenarioResult } from "./scenarios";

let lastResult: ScenarioResult | null = null;
let collapsed = false;       // showing the small progress pill instead of the full panel
let shownId: string | null = null;

export function syncScenarioPanel(): void {
  const scenario = getScenario(state.activeScenarioId);
  document.body.classList.toggle("scenario-active", !!scenario);
  if (!scenario) {
    lastResult = null; collapsed = false; shownId = null;
    document.body.classList.remove("scenario-collapsed");
    return;
  }
  // Discard a stale result when the active scenario changed id OR was replaced
  // (a same-id JSON import with a different checks array) — otherwise the marks
  // would be paired against the new labels positionally.
  if (lastResult && (lastResult.id !== scenario.id || lastResult.checks.length !== scenario.checks.length)) lastResult = null;
  // A freshly loaded scenario starts expanded.
  if (scenario.id !== shownId) { collapsed = false; shownId = scenario.id; }
  document.body.classList.toggle("scenario-collapsed", collapsed);

  // The collapsed progress pill: "Name — passed/total ✓".
  const passed = lastResult ? lastResult.checks.filter(c => c.passed).length : 0;
  dom.scenarioPillText.textContent = `${scenario.name} — ${passed}/${scenario.checks.length}${lastResult?.passed ? " ✓" : ""}`;

  dom.scenarioName.textContent = scenario.name;
  dom.scenarioObjective.textContent = scenario.objective;
  dom.scenarioChecks.innerHTML = scenario.checks.map((c, i) => {
    const res = lastResult?.checks[i];
    const mark = res == null ? "○" : res.passed ? "✓" : "✗";
    const cls = res == null ? "pending" : res.passed ? "pass" : "fail";
    return `<li class="scenario-check ${cls}"><span class="mark">${mark}</span>${escapeHtml(c.label)}</li>`;
  }).join("");
  dom.scenarioStatus.textContent = lastResult
    ? (lastResult.passed ? "Scenario complete" : "Not yet — keep going.")
    : "";
  dom.scenarioStatus.className = "scenario-status" + (lastResult ? (lastResult.passed ? " pass" : " fail") : "");
}

export function runActiveScenarioCheck(): void {
  const scenario = getScenario(state.activeScenarioId);
  if (!scenario) return;
  lastResult = checkScenario(scenario);
  syncScenarioPanel();
}

// The titlebar control collapses the panel to a progress pill (it no longer
// abandons the scenario); the pill body re-expands, the pill ✕ dismisses.
export function collapseScenario(): void { collapsed = true; syncScenarioPanel(); }
export function expandScenario(): void { collapsed = false; syncScenarioPanel(); }

export function dismissScenario(): void {
  state.activeScenarioId = null;
  lastResult = null;
  collapsed = false;
  syncScenarioPanel();
}
