/**
 * Scenario framework tests — loading, goal evaluation, and console parity.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { state, defaultConfig, vlanRoasConfig, routerMeshConfig, wifiVlanConfig } from "../src/state";
import { SCENARIOS, getScenario, loadScenario, checkScenario } from "../src/scenarios";
import { addLink } from "../src/devices";
import { runConsoleCommand as exec, runConsoleScript } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

describe("built-in topologies & scenarios — positive coordinates", () => {
  const configs: [string, any][] = [
    ["default", defaultConfig], ["vlan-roas", vlanRoasConfig], ["router-mesh", routerMeshConfig],
    ["wifi-vlan", wifiVlanConfig],
    ...SCENARIOS.map(s => [`scenario:${s.id}`, s.topology] as [string, any]),
  ];
  for (const [name, cfg] of configs) {
    it(`${name} has all device coordinates >= 0`, () => {
      for (const d of cfg.devices) {
        expect(d.x, `${name} ${d.name || d.id} x`).toBeGreaterThanOrEqual(0);
        expect(d.y, `${name} ${d.name || d.id} y`).toBeGreaterThanOrEqual(0);
      }
    });
  }
});

beforeAll(() => registerNoopCallbacks());

describe("scenarios — Connect a LAN", () => {
  beforeEach(() => resetState());

  it("loads the initial topology (unlinked) and sets the active scenario", () => {
    expect(loadScenario("connect-lan")).toBe(true);
    expect(state.activeScenarioId).toBe("connect-lan");
    expect(state.devices.map(d => d.name).sort()).toEqual(["PC-A", "PC-B", "Switch-1"]);
    expect(state.links).toHaveLength(0);
  });

  it("rejects an unknown scenario id", () => {
    expect(loadScenario("nope")).toBe(false);
  });

  it("fails the goal before linking, passes after linking", () => {
    loadScenario("connect-lan");
    const scenario = getScenario("connect-lan")!;

    const before = checkScenario(scenario);
    expect(before.passed).toBe(false);
    expect(before.checks.every(c => !c.passed)).toBe(true);

    // Wire PC-A and PC-B to the switch.
    addLink("s1-pc-a", "s1-sw");
    addLink("s1-pc-b", "s1-sw");

    const after = checkScenario(scenario);
    expect(after.passed).toBe(true);
    expect(after.checks.find(c => c.label.includes("ping"))!.passed).toBe(true);
  });
});

describe("scenarios — console parity", () => {
  beforeEach(() => resetState());

  it("scenario list / load / check via the command engine", () => {
    expect(exec("scenario list").output.join("\n")).toContain("connect-lan");
    expect(exec("scenario load connect-lan").ok).toBe(true);

    const before = exec("scenario check");
    expect(before.ok).toBe(false);
    expect((before.data as any).passed).toBe(false);

    addLink("s1-pc-a", "s1-sw");
    addLink("s1-pc-b", "s1-sw");

    const after = exec("scenario check");
    expect(after.ok).toBe(true);
    expect((after.data as any).passed).toBe(true);
  });
});

// ─── Curriculum solvability ────────────────────────────────────────────────────
// The reference solutions live as runnable console scripts in scenario-solutions/
// — the single source of truth (a learner runs the very same files). Each script
// loads its scenario, applies the fix, and checks the goal (`#` comments and blank
// lines are ignored by the runner). This proves every entry starts unsolved and
// passes after its script, so the scripts can never drift from the curriculum.

const SOLUTION_DIR = join(import.meta.dir, "..", "scenario-solutions");
const readSolution = (id: string) => readFileSync(join(SOLUTION_DIR, `${id}.routesim.txt`), "utf8");

describe("scenarios — every curriculum entry is solvable", () => {
  beforeEach(() => resetState());

  for (const scenario of SCENARIOS) {
    it(`${scenario.id}: fails fresh, passes after its solution script`, () => {
      let script: string;
      try { script = readSolution(scenario.id); }
      catch { throw new Error(`missing solution script scenario-solutions/${scenario.id}.routesim.txt`); }
      expect(loadScenario(scenario.id)).toBe(true);

      const before = checkScenario(scenario);
      expect(before.passed, `${scenario.id} must not be pre-solved`).toBe(false);

      // The script re-loads the scenario, applies the solution, then runs `scenario
      // check` — every line must succeed (a failing command or unmet goal shows here).
      const results = runConsoleScript(script);
      const failed = results.filter(r => !r.ok);
      expect(failed.map(f => f.output.join(" ")), `${scenario.id} solution commands all succeed`).toEqual([]);

      const after = checkScenario(scenario);
      expect(after.checks.filter(c => !c.passed).map(c => c.label), `${scenario.id} checks after solving`).toEqual([]);
      expect(after.passed).toBe(true);
    });
  }
});
