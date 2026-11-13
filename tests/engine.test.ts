import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { sameSubnet } from "../src/utils";
import { state } from "../src/state";
import { processAtSwitch, processAtRouter, processAtComputer, processAtHub, runSimulationHeadless, runTraceroute, linkLatencyFactor, startSimulation, stepOnce, allocateDhcpIp } from "../src/engine";
import { buildRoutingTable, runRipConvergence, routingLookup } from "../src/routing";
import { buildPingEvents, buildDhcpEvents } from "../src/simulation";
import { deleteLink, linksFor, addDevice, addLink } from "../src/devices";
import { buildConfigPayload } from "../src/config";
import { createArpRequest, createArpReply, createIcmpEchoRequest, createIcmpEchoReply, createDhcpOffer, createDhcpAck, BROADCAST_MAC } from "../src/frame";
import { runConsoleScript } from "../src/commands";
import { flushHostArp } from "../src/terminal/host";
import { flushRouterArp } from "../src/terminal/router";
import { registerNoopCallbacks, resetState } from "./helpers";
import { basicTopology, routedTopology, vlanTopology, trunkTopology } from "./fixtures";

beforeAll(() => {
  registerNoopCallbacks();
});

// ── link latency factor ──────────────────────────────────────────────────────

describe("linkLatencyFactor", () => {
  it("maps latency (ms) to a clamped transit multiplier", () => {
    expect(linkLatencyFactor(undefined)).toBe(1);     // no latency → normal
    expect(linkLatencyFactor({})).toBe(1);
    expect(linkLatencyFactor({ latency: 10 })).toBe(1); // 10 ms baseline = 1×
    expect(linkLatencyFactor({ latency: 100 })).toBe(10);
    expect(linkLatencyFactor({ latency: 1 })).toBe(0.25);   // clamped fast floor
    expect(linkLatencyFactor({ latency: 9999 })).toBe(20);  // clamped slow ceiling
  });
});

// ── processAtHub ─────────────────────────────────────────────────────────────

describe("processAtHub — layer-1 repeater", () => {
  beforeEach(() => resetState());

  function hubLan() {
    runConsoleScript(`
      add hub HUB at 200 0
      add computer PC1 at 0 0
      add computer PC2 at 400 0
      add computer PC3 at 200 200
      link PC1 HUB
      link PC2 HUB
      link PC3 HUB
    `);
    return state.devices.find(d => d.name === "HUB")!;
  }

  it("repeats a frame out every port except ingress (floods broadcast)", () => {
    const hub = hubLan();
    const pc1 = state.devices.find(d => d.name === "PC1")!;
    const frame = createArpRequest("02:00:00:00:01:10", "192.168.1.10", "192.168.1.20");
    const out = processAtHub(hub, frame, pc1.id);
    const targets = out.map(o => o.toDeviceId).sort();
    const others = state.devices.filter(d => d.name === "PC2" || d.name === "PC3").map(d => d.id).sort();
    expect(targets).toEqual(others); // PC2 + PC3, never back to PC1
  });

  it("repeats unicast too (no MAC learning — the switch contrast)", () => {
    const hub = hubLan();
    const pc1 = state.devices.find(d => d.name === "PC1")!;
    // A unicast frame addressed to PC2 still goes everywhere (PC2 and PC3).
    const unicast = createIcmpEchoRequest("02:00:00:00:01:10", "02:00:00:00:01:20", "192.168.1.10", "192.168.1.20", 64);
    const out = processAtHub(hub, unicast, pc1.id);
    expect(out).toHaveLength(2);
    expect(hub.config.macTable).toBeUndefined(); // a hub keeps no table
  });

  it("a powered-off hub repeats nothing", () => {
    const hub = hubLan();
    hub.poweredOff = true;
    const pc1 = state.devices.find(d => d.name === "PC1")!;
    const frame = createArpRequest("02:00:00:00:01:10", "192.168.1.10", "192.168.1.20");
    expect(processAtHub(hub, frame, pc1.id)).toEqual([]);
  });

  it("with no ingress (fromDeviceId null) floods every port", () => {
    const hub = hubLan();
    const frame = createArpRequest("02:00:00:00:01:10", "192.168.1.10", "192.168.1.20");
    const out = processAtHub(hub, frame, null);
    const all = state.devices.filter(d => d.name.startsWith("PC")).map(d => d.id).sort();
    expect(out.map(o => o.toDeviceId).sort()).toEqual(all); // PC1 + PC2 + PC3, none skipped
  });
});

// ── processAtSwitch ──────────────────────────────────────────────────────────

describe("processAtSwitch — unmanaged", () => {
  beforeEach(() => resetState());

  it("floods broadcast frame to all ports except ingress", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const sw = state.devices.find(d => d.id === "sw1")!;
    // ARP broadcast from PC-1 arriving at switch
    const frame = createArpRequest("02:00:00:00:01:10", "192.168.1.10", "192.168.1.20");
    const outgoing = processAtSwitch(sw, frame, "pc1");
    // SW-1 has 2 linked ports: Ethernet1=pc1, Ethernet2=pc2
    // Should flood to pc2 only (not back to pc1)
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].toDeviceId).toBe("pc2");
  });

  it("learns source MAC on ingress", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const sw = state.devices.find(d => d.id === "sw1")!;
    const frame = createArpRequest("02:00:00:00:01:10", "192.168.1.10", "192.168.1.20");
    processAtSwitch(sw, frame, "pc1");
    const entry = sw.config.macTable!.find((e: any) => e.macAddress === "02:00:00:00:01:10")!;
    expect(entry).toBeDefined();
    expect(entry.port).toBe("Ethernet1");
  });

  it("forwards known unicast to learned port only", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const sw = state.devices.find(d => d.id === "sw1")!;
    // First: learn PC-2's MAC by sending a frame from PC-2
    const fromPc2 = createArpReply("02:00:00:00:01:20", "192.168.1.20", "02:00:00:00:01:10", "192.168.1.10");
    processAtSwitch(sw, fromPc2, "pc2");
    // Now send a unicast frame destined for PC-2's MAC from PC-1
    const unicast = createIcmpEchoRequest("02:00:00:00:01:10", "02:00:00:00:01:20", "192.168.1.10", "192.168.1.20", 64);
    const outgoing = processAtSwitch(sw, unicast, "pc1");
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].toDeviceId).toBe("pc2");
  });

  it("returns empty array when device is powered off", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const sw = state.devices.find(d => d.id === "sw1")!;
    sw.poweredOff = true;
    const frame = createArpRequest("02:00:00:00:01:10", "192.168.1.10", "192.168.1.20");
    const outgoing = processAtSwitch(sw, frame, "pc1");
    expect(outgoing).toHaveLength(0);
  });
});

describe("processAtSwitch — managed 802.1Q", () => {
  beforeEach(() => resetState());

  it("assigns access port VLAN on ingress", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const msw = state.devices.find(d => d.id === "msw")!;
    // Frame from pc-v10 (Ethernet2, access VLAN 10) — untagged
    const frame = createArpRequest("02:00:0A:00:01:10", "192.168.10.10", "192.168.10.1");
    const outgoing = processAtSwitch(msw, frame, "pc-v10");
    // Should forward to trunk port (Ethernet1 → rtr-v) only, not to pc-v20 (VLAN 20)
    const destIds = outgoing.map(o => o.toDeviceId);
    expect(destIds).toContain("rtr-v");
    expect(destIds).not.toContain("pc-v20");
  });

  it("drops tagged frame arriving on access port", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const msw = state.devices.find(d => d.id === "msw")!;
    // Tagged frame arriving on access port Ethernet2
    const frame = createArpRequest("02:00:0A:00:01:10", "192.168.10.10", "192.168.10.1");
    frame.vlanTag = 10;
    const outgoing = processAtSwitch(msw, frame, "pc-v10");
    expect(outgoing).toHaveLength(0);
  });

  it("accepts tagged frame on trunk port", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const msw = state.devices.find(d => d.id === "msw")!;
    // Tagged frame from router on trunk port Ethernet1
    const frame = createArpReply("02:01:00:00:01:01", "192.168.10.1", "02:00:0A:00:01:10", "192.168.10.10");
    frame.vlanTag = 10;
    const outgoing = processAtSwitch(msw, frame, "rtr-v");
    // Should forward to pc-v10 (access VLAN 10) — tag stripped on egress
    const destIds = outgoing.map(o => o.toDeviceId);
    expect(destIds).toContain("pc-v10");
    // Frame to access port should have tag stripped
    const toPcV10 = outgoing.find(o => o.toDeviceId === "pc-v10");
    expect(toPcV10!.frame.vlanTag).toBeNull();
  });

  it("strips VLAN tag on access port egress", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const msw = state.devices.find(d => d.id === "msw")!;
    // Broadcast from router on trunk, VLAN 10
    const frame = createArpRequest("02:01:00:00:01:01", "192.168.10.1", "192.168.10.10");
    frame.vlanTag = 10;
    const outgoing = processAtSwitch(msw, frame, "rtr-v");
    const toPcV10 = outgoing.find(o => o.toDeviceId === "pc-v10");
    expect(toPcV10).toBeDefined();
    expect(toPcV10!.frame.vlanTag).toBeNull();
  });

  it("adds VLAN tag on trunk port egress", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const msw = state.devices.find(d => d.id === "msw")!;
    // Broadcast from pc-v10 (access VLAN 10, untagged)
    const frame = createArpRequest("02:00:0A:00:01:10", "192.168.10.10", "192.168.10.1");
    const outgoing = processAtSwitch(msw, frame, "pc-v10");
    // Frame to trunk port (rtr-v) should have VLAN tag set
    const toRtr = outgoing.find(o => o.toDeviceId === "rtr-v");
    expect(toRtr).toBeDefined();
    expect(toRtr!.frame.vlanTag).toBe(10);
  });

  it("only floods to same-VLAN ports", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const msw = state.devices.find(d => d.id === "msw")!;
    // Broadcast from pc-v10 (VLAN 10)
    const frame = createArpRequest("02:00:0A:00:01:10", "192.168.10.10", "192.168.10.1");
    const outgoing = processAtSwitch(msw, frame, "pc-v10");
    const destIds = outgoing.map(o => o.toDeviceId);
    // Should reach trunk (carries all VLANs) but NOT pc-v20 (VLAN 20)
    expect(destIds).not.toContain("pc-v20");
  });

  it("learns MAC with VLAN on managed switch", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const msw = state.devices.find(d => d.id === "msw")!;
    const frame = createArpRequest("02:00:0A:00:01:10", "192.168.10.10", "192.168.10.1");
    processAtSwitch(msw, frame, "pc-v10");
    const entry = msw.config.macTable!.find((e: any) => e.macAddress === "02:00:0A:00:01:10")!;
    expect(entry).toBeDefined();
    expect(entry.port).toBe("Ethernet2");
    expect(entry.vlan).toBe("10");
  });
});

