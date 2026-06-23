/**
 * JSON import/export tests (io.ts). File pickers (pickFile) can't be driven
 * headlessly, so we test the underlying data paths + that the download helpers
 * (Blob/anchor — stubbed in preload) don't throw.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { downloadJson, downloadText, exportConfig, exportScenarios, exportScript, exportLog } from "../src/io";
import { buildConfigPayload, parseConfig, applyConfig } from "../src/config";
import { placeToolDevice } from "../src/devices";
import { registerScenario, getScenario, SCENARIOS } from "../src/scenarios";
import { registerNoopCallbacks, resetState } from "./helpers";
import { basicTopology } from "./fixtures";

beforeAll(() => registerNoopCallbacks());

describe("io — config export→import data path", () => {
  beforeEach(() => resetState());

  it("buildConfigPayload → parseConfig → applyConfig reproduces the topology", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const before = {
      devices: state.devices.map(d => d.name).sort(),
      links: state.links.length,
      pc1ip: state.devices.find(d => d.id === "pc1")!.config.ipv4Address,
    };
    const json = JSON.stringify(buildConfigPayload());
    resetState();
    expect(state.devices).toHaveLength(0);
    applyConfig(parseConfig(json));
    const after = {
      devices: state.devices.map(d => d.name).sort(),
      links: state.links.length,
      pc1ip: state.devices.find(d => d.id === "pc1")!.config.ipv4Address,
    };
    expect(after).toEqual(before);
  });

  it("parseConfig throws on invalid JSON", () => {
    expect(() => parseConfig("{ not json")).toThrow();
  });

  it("a role-enabled-but-empty RADIUS server keeps its (empty) radius config across a round-trip", () => {
    const rad = placeToolDevice("radius-server", 0, 0);
    expect(rad.config.radius).toEqual({ users: [] });
    const json = JSON.stringify(buildConfigPayload());
    resetState();
    applyConfig(parseConfig(json));
    const restored = state.devices.find(d => d.type === "server")!;
    expect(restored.config.radius).toEqual({ users: [] });   // still flagged RADIUS, not a plain server
    expect(restored.config.dnsmasqRunning).toBe(false);
  });
});

describe("io — export helpers don't throw", () => {
  beforeEach(() => resetState());

  it("downloadJson/downloadText + the four exporters run", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    expect(() => {
      downloadJson({ a: 1 }, "x.json");
      downloadText("hello", "x.txt");
      exportConfig();
      exportScenarios();
      exportScript();
      exportLog();
    }).not.toThrow();
  });
});

describe("io — scenario registry import", () => {
  beforeEach(() => resetState());

  it("registerScenario adds (and replaces) a scenario", () => {
    const before = SCENARIOS.length;
    registerScenario({
      id: "io-test", name: "IO Test", objective: "x",
      topology: { version: 1, devices: [], links: [] },
      checks: [{ kind: "link", a: "A", b: "B", label: "linked" }],
    });
    expect(SCENARIOS.length).toBe(before + 1);
    expect(getScenario("io-test")?.name).toBe("IO Test");
    registerScenario({ ...getScenario("io-test")!, name: "IO Test 2" });
    expect(SCENARIOS.length).toBe(before + 1);          // replaced, not duplicated
    expect(getScenario("io-test")?.name).toBe("IO Test 2");
  });
});

describe("io — simulation log JSON round-trips", () => {
  beforeEach(() => resetState());

  it("serialises and parses the log", () => {
    state.simulation.log = [
      { step: 1, deviceId: "a", deviceName: "A", action: "x", kind: "sim-arp", summary: "s" },
    ] as any;
    const parsed = JSON.parse(JSON.stringify(state.simulation.log));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].deviceName).toBe("A");
  });
});
