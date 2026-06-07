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

export function syncScenarioPanel(): void {
  const scenario = getScenario(state.activeScenarioId);
  document.body.classList.toggle("scenario-active", !!scenario);
  if (!scenario) { lastResult = null; return; }
  if (lastResult && lastResult.id !== scenario.id) lastResult = null;

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

export function dismissScenario(): void {
  state.activeScenarioId = null;
  lastResult = null;
  syncScenarioPanel();
}