describe("processAtSwitch — trunk between switches", () => {
  beforeEach(() => resetState());

  it("forwards frame across trunk preserving VLAN", () => {
    const topo = trunkTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const mswA = state.devices.find(d => d.id === "msw-a")!;
    // Broadcast from pc-t1 on MSW-A (access VLAN 10)
    const frame = createArpRequest("02:00:0A:00:01:11", "192.168.10.11", "192.168.10.12");
    const outgoing = processAtSwitch(mswA, frame, "pc-t1");
    // Should forward to trunk port → MSW-B
    const toMswB = outgoing.find(o => o.toDeviceId === "msw-b");
    expect(toMswB).toBeDefined();
    // VLAN tag should be set (10, non-native)
    expect(toMswB!.frame.vlanTag).toBe(10);
  });
});

// ── processAtRouter ──────────────────────────────────────────────────────────

describe("processAtRouter", () => {
  beforeEach(() => resetState());

  it("replies to ARP request for its own interface IP", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const rtr = state.devices.find(d => d.id === "rtr")!;
    // ARP request from PC-A asking for router's interface IP (192.168.10.1)
    const frame = createArpRequest("02:00:00:00:10:10", "192.168.10.10", "192.168.10.1");
    const outgoing = processAtRouter(rtr, frame, "sw-a");
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].toDeviceId).toBe("sw-a");
    // Reply should contain router's MAC
    expect(outgoing[0].frame.payload.type).toBe("arp");
    expect((outgoing[0].frame.payload as any).operation).toBe("reply");
    expect((outgoing[0].frame.payload as any).senderMac).toBe("02:01:00:00:01:01");
  });

  it("ignores ARP request not for its IP", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const rtr = state.devices.find(d => d.id === "rtr")!;
    // ARP request for some other IP
    const frame = createArpRequest("02:00:00:00:10:10", "192.168.10.10", "192.168.10.99");
    const outgoing = processAtRouter(rtr, frame, "sw-a");
    expect(outgoing).toHaveLength(0);
  });

  it("routes ICMP across subnets with TTL decrement", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const rtr = state.devices.find(d => d.id === "rtr")!;
    // Pre-populate egress ARP so we don't get ARP miss
    rtr.config.interfaces![1].arpTable = [
      { ipv4Address: "192.168.20.10", macAddress: "02:00:00:00:20:10" },
    ];
    // ICMP from PC-A to PC-B arriving at router
    const frame = createIcmpEchoRequest(
      "02:00:00:00:10:10", "02:01:00:00:01:01",
      "192.168.10.10", "192.168.20.10", 64
    );
    const outgoing = processAtRouter(rtr, frame, "sw-a");
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].toDeviceId).toBe("sw-b");
    // TTL should be decremented
    const ipv4 = outgoing[0].frame.payload as any;
    expect(ipv4.ttl).toBe(63);
    // L2 headers should be rewritten
    expect(outgoing[0].frame.srcMac).toBe("02:01:00:00:02:01"); // egress interface MAC
    expect(outgoing[0].frame.dstMac).toBe("02:00:00:00:20:10"); // destination MAC
  });

  it("sends ICMP Time-Exceeded back to the source when TTL expires", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const rtr = state.devices.find(d => d.id === "rtr")!;
    rtr.config.interfaces![1].arpTable = [
      { ipv4Address: "192.168.20.10", macAddress: "02:00:00:00:20:10" },
    ];
    // TTL = 1: the router drops the packet and replies with a Time-Exceeded.
    const frame = createIcmpEchoRequest(
      "02:00:00:00:10:10", "02:01:00:00:01:01",
      "192.168.10.10", "192.168.20.10", 1
    );
    const outgoing = processAtRouter(rtr, frame, "sw-a");
    expect(outgoing).toHaveLength(1);
    const te = outgoing[0];
    expect(te.toDeviceId).toBe("sw-a");
    const ipv4 = te.frame.payload as any;
    expect(ipv4.payload.icmpType).toBe(11);       // ICMP Time-Exceeded
    expect(ipv4.srcIp).toBe("192.168.10.1");      // ingress interface address
    expect(ipv4.dstIp).toBe("192.168.10.10");     // original source
  });

  it("sends ARP request when egress ARP miss", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    // Initialise simulation state for pendingArp
    state.simulation.pendingArp = {};
    const rtr = state.devices.find(d => d.id === "rtr")!;
    // Ensure egress ARP table is empty
    rtr.config.interfaces![1].arpTable = [];
    const frame = createIcmpEchoRequest(
      "02:00:00:00:10:10", "02:01:00:00:01:01",
      "192.168.10.10", "192.168.20.10", 64
    );
    const outgoing = processAtRouter(rtr, frame, "sw-a");
    // Should send ARP request on egress interface
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].frame.payload.type).toBe("arp");
    expect((outgoing[0].frame.payload as any).operation).toBe("request");
    expect((outgoing[0].frame.payload as any).targetIp).toBe("192.168.20.10");
    // Original frame should be buffered in pendingArp
    expect(state.simulation.pendingArp["rtr:192.168.20.10"]).toBeDefined();
  });

  it("returns empty array when device is powered off", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const rtr = state.devices.find(d => d.id === "rtr")!;
    rtr.poweredOff = true;
    const frame = createArpRequest("02:00:00:00:10:10", "192.168.10.10", "192.168.10.1");
    const outgoing = processAtRouter(rtr, frame, "sw-a");
    expect(outgoing).toHaveLength(0);
  });

  it("drops frame when no matching interface", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const rtr = state.devices.find(d => d.id === "rtr")!;
    // Send from a peer that has no interface configured
    const frame = createArpRequest("02:00:00:00:10:10", "192.168.10.10", "192.168.10.1");
    const outgoing = processAtRouter(rtr, frame, "nonexistent-peer");
    expect(outgoing).toHaveLength(0);
  });
});

