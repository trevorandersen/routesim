import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { getVlanForDevice, l2Reachable, findRouterBetweenSubnets, buildPingEvents, buildDhcpEvents } from "../src/simulation";
import { registerNoopCallbacks, resetState } from "./helpers";
import { basicTopology, routedTopology, vlanTopology, trunkTopology } from "./fixtures";

beforeAll(() => {
  registerNoopCallbacks();
});

// ── getVlanForDevice ─────────────────────────────────────────────────────────

describe("getVlanForDevice", () => {
  beforeEach(() => resetState());

  it("returns VLAN ID for PC on managed switch access port", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    // pc-v10 is on Ethernet2 of MSW-1 with portVlans { Ethernet2: 10 }
    expect(getVlanForDevice("pc-v10")).toBe(10);
  });

  it("returns different VLAN for different access port", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    // pc-v20 is on Ethernet3 of MSW-1 with portVlans { Ethernet3: 20 }
    expect(getVlanForDevice("pc-v20")).toBe(20);
  });

  it("returns 1 (default) for PC on unmanaged switch", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    expect(getVlanForDevice("pc1")).toBe(1);
  });

  it("returns 1 for disconnected device", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = []; // no links
    expect(getVlanForDevice("pc1")).toBe(1);
  });

  it("returns 1 for device not in state", () => {
    resetState();
    expect(getVlanForDevice("nonexistent")).toBe(1);
  });
});

// ── l2Reachable ──────────────────────────────────────────────────────────────

describe("l2Reachable", () => {
  beforeEach(() => resetState());

  it("returns true for PCs on same unmanaged switch", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    expect(l2Reachable("pc1", "pc2", null)).toBe(true);
  });

  it("returns true for same VLAN across trunk link", () => {
    const topo = trunkTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    // pc-t1 on MSW-A VLAN 10, pc-t2 on MSW-B VLAN 10, trunk between MSW-A and MSW-B
    expect(l2Reachable("pc-t1", "pc-t2", 10)).toBe(true);
  });

  it("returns true for endpoints on same managed switch regardless of VLAN (BFS checks switches, not endpoints)", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    // l2Reachable VLAN filtering only checks managed switches *along the path*,
    // not the endpoint ports. So pc-v10 and pc-v20 on the same switch are reachable
    // even with different VLANs — the engine's processAtSwitch enforces port VLAN isolation.
    expect(l2Reachable("pc-v10", "pc-v20", 10)).toBe(true);
  });

  it("returns true when VLAN is null (ignores VLAN filtering)", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    // With null VLAN, l2Reachable should pass through unmanaged switches ignoring VLAN
    expect(l2Reachable("pc-v10", "pc-v20", null)).toBe(true);
  });

  it("returns false when no path exists", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = []; // no links
    expect(l2Reachable("pc1", "pc2", null)).toBe(false);
  });

  it("skips powered-off devices", () => {
    const topo = basicTopology();
    topo.devices[2].config.poweredOff = true;
    (topo.devices[2] as any).poweredOff = true;
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    expect(l2Reachable("pc1", "pc2", null)).toBe(false);
  });

  it("does not traverse through routers (unless destination)", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    // pc-a and pc-b are on different subnets connected through a router
    // l2Reachable should not traverse through the router to reach pc-b
    // (router blocks L2 bridging)
    expect(l2Reachable("pc-a", "pc-b", null)).toBe(false);
  });
});

// ── findRouterBetweenSubnets ─────────────────────────────────────────────────

describe("findRouterBetweenSubnets", () => {
  beforeEach(() => resetState());

  it("finds router connecting two subnets", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const result = findRouterBetweenSubnets("192.168.10.10", "192.168.20.10");
    expect(result).not.toBeNull();
    expect(result.router.id).toBe("rtr");
    expect(result.sourceIface.ipv4Address).toBe("192.168.10.1");
    expect(result.destIface.ipv4Address).toBe("192.168.20.1");
  });

  it("returns null when no router bridges subnets", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const result = findRouterBetweenSubnets("192.168.1.10", "10.0.0.1");
    expect(result).toBeNull();
  });

  it("skips powered-off routers", () => {
    const topo = routedTopology();
    const rtr = topo.devices.find(d => d.id === "rtr")!;
    (rtr as any).poweredOff = true;
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const result = findRouterBetweenSubnets("192.168.10.10", "192.168.20.10");
    expect(result).toBeNull();
  });

  it("skips hidden routers", () => {
    const topo = routedTopology();
    const rtr = topo.devices.find(d => d.id === "rtr")!;
    (rtr as any).hidden = true;
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const result = findRouterBetweenSubnets("192.168.10.10", "192.168.20.10");
    expect(result).toBeNull();
  });

  it("finds correct interfaces for VLAN router", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const result = findRouterBetweenSubnets("192.168.10.10", "192.168.20.10");
    expect(result).not.toBeNull();
    expect(result.router.id).toBe("rtr-v");
    expect(result.sourceIface.vlanTag).toBe(10);
    expect(result.destIface.vlanTag).toBe(20);
  });
});

