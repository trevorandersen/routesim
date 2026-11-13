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
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { runConsoleScript } from "../src/commands";
import { state, undo, redo } from "../src/state";
import { terminalPromptText, syncTerminal } from "../src/terminal";
import {
  runRouterTerminalCommand, runSwitchTerminalCommand, runTerminalCommand, runDeviceCommand, runHostTerminalCommand, setSwitchPortMode, showSwitchRunningConfig, showRouterRunningConfig } from "../src/terminal";
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

  // R86 — the mode machine's faults.
  const say = (rtr: any, c: string) => { const n = state.terminal.lines.length; runRouterTerminalCommand(rtr, c); return state.terminal.lines.slice(n).map(l => l.text).join(" "); };

  it("`end` at user exec does not hand out privileged mode", () => {
    const rtr = loadRouter();
    expect(say(rtr, "end")).toContain("% Invalid input — end leaves configuration mode");
    expect(state.terminal.mode).toBe("exec");
    runRouterTerminalCommand(rtr, "enable");
    expect(say(rtr, "end")).toBe("");                       // already at privileged: nothing to leave
    expect(state.terminal.mode).toBe("privileged");
  });

  it("`disable` steps privileged back to user exec, and is refused from configuration", () => {
    const rtr = loadRouter();
    runRouterTerminalCommand(rtr, "enable");
    runRouterTerminalCommand(rtr, "disable");
    expect(state.terminal.mode).toBe("exec");
    runRouterTerminalCommand(rtr, "enable");
    runRouterTerminalCommand(rtr, "configure terminal");
    expect(say(rtr, "disable")).toContain("leave configuration mode first");
    expect(state.terminal.mode).toBe("config");
    state.terminal.mode = "privileged";
    runRouterTerminalCommand(rtr, "disa");                  // abbreviates like any registered command
    expect(state.terminal.mode).toBe("exec");
  });

  it("`exit` at privileged exec logs out, as at user exec", () => {
    const rtr = loadRouter();
    state.terminalSessions = [state.terminal];
    runRouterTerminalCommand(rtr, "enable");
    runRouterTerminalCommand(rtr, "exit");
    expect(state.terminalSessions).toHaveLength(0);
  });

  it("the clear commands run only where the registry says", () => {
    const rtr = loadRouter();
    rtr.config.natTranslations = [{ protocol: "icmp", insideIp: "192.168.10.10", insidePort: 1, outsideIp: "192.168.20.1", outsidePort: 1, destIp: "192.168.20.10", destPort: 1 }] as any;
    rtr.config.rip = { enabled: true, networks: [], passiveInterfaces: [], learnedRoutes: [{ network: "10.9.0.0/24", nextHop: "192.168.20.2", interface: "Ethernet2", metric: 2 }] } as any;
    const depth = state.undoStack.length;
    expect(say(rtr, "clear ip nat translation *")).toBe("% Privileged mode required. Enter enable first.");
    expect(say(rtr, "clear ip rip database")).toBe("% Privileged mode required. Enter enable first.");
    state.terminal.mode = "interface"; state.terminal.interfacePeerId = "sw-a";
    expect(say(rtr, "clear ip nat translation *")).toContain("% Leave the sub-mode first");
    expect(say(rtr, "clear ip rip database")).toContain("% Leave the sub-mode first");
    expect(rtr.config.natTranslations).toHaveLength(1);
    expect(rtr.config.rip!.learnedRoutes).toHaveLength(1);
    expect(state.undoStack.length).toBe(depth);
    state.terminal.mode = "rip";
    expect(say(rtr, "clear ip nat translation *")).toContain("% Leave the sub-mode first");
    expect(say(rtr, "clear ip rip database")).not.toContain("%");     // the registry lists rip mode for this one
    expect(rtr.config.rip!.learnedRoutes).toHaveLength(0);
    state.terminal.mode = "privileged";
    expect(say(rtr, "clear ip nat translation *")).toBe("Cleared all NAT translations.");
    expect(rtr.config.natTranslations).toHaveLength(0);
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

  it("ip neigh flush all clears every interface's ARP cache (privileged), undoably", () => {
    const rtr = loadRouter();
    rtr.config.interfaces![0].arpTable = [{ ipv4Address: "192.168.10.10", macAddress: "02:DE:AD:00:00:01" }];
    runRouterTerminalCommand(rtr, "ip neigh flush all");   // exec: refused
    expect(hasError()).toBe(true);
    expect(rtr.config.interfaces![0].arpTable).toHaveLength(1);
    runRouterTerminalCommand(rtr, "enable");
    runRouterTerminalCommand(rtr, "ip neigh flush all");
    expect(rtr.config.interfaces!.every(i => !i.arpTable?.length)).toBe(true);
    expect(state.terminal.lines.at(-1)!.text).toBe("Flushed 1 ARP entry.");
    runConsoleScript("undo");
    expect(state.devices.find(d => d.id === "rtr")!.config.interfaces![0].arpTable).toHaveLength(1);
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

describe("a powered-off device has no working shell (R42)", () => {
  beforeEach(() => resetState());

  function open(name: string) {
    const device = state.devices.find(d => d.name === name)!;
    state.terminal = { ...state.terminal, deviceId: device.id, lines: [], mode: "exec" };
    return device;
  }

  it("refuses a host command with the reason, changes nothing and takes no undo point", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      ip PC1 10.0.0.1/24
    `);
    const pc = open("PC1");
    runConsoleScript("power PC1 off");
    const undoDepth = state.undoStack.length;
    const result = runTerminalCommand("ip addr add 10.0.0.9/24 dev eth0");
    expect(result.ok).toBe(false);
    expect(result.lines.map(l => l.text)).toEqual(["PC1 is powered off."]);
    expect(pc.config.ipv4Address).toBe("10.0.0.1");
    expect(state.undoStack.length).toBe(undoDepth);
    // A traceroute used to print thirty silent hops from a dead machine.
    expect(runTerminalCommand("traceroute 10.0.0.2").lines.map(l => l.text)).toEqual(["PC1 is powered off."]);
  });

  it("refuses a router's config commands too", () => {
    runConsoleScript("add router R1 at 0 0");
    const router = open("R1");
    state.terminal.mode = "config";
    runConsoleScript("power R1 off");
    expect(runTerminalCommand("ip route 10.9.0.0/24 10.0.0.2").ok).toBe(false);
    expect(router.config.staticRoutes || []).toEqual([]);
    expect(state.terminal.lines.map(l => l.text)).toEqual(["R1 is powered off."]);
  });

  it("still lets `clear` tidy the scrollback, and works again once powered on", () => {
    runConsoleScript("add computer PC1 at 0 0");
    const pc = open("PC1");
    runConsoleScript("power PC1 off");
    runTerminalCommand("ip addr show");
    expect(state.terminal.lines.length).toBe(1);
    expect(runTerminalCommand("clear").ok).toBe(true);
    expect(state.terminal.lines).toEqual([]);
    runConsoleScript("power PC1 on");
    expect(runTerminalCommand("ip addr add 10.0.0.9/24 dev eth0").ok).toBe(true);
    expect(pc.config.ipv4Address).toBe("10.0.0.9");
  });

  it("the console's `cli` verb reports the refusal", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      power PC1 off
    `);
    const results = runConsoleScript("cli PC1 ip addr add 10.0.0.9/24 dev eth0");
    expect(results[0].ok).toBe(false);
    expect(results[0].output).toEqual(["PC1 is powered off."]);
  });

  it("the input's placeholder says why the shell is dead", () => {
    runConsoleScript("add computer PC1 at 0 0");
    open("PC1");
    runConsoleScript("power PC1 off");
    syncTerminal();
    expect((document.getElementById("terminalInput") as HTMLInputElement).placeholder).toContain("PC1 is powered off");
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

  it("ip neigh flush all empties the ARP cache, undoably", () => {
    const d = pc();
    d.config.arpTable = [{ ipv4Address: "192.168.1.1", macAddress: "02:DE:AD:00:00:01" }];
    runTerminalCommand("ip neigh flush all");
    expect(d.config.arpTable).toEqual([]);
    expect(state.terminal.lines.at(-1)!.text).toBe("Flushed 1 ARP entry from eth0.");
    runConsoleScript("undo");
    expect(state.devices.find(x => x.id === "pc1")!.config.arpTable).toHaveLength(1);
    runTerminalCommand("ip neigh flush dev eth0");
    runTerminalCommand("ip neigh flush all");
    expect(state.terminal.lines.at(-1)!.text).toBe("ARP cache is already empty.");
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

describe("router CLI — faithfulness fixes", () => {
  beforeEach(() => resetState());

  it("interface retargets directly from interface mode (no need to exit first)", () => {
    const rtr = loadRouter();
    runRouterTerminalCommand(rtr, "enable");
    runRouterTerminalCommand(rtr, "configure terminal");
    runRouterTerminalCommand(rtr, "interface Ethernet1");
    expect(state.terminal.interfacePeerId).toBe("sw-a");
    state.terminal.lines = [];
    runRouterTerminalCommand(rtr, "interface Ethernet2"); // retarget while in interface mode
    expect(state.terminal.mode).toBe("interface");
    expect(state.terminal.interfacePeerId).toBe("sw-b");
    expect(hasError()).toBe(false);
  });

  it("enable is rejected from configuration mode", () => {
    const rtr = loadRouter();
    runRouterTerminalCommand(rtr, "enable");
    runRouterTerminalCommand(rtr, "configure terminal");
    state.terminal.lines = [];
    runRouterTerminalCommand(rtr, "enable"); // not a config command
    expect(state.terminal.mode).toBe("config"); // unchanged
    expect(hasError()).toBe(true);
  });

  it("no ip route requires the prefix and matches the stored CIDR route", () => {
    const rtr = loadRouter();
    runRouterTerminalCommand(rtr, "enable");
    runRouterTerminalCommand(rtr, "configure terminal");
    runRouterTerminalCommand(rtr, "ip route 10.0.0.0/24 192.168.10.2");
    expect((rtr.config.staticRoutes || []).length).toBe(1);
    state.terminal.lines = [];
    runRouterTerminalCommand(rtr, "no ip route 10.0.0.0"); // bare network — rejected
    expect(hasError()).toBe(true);
    expect((rtr.config.staticRoutes || []).length).toBe(1);
    runRouterTerminalCommand(rtr, "no ip route 10.0.0.0/24"); // with prefix — removes
    expect((rtr.config.staticRoutes || []).length).toBe(0);
  });

  it("RIP network with host bits is stored masked", () => {
    const rtr = loadRouter();
    runRouterTerminalCommand(rtr, "enable");
    runRouterTerminalCommand(rtr, "configure terminal");
    runRouterTerminalCommand(rtr, "router rip");
    runRouterTerminalCommand(rtr, "network 192.168.5.7/24");
    expect(rtr.config.rip!.networks).toContain("192.168.5.0/24");
    expect(rtr.config.rip!.networks).not.toContain("192.168.5.7/24");
  });
});

describe("hostname — a CLI device's name is its hostname", () => {
  beforeEach(() => resetState());

  function loadHost() {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    state.dock.open = true;
    state.terminal.deviceId = "pc1";
    state.terminal.mode = "exec";
    return state.devices.find(d => d.id === "pc1")!;
  }

  it("`hostname <name>` renames the host (which is its canvas name)", () => {
    const pc = loadHost();
    runTerminalCommand("hostname web-01");
    expect(pc.name).toBe("web-01");
    expect(hasError()).toBe(false);
  });

  it("`hostname` with no args prints the current name", () => {
    const pc = loadHost();
    runTerminalCommand("hostname");
    expect(state.terminal.lines.some(l => l.text === pc.name)).toBe(true);
  });

  it("`hostnamectl set-hostname` and `echo > /etc/hostname` both set it", () => {
    const pc = loadHost();
    runTerminalCommand("hostnamectl set-hostname alpha");
    expect(pc.name).toBe("alpha");
    runTerminalCommand("echo beta > /etc/hostname");
    expect(pc.name).toBe("beta");
    expect(hasError()).toBe(false);
  });

  it("rejects an invalid hostname and leaves the name unchanged", () => {
    const pc = loadHost();
    const before = pc.name;
    runTerminalCommand("hostname _nope");   // can't start with a hyphen/underscore
    expect(pc.name).toBe(before);
    expect(hasError()).toBe(true);
  });

  it("router `hostname` renames it, but only in config mode", () => {
    const rtr = loadRouter();
    const before = rtr.name;
    runRouterTerminalCommand(rtr, "hostname R9");   // exec mode → refused
    expect(rtr.name).toBe(before);
    runRouterTerminalCommand(rtr, "enable");
    runRouterTerminalCommand(rtr, "configure terminal");
    runRouterTerminalCommand(rtr, "hostname R9");
    expect(rtr.name).toBe("R9");
  });

  it("switch `config hostname` renames it", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    state.terminal.deviceId = "msw";
    const sw = state.devices.find(d => d.id === "msw")!;
    runSwitchTerminalCommand(sw, "config hostname Core-SW");
    expect(sw.name).toBe("Core-SW");
  });
});

describe("router-on-a-stick from the FRR shell (sub-interfaces are created by naming them)", () => {
  function roas() {
    resetState();
    runConsoleScript("add router R1 at 0 0\nadd switch SW at 200 0\nmanaged SW on\nlink R1 SW");
    const r1 = state.devices.find(d => d.name === "R1")!;
    state.terminal = { deviceId: r1.id, mode: "config", interfacePeerId: null, interfaceVlanTag: null, lines: [], history: [], historyIndex: -1 } as any;
    const run = (c: string) => { const n = state.terminal.lines.length; runRouterTerminalCommand(r1, c); return state.terminal.lines.slice(n).map((l: any) => l.text).join(" "); };
    const tagged = () => r1.config!.interfaces!.filter(i => i.vlanTag != null).map(i => `${i.vlanTag}=${i.ipv4Address}`).sort();
    return { r1, run, tagged };
  }
  it("base + encapsulation creates the .N sub-interface and leaves the base untagged", () => {
    const { r1, run, tagged } = roas();
    run("interface Ethernet1");
    run("encapsulation dot1q 10");
    expect(state.terminal.interfaceVlanTag).toBe(10);
    run("ip address 192.168.10.1/24");
    expect(tagged()).toEqual(["10=192.168.10.1"]);
    run("exit");
    expect(run("interface Ethernet1")).not.toContain("Unknown");   // the base is still enterable, untagged
    expect(state.terminal.interfaceVlanTag).toBeNull();
  });
  it("interface Ethernet1.20 creates a second sub-interface; the base stays enterable", () => {
    const { run, tagged } = roas();
    run("interface Ethernet1"); run("encapsulation dot1q 10"); run("ip address 192.168.10.1/24"); run("exit");
    expect(run("interface Ethernet1.20")).not.toContain("Unknown");
    run("ip address 192.168.20.1/24");
    expect(tagged()).toEqual(["10=192.168.10.1", "20=192.168.20.1"]);   // TWO sub-interfaces (this used to be impossible)
    run("exit");
    expect(run("interface Ethernet1")).not.toContain("Unknown");           // the base, even with sub-interfaces present
    expect(state.terminal.interfaceVlanTag).toBeNull();
  });
  it("encapsulation on a sub-interface retags it; a bogus name is still unknown", () => {
    const { run, tagged } = roas();
    run("interface Ethernet1.10"); run("ip address 192.168.10.1/24");
    run("encapsulation dot1q 30");
    expect(tagged()).toEqual(["30=192.168.10.1"]);
    expect(run("interface Ethernet9.5")).toContain("Unknown");
  });
  // R40: retagging used to create a second Ethernet1.10 with another subnet —
  // unselectable, and a later `ip address` overwrote the first.
  it("retagging a sub-interface onto a VLAN a sibling carries is refused, with no undo point", () => {
    const { run, tagged } = roas();
    run("interface Ethernet1.10"); run("ip address 192.168.10.1/24"); run("exit");
    run("interface Ethernet1.20"); run("ip address 192.168.20.1/24");
    const depth = state.undoStack.length;
    const out = run("encapsulation dot1q 10");
    expect(out).toContain("% VLAN 10 is already carried by sub-interface Ethernet1.10");
    expect(tagged()).toEqual(["10=192.168.10.1", "20=192.168.20.1"]);
    expect(state.terminal.interfaceVlanTag).toBe(20);              // still configuring .20
    expect(state.undoStack.length).toBe(depth);
    run("ip address 192.168.21.1/24");                             // …which edits .20, not .10
    expect(tagged()).toEqual(["10=192.168.10.1", "20=192.168.21.1"]);
  });
  it("re-stating the sub-interface's own VLAN is a no-op; a free VLAN still retags", () => {
    const { run, tagged } = roas();
    run("interface Ethernet1.10"); run("ip address 192.168.10.1/24");
    const depth = state.undoStack.length;
    expect(run("encapsulation dot1q 10")).toBe("Encapsulation is already 802.1Q VLAN 10.");
    expect(state.undoStack.length).toBe(depth);
    expect(run("encapsulation dot1q 30")).toContain("Encapsulation set to 802.1Q VLAN 30");
    expect(tagged()).toEqual(["30=192.168.10.1"]);
  });
  it("on the base, naming a VLAN that exists selects that sub-interface rather than duplicating it", () => {
    const { run, tagged } = roas();
    run("interface Ethernet1.10"); run("ip address 192.168.10.1/24"); run("exit");
    run("interface Ethernet1");
    run("encapsulation dot1q 10");
    expect(state.terminal.interfaceVlanTag).toBe(10);
    expect(tagged()).toEqual(["10=192.168.10.1"]);
  });
});

describe("terminal targets by name (G2-02) and `no network` symmetry (G2-04)", () => {
  let raf: any;
  beforeAll(() => { raf = (globalThis as any).requestAnimationFrame; (globalThis as any).requestAnimationFrame = () => 0; });
  afterAll(() => { (globalThis as any).requestAnimationFrame = raf; });
  it("`ping <laptop>` from a PC terminal targets the laptop's ADDRESS, not the literal name", () => {
    resetState();
    runConsoleScript("add computer PC at 0 0\nadd laptop L at 0 200\nadd access-point AP at 200 200\nadd switch SW at 200 0\nlink PC SW\nlink AP SW\nlink L AP\nip PC 10.0.0.5/24\nip L 10.0.0.6/24");
    state.options.instantDns = true;
    const pc = state.devices.find(d => d.name === "PC")!;
    state.terminal = { deviceId: pc.id, mode: "exec", interfacePeerId: null, interfaceVlanTag: null, lines: [], history: [], historyIndex: -1 } as any;
    runHostTerminalCommand(pc, "ping L");
    expect(state.simulation.pingTargetIp).toBe("10.0.0.6");   // was "L"
  });
  it("`no network` removes exactly what `network` added, masked, and by interface name too", () => {
    resetState();
    runConsoleScript("add router R1 at 0 0\nadd switch SW at 200 0\nlink R1 SW\ninterface R1 SW ip 192.168.1.1/24");
    const r1 = state.devices.find(d => d.name === "R1")!;
    state.terminal = { deviceId: r1.id, mode: "rip", interfacePeerId: null, interfaceVlanTag: null, lines: [], history: [], historyIndex: -1 } as any;
    r1.config!.rip = { enabled: true, networks: [], passiveInterfaces: [], learnedRoutes: [] } as any;
    runRouterTerminalCommand(r1, "network 192.168.1.5/24");
    expect(r1.config!.rip!.networks).toEqual(["192.168.1.0/24"]);
    runRouterTerminalCommand(r1, "no network 192.168.1.5/24");
    expect(r1.config!.rip!.networks).toEqual([]);                // used to stay ["192.168.1.0/24"]
    runRouterTerminalCommand(r1, "network Ethernet1");
    runRouterTerminalCommand(r1, "no network Ethernet1");
    expect(r1.config!.rip!.networks).toEqual([]);
    const n = state.terminal.lines.length;
    runRouterTerminalCommand(r1, "no network 10.9.0.0/16");
    expect(state.terminal.lines.slice(n).some((l: any) => /not a RIP network/.test(l.text))).toBe(true);
  });
});

describe("P3 sweep — switch shell", () => {
  const managed = () => {
    resetState();
    runConsoleScript("add switch SW at 0 0\nadd computer A at -200 0\nadd computer B at 200 0\nlink SW A\nlink SW B\nmanaged SW on\nvlan SW add 20");
    const sw = state.devices.find(d => d.name === "SW")!;
    state.terminal = { deviceId: sw.id, mode: "exec", interfacePeerId: null, interfaceVlanTag: null, lines: [], history: [], historyIndex: -1 } as any;
    return sw;
  };
  it("a rejected mirror (unknown port) pushes no undo entry", () => {
    const sw = managed(); const before = state.undoStack.length;
    runSwitchTerminalCommand(sw, "config mirror_session span add MON Ethernet9");
    expect(state.undoStack.length).toBe(before);
  });
  it("deleting a non-member VLAN from a port pushes no undo entry and says so", () => {
    const sw = managed(); const before = state.undoStack.length; const n = state.terminal.lines.length;
    runSwitchTerminalCommand(sw, "config vlan member del 20 Ethernet1");
    expect(state.undoStack.length).toBe(before);
    expect(state.terminal.lines.slice(n).some((l: any) => /not a member/.test(l.text))).toBe(true);
  });
  it("`config vlan del` also clears trunk allow-lists and native VLANs referencing the VLAN", () => {
    const sw = managed();
    runSwitchTerminalCommand(sw, "config vlan member add -t 20 Ethernet1");
    runSwitchTerminalCommand(sw, "config vlan member add 20 Ethernet2");
    runSwitchTerminalCommand(sw, "config vlan del 20");
    expect(JSON.stringify(sw.config!.trunkAllowedVlans || {})).not.toContain("20");
    expect(JSON.stringify(sw.config!.trunkNativeVlans || {})).not.toContain("20");
    expect(JSON.stringify(sw.config!.portVlans || {})).not.toContain("20");
  });
  it("the running-config names a trunk carrying all VLANs instead of omitting it", () => {
    const sw = managed();
    setSwitchPortMode(sw, "Ethernet1", "trunk");          // no allow-list = all VLANs
    expect(showSwitchRunningConfig(sw)).toContain("Ethernet1: trunk carrying all VLANs");
  });
});

describe("P3 sweep — router shell", () => {
  const router = (mode: string) => {
    resetState();
    runConsoleScript("add router R1 at 0 0\nadd switch SW at 200 0\nlink R1 SW\ninterface R1 SW ip 10.0.0.1/24");
    const r1 = state.devices.find(d => d.name === "R1")!;
    state.terminal = { deviceId: r1.id, mode, interfacePeerId: null, interfaceVlanTag: null, lines: [], history: [], historyIndex: -1 } as any;
    const run = (c: string) => { const n = state.terminal.lines.length; runRouterTerminalCommand(r1, c); return state.terminal.lines.slice(n).map((l: any) => l.text).join(" "); };
    return { r1, run };
  };
  it("iptables is refused in a sub-mode, as the registry advertises", () => {
    const { run } = router("config");
    run("interface Ethernet1");   // a real interface mode — one with no interface selected is reconciled away
    expect(run("iptables -L")).toContain("Leave the sub-mode");
  });
  it("removing a port-forward that does not exist is an error and pushes no undo", () => {
    const { run } = router("config"); const before = state.undoStack.length;
    expect(run("no ip nat inside source static tcp 10.0.0.5 80 203.0.113.1 80")).toContain("No port-forward");
    expect(state.undoStack.length).toBe(before);
  });
  // R84: `no passive-interface` compared the raw token, so a case variant
  // removed nothing, yet reported success and took an undo point.
  it("no passive-interface resolves the name as passive-interface does, and a no-op takes no undo point", () => {
    const { r1, run } = router("rip");
    r1.config!.rip = { enabled: true, networks: [], passiveInterfaces: [], learnedRoutes: [] } as any;
    run("passive-interface Ethernet1");
    let depth = state.undoStack.length;
    expect(run("passive-interface ethernet1")).toBe("Ethernet1 is already passive.");
    expect(state.undoStack.length).toBe(depth);
    expect(run("no passive-interface ETHERNET1")).toBe("Removed Ethernet1 from passive interfaces.");
    expect(r1.config!.rip!.passiveInterfaces).toEqual([]);
    expect(state.undoStack.length).toBe(depth + 1);
    depth = state.undoStack.length;
    expect(run("no passive-interface Ethernet1")).toBe("% Ethernet1 is not a passive interface on this router.");
    expect(run("no passive-interface Ethernet9")).toBe("% Ethernet9 is not a passive interface on this router.");
    expect(state.undoStack.length).toBe(depth);
  });

  it("passive-interface validates the interface and canonicalises its name", () => {
    const { r1, run } = router("rip");
    r1.config!.rip = { enabled: true, networks: [], passiveInterfaces: [], learnedRoutes: [] } as any;
    expect(run("passive-interface Ethernet9")).toContain("Unknown interface");
    run("passive-interface ethernet1");
    expect(r1.config!.rip!.passiveInterfaces).toEqual(["Ethernet1"]);
  });
  it("show running-config includes the static port-forwards", () => {
    const { r1, run } = router("config");
    run("ip nat inside source static tcp 10.0.0.5 80 203.0.113.1 8080");
    expect(showRouterRunningConfig(r1)).toContain("ip nat inside source static tcp 10.0.0.5 80 203.0.113.1 8080");
  });
});

// R33: a router session's CLI mode points at configuration (the RIP process, one
// sub-interface). Undo rewound that configuration but not the mode, so the next
// `network` dereferenced a RIP block that no longer existed (a TypeError that
// escaped the submit) and `ip address` silently recreated the undone
// sub-interface. The mode is now reconciled against the live router.
describe("router shell — a CLI mode whose target is gone falls back to config mode (R33)", () => {
  function shell() {
    resetState();
    runConsoleScript("add router R1 at 0 0\nadd switch SW at 200 0\nmanaged SW on\nlink R1 SW\ninterface R1 SW ip 10.0.0.1/24");
    const r1 = () => state.devices.find(d => d.name === "R1")!;   // undo replaces the device objects
    state.terminal = { deviceId: r1().id, mode: "config", interfacePeerId: null, interfaceVlanTag: null, lines: [], history: [], historyIndex: -1 } as any;
    state.terminalSessions = [state.terminal];
    const run = (c: string) => { const n = state.terminal.lines.length; runRouterTerminalCommand(r1(), c); return state.terminal.lines.slice(n).map((l: any) => l.text).join(" "); };
    return { r1, run };
  }

  it("undoing `router rip` leaves rip mode: `network` reports it instead of throwing", () => {
    const { r1, run } = shell();
    run("router rip");
    expect(state.terminal.mode).toBe("rip");
    undo();
    expect(r1().config!.rip?.enabled).toBeFalsy();
    let out = "";
    expect(() => { out = run("network 10.0.0.0/24"); }).not.toThrow();
    expect(state.terminal.mode).toBe("config");
    expect(out).toContain("RIP is no longer enabled on R1");
    expect(out).toContain("Enter router rip mode first");
    expect(r1().config!.rip?.networks ?? []).toEqual([]);   // nothing was configured behind the learner's back
  });

  it("every RIP sub-mode command survives the undo", () => {
    for (const cmd of ["network 10.0.0.0/24", "no network 10.0.0.0/24", "passive-interface Ethernet1", "no passive-interface Ethernet1"]) {
      const { run } = shell();
      run("router rip");
      undo();
      expect(() => run(cmd)).not.toThrow();
      expect(state.terminal.mode).toBe("config");
    }
  });

  it("redo brings the RIP process back, and `router rip` re-enters it", () => {
    const { r1, run } = shell();
    run("router rip");
    undo();
    run("exit");                       // reconciled to config, then exit → privileged
    redo();
    expect(r1().config!.rip?.enabled).toBe(true);
    run("configure terminal");
    run("router rip");
    run("network 10.0.0.0/24");
    expect(r1().config!.rip!.networks).toEqual(["10.0.0.0/24"]);
  });

  it("`no router rip` in a script, then a stale rip-mode session, is reconciled the same way", () => {
    const { r1, run } = shell();
    run("router rip");
    r1().config!.rip = { enabled: false, networks: [], passiveInterfaces: [], learnedRoutes: [] };   // disabled from elsewhere
    expect(run("network 10.0.0.0/24")).toContain("RIP is no longer enabled");
  });

  it("an undone sub-interface is not silently recreated by the next `ip address`", () => {
    const { r1, run } = shell();
    run("interface Ethernet1.20");     // naming it creates it (one undo point)
    expect(r1().config!.interfaces!.some(i => i.vlanTag === 20)).toBe(true);
    undo();
    expect(r1().config!.interfaces!.some(i => i.vlanTag === 20)).toBe(false);
    const out = run("ip address 192.168.20.1/24");
    expect(out).toContain("Sub-interface .20 no longer exists");
    expect(out).toContain("Interface mode required");
    expect(state.terminal.mode).toBe("config");
    expect(state.terminal.interfacePeerId).toBeNull();
    expect(r1().config!.interfaces!.some(i => i.vlanTag === 20)).toBe(false);
  });

  it("an interface command typed in config mode is answered as one, not expanded to iptables", () => {
    const { run } = shell();
    expect(run("ip address 10.0.0.9/24")).toBe("% Interface mode required.");
    expect(run("ip nat inside")).toBe("% Interface mode required.");
    expect(run("ipt -L")).not.toContain("Interface mode");   // a real abbreviation of iptables still expands
  });
  // R11: `ip` is not an abbreviation of `iptables`, so an ABBREVIATED interface
  // command in the wrong mode is diagnosed too (the fully spelled one already was).
  it("an abbreviated interface command in config or privileged mode is not rewritten as iptables", () => {
    const { run } = shell();
    for (const mode of ["config", "privileged"] as const) {
      state.terminal.mode = mode;
      expect(run("ip add 10.0.0.9/24")).toBe("% Interface mode required.");
      expect(run("ip addr 10.0.0.9/24")).toBe("% Interface mode required.");
      expect(run("ip nat in")).toBe("% Interface mode required.");
      expect(run("no ip addr")).toBe("% Interface mode required.");
      expect(run("ip")).not.toContain("iptables");
      state.terminal.mode = mode;
    }
    state.terminal.mode = "config";
    expect(run("ipt -L")).toContain("Chain");                  // three letters still abbreviate it
    expect(run("iptables -L")).toContain("Chain");
    expect(run("ip ro 10.9.0.0/24 192.168.10.2")).not.toContain("%");   // and `ip route` still abbreviates
  });

  it("an unplugged cable ends interface mode instead of configuring a phantom interface", () => {
    const { r1, run } = shell();
    run("interface Ethernet1");
    const before = r1().config!.interfaces!.length;
    runConsoleScript("unlink R1 SW");
    const out = run("ip address 10.9.9.1/24");
    expect(out).toContain("no longer cabled");
    expect(state.terminal.mode).toBe("config");
    expect(r1().config!.interfaces!.some(i => i.ipv4Address === "10.9.9.1")).toBe(false);
    expect(r1().config!.interfaces!.length).toBe(before);
  });

  it("a live mode is left alone (no notice, no fallback)", () => {
    const { run } = shell();
    run("interface Ethernet1");
    const lines = state.terminal.lines.length;
    syncTerminal();
    expect(state.terminal.mode).toBe("interface");
    run("exit");
    run("router rip");
    syncTerminal();
    expect(state.terminal.mode).toBe("rip");
    expect(state.terminal.lines.slice(lines).some((l: any) => /back in configuration mode/.test(l.text))).toBe(false);
  });

  it("the prompt follows at the next render, and the notice is written once", () => {
    const { r1, run } = shell();
    run("router rip");
    expect(terminalPromptText(r1())).toBe("R1(config-router)#");
    undo();
    syncTerminal();                    // what restoreSnapshot's bridge call does in the app
    syncTerminal();
    expect(terminalPromptText(r1())).toBe("R1(config)#");
    expect(state.terminal.lines.filter((l: any) => /RIP is no longer enabled/.test(l.text)).length).toBe(1);
  });

  it("the console's `cli` echoes the reconciled prompt", () => {
    const { r1 } = shell();
    runTerminalCommand("router rip");
    undo();
    const n = state.terminal.lines.length;
    runTerminalCommand("network 10.0.0.0/24");
    const echoed = state.terminal.lines.slice(n).find((l: any) => l.kind === "command")!;
    expect(echoed.text).toBe("R1(config)# network 10.0.0.0/24");
    expect(r1().config!.rip?.enabled).toBeFalsy();
  });
});

// R39: an uncabled router port has no peer, and config-if was keyed by peer id
// alone — `interface Ethernet3` entered the mode, then every command in it
// answered "Interface mode required" (later: "no longer cabled", for a port
// that never was). The session now holds the port's name, and the commands
// edit the by-name entry the inspector's "not connected" rows use.
describe("router shell — config-if on a port with no cable (R39)", () => {
  function shell() {
    resetState();
    runConsoleScript("add router R1 at 0 0\nadd switch SW at 200 0\nlink R1 SW\ninterface R1 SW ip 10.0.0.1/24");
    const r1 = () => state.devices.find(d => d.name === "R1")!;   // undo replaces the device objects
    state.terminal = { deviceId: r1().id, mode: "config", interfacePeerId: null, interfaceVlanTag: null, interfaceName: null, lines: [], history: [], historyIndex: -1 };
    state.terminalSessions = [state.terminal];
    const run = (c: string) => { const n = state.terminal.lines.length; runRouterTerminalCommand(r1(), c); return state.terminal.lines.slice(n).map(l => l.text).join(" "); };
    const byName = (name: string) => (r1().config.interfaces || []).find(i => i.peerId === "" && i.name === name);
    return { r1, run, byName };
  }

  it("`ip address` addresses the unplugged port, says it stays down, and is undoable", () => {
    const { r1, run, byName } = shell();
    expect(run("interface Ethernet3")).toBe("");
    expect(state.terminal.mode).toBe("interface");
    expect(state.terminal.interfaceName).toBe("Ethernet3");
    const out = run("ip address 10.3.0.1/24");
    expect(out).not.toContain("Interface mode required");
    expect(out).toContain("Ethernet3 is not cabled");
    expect(state.terminal.mode).toBe("interface");
    expect(byName("Ethernet3")).toMatchObject({ ipv4Address: "10.3.0.1", prefixLength: 24 });
    expect(showRouterRunningConfig(r1())).toContain("interface Ethernet3\n ip address 10.3.0.1/24");
    undo();
    expect(byName("Ethernet3")?.ipv4Address || "").toBe("");
  });

  it("`no ip address`, `ip nat` and a bad address all act on that port", () => {
    const { run, byName } = shell();
    run("interface ethernet3");                                    // names match ignoring case
    expect(run("ip address 10.3.0.999")).toContain("Invalid IPv4 address");
    run("ip address 10.3.0.1/24");
    expect(run("ip nat inside")).toContain("ip nat inside");
    expect(byName("Ethernet3")!.natRole).toBe("inside");
    expect(run("no ip address")).not.toContain("Interface mode required");
    expect(byName("Ethernet3")!.ipv4Address).toBe("");
  });

  it("a sub-interface on an unplugged port is refused with the reason, not `Unknown interface`", () => {
    const { run } = shell();
    const undoDepth = state.undoStack.length;
    const out = run("interface Ethernet3.10");
    expect(out).toContain("Ethernet3 is not cabled");
    expect(out).not.toContain("Unknown interface");
    expect(state.terminal.mode).toBe("config");
    run("interface Ethernet3");
    expect(run("encapsulation dot1q 10")).toContain("Ethernet3 is not cabled");
    expect(state.terminal.interfaceVlanTag).toBeNull();
    expect(state.undoStack.length).toBe(undoDepth);
    expect(run("interface Ethernet99")).toContain("Unknown interface Ethernet99");   // a port that does not exist still is
  });

  it("retargeting to a cabled interface, `exit` and `end` drop the port name", () => {
    const { r1, run } = shell();
    run("interface Ethernet3");
    run("interface Ethernet1");
    expect(state.terminal.interfaceName).toBeNull();
    expect(state.terminal.interfacePeerId).toBe(state.devices.find(d => d.name === "SW")!.id);
    run("ip address 10.0.0.254/24");
    expect(r1().config.interfaces!.find(i => i.peerId)!.ipv4Address).toBe("10.0.0.254");
    run("interface Ethernet3");
    run("exit");
    expect(state.terminal.mode).toBe("config");
    expect(state.terminal.interfaceName).toBeNull();
    expect(run("ip address 10.9.9.9/24")).toContain("Interface mode required");   // truly outside the mode
  });

  it("a cable plugged into the port mid-session moves the session onto that interface", () => {
    const { r1, run } = shell();
    run("interface Ethernet2");
    runConsoleScript("add switch SW2 at 200 200\nlink R1 SW2");      // the next free port: Ethernet2
    const out = run("ip address 10.2.0.1/24");
    expect(out).toContain("Ethernet2 is now cabled to SW2");
    const sw2 = state.devices.find(d => d.name === "SW2")!.id;
    expect(state.terminal.interfacePeerId).toBe(sw2);
    expect(state.terminal.interfaceName).toBeNull();
    expect(r1().config.interfaces!.find(i => i.peerId === sw2)!.ipv4Address).toBe("10.2.0.1");
  });

  it("a port removed mid-session falls back to config mode and says so", () => {
    const { run } = shell();
    run("interface Ethernet4");
    expect(state.terminal.mode).toBe("interface");
    expect(runConsoleScript("portcount R1 2").every(r => r.ok)).toBe(true);
    const out = run("ip address 10.4.0.1/24");
    expect(out).toContain("Ethernet4 no longer exists on R1");
    expect(out).toContain("Interface mode required");
    expect(state.terminal.mode).toBe("config");
  });
});