describe("processAtRouter — self-destined frames", () => {
  beforeEach(() => resetState());

  it("replies to an ICMP echo request for its own interface IP", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const rtr = state.devices.find(d => d.id === "rtr")!;
    const frame = createIcmpEchoRequest(
      "02:00:00:00:10:10", "02:01:00:00:01:01",
      "192.168.10.10", "192.168.10.1", 64
    );
    const outgoing = processAtRouter(rtr, frame, "sw-a");
    const reply = outgoing.find(o =>
      o.frame.payload.type === "ipv4" &&
      (o.frame.payload as any).payload.type === "icmp" &&
      (o.frame.payload as any).payload.icmpType === 0
    );
    expect(reply).toBeDefined();
  });

  it("does NOT treat a DHCP packet destined to its interface IP as an ICMP self-ping", () => {
    // Regression for the payload-type narrowing fix: routeIpv4Frame's self-IP
    // branch must check payload.type === "icmp" before reading icmpType.
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const rtr = state.devices.find(d => d.id === "rtr")!;
    const dhcpToRouter: any = {
      id: "dhcp-unicast",
      srcMac: "02:00:00:00:10:10",
      dstMac: "02:01:00:00:01:01",
      etherType: 0x0800,
      vlanTag: null,
      payload: {
        type: "ipv4", srcIp: "192.168.10.10", dstIp: "192.168.10.1", ttl: 64, protocol: 17,
        payload: { type: "dhcp", messageType: "request", transactionId: "t1",
          clientMac: "02:00:00:00:10:10", requestedIp: "192.168.10.50", serverIp: "192.168.10.1" },
      },
    };
    const outgoing = processAtRouter(rtr, dhcpToRouter, "sw-a");
    const icmpReply = outgoing.some(o =>
      o.frame.payload.type === "ipv4" &&
      (o.frame.payload as any).payload.type === "icmp"
    );
    expect(icmpReply).toBe(false);
  });
});

// A router takes up only frames addressed to its ingress interface's MAC (or a
// link-layer broadcast it handles locally, like DHCP). A hub repeats every frame
// to every port, so on a shared segment the router sees the hosts' own unicast
// conversation — routing that would hand the recipient a TTL-63 duplicate.
describe("processAtRouter — L2 admission (destination MAC)", () => {
  beforeEach(() => resetState());

  function hubWithRouter() {
    runConsoleScript(`
      add hub HUB at 200 0
      add computer A at 0 0
      add computer B at 400 0
      add router R at 200 200
      link A HUB
      link B HUB
      link R HUB
      ip A 192.168.1.10/24
      gateway A 192.168.1.1
      ip B 192.168.1.20/24
      gateway B 192.168.1.1
      interface R HUB ip 192.168.1.1
    `);
    const dev = (n: string) => state.devices.find(d => d.name === n)!;
    return { a: dev("A"), b: dev("B"), r: dev("R"), hub: dev("HUB") };
  }
  const actions = (name: string) => state.simulation.log.filter(l => l.deviceName === name).map(l => l.action);

  it("an on-link ping across a hub gets exactly one reply, TTL 64, and no routed duplicate", () => {
    const { a, r } = hubWithRouter();
    const result = runSimulationHeadless(buildPingEvents(a, "192.168.1.20") as any, a.id, "192.168.1.20", "ping");
    expect(result.success).toBe(true);
    expect(state.simulation.pingTtl).toBe(64);   // straight from B, never via R (63)
    expect(actions("A").filter(t => t.startsWith("Received ICMP Echo Reply"))).toHaveLength(1);
    expect(actions("B").filter(t => t.startsWith("Received ICMP Echo Request"))).toHaveLength(1);
    expect(actions("R").some(t => t.startsWith("Route ") || t.includes("Forward deferred"))).toBe(false);
    expect(actions("R").some(t => t.includes("not ours to route"))).toBe(true);   // the reason is stated
    // The A↔B ARP reply was not addressed to R, so R learned nothing from it.
    expect(r.config.interfaces![0].arpTable ?? []).toEqual([]);
  });

  it("ignores a unicast IPv4 frame addressed to another MAC (states why)", () => {
    const { a, b, r, hub } = hubWithRouter();
    const frame = createIcmpEchoRequest(a.config.macAddress!, b.config.macAddress!, "192.168.1.10", "192.168.1.20", 64);
    expect(processAtRouter(r, frame, hub.id)).toEqual([]);
    expect(actions("R").at(-1)).toContain(`is for ${b.config.macAddress}`);
  });

  it("still routes a frame addressed to the ingress interface MAC", () => {
    const { a } = hubWithRouter();
    runConsoleScript(`
      add computer C at 400 200
      link R C
      ip C 10.0.0.10/24
      gateway C 10.0.0.1
      interface R C ip 10.0.0.1
    `);
    const result = runSimulationHeadless(buildPingEvents(a, "10.0.0.10") as any, a.id, "10.0.0.10", "ping");
    expect(result.success).toBe(true);
    expect(state.simulation.pingTtl).toBe(63);   // exactly one routed hop
    expect(actions("A").filter(t => t.startsWith("Received ICMP Echo Reply"))).toHaveLength(1);
  });

  it("does not route a link-layer broadcast IPv4 frame off the segment", () => {
    const { a, r, hub } = hubWithRouter();
    runConsoleScript(`
      add computer C at 400 200
      link R C
      ip C 10.0.0.10/24
      interface R C ip 10.0.0.1
    `);
    const frame = createIcmpEchoRequest(a.config.macAddress!, BROADCAST_MAC, "192.168.1.10", "10.0.0.10", 64);
    expect(processAtRouter(r, frame, hub.id)).toEqual([]);
    expect(actions("R").at(-1)).toContain("does not route it off the segment");
  });

  it("still serves DHCP broadcasts on a hub segment", () => {
    const { r } = hubWithRouter();
    runConsoleScript(`
      add computer D at 0 200
      link D HUB
    `);
    const d = state.devices.find(x => x.name === "D")!;
    const result = runSimulationHeadless(buildDhcpEvents(d) as any, d.id, "", "dhcp");
    expect(result.success).toBe(true);
    expect(d.config.ipv4Address).toMatch(/^192\.168\.1\./);
    expect(r.config.interfaces![0].dhcpLeases).toHaveLength(1);
  });

  it("learns an ARP reply sent to its MAC, refreshes a known entry from a gratuitous broadcast, but never creates one from it", () => {
    const { r, hub } = hubWithRouter();
    const iface = r.config.interfaces![0];
    // Unicast to another host: not learned.
    processAtRouter(r, createArpReply("02:00:00:00:00:20", "192.168.1.20", "02:00:00:00:00:10", "192.168.1.10"), hub.id);
    expect(iface.arpTable ?? []).toEqual([]);
    // Gratuitous broadcast for an IP R holds no entry for: not learned (arp_accept off).
    processAtRouter(r, createArpReply("02:00:00:00:00:20", "192.168.1.20", BROADCAST_MAC, "192.168.1.20"), hub.id);
    expect(iface.arpTable ?? []).toEqual([]);
    // Addressed to R's interface MAC: learned.
    processAtRouter(r, createArpReply("02:00:00:00:00:20", "192.168.1.20", iface.macAddress!, "192.168.1.1"), hub.id);
    expect(iface.arpTable).toEqual([{ ipv4Address: "192.168.1.20", macAddress: "02:00:00:00:00:20" }]);
    // A gratuitous broadcast now refreshes the existing entry.
    processAtRouter(r, createArpReply("02:00:00:00:00:21", "192.168.1.20", BROADCAST_MAC, "192.168.1.20"), hub.id);
    expect(iface.arpTable).toEqual([{ ipv4Address: "192.168.1.20", macAddress: "02:00:00:00:00:21" }]);
  });

  // The strict MAC filter is only faithful if a stale ARP cache can recover:
  // the simulator has no ARP ageing, so deleting a device drops every entry
  // pointing at its MACs, and a stale entry that survives is diagnosed.
  function switchedGateway() {
    runConsoleScript(`
      add switch SW at 200 0
      add computer A at 0 0
      add computer C at 600 0
      add router R at 400 0
      link A SW
      link R SW
      link R C
      ip A 192.168.1.10/24
      gateway A 192.168.1.1
      ip C 10.0.0.10/24
      gateway C 10.0.0.1
      interface R SW ip 192.168.1.1
      interface R C ip 10.0.0.1
    `);
    return state.devices.find(d => d.name === "A")!;
  }
  const pingC = (a: any) => runSimulationHeadless(buildPingEvents(a, "10.0.0.10") as any, a.id, "10.0.0.10", "ping");

  it("reaches a replacement gateway router after the old one is deleted (its ARP entries go with it)", () => {
    const a = switchedGateway();
    expect(pingC(a).success).toBe(true);
    const oldMac = state.devices.find(d => d.name === "R")!.config.interfaces![0].macAddress;
    expect(a.config.arpTable!.some(e => e.macAddress === oldMac)).toBe(true);   // the cache is warm
    runConsoleScript(`
      remove R
      add router R2 at 400 0
      link R2 SW
      link R2 C
      interface R2 SW ip 192.168.1.1
      interface R2 C ip 10.0.0.1
    `);
    expect(a.config.arpTable!.some(e => e.macAddress === oldMac)).toBe(false);
    const result = pingC(a);
    expect(result.success).toBe(true);
    expect(state.simulation.pingTtl).toBe(63);
  });

  it("undoing the delete restores the ARP entries it dropped", () => {
    const a = switchedGateway();
    pingC(a);
    const before = JSON.stringify(a.config.arpTable);
    runConsoleScript("remove R");
    runConsoleScript("undo");
    const restored = state.devices.find(d => d.name === "A")!;
    expect(JSON.stringify(restored.config.arpTable)).toBe(before);
  });

  it("diagnoses a stale ARP entry (a MAC no device owns) and `ip neigh flush all` recovers", () => {
    const a = switchedGateway();
    a.config.arpTable = [{ ipv4Address: "192.168.1.1", macAddress: "02:DE:AD:00:00:01" }];
    const failed = pingC(a);
    expect(failed.success).toBe(false);
    const line = failed.diagnosis.find(l => l.startsWith("Stale ARP entry"));
    expect(line).toContain("192.168.1.1 (A's default gateway) is cached at 02:DE:AD:00:00:01");
    expect(line).toContain("ip neigh flush all");
    expect(flushHostArp(a)).toBe("Flushed 1 ARP entry from eth0.");
    expect(pingC(a).success).toBe(true);
  });

  it("does not report a stale entry for an address the flow never used", () => {
    const a = switchedGateway();
    // A firewall-free failure: C is powered off. A's unrelated stale entry for
    // 192.168.1.99 is beside the point and stays out of the diagnosis.
    a.config.arpTable = [{ ipv4Address: "192.168.1.99", macAddress: "02:DE:AD:00:00:99" }];
    state.devices.find(d => d.name === "C")!.poweredOff = true;
    const failed = pingC(a);
    expect(failed.success).toBe(false);
    expect(failed.diagnosis.some(l => l.includes("Stale ARP entry"))).toBe(false);
  });

  it("routes a frame addressed to the second of two interfaces on the same segment", () => {
    const { a, r, hub } = hubWithRouter();
    r.config.interfaces!.push({ ...r.config.interfaces![0], name: "", ipv4Address: "192.168.1.2", macAddress: "02:00:00:00:00:F2", arpTable: [], dhcpLeases: [] });
    runConsoleScript(`
      add computer C at 400 200
      link R C
      ip C 10.0.0.10/24
      interface R C ip 10.0.0.1
    `);
    const c = state.devices.find(d => d.name === "C")!;
    r.config.interfaces!.find(i => i.peerId === c.id)!.arpTable = [{ ipv4Address: "10.0.0.10", macAddress: c.config.macAddress! }];
    const frame = createIcmpEchoRequest(a.config.macAddress!, "02:00:00:00:00:F2", "192.168.1.10", "10.0.0.10", 64);
    const out = processAtRouter(r, frame, hub.id);
    expect(out).toHaveLength(1);
    expect(out[0].toDeviceId).toBe(c.id);   // routed out the 10.0.0.0/24 interface
    expect(out[0].frame.dstMac).toBe(c.config.macAddress!);
    expect(out[0].frame.payload.type === "ipv4" && out[0].frame.payload.ttl).toBe(63);
    expect(actions("R").some(t => t.includes("not ours to route"))).toBe(false);
  });

  // Re-cabling a router port gives it a fresh interface (and MAC); the old one
  // stays in the config with no cable. Unplugging it must take the hosts'
  // cached gateway MAC with it, or the strict MAC filter ignores their frames.
  it("reaches the gateway after the router's cable moves to another switch on the LAN", () => {
    const a = switchedGateway();
    runConsoleScript(`
      add switch SW2 at 200 200
      link SW SW2
    `);
    expect(pingC(a).success).toBe(true);
    runConsoleScript(`
      unlink R SW
      link R SW2
      interface R SW2 ip 192.168.1.1
    `);
    const result = pingC(a);
    expect(result.success).toBe(true);
    expect(state.simulation.pingTtl).toBe(63);
  });

  it("reaches the gateway after the LAN switch is replaced", () => {
    const a = switchedGateway();
    expect(pingC(a).success).toBe(true);
    runConsoleScript(`
      remove SW
      add switch SW2 at 200 0
      link A SW2
      link R SW2
      interface R SW2 ip 192.168.1.1
    `);
    expect(pingC(a).success).toBe(true);
  });

  // R1 —(T)— R2, with a second switch T2 bridged to T for R2's cable to move to.
  function twoRouters() {
    runConsoleScript(`
      add computer A at 0 0
      add router R1 at 200 0
      add switch T at 400 0
      add switch T2 at 400 200
      add router R2 at 600 0
      add computer C at 800 0
      link A R1
      link R1 T
      link T T2
      link R2 T
      link R2 C
      ip A 192.168.1.10/24
      gateway A 192.168.1.1
      ip C 10.0.0.10/24
      gateway C 10.0.0.1
      interface R1 A ip 192.168.1.1
      interface R1 T ip 172.16.0.1/24
      interface R2 T ip 172.16.0.2/24
      interface R2 C ip 10.0.0.1
      route R1 10.0.0.0/24 172.16.0.2
      route R2 192.168.1.0/24 172.16.0.1
    `);
    const dev = (n: string) => state.devices.find(d => d.name === n)!;
    return { a: dev("A"), r1: dev("R1"), r2: dev("R2"), t: dev("T") };
  }
  const moveR2 = () => runConsoleScript(`
    unlink R2 T
    link R2 T2
    interface R2 T2 ip 172.16.0.2/24
  `);

  it("a router reaches its next-hop router after that router's cable moves", () => {
    const { a } = twoRouters();
    expect(pingC(a).success).toBe(true);
    moveR2();
    expect(pingC(a).success).toBe(true);
  });

  it("names a router's stale next-hop entry, and the router's `ip neigh flush all` recovers", () => {
    const { a, r1, r2, t } = twoRouters();
    expect(pingC(a).success).toBe(true);
    const oldMac = r2.config.interfaces!.find(i => i.peerId === t.id)!.macAddress;
    moveR2();
    // An entry the unplug purge never saw (as an imported topology might carry
    // it): R1 still caches its next hop at R2's old, now cable-less interface.
    const r1Iface = r1.config.interfaces!.find(i => i.peerId === t.id)!;
    r1Iface.arpTable = [{ ipv4Address: "172.16.0.2", macAddress: oldMac }];
    const failed = pingC(a);
    expect(failed.success).toBe(false);
    const line = failed.diagnosis.find(l => l.startsWith("R1: Stale ARP entry"));
    expect(line).toContain(`172.16.0.2 (R1's next hop toward 10.0.0.10) is cached at ${oldMac}, which belongs to R2's interface with no cable now`);
    expect(line).toContain("`ip neigh flush all` (privileged mode)");
    expect(flushRouterArp(r1)).toMatch(/^Flushed \d+ ARP entr(y|ies)\.$/);
    expect(pingC(a).success).toBe(true);
  });
});

