/**
 * The Internet cloud — a transparent L2 transit (unmanaged-switch semantics)
 * that forwards between connected routers. Placement/normalise, the MAC-learning
 * forward, L2 reachability across it, the JSON round-trip, and the capstone:
 * a private host reaching a published service at another site across the internet
 * through two NAT routers.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { runSimulationHeadless } from "../src/engine";
import { buildPingEvents, buildHttpEvents, l2Reachable } from "../src/simulation";
import { buildConfigPayload, parseConfig } from "../src/config";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());
beforeEach(() => resetState());

const dev = (name: string) => state.devices.find(d => d.name === name)!;

describe("the internet cloud", () => {
  it("places as an unmanaged-switch-like transit (ports + MAC table, no role config)", () => {
    expect(exec("add internet NET at 0 0").ok).toBe(true);
    const net = dev("NET");
    expect(net.type).toBe("internet");
    expect(net.config!.ethernetPorts).toBe(8);
    expect(Array.isArray(net.config!.macTable)).toBe(true);
  });

  it("bridges two hosts on a shared subnet (MAC-learning forward) and is L2-transparent", () => {
    runConsoleScript(`
      add internet NET at 0 0
      add computer PC1 at -200 0
      add computer PC2 at 200 0
      link PC1 NET
      link PC2 NET
      ip PC1 100.0.0.1/24
      ip PC2 100.0.0.2/24
    `);
    const pc1 = dev("PC1");
    expect(l2Reachable(pc1.id, dev("PC2").id, null)).toBe(true); // transparent transit
    const r = runSimulationHeadless(buildPingEvents(pc1, "100.0.0.2") as any, pc1.id, "100.0.0.2", "ping");
    expect(r.success).toBe(true);
    const netLog = state.simulation.log.filter(l => l.deviceName === "NET").map(l => l.action);
    expect(netLog.some(a => a.includes("MAC learn"))).toBe(true);                 // learns
    expect(netLog.some(a => a.includes("Forward") && a.includes("known unicast"))).toBe(true); // forwards appropriately
  });

  it("round-trips through the config payload", () => {
    runConsoleScript(`add internet NET at 0 0`);
    const round = parseConfig(JSON.stringify(buildConfigPayload()));
    const net = round.devices.find((d: any) => d.name === "NET");
    expect(net.type).toBe("internet");
    expect(net.config.ethernetPorts).toBe(8);
  });

  it("carries two sites across the internet: NAT out, port-forward in, HTTP 200", () => {
    // PC-A (private) — R1 (NAT) — Internet — R2 (port-forward) — WEB (web service)
    runConsoleScript(`
      add computer PC-A at -500 0
      add router R1 at -300 0
      add internet NET at 0 0
      add router R2 at 300 0
      add server WEB at 500 0
      link PC-A R1
      link R1 NET
      link R2 NET
      link WEB R2
      ip PC-A 10.0.0.10/24
      gateway PC-A 10.0.0.1
      interface R1 PC-A ip 10.0.0.1/24
      interface R1 NET ip 203.0.113.1/24
      interface R2 NET ip 203.0.113.2/24
      interface R2 WEB ip 10.0.1.1/24
      ip WEB 10.0.1.80/24
      gateway WEB 10.0.1.1
      web WEB on
      cli R1 enable
      cli R1 configure terminal
      cli R1 interface Ethernet1
      cli R1 ip nat inside
      cli R1 exit
      cli R1 interface Ethernet2
      cli R1 ip nat outside
      cli R1 end
      cli R2 enable
      cli R2 configure terminal
      cli R2 ip nat inside source static tcp 10.0.1.80 80 203.0.113.2 80
      cli R2 end
    `);
    const pcA = dev("PC-A");
    // PC-A loads the published service at R2's public address, across the internet.
    const r = runSimulationHeadless(buildHttpEvents(pcA, "203.0.113.2") as any, pcA.id, "203.0.113.2", "http", 80);
    expect(r.httpStatus).toBe(200);
    // the internet cloud actually forwarded the transit traffic
    expect(state.simulation.log.some(l => l.deviceName === "NET" && l.action.includes("Forward"))).toBe(true);
  });
});
