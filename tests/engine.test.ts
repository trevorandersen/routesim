import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { processAtSwitch, processAtRouter, processAtComputer } from "../src/engine";
import { createArpRequest, createArpReply, createIcmpEchoRequest, createIcmpEchoReply, createDhcpOffer, createDhcpAck, BROADCAST_MAC } from "../src/frame";
import { registerNoopCallbacks, resetState } from "./helpers";
import { basicTopology, routedTopology, vlanTopology, trunkTopology } from "./fixtures";

beforeAll(() => {
  registerNoopCallbacks();
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
    const entry = sw.config.macTable.find((e: any) => e.macAddress === "02:00:00:00:01:10");
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
    const entry = msw.config.macTable.find((e: any) => e.macAddress === "02:00:0A:00:01:10");
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
    rtr.config.interfaces[1].arpTable = [
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

  it("drops packet when TTL expires", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const rtr = state.devices.find(d => d.id === "rtr")!;
    rtr.config.interfaces[1].arpTable = [
      { ipv4Address: "192.168.20.10", macAddress: "02:00:00:00:20:10" },
    ];
    // TTL = 1 means it should be dropped
    const frame = createIcmpEchoRequest(
      "02:00:00:00:10:10", "02:01:00:00:01:01",
      "192.168.10.10", "192.168.20.10", 1
    );
    const outgoing = processAtRouter(rtr, frame, "sw-a");
    expect(outgoing).toHaveLength(0);
  });

  it("sends ARP request when egress ARP miss", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    // Initialise simulation state for pendingArp
    state.simulation.pendingArp = {};
    const rtr = state.devices.find(d => d.id === "rtr")!;
    // Ensure egress ARP table is empty
    rtr.config.interfaces[1].arpTable = [];
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
    rtr.config.interfaces[1].arpTable = [
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
    const iface10 = rtr.config.interfaces.find((i: any) => i.vlanTag === 10);
    const learned = iface10.arpTable.find((e: any) => e.ipv4Address === "192.168.10.10");
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
    const learned = pc1.config.arpTable.find((e: any) => e.ipv4Address === "192.168.1.20");
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
    const learned = pc1.config.arpTable.find((e: any) => e.ipv4Address === "192.168.1.20");
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
    const gwArp = pc1.config.arpTable.find((e: any) => e.ipv4Address === "192.168.1.1");
    expect(gwArp).toBeDefined();
    expect(gwArp.macAddress).toBe("02:01:00:00:01:01");
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