describe("processAtRouter — sub-interfaces (VLAN)", () => {
  beforeEach(() => resetState());

  it("matches sub-interface by vlanTag", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const rtr = state.devices.find(d => d.id === "rtr-v")!;
    // ARP request arriving tagged with VLAN 10 from MSW trunk
    const frame = createArpRequest("02:00:0A:00:01:10", "192.168.10.10", "192.168.10.1");
    frame.vlanTag = 10;
    const outgoing = processAtRouter(rtr, frame, "msw");
    expect(outgoing).toHaveLength(1);
    // Reply should use the VLAN 10 sub-interface's MAC
    expect((outgoing[0].frame.payload as any).senderMac).toBe("02:01:00:00:01:01");
    // Reply should carry VLAN tag 10
    expect(outgoing[0].frame.vlanTag).toBe(10);
  });

  it("routes between VLANs via sub-interfaces", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const rtr = state.devices.find(d => d.id === "rtr-v")!;
    // Pre-populate egress ARP
    rtr.config.interfaces![1].arpTable = [
      { ipv4Address: "192.168.20.10", macAddress: "02:00:14:00:01:10" },
    ];
    // ICMP from VLAN 10 to VLAN 20
    const frame = createIcmpEchoRequest(
      "02:00:0A:00:01:10", "02:01:00:00:01:01",
      "192.168.10.10", "192.168.20.10", 64
    );
    frame.vlanTag = 10;
    const outgoing = processAtRouter(rtr, frame, "msw");
    expect(outgoing).toHaveLength(1);
    // Should route to same peer (msw) but with VLAN 20 tag
    expect(outgoing[0].toDeviceId).toBe("msw");
    expect(outgoing[0].frame.vlanTag).toBe(20);
    // L2 rewrite
    expect(outgoing[0].frame.srcMac).toBe("02:01:00:00:02:01"); // VLAN 20 sub-interface MAC
    expect(outgoing[0].frame.dstMac).toBe("02:00:14:00:01:10"); // destination MAC
    // TTL decremented
    expect((outgoing[0].frame.payload as any).ttl).toBe(63);
  });

  it("drops when no route exists", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const rtr = state.devices.find(d => d.id === "rtr-v")!;
    // ICMP to a subnet the router doesn't have an interface for
    const frame = createIcmpEchoRequest(
      "02:00:0A:00:01:10", "02:01:00:00:01:01",
      "192.168.10.10", "10.0.0.1", 64
    );
    frame.vlanTag = 10;
    const outgoing = processAtRouter(rtr, frame, "msw");
    expect(outgoing).toHaveLength(0);
  });

  it("learns ARP on the correct sub-interface", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const rtr = state.devices.find(d => d.id === "rtr-v")!;
    // ARP request on VLAN 10 sub-interface
    const frame = createArpRequest("02:00:0A:00:01:10", "192.168.10.10", "192.168.10.1");
    frame.vlanTag = 10;
    processAtRouter(rtr, frame, "msw");
    // Check that ARP was learned on the VLAN 10 interface
    const iface10 = rtr.config.interfaces!.find((i: any) => i.vlanTag === 10)!;
    const learned = iface10.arpTable!.find((e: any) => e.ipv4Address === "192.168.10.10")!;
    expect(learned).toBeDefined();
    expect(learned.macAddress).toBe("02:00:0A:00:01:10");
  });
});

