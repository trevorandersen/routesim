/**
 * RIP across a shared L2 segment (review R19). RIPv2 multicasts its updates on
 * the segment, so routers joined through a core switch, a hub or an access
 * point are neighbours — not only routers cabled straight to each other. The
 * adjacency honours the segment: same subnet, same VLAN, a live L2 path.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { runSimulationHeadless } from "../src/engine";
import { buildRoutingTable, runRipConvergence } from "../src/routing";
import { buildPingEvents } from "../src/simulation";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());
beforeEach(() => resetState());

const dev = (name: string) => state.devices.find(d => d.name === name)!;
const learned = (name: string) => {
  runRipConvergence();
  return (dev(name).config!.rip!.learnedRoutes || []).map(r => `${r.network} via ${r.nextHop}`).sort();
};
const rip = (router: string, ...networks: string[]) => [
  `cli ${router} enable`, `cli ${router} configure terminal`, `cli ${router} router rip`,
  ...networks.map(n => `cli ${router} network ${n}`), `cli ${router} end`,
].join("\n");
const ping = (from: string, to: string) => {
  const src = dev(from);
  return runSimulationHeadless(buildPingEvents(src, to) as any, src.id, to, "ping");
};

// Three routers on one core segment (10.0.0.0/24), each with its own LAN and PC.
function core(kind: "switch" | "hub") {
  const rejected = runConsoleScript(`
    add ${kind} CORE at 0 0
    add router R1 at -300 0
    add router R2 at 300 0
    add router R3 at 0 300
    add computer PC1 at -500 0
    add computer PC2 at 500 0
    add computer PC3 at 0 500
    link R1 CORE
    link R2 CORE
    link R3 CORE
    link PC1 R1
    link PC2 R2
    link PC3 R3
    interface R1 CORE ip 10.0.0.1/24
    interface R2 CORE ip 10.0.0.2/24
    interface R3 CORE ip 10.0.0.3/24
    interface R1 PC1 ip 192.168.1.1/24
    interface R2 PC2 ip 192.168.2.1/24
    interface R3 PC3 ip 192.168.3.1/24
    ip PC1 192.168.1.10/24
    ip PC2 192.168.2.10/24
    ip PC3 192.168.3.10/24
    gateway PC1 192.168.1.1
    gateway PC2 192.168.2.1
    gateway PC3 192.168.3.1
    ${rip("R1", "10.0.0.0/24", "192.168.1.0/24")}
    ${rip("R2", "10.0.0.0/24", "192.168.2.0/24")}
    ${rip("R3", "10.0.0.0/24", "192.168.3.0/24")}
  `).filter(r => !r.ok);
  expect(rejected).toEqual([]);
}

describe("RIP forms adjacencies across a shared segment (R19)", () => {
  it("three routers on a core switch learn each other's LANs, next hop = the advertiser's core address", () => {
    core("switch");
    expect(learned("R1")).toEqual(["192.168.2.0/24 via 10.0.0.2", "192.168.3.0/24 via 10.0.0.3"]);
    expect(learned("R2")).toEqual(["192.168.1.0/24 via 10.0.0.1", "192.168.3.0/24 via 10.0.0.3"]);
    expect(learned("R3")).toEqual(["192.168.1.0/24 via 10.0.0.1", "192.168.2.0/24 via 10.0.0.2"]);
    expect(buildRoutingTable(dev("R1")).some(r => r.type === "R" && r.network === "192.168.3.0/24" && r.nextHop === "10.0.0.3")).toBe(true);
  });

  it("a ping between LANs behind different routers succeeds (it used to fail with No route)", () => {
    core("switch");
    expect(ping("PC1", "192.168.3.10").success).toBe(true);
    expect(ping("PC3", "192.168.2.10").success).toBe(true);
  });

  it("works through a hub as well", () => {
    core("hub");
    expect(learned("R1")).toEqual(["192.168.2.0/24 via 10.0.0.2", "192.168.3.0/24 via 10.0.0.3"]);
    expect(ping("PC2", "192.168.1.10").success).toBe(true);
  });

  it("a router whose core interface is in another subnet is not a neighbour", () => {
    core("switch");
    exec("interface R3 CORE ip 10.0.9.3/24");
    exec("cli R3 configure terminal"); exec("cli R3 router rip"); exec("cli R3 network 10.0.9.0/24"); exec("cli R3 end");
    expect(learned("R1")).toEqual(["192.168.2.0/24 via 10.0.0.2"]);
    expect(learned("R3")).toEqual([]);
  });

  it("an interface with no covering `network` statement, or a passive one, takes no part", () => {
    core("switch");
    exec("cli R3 configure terminal"); exec("cli R3 router rip");
    expect(exec("cli R3 no network 10.0.0.0/24").ok).toBe(true);
    expect(learned("R3")).toEqual([]);
    expect(learned("R1")).toEqual(["192.168.2.0/24 via 10.0.0.2"]);
    expect(exec("cli R3 network 10.0.0.0/24").ok).toBe(true);
    expect(exec("cli R3 passive-interface Ethernet1").ok).toBe(true);
    expect(learned("R3")).toEqual([]);
    expect(learned("R2")).toEqual(["192.168.1.0/24 via 10.0.0.1"]);
  });

  it("a shut cable or a powered-off core takes the adjacency with it", () => {
    core("switch");
    exec("shut R3 CORE");
    expect(learned("R1")).toEqual(["192.168.2.0/24 via 10.0.0.2"]);
    expect(learned("R3")).toEqual([]);
    exec("noshut R3 CORE");
    expect(learned("R3").length).toBe(2);
    exec("power CORE off");
    expect(learned("R1")).toEqual([]);
    expect(ping("PC1", "192.168.3.10").success).toBe(false);
  });

  it("split horizon still holds on the shared segment: nothing learnt there is sent back onto it", () => {
    core("switch");
    runRipConvergence();
    // R2 hears 192.168.3.0/24 from R3 directly (metric 1 + 0 hops), never a
    // worse copy relayed by R1 over the same wire.
    const viaR1 = (dev("R2").config!.rip!.learnedRoutes || []).filter(r => r.nextHop === "10.0.0.1").map(r => r.network);
    expect(viaR1).toEqual(["192.168.1.0/24"]);
  });
});

describe("RIP adjacency honours VLANs on a managed switch (R19)", () => {
  function managedCore() {
    const rejected = runConsoleScript(`
      add switch CORE at 0 0
      managed CORE on
      add router R1 at -300 0
      add router R2 at 300 0
      link R1 CORE
      link R2 CORE
      vlan CORE add 10
      vlan CORE add 20
      interface R1 CORE ip 10.0.0.1/24
      interface R2 CORE ip 10.0.0.2/24
      ${rip("R1", "10.0.0.0/24")}
      ${rip("R2", "10.0.0.0/24")}
      add computer PC1 at -500 0
      link PC1 R1
      interface R1 PC1 ip 192.168.1.1/24
      cli R1 configure terminal
      cli R1 router rip
      cli R1 network 192.168.1.0/24
      cli R1 end
    `).filter(r => !r.ok);
    expect(rejected).toEqual([]);
  }

  it("two routers on the same access VLAN are neighbours", () => {
    managedCore();
    exec("port CORE Ethernet1 vlan 10");
    exec("port CORE Ethernet2 vlan 10");
    expect(learned("R2")).toEqual(["192.168.1.0/24 via 10.0.0.1"]);
  });

  it("two routers on different access VLANs are not, even in the same subnet", () => {
    managedCore();
    exec("port CORE Ethernet1 vlan 10");
    exec("port CORE Ethernet2 vlan 20");
    expect(learned("R2")).toEqual([]);
  });

  it("a dot1q sub-interface on a trunk reaches a router on that VLAN's access port", () => {
    managedCore();
    exec("port CORE Ethernet1 vlan 10");
    exec("port CORE Ethernet2 mode trunk");
    expect(exec("interface R2 CORE ip 10.0.0.2/24 vlan 10").ok).toBe(true);
    expect(learned("R2")).toEqual(["192.168.1.0/24 via 10.0.0.1"]);
    // Prune VLAN 10 from the trunk and the adjacency goes.
    expect(exec("port CORE Ethernet2 allowed add 20").ok).toBe(true);
    expect(learned("R2")).toEqual([]);
  });
});
