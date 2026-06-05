import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { showHostIp, showHostRoute, showHostArp, setHostIp, flushHostIp, setHostGateway } from "../src/terminal";
import { showRouterInterfaceBrief, showRouterRoute, showRouterArp } from "../src/terminal";
import { showSwitchInterfaces, showSwitchVlans, showSwitchMacTable } from "../src/terminal";
import { addSwitchVlan, removeSwitchVlan, setSwitchPortVlan, setSwitchPortMode, setSwitchTrunkNative, modifySwitchTrunkAllowed } from "../src/terminal";
import { registerNoopCallbacks, resetState } from "./helpers";
import { basicTopology, routedTopology, vlanTopology } from "./fixtures";

beforeAll(() => {
  registerNoopCallbacks();
});

// ── Host display tests ──────────────────────────────────────────────────────

describe("showHostIp", () => {
  beforeEach(() => resetState());

  it("shows IP and MAC for configured computer", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    const pc = state.devices.find(d => d.id === "pc1")!;
    const output = showHostIp(pc);
    expect(output).toContain("192.168.1.10");
    expect(output).toContain("02:00:00:00:01:10");
  });

  it("shows unassigned when no IP configured", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    const pc = state.devices.find(d => d.id === "pc1")!;
    pc.config.ipv4Address = "";
    const output = showHostIp(pc);
    expect(output).toContain("unassigned");
  });
});

describe("showHostRoute", () => {
  beforeEach(() => resetState());

  it("shows default gateway", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    const pc = state.devices.find(d => d.id === "pc1")!;
    expect(showHostRoute(pc)).toContain("192.168.1.1");
  });

  it("shows no route when gateway not configured", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    const pc = state.devices.find(d => d.id === "pc1")!;
    pc.config.gatewayIpv4Address = "";
    expect(showHostRoute(pc)).toContain("No default route");
  });
});

describe("showHostArp", () => {
  beforeEach(() => resetState());

  it("shows header only for empty table", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    const pc = state.devices.find(d => d.id === "pc1")!;
    const output = showHostArp(pc);
    expect(output).toContain("Address");
    expect(output).toContain("HWaddress");
    // No entries beyond the header
    expect(output.split("\n")).toHaveLength(1);
  });

  it("shows entries for populated table", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    const pc = state.devices.find(d => d.id === "pc1")!;
    pc.config.arpTable = [{ ipv4Address: "192.168.1.20", macAddress: "02:00:00:00:01:20" }];
    const output = showHostArp(pc);
    expect(output).toContain("192.168.1.20");
    expect(output).toContain("02:00:00:00:01:20");
  });
});

// ── Host mutation tests ─────────────────────────────────────────────────────

describe("setHostIp", () => {
  beforeEach(() => resetState());

  it("assigns valid IP address", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const pc = state.devices.find(d => d.id === "pc1")!;
    const result = setHostIp(pc, "10.0.0.5/24");
    expect(result).toContain("10.0.0.5");
    expect(pc.config.ipv4Address).toBe("10.0.0.5");
  });

  it("returns error for invalid IP", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const pc = state.devices.find(d => d.id === "pc1")!;
    const result = setHostIp(pc, "not-an-ip");
    expect(result).toContain("Invalid");
  });
});

describe("flushHostIp", () => {
  beforeEach(() => resetState());

  it("clears IP and ARP table", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const pc = state.devices.find(d => d.id === "pc1")!;
    pc.config.arpTable = [{ ipv4Address: "192.168.1.20", macAddress: "02:00:00:00:01:20" }];
    flushHostIp(pc);
    expect(pc.config.ipv4Address).toBeFalsy();
    expect(pc.config.arpTable).toHaveLength(0);
  });
});

describe("setHostGateway", () => {
  beforeEach(() => resetState());

  it("sets default gateway", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const pc = state.devices.find(d => d.id === "pc1")!;
    setHostGateway(pc, "10.0.0.1");
    expect(pc.config.gatewayIpv4Address).toBe("10.0.0.1");
  });
});

// ── Router display tests ────────────────────────────────────────────────────

describe("showRouterInterfaceBrief", () => {
  beforeEach(() => resetState());

  it("lists interfaces with IP addresses", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const rtr = state.devices.find(d => d.id === "rtr")!;
    const output = showRouterInterfaceBrief(rtr);
    expect(output).toContain("192.168.10.1");
    expect(output).toContain("192.168.20.1");
  });
});

describe("showRouterRoute", () => {
  beforeEach(() => resetState());

  it("shows connected routes with C code", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const rtr = state.devices.find(d => d.id === "rtr")!;
    const output = showRouterRoute(rtr);
    expect(output).toContain("C");
    expect(output).toContain("192.168.10.0/24");
  });
});

