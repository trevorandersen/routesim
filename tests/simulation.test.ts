import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { runConsoleScript } from "../src/commands";
import { state } from "../src/state";
import { getVlanForDevice, l2Reachable, buildPingEvents, buildDhcpEvents } from "../src/simulation";
import { setSwitchPortVlan } from "../src/terminal";
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

  it("reflects a VLAN change made after the first read (memoised port-vlan map invalidates on edit)", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    expect(getVlanForDevice("pc-v10")).toBe(10); // primes the memo
    const link = state.links.find(l => l.from === "pc-v10" || l.to === "pc-v10")!;
    const sw = state.devices.find(d => d.id === (link.from === "pc-v10" ? link.to : link.from))!;
    setSwitchPortVlan(sw, "Ethernet2", "30"); // mutator replaces config.portVlans
    expect(getVlanForDevice("pc-v10")).toBe(30); // recomputed, not a stale cache hit
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

  it("endpoints on DIFFERENT access VLANs of the same managed switch are not reachable (the egress check is alive)", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    // This used to pin the opposite: the egress-VLAN check searched the switch's
    // ports for a peer equal to the switch itself and never fired, so the
    // pre-check said "reachable" while processAtSwitch correctly isolated them.
    // Now the switch's port toward pc-v20 (access VLAN 20) is checked on the way
    // out, and the pre-check agrees with the engine.
    expect(l2Reachable("pc-v10", "pc-v20", 10)).toBe(false);
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

  it("returns 'cannot resolve' only for an unresolvable hostname (not a bare IP)", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    // An unresolvable name still errors out instantly.
    const named = buildPingEvents(topo.devices[0], "no-such-host");
    expect(typeof named).toBe("string");
    expect(named as string).toContain("cannot resolve");
    // A valid IP that belongs to no device must NOT be "cannot resolve" — it
    // should attempt the ping (ARP first) and let the simulation time out.
    const byIp = buildPingEvents(topo.devices[0], "192.168.1.99");
    expect(typeof byIp).not.toBe("string");
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

describe("l2Reachable — the egress-VLAN check is alive", () => {
  beforeEach(() => resetState());
  function twoVlans() {
    runConsoleScript(`
      add computer PC-A at 0 0
      add computer PC-B at 0 200
      add switch SW at 200 100
      link PC-A SW
      link PC-B SW
      managed SW on
      vlan SW add 10
      vlan SW add 20
      port SW Ethernet1 vlan 10
      port SW Ethernet2 vlan 20
    `);
    return { a: state.devices.find(d => d.name === "PC-A")!, b: state.devices.find(d => d.name === "PC-B")! };
  }
  it("two hosts on different access VLANs of one switch are NOT L2-reachable", () => {
    const { a, b } = twoVlans();
    expect(l2Reachable(a.id, b.id, 10)).toBe(false);   // the old check searched the switch for itself and never fired
    expect(l2Reachable(a.id, b.id, 20)).toBe(false);
  });
  it("moving PC-B onto VLAN 10 makes them reachable again", () => {
    const { a, b } = twoVlans();
    runConsoleScript("port SW Ethernet2 vlan 10");
    expect(l2Reachable(a.id, b.id, 10)).toBe(true);
  });
});