// ── processAtComputer ───────────────────────────────────────────────────────

describe("processAtComputer", () => {
  beforeEach(() => resetState());

  it("learns sender and sends ARP reply when ARP request targets own IP", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const pc1 = state.devices.find(d => d.id === "pc1")!;
    // ARP request from PC-2 targeting PC-1's IP
    const frame = createArpRequest("02:00:00:00:01:20", "192.168.1.20", "192.168.1.10");
    const outgoing = processAtComputer(pc1, frame, "sw1");
    expect(outgoing).toHaveLength(1);
    expect((outgoing[0].frame.payload as any).operation).toBe("reply");
    // PC-1 should have learnt PC-2's MAC
    const learned = pc1.config.arpTable!.find((e: any) => e.ipv4Address === "192.168.1.20")!;
    expect(learned).toBeDefined();
    expect(learned.macAddress).toBe("02:00:00:00:01:20");
  });

  it("ignores ARP request for a different IP", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const pc1 = state.devices.find(d => d.id === "pc1")!;
    // ARP request targeting an IP that is not PC-1's
    const frame = createArpRequest("02:00:00:00:01:20", "192.168.1.20", "192.168.1.99");
    const outgoing = processAtComputer(pc1, frame, "sw1");
    expect(outgoing).toHaveLength(0);
  });

  it("learns sender from ARP reply and drains pendingArp", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    state.simulation.status = "running";
    state.simulation.originDeviceId = "pc1";
    const pc1 = state.devices.find(d => d.id === "pc1")!;
    // Pre-populate pendingArp with a deferred ICMP
    const icmp = createIcmpEchoRequest("02:00:00:00:01:10", "00:00:00:00:00:00", "192.168.1.10", "192.168.1.20", 64);
    state.simulation.pendingArp["pc1:192.168.1.20"] = [icmp];
    // ARP reply from PC-2
    const frame = createArpReply("02:00:00:00:01:20", "192.168.1.20", "02:00:00:00:01:10", "192.168.1.10");
    const outgoing = processAtComputer(pc1, frame, "sw1");
    // Should have learnt PC-2's MAC
    const learned = pc1.config.arpTable!.find((e: any) => e.ipv4Address === "192.168.1.20")!;
    expect(learned).toBeDefined();
    expect(learned.macAddress).toBe("02:00:00:00:01:20");
    // Should have drained the deferred ICMP
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].frame.dstMac).toBe("02:00:00:00:01:20");
    // pendingArp entry should be deleted
    expect(state.simulation.pendingArp["pc1:192.168.1.20"]).toBeUndefined();
  });

  it("sends ICMP echo reply when receiving an echo request", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const pc1 = state.devices.find(d => d.id === "pc1")!;
    // ICMP echo request from PC-2 to PC-1
    const frame = createIcmpEchoRequest("02:00:00:00:01:20", "02:00:00:00:01:10", "192.168.1.20", "192.168.1.10", 64);
    const outgoing = processAtComputer(pc1, frame, "sw1");
    expect(outgoing).toHaveLength(1);
    const ipv4 = outgoing[0].frame.payload as any;
    expect(ipv4.payload.icmpType).toBe(0);
    expect(ipv4.srcIp).toBe("192.168.1.10");
  });

  it("marks ping success on ICMP echo reply at origin device", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    state.simulation.status = "running";
    state.simulation.originDeviceId = "pc1";
    state.simulation.pingTargetIp = "192.168.1.20"; // success requires the reply to come from the pinged address
    const pc1 = state.devices.find(d => d.id === "pc1")!;
    // ICMP echo reply arriving at origin
    const frame = createIcmpEchoReply("02:00:00:00:01:20", "02:00:00:00:01:10", "192.168.1.20", "192.168.1.10", 64);
    const outgoing = processAtComputer(pc1, frame, "sw1");
    expect(state.simulation.pingSuccess).toBe(true);
    expect(outgoing).toHaveLength(0);
  });

  it("sends DHCP request in response to DHCP offer", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const pc1 = state.devices.find(d => d.id === "pc1")!;
    // DHCP offer from server
    const frame = createDhcpOffer("02:01:00:00:01:01", "192.168.1.1", "02:00:00:00:01:10", "192.168.1.100", "txn-1");
    const outgoing = processAtComputer(pc1, frame, "sw1");
    expect(outgoing).toHaveLength(1);
    const ipv4 = outgoing[0].frame.payload as any;
    const dhcp = ipv4.payload;
    expect(dhcp.messageType).toBe("request");
    expect(dhcp.requestedIp).toBe("192.168.1.100");
  });

  it("assigns IP and gateway from DHCP ACK and learns ARP", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    state.simulation.status = "running";
    const pc1 = state.devices.find(d => d.id === "pc1")!;
    // DHCP ACK from server
    const frame = createDhcpAck("02:01:00:00:01:01", "192.168.1.1", "02:00:00:00:01:10", "192.168.1.100", "txn-1");
    const outgoing = processAtComputer(pc1, frame, "sw1");
    expect(pc1.config.ipv4Address).toBe("192.168.1.100");
    expect(pc1.config.gatewayIpv4Address).toBe("192.168.1.1");
    expect(state.simulation.dhcpSuccess).toBe(true);
    // Should have learnt gateway MAC in ARP table
    const gwArp = pc1.config.arpTable!.find((e: any) => e.ipv4Address === "192.168.1.1")!;
    expect(gwArp).toBeDefined();
    expect(gwArp.macAddress).toBe("02:01:00:00:01:01");
  });

  it("does NOT bind the gateway IP to a standalone DHCP server's MAC (no ARP poisoning)", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    state.simulation.status = "running";
    const pc1 = state.devices.find(d => d.id === "pc1")!;
    // Server 192.168.1.50 (MAC ...:50:50) hands out gateway 192.168.1.1 — a
    // different box. Its MAC must not be learnt for the gateway IP.
    const frame = createDhcpAck("02:01:00:00:50:50", "192.168.1.50", "02:00:00:00:01:10", "192.168.1.100", "txn-1", null, undefined, "192.168.1.1");
    processAtComputer(pc1, frame, "sw1");
    expect(pc1.config.gatewayIpv4Address).toBe("192.168.1.1");
    const poisoned = pc1.config.arpTable!.find((e: any) => e.ipv4Address === "192.168.1.1");
    expect(poisoned).toBeUndefined();     // client will ARP for the real gateway itself
  });

  it("returns empty array when device is powered off", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const pc1 = state.devices.find(d => d.id === "pc1")!;
    pc1.poweredOff = true;
    const frame = createArpRequest("02:00:00:00:01:20", "192.168.1.20", "192.168.1.10");
    const outgoing = processAtComputer(pc1, frame, "sw1");
    expect(outgoing).toHaveLength(0);
  });
});

