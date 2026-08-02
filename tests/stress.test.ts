import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { runConsoleCommand as exec } from "../src/commands";
import { diagnoseState } from "../src/diagnostics";
import { runStressTest, type StressReport } from "../src/stress";
import { state } from "../src/state";
import { freshNameCounters } from "../src/device-registry";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());

function reset(): void {
  resetState();
  state.nameCounters = freshNameCounters();
  state.configStore = { version: 1, configs: {} } as any;
}

describe("deterministic stress runner", () => {
  beforeEach(reset);

  it("runs a broad repeatable mutation sequence without corrupting state", () => {
    const report = exec("stress 20260706 500");
    expect(report.ok).toBe(true);
    expect((report.data as StressReport).completedSteps).toBe(500);
    expect(diagnoseState(state)).toEqual([]);
  });

  it("clears capped-run queues before a later cable edit", () => {
    const report = exec("stress 42 5000");
    expect(report.ok).toBe(true);
    expect((report.data as StressReport).completedSteps).toBe(5000);
  });

  it("generates the same commands for the same seed", () => {
    const first = exec("stress 42 120").data as StressReport;
    const firstCommands = first.actions.map(action => action.command);
    reset();
    const second = exec("stress 42 120").data as StressReport;
    expect(second.actions.map(action => action.command)).toEqual(firstCommands);
  });

  it("reports the failing action and seed when a command throws", () => {
    const report = runStressTest(
      9,
      3,
      command => ({ ok: false, output: [`Error: failed while running ${command}`] }),
      () => state,
      () => [],
    );
    expect(report.ok).toBe(false);
    expect(report.completedSteps).toBe(1);
    expect(report.issues[0]).toContain("Action 1 (topology basic) threw");
  });

  it("validates seed and step bounds", () => {
    expect(exec("stress nope 10").ok).toBe(false);
    expect(exec("stress 1 0").ok).toBe(false);
    expect(exec("stress 1 5001").ok).toBe(false);
    expect(exec("stress 4294967296 10").ok).toBe(false);
  });
});
