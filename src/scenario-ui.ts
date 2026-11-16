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
    // A failed check can carry a note — why it failed when the label alone
    // would read as satisfied (blocked, but not where the scenario asks).
    // …and the explanation of the failing run, from its own log (explain.ts):
    // the drops in order and the post-mortem's diagnosis. Each reason is its
    // own line, marked as a reason rather than left to colour.
    const why = res && !res.passed && res.why?.length
      ? `<span class="scenario-check-note scenario-check-why"><span class="scenario-why-title">Why:</span>${res.why.map(line => `<span class="scenario-why-line">${escapeHtml(line)}</span>`).join("")}</span>` : "";
    // …and, where a probe found one, the most likely thing wrong (hints.ts).
    const hint = res && !res.passed && res.hint
      ? `<span class="scenario-check-note scenario-check-hint"><span class="scenario-why-title">Likely cause:</span>${escapeHtml(res.hint)}</span>` : "";
    const note = (res && !res.passed && res.note ? `<span class="scenario-check-note">${escapeHtml(res.note)}</span>` : "") + why + hint;
    return `<li class="scenario-check ${cls}"><span class="mark">${mark}</span><span class="scenario-check-text">${escapeHtml(c.label)}${note}</span></li>`;
  }).join("");
  dom.scenarioStatus.textContent = lastResult
    ? (lastResult.passed ? "Scenario complete" : "Not yet — keep going.")
    : "";
  dom.scenarioStatus.className = "scenario-status" + (lastResult ? (lastResult.passed ? " pass" : " fail") : "");
}

export function runActiveScenarioCheck(): void {
  const scenario = getScenario(state.activeScenarioId);
  if (!scenario) return;
  // The checks run headless simulations on the shared simulation state; the
  // engine's beginRun stops an animated run in progress first (the same teardown
  // Stop uses) and says so, rather than letting the checks replace it silently.
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
