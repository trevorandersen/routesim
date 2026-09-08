/**
 * JSON import/export tests (io.ts). File pickers (pickFile) can't be driven
 * headlessly, so we test the underlying data paths + that the download helpers
 * (Blob/anchor — stubbed in preload) don't throw.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { collapseLan as _collapseLan, addDevice as _addDevice } from "../src/devices";
import { buildConfigPayload as _payload } from "../src/config";
import { normaliseConfig as _normalise } from "../src/normalise";
import { DEVICE_TYPES as _TYPES } from "../src/device-registry";
import { routedTopology as _routed } from "./fixtures";
import { state as _state } from "../src/state";
import { resetState as _reset, registerNoopCallbacks as _noop } from "./helpers";
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

describe("persistence — a collapsed LAN keeps its router interfaces (F02)", () => {
  beforeAll(() => _noop());
  beforeEach(() => _reset());
  it("the payload asks whether a cable is REAL, not whether it is drawn", () => {
    const t = _routed(); _state.devices = t.devices as any; _state.links = t.links as any;
    const r = _state.devices.find(d => d.type === "router")!;
    const sw = _state.devices.find(d => d.type === "switch")!;
    const ifaces = () => (_payload() as any).devices.find((d: any) => d.id === r.id).config.interfaces.map((i: any) => i.ipv4Address).sort();
    const before = ifaces();
    _collapseLan(sw);
    expect(_state.links.some(l => l.hidden)).toBe(true);          // collapse really happened
    expect(ifaces()).toEqual(before);                             // nothing dropped
    const back = _normalise(_payload() as any);
    expect(back.devices.find(d => d.id === r.id)!.config.interfaces!.length).toBe(before.length);
  });
});

describe("persistence — every device type carries its config through the payload (F11)", () => {
  beforeAll(() => _noop());
  beforeEach(() => _reset());
  it("hub and internet port counts round-trip", () => {
    const hub = _addDevice("hub", 0, 0); hub.config!.ethernetPorts = 16;
    const net = _addDevice("internet", 200, 0); net.config!.ethernetPorts = 20;
    const back = _normalise(_payload() as any);
    expect(back.devices.find(d => d.id === hub.id)!.config.ethernetPorts).toBe(16);
    expect(back.devices.find(d => d.id === net.id)!.config.ethernetPorts).toBe(20);
  });
  it("no registered type falls through buildConfigPayload without a config branch", () => {
    // Exhaustiveness guard: a new DeviceType added to the registry but not to
    // the payload builder would lose its config silently — this fails first.
    for (const type of _TYPES) {
      if (type === "lan") continue;                               // synthetic, serialised separately
      _reset();
      const d = _addDevice(type as any, 0, 0);
      const out = (_payload() as any).devices.find((x: any) => x.id === d.id);
      expect(out && typeof out.config === "object").toBe(true);
    }
  });
});
