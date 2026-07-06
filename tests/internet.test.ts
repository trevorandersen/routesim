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
import { runSimulationHeadless, processAtInternet, runTraceroute } from "../src/engine";
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

  it("dual-edge: both edges keep originating; neither learns the other's default", () => {
    // R-A and R-B are BOTH cabled to the internet (separate /30s) and are RIP
    // neighbours; R-C sits behind R-B. Each edge must originate its own default
    // (an edge never learns one), so R-C hears a metric-1 default from R-B —
    // not a metric-2 relay of R-A's, and no edge depends on the other's word.
    runConsoleScript(`
      add internet NET at 0 200
      add router R-A at -200 0
      add router R-B at 200 0
      add router R-C at 500 0
      link R-A NET
      link R-B NET
      link R-A R-B
      link R-B R-C
      interface R-A NET ip 203.0.113.1/30
      interface R-B NET ip 198.51.100.1/30
      interface R-A R-B ip 10.0.0.1/30
      interface R-B R-A ip 10.0.0.2/30
      interface R-B R-C ip 10.0.1.1/30
      interface R-C R-B ip 10.0.1.2/30
      cli R-A enable
      cli R-A configure terminal
      cli R-A router rip
      cli R-A network 10.0.0.0/30
      cli R-A end
      cli R-B enable
      cli R-B configure terminal
      cli R-B router rip
      cli R-B network 10.0.0.0/30
      cli R-B network 10.0.1.0/30
      cli R-B end
      cli R-C enable
      cli R-C configure terminal
      cli R-C router rip
      cli R-C network 10.0.1.0/30
      cli R-C end
    `);
    runRipConvergence();
    const noDefault = (name: string) =>
      (dev(name).config!.rip!.learnedRoutes || []).every(r => r.network !== "0.0.0.0/0");
    expect(noDefault("R-A")).toBe(true);   // edges never learn a default…
    expect(noDefault("R-B")).toBe(true);
    const cDef = dev("R-C").config!.rip!.learnedRoutes!.find(r => r.network === "0.0.0.0/0");
    expect(cDef?.metric).toBe(1);          // …and R-C hears R-B's own origination, not a relay
    expect(cDef?.nextHop).toBe("10.0.1.1");
    // Both edges keep their real (static) default toward their own cloud link.
    expect(buildRoutingTable(dev("R-A")).find(r => r.network === "0.0.0.0/0")?.nextHop).toBe("203.0.113.2");
    expect(buildRoutingTable(dev("R-B")).find(r => r.network === "0.0.0.0/0")?.nextHop).toBe("198.51.100.2");
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

  it("traceroute from behind NAT sees every hop — errors are un-NAT'd via the embedded original", () => {
    // PC-A (private) — R1 (NAT) — Internet — R2. The cloud's Time-Exceeded is
    // addressed to R1's outside IP; without the embedded-original restore it
    // would die at R1 and the cloud hop would read "* no response".
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
    const res = runTraceroute(dev("PC-A"), "198.51.100.1") as any;
    expect(res.reached).toBe(true);
    expect(res.hops.map((h: any) => h.ip)).toEqual([
      "10.0.0.1",       // R1 (the NAT gateway itself)
      "203.0.113.2",    // the internet cloud's gateway — visible THROUGH the NAT
      "198.51.100.1",   // R2's public address (destination reached)
    ]);
  });

  it("round-trips through the config payload", () => {
    runConsoleScript(`add internet NET at 0 0`);
    const round = parseConfig(JSON.stringify(buildConfigPayload()));
    const net = round.devices.find((d: any) => d.name === "NET")!;
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
