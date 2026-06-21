/**
 * WiFi — the laptop (WiFi-only host) and access point (L2 bridge) devices, the
 * wireless association link, and forwarding through an AP onto the wired LAN.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { addLink, classifyLink, linkBlockReason } from "../src/devices";
import { runSimulationHeadless } from "../src/engine";
import { buildPingEvents } from "../src/simulation";
import { runConsoleScript, runConsoleCommand as exec, exportTopologyScript } from "../src/commands";
import { buildConfigPayload, parseConfig, applyConfig } from "../src/config";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());

const byName = (name: string) => state.devices.find(d => d.name === name)!;

describe("wifi — device types", () => {
  beforeEach(() => resetState());

  it("a laptop is a WiFi-only host (gets a MAC, takes host config)", () => {
    runConsoleScript("add laptop LT1 at 0 0\nip LT1 10.0.0.5/24");
    const lt = byName("LT1");
    expect(lt.type).toBe("laptop");
    expect(lt.config.macAddress).toMatch(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/); // auto NIC MAC on add
    expect(lt.config.ipv4Address).toBe("10.0.0.5");
  });

  it("an access point normalises to an unmanaged-switch config", () => {
    runConsoleScript("add access-point AP1 at 0 0");
    const ap = byName("AP1");
    expect(ap.type).toBe("access-point");
    expect(ap.config.managed).toBe(false);
    expect(ap.config.ethernetPorts).toBeGreaterThan(0);
  });
});

describe("wifi — wireless association link", () => {
  beforeEach(() => resetState());

  function topo() {
    runConsoleScript(`
      add laptop LT1 at 0 0
      add access-point AP1 at 100 0
      add switch SW at 200 0
    `);
    return { lt: byName("LT1"), ap: byName("AP1"), sw: byName("SW") };
  }

  it("laptop ↔ AP is allowed and marked wireless", () => {
    const { lt, ap } = topo();
    expect(classifyLink(lt.id, ap.id).wireless).toBe(true);
    expect(linkBlockReason(lt.id, ap.id)).toBeNull();
    addLink(lt.id, ap.id);
    const link = state.links.find(l => l.from === lt.id || l.to === lt.id)!;
    expect(link.wireless).toBe(true);
  });

  it("a laptop cannot associate to a non-AP, or to another laptop", () => {
    const { lt, sw } = topo();
    expect(linkBlockReason(lt.id, sw.id)).toMatch(/wireless/i);
    expect(exec("link LT1 SW").ok).toBe(false); // surfaced via the console too
    runConsoleScript("add laptop LT2 at 0 100");
    expect(linkBlockReason(lt.id, byName("LT2").id)).toMatch(/laptop/i);
  });

  it("a laptop has a single NIC — one association only", () => {
    const { lt, ap } = topo();
    addLink(lt.id, ap.id);
    runConsoleScript("add access-point AP2 at 100 100");
    expect(linkBlockReason(lt.id, byName("AP2").id)).toMatch(/single NIC/i);
  });
});

describe("wifi — forwarding through an access point", () => {
  beforeEach(() => resetState());

  it("a laptop reaches the wired LAN via its AP (bridged like a switch)", () => {
    runConsoleScript(`
      add laptop LT1 at 0 0
      add access-point AP1 at 100 0
      add switch SW at 200 0
      add router R1 at 300 0
      link LT1 AP1
      link AP1 SW
      link SW R1
      interface R1 SW ip 192.168.1.1
      ip LT1 192.168.1.10/24
      gateway LT1 192.168.1.1
    `);
    const lt = byName("LT1");
    const res = runSimulationHeadless(buildPingEvents(lt, "192.168.1.1") as any, lt.id, "192.168.1.1", "ping");
    expect(res.success).toBe(true);
  });

  it("two laptops on the same AP reach each other", () => {
    runConsoleScript(`
      add laptop LT1 at 0 0
      add laptop LT2 at 0 100
      add access-point AP1 at 100 0
      link LT1 AP1
      link LT2 AP1
      ip LT1 10.0.0.1/24
      ip LT2 10.0.0.2/24
    `);
    const lt1 = byName("LT1");
    const res = runSimulationHeadless(buildPingEvents(lt1, "10.0.0.2") as any, lt1.id, "10.0.0.2", "ping");
    expect(res.success).toBe(true);
  });
});

describe("wifi — serialisation round-trips", () => {
  beforeEach(() => resetState());

  it("laptop/AP and the wireless flag survive JSON export → import", () => {
    runConsoleScript(`
      add laptop LT1 at 0 0
      add access-point AP1 at 100 0
      link LT1 AP1
      ip LT1 10.0.0.5/24
    `);
    const json = JSON.stringify(buildConfigPayload());
    resetState();
    applyConfig(parseConfig(json));
    const lt = byName("LT1");
    expect(lt.type).toBe("laptop");
    expect(lt.config.ipv4Address).toBe("10.0.0.5");
    expect(byName("AP1").type).toBe("access-point");
    expect(state.links[0].wireless).toBe(true);
  });

  it("a topology script re-derives the wireless association on replay", () => {
    runConsoleScript("add laptop LT1 at 0 0\nadd access-point AP1 at 100 0\nlink LT1 AP1");
    const script = exportTopologyScript();
    expect(script).toContain("add laptop LT1");
    expect(script).toContain("add access-point AP1");
    resetState();
    runConsoleScript(script);
    expect(state.links[0].wireless).toBe(true); // classifyLink re-marks it on the replayed `link`
  });
});
