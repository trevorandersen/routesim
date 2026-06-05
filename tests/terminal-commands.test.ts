/**
 * Terminal command dispatcher tests — the router/switch/computer command
 * parsing and the router mode state machine (exec → privileged → config →
 * interface/rip). These dispatchers had no coverage before; they are where
 * the WS3 decomposition landed.
 *
 * Note: ping/dhcp happy paths call startSimulation (an rAF loop that the test
 * preload's synchronous requestAnimationFrame would recurse on), so those are
 * exercised via their validation-error paths only.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import {
  runRouterTerminalCommand, runSwitchTerminalCommand, runTerminalCommand,
} from "../src/terminal";
import { registerNoopCallbacks, resetState } from "./helpers";
import { basicTopology, routedTopology, vlanTopology } from "./fixtures";

beforeAll(() => registerNoopCallbacks());

function loadRouter() {
  const topo = routedTopology();
  state.devices = topo.devices as any;
  state.links = topo.links as any;
  const rtr = state.devices.find(d => d.id === "rtr")!;
  state.terminal.open = true;
  state.terminal.deviceId = "rtr";
  state.terminal.mode = "exec";
  return rtr;
}

const hasError = () => state.terminal.lines.some(l => l.kind === "error");

describe("runRouterTerminalCommand — mode machine", () => {
  beforeEach(() => resetState());

  it("walks exec → privileged → config → interface/rip and back", () => {
    const rtr = loadRouter();
    runRouterTerminalCommand(rtr, "enable");
    expect(state.terminal.mode).toBe("privileged");
    runRouterTerminalCommand(rtr, "configure terminal");
    expect(state.terminal.mode).toBe("config");
    runRouterTerminalCommand(rtr, "interface Ethernet1");
    expect(state.terminal.mode).toBe("interface");
    expect(state.terminal.interfacePeerId).toBe("sw-a");
    runRouterTerminalCommand(rtr, "exit");
    expect(state.terminal.mode).toBe("config");
    runRouterTerminalCommand(rtr, "router rip");
    expect(state.terminal.mode).toBe("rip");
    expect(rtr.config.rip!.enabled).toBe(true);
    runRouterTerminalCommand(rtr, "exit");
    expect(state.terminal.mode).toBe("config");
    runRouterTerminalCommand(rtr, "end");
    expect(state.terminal.mode).toBe("privileged");
  });

  it("conf t requires privileged mode", () => {
    const rtr = loadRouter();
    runRouterTerminalCommand(rtr, "configure terminal"); // from exec
    expect(state.terminal.mode).toBe("exec");
    expect(hasError()).toBe(true);
  });
});

describe("runRouterTerminalCommand — config commands", () => {
  beforeEach(() => resetState());

  it("ip route adds a static route in config mode", () => {
    const rtr = loadRouter();
    state.terminal.mode = "config";
    runRouterTerminalCommand(rtr, "ip route 10.0.0.0/24 192.168.1.1");
    expect(rtr.config.staticRoutes).toContainEqual({ network: "10.0.0.0/24", nextHop: "192.168.1.1" });
  });

  it("ip route is rejected outside config mode", () => {
    const rtr = loadRouter(); // mode exec
    runRouterTerminalCommand(rtr, "ip route 10.0.0.0/24 192.168.1.1");
    expect(rtr.config.staticRoutes ?? []).toHaveLength(0);
    expect(hasError()).toBe(true);
  });

  it("router rip + network + passive-interface populate rip config", () => {
    const rtr = loadRouter();
    state.terminal.mode = "config";
    runRouterTerminalCommand(rtr, "router rip");
    runRouterTerminalCommand(rtr, "network 192.168.10.0/24");
    runRouterTerminalCommand(rtr, "passive-interface Ethernet1");
    expect(rtr.config.rip!.networks).toContain("192.168.10.0/24");
    expect(rtr.config.rip!.passiveInterfaces).toContain("Ethernet1");
  });
});

describe("runRouterTerminalCommand — interface commands", () => {
  beforeEach(() => resetState());

  it("ip address sets the selected interface IP", () => {
    const rtr = loadRouter();
    state.terminal.mode = "config";
    runRouterTerminalCommand(rtr, "interface Ethernet1");
    runRouterTerminalCommand(rtr, "ip address 192.168.10.5/24");
    expect(rtr.config.interfaces!.some(i => i.ipv4Address === "192.168.10.5")).toBe(true);
  });

  it("encapsulation dot1q sets the interface vlan tag", () => {
    const rtr = loadRouter();
    state.terminal.mode = "config";
    runRouterTerminalCommand(rtr, "interface Ethernet1");
    runRouterTerminalCommand(rtr, "encapsulation dot1q 10");
    expect(state.terminal.interfaceVlanTag).toBe(10);
  });

  it("ip address requires interface mode", () => {
    const rtr = loadRouter();
    state.terminal.mode = "config";
    runRouterTerminalCommand(rtr, "ip address 192.168.10.5/24");
    expect(hasError()).toBe(true);
  });
});

describe("runRouterTerminalCommand — show & unknown", () => {
  beforeEach(() => resetState());

  it("show ip route returns output (no error)", () => {
    const rtr = loadRouter();
    runRouterTerminalCommand(rtr, "show ip route");
    expect(state.terminal.lines.length).toBeGreaterThan(0);
    expect(hasError()).toBe(false);
  });

  it("unknown command reports an error", () => {
    const rtr = loadRouter();
    runRouterTerminalCommand(rtr, "frobnicate the widgets");
    expect(state.terminal.lines.some(l => l.text.includes("Unknown command"))).toBe(true);
  });
});

describe("runSwitchTerminalCommand", () => {
  beforeEach(() => resetState());

  function loadSwitch() {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    return state.devices.find(d => d.id === "msw")!;
  }

  it("rejects an unmanaged switch", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const sw = state.devices.find(d => d.id === "sw1")!;
    runSwitchTerminalCommand(sw, "config vlan add 10");
    expect(state.terminal.lines.some(l => l.text.includes("unmanaged"))).toBe(true);
  });

  it("config vlan add creates a VLAN", () => {
    const msw = loadSwitch();
    runSwitchTerminalCommand(msw, "config vlan add 30");
    expect(msw.config.vlans!.some(v => v.id === 30)).toBe(true);
  });

  it("config interface vlan add assigns an access VLAN", () => {
    const msw = loadSwitch();
    runSwitchTerminalCommand(msw, "config interface vlan add Ethernet4 30");
    expect(msw.config.portVlans!.Ethernet4).toBe(30);
  });

  it("config interface mode sets trunk", () => {
    const msw = loadSwitch();
    runSwitchTerminalCommand(msw, "config interface mode Ethernet5 trunk");
    expect(msw.config.portModes!.Ethernet5).toBe("trunk");
  });

  it("config interface trunk native sets the native VLAN", () => {
    const msw = loadSwitch();
    runSwitchTerminalCommand(msw, "config interface trunk native Ethernet1 99");
    expect(msw.config.trunkNativeVlans!.Ethernet1).toBe(99);
  });

  it("config interface trunk allowed add updates the allowed list", () => {
    const msw = loadSwitch();
    runSwitchTerminalCommand(msw, "config interface trunk allowed Ethernet1 add 30");
    expect(msw.config.trunkAllowedVlans!.Ethernet1).toContain(30);
  });
});

describe("runTerminalCommand — dispatch by device type", () => {
  beforeEach(() => resetState());

  it("dispatches to the router handler", () => {
    loadRouter();
    state.terminal.mode = "config";
    runTerminalCommand("ip route 10.0.0.0/24 192.168.1.1");
    const rtr = state.devices.find(d => d.id === "rtr")!;
    expect(rtr.config.staticRoutes).toContainEqual({ network: "10.0.0.0/24", nextHop: "192.168.1.1" });
  });

  it("dispatches a computer ip-addr command to setHostIp", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    state.terminal.deviceId = "pc1";
    runTerminalCommand("ip addr add 10.0.0.5/24 dev eth0");
    const pc = state.devices.find(d => d.id === "pc1")!;
    expect(pc.config.ipv4Address).toBe("10.0.0.5");
  });

  it("reports a ping validation error (no simulation started)", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    state.terminal.deviceId = "pc1";
    runTerminalCommand("ping nosuchhost");
    expect(state.terminal.lines.some(l => l.text.startsWith("ping:"))).toBe(true);
    expect(state.simulation.status).toBe("idle");
  });

  it("errors when no device is attached", () => {
    state.terminal.deviceId = null;
    runTerminalCommand("ip addr show");
    expect(state.terminal.lines.some(l => l.text.includes("No device"))).toBe(true);
  });
});