describe("showRouterArp", () => {
  beforeEach(() => resetState());

  it("shows header when no ARP entries", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const rtr = state.devices.find(d => d.id === "rtr")!;
    const output = showRouterArp(rtr);
    expect(output).toContain("Address");
  });
});

// ── Switch display tests ────────────────────────────────────────────────────

describe("showSwitchInterfaces", () => {
  beforeEach(() => resetState());

  it("lists ports for managed switch", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const sw = state.devices.find(d => d.id === "msw")!;
    const output = showSwitchInterfaces(sw);
    expect(output).toContain("Ethernet1");
    expect(output).toContain("trunk");
  });
});

describe("showSwitchVlans", () => {
  beforeEach(() => resetState());

  it("lists VLAN membership", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const sw = state.devices.find(d => d.id === "msw")!;
    const output = showSwitchVlans(sw);
    expect(output).toContain("Sales");
    expect(output).toContain("10");
  });
});

describe("showSwitchMacTable", () => {
  beforeEach(() => resetState());

  it("shows header for empty table", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const sw = state.devices.find(d => d.id === "msw")!;
    const output = showSwitchMacTable(sw);
    expect(output).toContain("Vlan");
    expect(output).toContain("MacAddress");
  });
});

// ── Switch mutation tests ───────────────────────────────────────────────────

describe("addSwitchVlan", () => {
  beforeEach(() => resetState());

  it("adds a new VLAN", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const sw = state.devices.find(d => d.id === "msw")!;
    addSwitchVlan(sw, "30");
    expect(sw.config.vlans.some((v: any) => v.id === 30)).toBe(true);
  });
});

describe("removeSwitchVlan", () => {
  beforeEach(() => resetState());

  it("removes an existing VLAN", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const sw = state.devices.find(d => d.id === "msw")!;
    removeSwitchVlan(sw, "10");
    expect(sw.config.vlans.some((v: any) => v.id === 10)).toBe(false);
  });
});

describe("setSwitchPortVlan", () => {
  beforeEach(() => resetState());

  it("assigns port to VLAN", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const sw = state.devices.find(d => d.id === "msw")!;
    setSwitchPortVlan(sw, "Ethernet4", "20");
    expect(sw.config.portVlans.Ethernet4).toBe(20);
  });
});

describe("setSwitchPortMode", () => {
  beforeEach(() => resetState());

  it("sets port mode to trunk", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const sw = state.devices.find(d => d.id === "msw")!;
    setSwitchPortMode(sw, "Ethernet2", "trunk");
    expect(sw.config.portModes.Ethernet2).toBe("trunk");
  });
});

function loadManagedSwitch() {
  const topo = vlanTopology();
  state.devices = topo.devices as any;
  state.links = topo.links as any;
  return state.devices.find(d => d.id === "msw")!;
}

describe("setSwitchTrunkNative", () => {
  beforeEach(() => resetState());

  it("sets the native VLAN on a trunk port", () => {
    const sw = loadManagedSwitch();
    setSwitchTrunkNative(sw, "Ethernet1", "99");
    expect(sw.config.trunkNativeVlans.Ethernet1).toBe(99);
  });

  it("clears the entry when set back to VLAN 1", () => {
    const sw = loadManagedSwitch();
    setSwitchTrunkNative(sw, "Ethernet1", "99");
    setSwitchTrunkNative(sw, "Ethernet1", "1");
    expect(sw.config.trunkNativeVlans.Ethernet1).toBeUndefined();
  });

  it("rejects an unknown interface", () => {
    const sw = loadManagedSwitch();
    const result = setSwitchTrunkNative(sw, "Ethernet99", "10");
    expect(result).toContain("Unknown interface");
  });
});

describe("modifySwitchTrunkAllowed", () => {
  beforeEach(() => resetState());

  it("adds VLANs to the allowed list (sorted)", () => {
    const sw = loadManagedSwitch();
    modifySwitchTrunkAllowed(sw, "Ethernet1", "30", "add");
    modifySwitchTrunkAllowed(sw, "Ethernet1", "20", "add");
    expect(sw.config.trunkAllowedVlans.Ethernet1).toEqual([20, 30]);
  });

  it("removes a VLAN and prunes the empty entry", () => {
    const sw = loadManagedSwitch();
    modifySwitchTrunkAllowed(sw, "Ethernet1", "30", "add");
    modifySwitchTrunkAllowed(sw, "Ethernet1", "30", "remove");
    expect(sw.config.trunkAllowedVlans.Ethernet1).toBeUndefined();
  });
});