describe("runSimulationHeadless", () => {
  beforeEach(() => resetState());

  it("reports success + a hop log for a reachable same-subnet ping", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const pc1 = state.devices.find(d => d.id === "pc1")!;
    const setup = buildPingEvents(pc1, "192.168.1.20");
    expect(typeof setup).not.toBe("string");
    const result = runSimulationHeadless(setup as any, "pc1", "192.168.1.20");
    expect(result.success).toBe(true);
    expect(result.log.length).toBeGreaterThan(0);
    expect(state.simulation.status).toBe("done");
  });

  it("issues an ARP request (not an instant error) when pinging an unknown same-subnet IP", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const pc1 = state.devices.find(d => d.id === "pc1")!;
    // 192.168.1.99 belongs to no device but is on PC1's subnet.
    const setup = buildPingEvents(pc1, "192.168.1.99");
    // Regression: this previously returned an instant "cannot resolve" string
    // without ever emitting a frame.
    expect(typeof setup).not.toBe("string");
    const result = runSimulationHeadless(setup as any, "pc1", "192.168.1.99");
    expect(result.success).toBe(false);
    // An ARP request really was broadcast and processed by other hosts.
    expect(result.log.some(l => /ARP Request/i.test(l.summary))).toBe(true);
  });

  it("still rejects a target that is neither a device nor a valid IP", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const pc1 = state.devices.find(d => d.id === "pc1")!;
    const setup = buildPingEvents(pc1, "not-a-host");
    expect(typeof setup).toBe("string");
    expect(setup as string).toContain("cannot resolve");
  });

  it("reports failure when the destination host does not reply (powered off)", () => {
    // Cross-subnet ping: validation only checks source→gateway L2 reachability, so
    // buildPingEvents succeeds, but the powered-off destination never answers ICMP.
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const pcB = state.devices.find(d => d.id === "pc-b")!;
    (pcB as any).poweredOff = true;
    const pcA = state.devices.find(d => d.id === "pc-a")!;
    const setup = buildPingEvents(pcA, "192.168.20.10");
    expect(typeof setup).not.toBe("string");
    const result = runSimulationHeadless(setup as any, "pc-a", "192.168.20.10");
    expect(result.success).toBe(false);
  });

  it("ARPs the gateway and lets the router drop a cross-subnet unrouteable IP", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const pcA = state.devices.find(d => d.id === "pc-a")!;
    // 192.168.99.99 is off-subnet with no route on the router.
    const setup = buildPingEvents(pcA, "192.168.99.99");
    // Regression: this used to short-circuit to an instant loss string with no ARP.
    expect(typeof setup).not.toBe("string");
    const result = runSimulationHeadless(setup as any, "pc-a", "192.168.99.99");
    expect(result.success).toBe(false);
    // The host ARPed its gateway and the router made the drop decision.
    expect(result.log.some(l => /ARP Request/i.test(l.summary))).toBe(true);
    expect(result.log.some(l => /No route/i.test(l.summary))).toBe(true);
  });
});

describe("traceroute", () => {
  beforeEach(() => resetState());

  it("a router emits ICMP Time-Exceeded when the TTL expires", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const pcA = state.devices.find(d => d.id === "pc-a")!;
    const setup = buildPingEvents(pcA, "192.168.20.10", { ttl: 1 });
    expect(typeof setup).not.toBe("string");
    const res = runSimulationHeadless(setup as any, "pc-a", "192.168.20.10", "ping");
    expect(res.success).toBe(false);
    expect(res.timeExceeded).toBe(true);
    expect(res.responderIp).toBe("192.168.10.1"); // router's ingress interface
  });

  it("discovers each hop via increasing TTL (cross-subnet)", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const pcA = state.devices.find(d => d.id === "pc-a")!;
    const result = runTraceroute(pcA, "192.168.20.10") as any;
    expect(typeof result).not.toBe("string");
    expect(result.reached).toBe(true);
    expect(result.hops.length).toBeGreaterThanOrEqual(2);
    expect(result.hops[0].ip).toBe("192.168.10.1"); // first hop = router (TTL exceeded)
    expect(result.hops[0].reached).toBe(false);
    expect(result.hops[result.hops.length - 1].reached).toBe(true);
  });

  it("reaches a same-subnet host in a single hop", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const pc1 = state.devices.find(d => d.id === "pc1")!;
    const result = runTraceroute(pc1, "192.168.1.20") as any;
    expect(result.reached).toBe(true);
    expect(result.hops.length).toBe(1);
    expect(result.hops[0].reached).toBe(true);
  });
});

// ── RIP learned routes are derived state ─────────────────────────────────────

describe("runRipConvergence — derived state", () => {
  beforeEach(() => resetState());

  const dev = (name: string) => state.devices.find(d => d.name === name)!;

  function buildRipPair(): void {
    runConsoleScript(`
      add computer PC-A at -600 0
      add router R1 at -400 0
      add router R2 at -100 0
      add computer PC-B at 100 0
      link PC-A R1
      link R1 R2
      link PC-B R2
      ip PC-A 192.168.1.10/24
      gateway PC-A 192.168.1.1
      interface R1 PC-A ip 192.168.1.1/24
      interface R1 R2 ip 10.0.12.1/30
      interface R2 R1 ip 10.0.12.2/30
      interface R2 PC-B ip 192.168.2.1/24
      ip PC-B 192.168.2.10/24
      gateway PC-B 192.168.2.1
      cli R1 enable
      cli R1 configure terminal
      cli R1 router rip
      cli R1 network 192.168.1.0/24
      cli R1 network 10.0.12.0/30
      cli R1 end
      cli R2 enable
      cli R2 configure terminal
      cli R2 router rip
      cli R2 network 192.168.2.0/24
      cli R2 network 10.0.12.0/30
      cli R2 end
    `);
  }

  it("recomputes from scratch — a removed link takes its learned route with it", () => {
    buildRipPair();
    runRipConvergence();
    const r1 = dev("R1");
    expect(buildRoutingTable(r1).find(r => r.network === "192.168.2.0/24")?.type).toBe("R");

    // Cut the inter-router link: the next convergence must NOT resurrect the
    // route from the previous run's learned state (a stale entry would outrank
    // a genuine alternative and black-hole the traffic).
    const inter = linksFor(r1.id).find(l => [l.from, l.to].includes(dev("R2").id))!;
    deleteLink(inter.id);
    runRipConvergence();
    expect(buildRoutingTable(r1).find(r => r.network === "192.168.2.0/24")).toBeUndefined();
    expect(r1.config!.rip!.learnedRoutes).toEqual([]);
  });

  it("does not serialise learned routes — only the RIP configuration round-trips", () => {
    buildRipPair();
    runRipConvergence();
    expect(dev("R1").config!.rip!.learnedRoutes!.length).toBeGreaterThan(0);  // live state is populated…
    const payload = JSON.parse(JSON.stringify(buildConfigPayload()));
    const r1rip = payload.devices.find((d: any) => d.name === "R1").config.rip;
    expect(r1rip.enabled).toBe(true);
    expect(r1rip.networks).toContain("192.168.1.0/24");                       // …config round-trips…
    expect(r1rip.learnedRoutes).toBeUndefined();                              // …derived state does not
  });
});

// ── Routing honours link.shutdown ─────────────────────────────────────────────

describe("routing + RIP honour link.shutdown", () => {
  beforeEach(() => resetState());
  const dev = (name: string) => state.devices.find(d => d.name === name)!;

  function ripPair() {
    runConsoleScript(`
      add router R1 at 0 0
      add router R2 at 200 0
      add computer PC-B at 400 0
      link R1 R2
      link R2 PC-B
      interface R1 R2 ip 10.0.12.1/30
      interface R2 R1 ip 10.0.12.2/30
      interface R2 PC-B ip 192.168.2.1/24
      cli R1 enable
      cli R1 configure terminal
      cli R1 router rip
      cli R1 network 10.0.12.0/30
      cli R1 end
      cli R2 enable
      cli R2 configure terminal
      cli R2 router rip
      cli R2 network 10.0.12.0/30
      cli R2 network 192.168.2.0/24
      cli R2 end
    `);
  }

  it("drops the shut link's connected route and stops RIP converging over it", () => {
    ripPair();
    runRipConvergence();
    // Baseline: R1 has the connected /30 and learns R2's LAN via RIP.
    expect(buildRoutingTable(dev("R1")).find(r => r.network === "10.0.12.0/30")?.type).toBe("C");
    expect(buildRoutingTable(dev("R1")).find(r => r.network === "192.168.2.0/24")?.type).toBe("R");

    // Shut the inter-router link and re-converge.
    expect(runConsoleScript("shut R1 R2").at(-1)!.ok).toBe(true);
    runRipConvergence();

    // The connected route is gone, and RIP no longer carries R2's LAN over the shut cable.
    expect(buildRoutingTable(dev("R1")).find(r => r.network === "10.0.12.0/30")).toBeUndefined();
    expect(buildRoutingTable(dev("R1")).find(r => r.network === "192.168.2.0/24")).toBeUndefined();
  });
});

