/**
 * The Internet cloud — an L3 transit that represents the public internet. It
 * does NOT bridge: it routes IPv4 between the routers cabled to it (each on its
 * own public subnet), handing each a default route and answering ARP for the
 * gateway it presents. Covers placement/normalise, the L3-boundary semantics
 * (not an L2 bridge), the auto default route + routing between different public
 * subnets, the JSON round-trip, dropping unroutable destinations, and the
 * capstone: a private host reaching a published service at a different site
 * across the internet (NAT out, port-forward in, HTTP 200).
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { runSimulationHeadless, processAtInternet } from "../src/engine";
import { buildRoutingTable, runRipConvergence } from "../src/routing";
import { buildPingEvents, buildHttpEvents, l2Reachable } from "../src/simulation";
import { buildConfigPayload, parseConfig } from "../src/config";
import { createIcmpEchoRequest } from "../src/frame";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());
beforeEach(() => resetState());

const dev = (name: string) => state.devices.find(d => d.name === name)!;
const netLog = () => state.simulation.log.filter(l => l.deviceName === "NET").map(l => l.action);

describe("the internet cloud", () => {
  it("places as an L3 routing cloud (ports only, no MAC table)", () => {
    expect(exec("add internet NET at 0 0").ok).toBe(true);
    const net = dev("NET");
    expect(net.type).toBe("internet");
    expect(net.config!.ethernetPorts).toBe(8);
    expect(net.config!.macTable).toBeUndefined();   // it routes by destination, it doesn't MAC-learn
  });

  it("is an L3 boundary, not an L2 bridge — it does not stitch two hosts onto one segment", () => {
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
    expect(l2Reachable(pc1.id, dev("PC2").id, null)).toBe(false);   // not transparent at L2
    const r = runSimulationHeadless(buildPingEvents(pc1, "100.0.0.2") as any, pc1.id, "100.0.0.2", "ping");
    expect(r.success).toBe(false);                                  // the cloud only routes between routers
    expect(netLog().some(a => a.includes("routes"))).toBe(false);
  });

  it("routes between two routers on different public subnets, auto-handing each a default route", () => {
    // PC-A (private) — R1 — Internet — R2, on separate /30 public links. PC-A
    // reaches R2's public address with no manual default routes anywhere.
    runConsoleScript(`
      add computer PC-A at -500 0
      add router R1 at -300 0
      add internet NET at 0 0
      add router R2 at 300 0
      link PC-A R1
      link R1 NET
      link R2 NET
      ip PC-A 10.0.0.10/24
      gateway PC-A 10.0.0.1
      interface R1 PC-A ip 10.0.0.1/24
      interface R1 NET ip 203.0.113.1/30
      interface R2 NET ip 198.51.100.1/30
      cli R1 enable
      cli R1 configure terminal
      cli R1 interface Ethernet1
      cli R1 ip nat inside
      cli R1 exit
      cli R1 interface Ethernet2
      cli R1 ip nat outside
      cli R1 end
    `);
    const r1 = dev("R1"), pcA = dev("PC-A");
    // The cloud presents a gateway and R1 auto-learns a default route toward it.
    const def = buildRoutingTable(r1).find(rt => rt.network === "0.0.0.0/0");
    expect(def?.nextHop).toBe("203.0.113.2");                       // the cloud's gateway on R1's /30
    // The two edge routers are on genuinely different subnets.
    expect(r1.config!.interfaces!.find(i => i.peerId === dev("NET").id)!.ipv4Address).toBe("203.0.113.1");

    const r = runSimulationHeadless(buildPingEvents(pcA, "198.51.100.1") as any, pcA.id, "198.51.100.1", "ping");
    expect(r.success).toBe(true);
    expect(netLog().some(a => a.includes("Internet routes") && a.includes("R2"))).toBe(true);
  });

  it("drops a destination no connected router owns (the rest of the internet is unreachable)", () => {
    runConsoleScript(`
      add computer PC-A at -500 0
      add router R1 at -300 0
      add internet NET at 0 0
      link PC-A R1
      link R1 NET
      ip PC-A 10.0.0.10/24
      gateway PC-A 10.0.0.1
      interface R1 PC-A ip 10.0.0.1/24
      interface R1 NET ip 203.0.113.1/30
      cli R1 enable
      cli R1 configure terminal
      cli R1 interface Ethernet1
      cli R1 ip nat inside
      cli R1 exit
      cli R1 interface Ethernet2
      cli R1 ip nat outside
      cli R1 end
    `);
    const pcA = dev("PC-A");
    const r = runSimulationHeadless(buildPingEvents(pcA, "8.8.8.8") as any, pcA.id, "8.8.8.8", "ping");
    expect(r.success).toBe(false);
    expect(netLog().some(a => a.includes("No route to 8.8.8.8 on the internet"))).toBe(true);
  });

  it("originates a default into RIP so a router several hops from the edge still gets out", () => {
    // PC — R-INNER (RIP) — R-EDGE (RIP + internet) — Internet. R-INNER has no
    // internet interface of its own; it must learn the way out via RIP.
    runConsoleScript(`
      add router R-EDGE at 0 0
      add internet NET at 200 0
      add router R-INNER at -300 0
      link R-EDGE NET
      link R-INNER R-EDGE
      interface R-EDGE NET ip 203.0.113.1/30
      interface R-EDGE R-INNER ip 10.10.10.1/30
      interface R-INNER R-EDGE ip 10.10.10.2/30
      cli R-EDGE enable
      cli R-EDGE configure terminal
      cli R-EDGE router rip
      cli R-EDGE network 10.10.10.0/30
      cli R-EDGE end
      cli R-INNER enable
      cli R-INNER configure terminal
      cli R-INNER router rip
      cli R-INNER network 10.10.10.0/30
      cli R-INNER end
    `);
    runRipConvergence();
    // The edge keeps its own real (static) default toward the cloud...
    const edgeDef = buildRoutingTable(dev("R-EDGE")).find(r => r.network === "0.0.0.0/0");
    expect(edgeDef?.type).toBe("S");
    expect(edgeDef?.nextHop).toBe("203.0.113.2");
    // ...and the inner router learns one via RIP, next-hopping the edge.
    const innerDef = buildRoutingTable(dev("R-INNER")).find(r => r.network === "0.0.0.0/0");
    expect(innerDef?.type).toBe("R");
    expect(innerDef?.nextHop).toBe("10.10.10.1");
  });

  it("emits an ICMP Time-Exceeded when a packet expires on it (so it is a real traceroute hop)", () => {
    runConsoleScript(`
      add router R1 at -200 0
      add internet NET at 0 0
      add router R2 at 200 0
      link R1 NET
      link R2 NET
      interface R1 NET ip 203.0.113.1/30
      interface R2 NET ip 198.51.100.1/30
    `);
    const net = dev("NET"), r1 = dev("R1");
    const r1mac = r1.config!.interfaces!.find(i => i.peerId === net.id)!.macAddress;
    // A packet destined across the cloud (to R2) arriving with TTL 1 must expire here.
    const frame = createIcmpEchoRequest(r1mac, "02:00:00:00:00:99", "203.0.113.1", "198.51.100.1", 1);
    const out = processAtInternet(net, frame, r1.id);
    expect(out.length).toBe(1);
    const p = out[0].frame.payload as any;
    expect(p.type).toBe("ipv4");
    expect(p.payload.icmpType).toBe(11);          // Time-Exceeded
    expect(p.srcIp).toBe("203.0.113.2");          // sourced from the cloud's gateway on R1's link
    expect(p.dstIp).toBe("203.0.113.1");          // back to the sender
    expect(out[0].toDeviceId).toBe(r1.id);
  });

  it("round-trips through the config payload", () => {
    runConsoleScript(`add internet NET at 0 0`);
    const round = parseConfig(JSON.stringify(buildConfigPayload()));
    const net = round.devices.find((d: any) => d.name === "NET");
    expect(net.type).toBe("internet");
    expect(net.config.ethernetPorts).toBe(8);
  });

  it("carries two sites across the internet: NAT out, port-forward in, HTTP 200", () => {
    // PC-A (private) — R1 (NAT) — Internet — R2 (port-forward) — WEB, with R1 and
    // R2 on different public subnets and no manual default routes.
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
      interface R1 NET ip 203.0.113.1/30
      interface R2 NET ip 198.51.100.1/30
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
      cli R2 ip nat inside source static tcp 10.0.1.80 80 198.51.100.1 80
      cli R2 end
    `);
    const pcA = dev("PC-A");
    // PC-A loads the published service at R2's public address, across the internet.
    const r = runSimulationHeadless(buildHttpEvents(pcA, "198.51.100.1") as any, pcA.id, "198.51.100.1", "http", 80);
    expect(r.httpStatus).toBe(200);
    expect(netLog().some(a => a.includes("Internet routes"))).toBe(true);
  });
});
