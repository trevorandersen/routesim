/**
 * Real-subnet-prefix behaviour — proves the simulation honours configured
 * prefix lengths instead of assuming /24 everywhere.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { runSimulationHeadless, routingLookup, buildRoutingTable } from "../src/engine";
import { buildPingEvents } from "../src/simulation";
import { buildConfigPayload, parseConfig } from "../src/config";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());

describe("prefixes — same-subnet decisions", () => {
  beforeEach(() => resetState());

  it("a /16 spans hosts that /24 logic would separate", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      add computer PC2 at 200 0
      add switch SW1 at 100 0
      link SW1 PC1
      link SW1 PC2
      ip PC1 10.0.1.5/16
      ip PC2 10.0.2.5/16
    `);
    const pc1 = state.devices.find(d => d.name === "PC1")!;
    expect(pc1.config.prefixLength).toBe(16);
    const setup = buildPingEvents(pc1, "10.0.2.5");
    expect(typeof setup).not.toBe("string"); // same subnet under /16 → direct L2 ping
    expect(runSimulationHeadless(setup as any, pc1.id, "10.0.2.5", "ping").success).toBe(true);
  });

  it("a /30 separates hosts that /24 logic would join", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      add computer PC2 at 200 0
      add switch SW1 at 100 0
      link SW1 PC1
      link SW1 PC2
      ip PC1 192.168.1.1/30
      ip PC2 192.168.1.5/30
    `);
    const pc1 = state.devices.find(d => d.name === "PC1")!;
    // Different /30 blocks → cross-subnet; PC1 has no gateway, so ping errors out.
    const setup = buildPingEvents(pc1, "192.168.1.5");
    expect(typeof setup).toBe("string");
    expect(setup as string).toContain("no default gateway");
  });
});

describe("prefixes — longest-prefix routing", () => {
  beforeEach(() => resetState());

  it("a /24 static route wins over a /16 connected route", () => {
    runConsoleScript(`
      add router R1 at 0 0
      add switch SW1 at 100 0
      add switch SW2 at -100 0
      link R1 SW1
      link R1 SW2
    `);
    const r1 = state.devices.find(d => d.name === "R1")!;
    exec("interface R1 SW1 ip 10.0.0.1/16");
    exec("interface R1 SW2 ip 172.16.0.1/24");
    exec("route R1 10.0.50.0/24 172.16.0.9");

    // 10.0.50.x is inside both the /16 connected network and the /24 static.
    const inStatic = routingLookup(r1, "10.0.50.7")!;
    expect(inStatic.nextHopIp).toBe("172.16.0.9"); // /24 static wins
    // Elsewhere in the /16, the connected route applies (egress toward SW1).
    const inConnected = routingLookup(r1, "10.0.99.7")!;
    expect(inConnected.nextHopIp).toBe("10.0.99.7");
  });

  it("a prebuilt routing table yields the same lookup as building per call (ARP-flush path)", () => {
    runConsoleScript(`
      add router R1 at 0 0
      add switch SW1 at 200 0
      add switch SW2 at -200 0
      link R1 SW1
      link R1 SW2
    `);
    const r1 = state.devices.find(d => d.name === "R1")!;
    exec("interface R1 SW1 ip 10.0.0.1/24");
    exec("interface R1 SW2 ip 172.16.0.1/24");
    exec("route R1 192.168.9.0/24 172.16.0.9");
    const table = buildRoutingTable(r1);
    for (const ip of ["10.0.0.5", "192.168.9.9", "8.8.8.8"]) {
      expect(routingLookup(r1, ip, table)).toEqual(routingLookup(r1, ip)); // prebuilt === per-call
    }
  });
});

describe("prefixes — DHCP subnet-mask option", () => {
  beforeEach(() => resetState());

  it("the client receives the interface's prefix with its lease", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      add switch SW1 at 100 0
      add router R1 at 200 0
      link PC1 SW1
      link SW1 R1
    `);
    exec("interface R1 SW1 ip 10.0.0.1/16");
    const r = exec("run dhcp PC1");
    expect(r.ok).toBe(true);
    const pc1 = state.devices.find(d => d.name === "PC1")!;
    expect(pc1.config.prefixLength).toBe(16);
  });
});

describe("prefixes — config round-trip", () => {
  beforeEach(() => resetState());

  it("prefixLength survives export → import for hosts and router interfaces", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      add router R1 at 100 0
      link PC1 R1
      ip PC1 10.1.2.3/16
    `);
    exec("interface R1 PC1 ip 10.1.0.1/16");
    const round = parseConfig(JSON.stringify(buildConfigPayload()));
    const pc1 = round.devices.find((d: any) => d.name === "PC1")!;
    const r1 = round.devices.find((d: any) => d.name === "R1")!;
    expect(pc1.config.prefixLength).toBe(16);
    expect(r1.config.interfaces[0].prefixLength).toBe(16);
  });
});

describe("prefixes — subnet identification on display surfaces", () => {
  beforeEach(() => resetState());

  function mixedTopology() {
    runConsoleScript(`
      add computer PC1 at 0 0
      add router R1 at 100 0
      link PC1 R1
      ip PC1 10.1.2.3/16
    `);
    exec("interface R1 PC1 ip 10.1.0.1/16");
  }

  it("`show` reports address/prefix and the derived subnet", () => {
    mixedTopology();
    const pc = exec("show PC1").output.join("\n");
    expect(pc).toContain("ip: 10.1.2.3/16 (subnet 10.1.0.0/16)");
    const rtr = exec("show R1").output.join("\n");
    expect(rtr).toContain("10.1.0.1/16");
  });

  it("`show ip interface brief` includes the prefix", () => {
    mixedTopology();
    const out = exec("cli R1 show ip interface brief").output.join("\n");
    expect(out).toContain("10.1.0.1/16");
  });

  it("script export round-trips non-/24 prefixes (was silently dropped)", () => {
    mixedTopology();
    const script = (exec("export").data as string) ?? "";
    expect(script).toContain("ip PC1 10.1.2.3/16");
    expect(script).toContain("ip 10.1.0.1/16");
    const results = runConsoleScript(script);
    expect(results.filter(r => !r.ok)).toEqual([]);
    const pc1 = state.devices.find(d => d.name === "PC1")!;
    const r1 = state.devices.find(d => d.name === "R1")!;
    expect(pc1.config.prefixLength).toBe(16);
    expect(r1.config.interfaces![0].prefixLength).toBe(16);
  });
});