describe("routingLookup resolves the SELECTED route's interface (F04)", () => {
  beforeEach(() => resetState());
  function overlapping(order: "wide-first" | "narrow-first") {
    const r = addDevice("router", 0, 0); const wide = addDevice("switch", -100, 0); const narrow = addDevice("switch", 100, 0);
    addLink(r.id, wide.id); addLink(r.id, narrow.id);
    const w = { peerId: wide.id, ipv4Address: "10.0.0.1", prefixLength: 8, macAddress: "02:00:00:00:00:01", arpTable: [], dhcpLeases: [] };
    const n = { peerId: narrow.id, ipv4Address: "10.1.0.1", prefixLength: 16, macAddress: "02:00:00:00:00:02", arpTable: [], dhcpLeases: [] };
    r.config!.interfaces = (order === "wide-first" ? [w, n] : [n, w]) as any;
    return { r, wide, narrow };
  }
  it("overlapping connected prefixes egress via the longest match, in either configuration order", () => {
    for (const order of ["wide-first", "narrow-first"] as const) {
      resetState();
      const { r, wide, narrow } = overlapping(order);
      expect(routingLookup(r, "10.1.2.3")!.egressIface.peerId).toBe(narrow.id);   // /16 wins
      expect(routingLookup(r, "10.9.9.9")!.egressIface.peerId).toBe(wide.id);     // only the /8 contains it
    }
  });
  it("returns the STORED interface object (the engine reads its ARP table), not a copy", () => {
    const { r, narrow } = overlapping("wide-first");
    const hit = routingLookup(r, "10.1.2.3")!;
    expect(hit.egressIface).toBe(r.config!.interfaces!.find(i => i.peerId === narrow.id));
  });
  it("a static route's next hop resolves through the best connected route, not the first raw subnet match", () => {
    const { r, narrow } = overlapping("wide-first");
    r.config!.staticRoutes = [{ network: "172.16.0.0/16", nextHop: "10.1.0.254" }] as any;
    const hit = routingLookup(r, "172.16.5.5")!;
    expect(hit.nextHopIp).toBe("10.1.0.254");
    expect(hit.egressIface.peerId).toBe(narrow.id);   // 10.1.0.254 is in the /16, which beats the /8
  });
});

describe("host replies go via the CONFIGURED gateway (F06)", () => {
  beforeEach(() => resetState());
  const ping = () => {
    const pca = state.devices.find(d => d.id === "pc-a")!;
    return runSimulationHeadless(buildPingEvents(pca, "192.168.20.10") as any, pca.id, "192.168.20.10");
  };
  it("a WRONG far-side gateway makes the ping fail — the reply ARPs into silence", () => {
    const t = routedTopology(); state.devices = t.devices as any; state.links = t.links as any;
    state.devices.find(d => d.id === "pc-b")!.config!.gatewayIpv4Address = "192.168.20.254";   // nobody there
    const res = ping();
    expect(res.success).toBe(false);
    expect(state.simulation.log.some((l: any) => /ARP Request for 192\.168\.20\.254/.test(l.text || l.message || JSON.stringify(l)))).toBe(true);
  });
  it("an off-subnet gateway is diagnosed, not silently used", () => {
    const t = routedTopology(); state.devices = t.devices as any; state.links = t.links as any;
    state.devices.find(d => d.id === "pc-b")!.config!.gatewayIpv4Address = "10.9.9.9";
    expect(ping().success).toBe(false);
    expect(JSON.stringify(state.simulation.log)).toContain("not on this host's subnet");
  });
  it("the correct gateway still works (resolving it by ARP on first use)", () => {
    const t = routedTopology(); state.devices = t.devices as any; state.links = t.links as any;
    expect(ping().success).toBe(true);
  });
});

describe("RIP runs only on interfaces a `network` statement covers (F08)", () => {
  beforeEach(() => resetState());
  function pair() {
    runConsoleScript(`
      add router R1 at 0 0
      add router R2 at 200 0
      add switch LAN at -200 0
      link R1 R2
      link R1 LAN
      interface R1 R2 ip 10.0.0.1/24
      interface R2 R1 ip 10.0.0.2/24
      interface R1 LAN ip 192.168.1.1/24
    `);
    const r1 = state.devices.find(d => d.name === "R1")!; const r2 = state.devices.find(d => d.name === "R2")!;
    r1.config!.rip = { enabled: true, networks: ["192.168.1.0/24"], passiveInterfaces: [], learnedRoutes: [] } as any;
    r2.config!.rip = { enabled: true, networks: [], passiveInterfaces: [], learnedRoutes: [] } as any;
    return { r1, r2, learned: () => ((r2.config!.rip as any).learnedRoutes as any[]).map(x => x.network) };
  }
  it("an empty network list learns nothing; a transit subnet omitted on either end blocks the exchange", () => {
    const { r1, r2, learned } = pair();
    runRipConvergence();
    expect(learned()).toEqual([]);                                   // R2: networks []
    (r2.config!.rip as any).networks = ["10.0.0.0/24"];
    runRipConvergence();
    expect(learned()).toEqual([]);                                   // R1 still doesn't run RIP on the transit
    (r1.config!.rip as any).networks.push("10.0.0.0/24");
    runRipConvergence();
    expect(learned()).toContain("192.168.1.0/24");                   // both ends active → converges
  });
});

describe("the seeded first leg passes the same admission as every later hop (F10)", () => {
  let raf: any;
  beforeAll(() => { raf = (globalThis as any).requestAnimationFrame; (globalThis as any).requestAnimationFrame = () => 0; });
  afterAll(() => { (globalThis as any).requestAnimationFrame = raf; });
  beforeEach(() => resetState());
  it("a 100 % loss link drops the very first frame (it used to cross untouched)", () => {
    const t = basicTopology(); state.devices = t.devices as any; state.links = t.links as any;
    const pc1 = state.devices.find(d => d.id === "pc1")!;
    const first = state.links.find(l => [l.from, l.to].includes("pc1"))!;
    first.loss = 100;
    startSimulation(buildPingEvents(pc1, "192.168.1.20") as any, pc1.id, "192.168.1.20");
    expect(state.simulation.transits).toEqual([]);                   // nothing left the source
    expect(JSON.stringify(state.simulation.log)).toContain("100% loss");
    while (state.simulation.status !== "done" && state.simulation.status !== "idle") stepOnce();
    expect(state.simulation.pingSuccess).toBe(false);
  });
});

describe("router DHCP leases stay inside the interface's REAL subnet (F05)", () => {
  beforeEach(() => resetState());
  const iface = (ip: string, prefixLength: number, leases: string[] = []) =>
    ({ peerId: "x", ipv4Address: ip, prefixLength, arpTable: [], dhcpLeases: leases.map((l, i) => ({ macAddress: `02:00:00:00:00:${String(i + 1).padStart(2, "0")}`, ipv4Address: l })) });
  const routerWith = (i: any) => { const r = addDevice("router", 0, 0); r.config!.interfaces = [i] as any; return r; };

  it("a /25 in the upper half leases from the upper half — never .100 from the other half", () => {
    const i = iface("192.168.10.129", 25); const r = routerWith(i);
    const lease = allocateDhcpIp(i, r)!;
    expect(lease).toBe("192.168.10.130");
    expect(sameSubnet(lease, "192.168.10.129", 25)).toBe(true);
  });
  it("a /30 has exactly one usable lease, then reports exhaustion", () => {
    const r1 = routerWith(iface("10.0.0.1", 30));
    expect(allocateDhcpIp(r1.config!.interfaces![0], r1)).toBe("10.0.0.2");
    resetState();
    const taken = iface("10.0.0.1", 30, ["10.0.0.2"]); const r2 = routerWith(taken);
    expect(allocateDhcpIp(taken, r2)).toBeNull();
  });
  it("a /24 keeps the conventional .100 start and falls back below it before exhausting", () => {
    const i = iface("192.168.1.1", 24); const r = routerWith(i);
    expect(allocateDhcpIp(i, r)).toBe("192.168.1.100");
    const full = iface("192.168.1.1", 24, Array.from({ length: 155 }, (_, k) => `192.168.1.${100 + k}`));
    resetState(); const r2 = routerWith(full);
    expect(allocateDhcpIp(full, r2)).toBe("192.168.1.2");           // .1 is the router
  });
});

describe("a device deleted mid-run does not leave the simulation stuck (LOW sweep)", () => {
  let raf: any;
  beforeAll(() => { raf = (globalThis as any).requestAnimationFrame; (globalThis as any).requestAnimationFrame = () => 0; });
  afterAll(() => { (globalThis as any).requestAnimationFrame = raf; });
  beforeEach(() => resetState());
  it("the run settles to done when the target of the last queued event has gone", () => {
    const t = basicTopology(); state.devices = t.devices as any; state.links = t.links as any;
    const pc1 = state.devices.find(d => d.id === "pc1")!;
    startSimulation(buildPingEvents(pc1, "192.168.1.20") as any, pc1.id, "192.168.1.20");
    // Deliver the first leg so a frame is queued for the switch, then delete the switch.
    for (const tr of state.simulation.transits) tr.progress = 1;
    stepOnce();
    state.devices = state.devices.filter(d => d.id !== "sw1");
    state.links = state.links.filter(l => l.from !== "sw1" && l.to !== "sw1");
    let guard = 0;
    while (state.simulation.status === "running" && guard++ < 50) { for (const tr of state.simulation.transits) tr.progress = 1; stepOnce(); }
    expect(state.simulation.status).not.toBe("running");   // used to sit on "running" forever
  });
});

