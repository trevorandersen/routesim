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
  runRouterTerminalCommand, runSwitchTerminalCommand, runTerminalCommand, runDeviceCommand,
} from "../src/terminal";
import { registerNoopCallbacks, resetState } from "./helpers";
import { basicTopology, routedTopology, vlanTopology } from "./fixtures";

beforeAll(() => registerNoopCallbacks());

function loadRouter() {
  const topo = routedTopology();
  state.devices = topo.devices as any;
  state.links = topo.links as any;
  const rtr = state.devices.find(d => d.id === "rtr")!;
  state.dock.open = true;
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

describe("runRouterTerminalCommand — FRR additions", () => {
  beforeEach(() => resetState());

  it("network <ifname> enables RIP on the interface's connected subnet", () => {
    const rtr = loadRouter();
    state.terminal.mode = "config";
    runRouterTerminalCommand(rtr, "interface Ethernet1");
    runRouterTerminalCommand(rtr, "ip address 192.168.10.1/24");
    runRouterTerminalCommand(rtr, "exit");
    runRouterTerminalCommand(rtr, "router rip");
    runRouterTerminalCommand(rtr, "network Ethernet1");
    expect(rtr.config.rip!.networks).toContain("192.168.10.0/24");
  });

  it("do <show> runs a show command from a config sub-mode", () => {
    const rtr = loadRouter();
    state.terminal.mode = "config";
    runRouterTerminalCommand(rtr, "router rip");
    runRouterTerminalCommand(rtr, "do show ip route");
    expect(hasError()).toBe(false);
    expect(state.terminal.lines.length).toBeGreaterThan(0);
  });

  it("show ip rip status and show ip route rip return output without error", () => {
    const rtr = loadRouter();
    runRouterTerminalCommand(rtr, "show ip rip status");
    runRouterTerminalCommand(rtr, "show ip route rip");
    expect(hasError()).toBe(false);
  });
});

describe("runRouterTerminalCommand — abbreviation & context ?", () => {
  beforeEach(() => resetState());

  const mutedText = () => state.terminal.lines.filter(l => l.kind === "muted").map(l => l.text).join("\n");

  it("expands an unambiguous prefix (sh ip ro → show ip route)", () => {
    const rtr = loadRouter();
    runRouterTerminalCommand(rtr, "sh ip ro");
    expect(hasError()).toBe(false);
    expect(state.terminal.lines.length).toBeGreaterThan(0);
  });

  it("abbreviates mode commands (en, conf t)", () => {
    const rtr = loadRouter();
    runRouterTerminalCommand(rtr, "en");
    expect(state.terminal.mode).toBe("privileged");
    runRouterTerminalCommand(rtr, "conf t");
    expect(state.terminal.mode).toBe("config");
  });

  it("reports an ambiguous prefix", () => {
    const rtr = loadRouter();
    runRouterTerminalCommand(rtr, "show ip r"); // route vs rip
    expect(state.terminal.lines.some(l => l.text.includes("Ambiguous"))).toBe(true);
  });

  it("? lists commands for the current mode", () => {
    const rtr = loadRouter();
    state.terminal.mode = "privileged";
    runRouterTerminalCommand(rtr, "?");
    expect(mutedText()).toContain("configure terminal");
  });

  it("partial ? completes the next tokens (show ip ?)", () => {
    const rtr = loadRouter();
    runRouterTerminalCommand(rtr, "show ip ?");
    expect(mutedText()).toContain("show ip route");
  });

  it("do <abbrev show> works from a config sub-mode", () => {
    const rtr = loadRouter();
    state.terminal.mode = "rip";
    runRouterTerminalCommand(rtr, "do sh ip ro");
    expect(hasError()).toBe(false);
  });
});

describe("runSwitchTerminalCommand — SONiC", () => {
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

  it("config vlan member add (untagged) sets the access VLAN", () => {
    const msw = loadSwitch();
    runSwitchTerminalCommand(msw, "config vlan add 30");
    runSwitchTerminalCommand(msw, "config vlan member add 30 Ethernet4");
    expect(msw.config.portVlans!.Ethernet4).toBe(30);
  });

  it("config vlan member add -t (tagged) makes the port a trunk carrying the VLAN", () => {
    const msw = loadSwitch();
    runSwitchTerminalCommand(msw, "config vlan add 30");
    runSwitchTerminalCommand(msw, "config vlan member add -t 30 Ethernet5");
    expect(msw.config.portModes!.Ethernet5).toBe("trunk");
    expect(msw.config.trunkAllowedVlans!.Ethernet5).toContain(30);
  });

  it("tagged add migrates an existing access VLAN to the trunk native", () => {
    const msw = loadSwitch();
    runSwitchTerminalCommand(msw, "config vlan add 30");
    runSwitchTerminalCommand(msw, "config vlan add 40");
    runSwitchTerminalCommand(msw, "config vlan member add 30 Ethernet4");
    runSwitchTerminalCommand(msw, "config vlan member add -t 40 Ethernet4");
    expect(msw.config.portModes!.Ethernet4).toBe("trunk");
    expect(msw.config.trunkNativeVlans!.Ethernet4).toBe(30);
    expect(msw.config.trunkAllowedVlans!.Ethernet4).toContain(40);
  });

  it("config vlan member del removes an untagged membership", () => {
    const msw = loadSwitch();
    runSwitchTerminalCommand(msw, "config vlan add 30");
    runSwitchTerminalCommand(msw, "config vlan member add 30 Ethernet4");
    runSwitchTerminalCommand(msw, "config vlan member del 30 Ethernet4");
    expect(msw.config.portVlans!.Ethernet4).toBeUndefined();
  });

  it("removing the last tagged member collapses the trunk back to access", () => {
    const msw = loadSwitch();
    runSwitchTerminalCommand(msw, "config vlan add 30");
    runSwitchTerminalCommand(msw, "config vlan member add -t 30 Ethernet5");
    runSwitchTerminalCommand(msw, "config vlan member del 30 Ethernet5");
    expect(msw.config.portModes!.Ethernet5).toBeUndefined();
  });

  it("errors when adding a member to a non-existent VLAN (SONiC requires it first)", () => {
    const msw = loadSwitch();
    runSwitchTerminalCommand(msw, "config vlan member add 999 Ethernet4");
    expect(state.terminal.lines.some(l => l.kind === "error")).toBe(true);
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

describe("host CLI — the inspector-set commands", () => {
  beforeEach(() => resetState());
  function pc() {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    state.terminal.deviceId = "pc1";
    return state.devices.find(d => d.id === "pc1")!;
  }

  it("ip link set sets the MAC; an invalid one errors and doesn't apply", () => {
    const d = pc();
    runTerminalCommand("ip link set dev eth0 address 02:00:00:00:00:AB");
    expect(d.config.macAddress).toBe("02:00:00:00:00:AB");
    const before = d.config.macAddress;
    runTerminalCommand("ip link set dev eth0 address not-a-mac");
    expect(d.config.macAddress).toBe(before); // unchanged
    expect(state.terminal.lines.some(l => l.kind === "error" && /Invalid MAC/.test(l.text))).toBe(true);
  });

  it("ip route del default clears the gateway; rm /etc/resolv.conf clears DNS", () => {
    const d = pc();
    d.config.gatewayIpv4Address = "10.0.0.1";
    d.config.dnsServerIp = "10.0.0.53";
    runTerminalCommand("ip route del default");
    runTerminalCommand("rm /etc/resolv.conf");
    expect(d.config.gatewayIpv4Address).toBe("");
    expect(d.config.dnsServerIp).toBeUndefined();
  });

  it("an invalid `ip addr add` surfaces the error instead of silently applying", () => {
    const d = pc();
    runTerminalCommand("ip addr add 192.168.1.999/24 dev eth0");
    expect(d.config.ipv4Address || "").not.toBe("192.168.1.999");
    expect(state.terminal.lines.some(l => l.kind === "error" && /Invalid/.test(l.text))).toBe(true);
  });
});

describe("runDeviceCommand — simulator-issued (injected) commands", () => {
  beforeEach(() => resetState());

  it("runs the command on the device and flags the echo + output as injected", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const pc = state.devices.find(d => d.id === "pc1")!;
    runDeviceCommand(pc, "ip addr add 10.1.2.3/24 dev eth0");
    expect(pc.config.ipv4Address).toBe("10.1.2.3");      // the command applied
    const session = state.terminalSessions.find(s => s.deviceId === pc.id)!;
    // The echoed command and its output line are both flagged injected.
    expect(session.lines.length).toBeGreaterThanOrEqual(2);
    expect(session.lines.every(l => l.injected)).toBe(true);
    expect(session.lines[0].text).toContain("ip addr add 10.1.2.3/24 dev eth0");
  });
});