// ── buildPingEvents ──────────────────────────────────────────────────────────

describe("buildPingEvents", () => {
  beforeEach(() => resetState());

  it("returns error when source has no IP", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const source = { ...topo.devices[0], config: { ...topo.devices[0].config, ipv4Address: "" } };
    const result = buildPingEvents(source, "192.168.1.20");
    expect(typeof result).toBe("string");
    expect(result as string).toContain("no IPv4 address");
  });

  it("returns error when source has no MAC", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const source = { ...topo.devices[0], config: { ...topo.devices[0].config, macAddress: "" } };
    const result = buildPingEvents(source, "192.168.1.20");
    expect(typeof result).toBe("string");
    expect(result as string).toContain("no MAC address");
  });

  it("returns error when target not found", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const result = buildPingEvents(topo.devices[0], "99.99.99.99");
    expect(typeof result).toBe("string");
    expect(result as string).toContain("cannot resolve");
  });

  it("creates ARP event for same-subnet ping (no ARP cache)", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const result = buildPingEvents(topo.devices[0], "192.168.1.20");
    expect(typeof result).not.toBe("string");
    const setup = result as { events: any[]; pendingArp: Record<string, any[]> };
    expect(setup.events).toHaveLength(1);
    // Should be an ARP request frame
    expect(setup.events[0].frame.payload.type).toBe("arp");
    expect(setup.events[0].frame.payload.operation).toBe("request");
    // Should have a pending ICMP deferred until ARP resolves
    const pendingKeys = Object.keys(setup.pendingArp);
    expect(pendingKeys.length).toBe(1);
  });

  it("creates ICMP event for same-subnet ping (ARP cache hit)", () => {
    const topo = basicTopology();
    // Pre-populate ARP cache
    topo.devices[0].config.arpTable = [
      { ipv4Address: "192.168.1.20", macAddress: "02:00:00:00:01:20" },
    ];
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const result = buildPingEvents(topo.devices[0], "192.168.1.20");
    expect(typeof result).not.toBe("string");
    const setup = result as { events: any[]; pendingArp: Record<string, any[]> };
    expect(setup.events).toHaveLength(1);
    expect(setup.events[0].frame.payload.type).toBe("ipv4");
    // No pending ARP since cache hit
    expect(Object.keys(setup.pendingArp)).toHaveLength(0);
  });

  it("returns error for cross-subnet ping with no gateway", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const source = { ...topo.devices[0], config: { ...topo.devices[0].config, gatewayIpv4Address: "" } };
    const result = buildPingEvents(source, "192.168.20.10");
    expect(typeof result).toBe("string");
    expect(result as string).toContain("no default gateway");
  });

  it("creates ARP-to-gateway event for cross-subnet ping", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const result = buildPingEvents(topo.devices[0], "192.168.20.10");
    expect(typeof result).not.toBe("string");
    const setup = result as { events: any[]; pendingArp: Record<string, any[]> };
    expect(setup.events).toHaveLength(1);
    // Should ARP for the gateway, not the final destination
    const arp = setup.events[0].frame.payload;
    expect(arp.type).toBe("arp");
    expect(arp.targetIp).toBe("192.168.10.1"); // gateway IP
  });

  it("returns self-ping string for ping to self", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const result = buildPingEvents(topo.devices[0], "192.168.1.10");
    expect(typeof result).toBe("string");
    expect(result as string).toContain("0% packet loss");
  });

  it("returns error when source has no link", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = []; // no links at all
    const result = buildPingEvents(topo.devices[0], "192.168.1.20");
    expect(typeof result).toBe("string");
    expect(result as string).toContain("unreachable");
  });
});

// ── buildDhcpEvents ─────────────────────────────────────────────────────────

describe("buildDhcpEvents", () => {
  beforeEach(() => resetState());

  it("returns PingSetup with DHCP Discover frame for valid computer", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const pc1 = state.devices.find(d => d.id === "pc1")!;
    const result = buildDhcpEvents(pc1);
    expect(typeof result).not.toBe("string");
    const setup = result as any;
    expect(setup.events).toHaveLength(1);
    const frame = setup.events[0].frame;
    expect(frame.payload.type).toBe("ipv4");
    expect((frame.payload as any).payload.type).toBe("dhcp");
    expect((frame.payload as any).payload.messageType).toBe("discover");
    expect(setup.pendingArp).toEqual({});
  });

  it("returns error string for computer without MAC", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const pc1 = state.devices.find(d => d.id === "pc1")!;
    pc1.config.macAddress = "";
    const result = buildDhcpEvents(pc1);
    expect(typeof result).toBe("string");
  });

  it("returns error string for computer with no connected peer", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = [];  // no links
    const pc1 = state.devices.find(d => d.id === "pc1")!;
    const result = buildDhcpEvents(pc1);
    expect(typeof result).toBe("string");
  });
});