// R16: runTraceroute matched a device NAME unconditionally (findPingTarget),
// bypassing the Instant DNS setting — so with no nameserver `ping PC-B` said
// "cannot resolve" while `traceroute PC-B` quietly succeeded.
describe("traceroute honours Instant DNS (R16)", () => {
  beforeEach(() => resetState());

  function routedByName() {
    runConsoleScript(`
      add computer PC-A at 0 0
      add switch SW at 200 0
      add router R1 at 400 0
      add switch SW2 at 600 0
      add computer PC-B at 800 0
      link PC-A SW
      link SW R1
      link R1 SW2
      link SW2 PC-B
      ip PC-A 10.0.0.9/24
      ip PC-B 10.0.1.9/24
      gateway PC-A 10.0.0.1
      gateway PC-B 10.0.1.1
      interface R1 SW ip 10.0.0.1/24
      interface R1 SW2 ip 10.0.1.1/24
    `);
    return state.devices.find(d => d.name === "PC-A")!;
  }

  it("with Instant DNS off and no nameserver, a NAME cannot be traced", () => {
    const pcA = routedByName();
    state.options.instantDns = false;
    const byName = runTraceroute(pcA, "PC-B");
    expect(typeof byName).toBe("string");
    expect(byName as string).toContain("unknown host");
  });

  it("a bare IP always traces, regardless of Instant DNS", () => {
    const pcA = routedByName();
    state.options.instantDns = false;
    const byIp = runTraceroute(pcA, "10.0.1.9");
    expect(typeof byIp === "object" && (byIp as any).reached).toBe(true);
  });

  it("with Instant DNS on, the name shortcut still works", () => {
    const pcA = routedByName();
    state.options.instantDns = true;
    const on = runTraceroute(pcA, "PC-B");
    expect(typeof on === "object" && (on as any).reached).toBe(true);
  });
});

// R18: a static route with an unresolvable next hop used to be installed and
// added to `seen` — so it black-holed its prefix and hid a working RIP route or
// internet default. It is now marked inactive: listed, but never used to
// forward and never shadowing another route for the same prefix.
import { showRouterRoute } from "../src/terminal";

describe("a static with an unreachable next hop is inactive (R18)", () => {
  beforeEach(() => resetState());

  function router1() {
    runConsoleScript(`
      add router R1 at 0 0
      add computer H at 200 0
      link R1 H
      ip H 10.0.0.2/24
      interface R1 H ip 10.0.0.1/24
    `);
    return state.devices.find(d => d.name === "R1")!;
  }

  it("an active static (next hop on a connected subnet) forwards; an unreachable one does not", () => {
    const r = router1();
    r.config!.staticRoutes = [
      { network: "172.16.0.0/16", nextHop: "10.0.0.2" },     // reachable → active
      { network: "192.168.50.0/24", nextHop: "10.88.88.88" } // unreachable → inactive
    ] as any;
    const table = buildRoutingTable(r);
    expect(table.find(x => x.network === "172.16.0.0/16")?.inactive).toBeFalsy();
    expect(table.find(x => x.network === "192.168.50.0/24")?.inactive).toBe(true);

    expect(routingLookup(r, "172.16.5.5")?.nextHopIp).toBe("10.0.0.2");   // active forwards
    expect(routingLookup(r, "192.168.50.5")).toBeNull();                  // inactive black-holes nothing — it isn't used
  });

  it("does not shadow a RIP route for the same prefix", () => {
    const r = router1();
    r.config!.staticRoutes = [{ network: "192.168.9.0/24", nextHop: "10.77.77.77" }] as any;   // dead
    r.config!.rip = { enabled: true, networks: [], passiveInterfaces: [],
      learnedRoutes: [{ network: "192.168.9.0/24", nextHop: "10.0.0.2", interface: "Ethernet1", metric: 2 }] } as any;
    const hit = routingLookup(r, "192.168.9.5");
    expect(hit).not.toBeNull();
    expect(hit!.nextHopIp).toBe("10.0.0.2");   // the RIP route is used, not the dead static
  });

  it("show ip route lists an inactive static without the selected marker", () => {
    const r = router1();
    r.config!.staticRoutes = [
      { network: "172.16.0.0/16", nextHop: "10.0.0.2" },
      { network: "192.168.50.0/24", nextHop: "10.88.88.88" }
    ] as any;
    const out = showRouterRoute(r);
    expect(out).toContain("S>* 172.16.0.0/16 via 10.0.0.2");
    expect(out).toMatch(/192\.168\.50\.0\/24 .*inactive/);
    expect(out).not.toContain("S>* 192.168.50.0/24");
  });
});

// R52: a stored router interface is keyed by its peer's id and carries no
// name, and the log lines printed `iface.name || iface.peerId` — so "Route …
// via", "ARP miss … on", "Received ARP … on" and "Forward deferred … via" named
// the interface by a UUID. They now use the name `show ip interface brief`
// and the inspector show.
describe("router log lines name interfaces, never peer ids (R52)", () => {
  beforeEach(() => resetState());

  const dev = (name: string) => state.devices.find(d => d.name === name)!;
  const build = () => runConsoleScript(`
    add computer PC1 at 0 0
    add switch SW1 at 100 0
    add router R1 at 200 0
    add switch SW2 at 300 0
    add computer PC2 at 400 0
    link PC1 SW1
    link SW1 R1
    link R1 SW2
    link PC2 SW2
    interface R1 SW1 ip 10.0.1.1/24
    interface R1 SW2 ip 10.0.2.1/24
    ip PC1 10.0.1.10/24
    gateway PC1 10.0.1.1
    ip PC2 10.0.2.10/24
    gateway PC2 10.0.2.1
  `);
  const ping = (from: string, ip: string) => {
    const a = dev(from);
    return runSimulationHeadless(buildPingEvents(a, ip) as any, a.id, ip, "ping");
  };
  const routerLines = (result: { log: { deviceName: string; action: string }[] }) =>
    result.log.filter(l => l.deviceName === "R1").map(l => l.action);
  const expectNoIds = (lines: string[]) => {
    for (const d of state.devices) for (const line of lines) expect(line).not.toContain(d.id);
  };

  it("a routed ping: ARP, route, ARP-miss and deferred-forward lines say Ethernet1 / Ethernet2", () => {
    build();
    const result = ping("PC1", "10.0.2.10");
    expect(result.success).toBe(true);
    const lines = routerLines(result);
    expect(lines).toContain("Received ARP Request for 10.0.1.1 on Ethernet1 — sending Reply");
    expect(lines.some(l => /^ARP miss for 10\.0\.2\.10 on Ethernet2 /.test(l))).toBe(true);
    expect(lines.some(l => /^Received ARP Reply on Ethernet2: 10\.0\.2\.10 is-at /.test(l))).toBe(true);
    expect(lines.some(l => /^Forward deferred .* to 10\.0\.2\.10 via Ethernet2 /.test(l))).toBe(true);
    expect(lines.some(l => /^Route 10\.0\.2\.10→10\.0\.1\.10 via Ethernet1 /.test(l))).toBe(true);
    expectNoIds(lines);
  });

  it("the names follow the cabling: after an unlink renumbers the ports, the next run says so", () => {
    build();
    expect(ping("PC1", "10.0.2.10").success).toBe(true);            // names cached for this run
    runConsoleScript("unlink SW1 R1");                              // R1—SW2 is now its only cable: Ethernet1
    flushHostArp(dev("PC2"));                                       // so PC2 ARPs for its gateway again
    const lines = routerLines(ping("PC2", "10.0.2.1"));
    expect(lines).toContain("Received ARP Request for 10.0.2.1 on Ethernet1 — sending Reply");
    expect(lines.some(l => l.includes("Ethernet2"))).toBe(false);
    expectNoIds(lines);
  });

  it("sub-interfaces are named with their tag (router-on-a-stick)", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const rtr = state.devices.find(d => d.id === "rtr-v")!;
    rtr.config.interfaces![1].arpTable = [{ ipv4Address: "192.168.20.10", macAddress: "02:00:14:00:01:10" }];
    const frame = createIcmpEchoRequest("02:00:0A:00:01:10", "02:01:00:00:01:01", "192.168.10.10", "192.168.20.10", 64);
    frame.vlanTag = 10;
    expect(processAtRouter(rtr, frame, "msw")).toHaveLength(1);
    const line = state.simulation.log.map(l => l.action).find(l => l.startsWith("Route "))!;
    expect(line).toContain("via Ethernet1.20 ");
    expect(line).not.toContain("msw");
  });

  it("a cable beyond the port count has no port name: the line names the far device instead", () => {
    build();
    expect(routerLines(ping("PC2", "10.0.2.1"))).toContain("Received ARP Request for 10.0.2.1 on Ethernet2 — sending Reply");
    // An in-place edit — no cable added or removed — so only the per-run reset
    // can notice it: SW2's cable is now beyond the port count.
    dev("R1").config.ethernetPorts = 1;
    flushHostArp(dev("PC2"));
    const lines = routerLines(ping("PC2", "10.0.2.1"));
    expect(lines).toContain("Received ARP Request for 10.0.2.1 on the interface to SW2 — sending Reply");
    expectNoIds(lines);
  });
});
