/**
 * Scenario framework tests — loading, goal evaluation, and console parity.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { state, defaultConfig, vlanRoasConfig, routerMeshConfig, wifiVlanConfig } from "../src/state";
import { SCENARIOS, getScenario, loadScenario, checkScenario, registerScenario, isValidScenarioCheck, unregisterScenario } from "../src/scenarios";
import { SCENARIO_GROUPS } from "../src/scenario-library";
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

describe("scenarios — chooser grouping", () => {
  const grouped = SCENARIO_GROUPS.flatMap(g => g.ids);

  it("every scenario id in a group exists", () => {
    const ids = new Set(SCENARIOS.map(s => s.id));
    for (const id of grouped) expect(ids.has(id)).toBe(true);
  });

  it("every scenario belongs to exactly one group (no orphans, no duplicates)", () => {
    const seen = new Set<string>();
    for (const id of grouped) {
      expect(seen.has(id)).toBe(false);   // no scenario listed in two groups
      seen.add(id);
    }
    const ungrouped = SCENARIOS.filter(s => !seen.has(s.id)).map(s => s.id);
    expect(ungrouped).toEqual([]);         // every built-in scenario is grouped
  });
});

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

describe("scenario import validates every check before registering (F12)", () => {
  it("accepts every well-formed kind", () => {
    const ok = [
      { kind: "link", a: "A", b: "B", label: "l" },
      { kind: "config", device: "A", field: "ipv4Address", equals: "x", label: "l" },
      { kind: "ping", from: "A", to: "B", label: "l" },
      { kind: "ping-fail", from: "A", to: "B", label: "l" },
      { kind: "tcp", from: "A", to: "B", port: 80, label: "l" },
      { kind: "tcp-fail", from: "A", to: "B", port: 22, label: "l" },
      { kind: "http", from: "A", to: "B", label: "l" },
      { kind: "dns", from: "A", name: "web", label: "l" },
      { kind: "dhcp", host: "A", label: "l" },
      { kind: "alert", from: "A", to: "B", contains: "scan", label: "l" },
    ];
    for (const c of ok) expect(isValidScenarioCheck(c)).toBe(true);
  });

  it("rejects null, primitives, unknown kinds, missing fields, and bad ports", () => {
    // `checks: [null]` used to register, then throw `c.label` in the banner on
    // every re-select — a permanently broken dropdown entry.
    const bad = [null, 7, "ping", {}, { kind: "teleport", label: "l" },
      { kind: "ping", from: "A", label: "l" },               // missing `to`
      { kind: "ping", from: "A", to: "B" },                  // missing label
      { kind: "tcp", from: "A", to: "B", port: "80", label: "l" },
      { kind: "tcp", from: "A", to: "B", port: 70000, label: "l" },
      { kind: "alert", from: "A", to: "B", label: "l" }];    // missing `contains`
    for (const c of bad) expect(isValidScenarioCheck(c)).toBe(false);
  });

  it("unregisterScenario removes an entry the import rolled back", () => {
    registerScenario({ id: "__tmp", name: "T", objective: "", topology: { devices: [], links: [] }, checks: [] } as any);
    expect(getScenario("__tmp")).toBeDefined();
    unregisterScenario("__tmp");
    expect(getScenario("__tmp")).toBeUndefined();
  });
});
