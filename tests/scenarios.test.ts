/**
 * Scenario framework tests — loading, goal evaluation, and console parity.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state, defaultConfig, vlanRoasConfig, routerMeshConfig } from "../src/state";
import { SCENARIOS, getScenario, loadScenario, checkScenario } from "../src/scenarios";
import { addLink } from "../src/devices";
import { runConsoleCommand as exec } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

describe("built-in topologies & scenarios — positive coordinates", () => {
  const configs: [string, any][] = [
    ["default", defaultConfig], ["vlan-roas", vlanRoasConfig], ["router-mesh", routerMeshConfig],
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
