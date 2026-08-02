import { beforeEach, describe, expect, it } from "bun:test";
import { diagnoseState } from "../src/diagnostics";
import { state } from "../src/state";
import { resetState } from "./helpers";

describe("runtime diagnostics", () => {
  beforeEach(resetState);

  it("accepts a clean empty state", () => {
    expect(diagnoseState(state)).toEqual([]);
  });

  it("reports duplicate ids, dangling links, and invalid coordinates", () => {
    state.devices = [
      { id: "pc", type: "computer", name: "PC1", x: 10, y: 20, config: {} },
      { id: "pc", type: "computer", name: "PC2", x: Number.NaN, y: 30, config: {} },
    ] as any;
    state.links = [{ id: "wire", from: "pc", to: "missing" }] as any;

    const issues = diagnoseState(state);
    expect(issues.some(issue => issue.includes("Duplicate device id"))).toBe(true);
    expect(issues.some(issue => issue.includes("non-finite coordinates"))).toBe(true);
    expect(issues.some(issue => issue.includes("missing endpoint missing"))).toBe(true);
  });

  it("reports stale selection and animation references", () => {
    state.selectedId = "gone";
    state.simulation.transits = [{
      frame: {} as any,
      linkId: "gone-link",
      fromDeviceId: "gone",
      toDeviceId: "also-gone",
      progress: Number.NaN,
      startTime: 0,
    }];

    const issues = diagnoseState(state);
    expect(issues.some(issue => issue.includes("Selection references missing device"))).toBe(true);
    expect(issues.some(issue => issue.includes("Transit references missing link"))).toBe(true);
    expect(issues.some(issue => issue.includes("invalid animation values"))).toBe(true);
  });

  it("allows a completed run to remain as history after an endpoint edit", () => {
    state.simulation.status = "done";
    state.simulation.originDeviceId = "removed-after-run";

    expect(diagnoseState(state)).toEqual([]);
  });
});
