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
import { state } from "../src/state";
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
    const { run } = router("interface");
    expect(run("iptables -L")).toContain("Leave the sub-mode");
  });
  it("removing a port-forward that does not exist is an error and pushes no undo", () => {
    const { run } = router("config"); const before = state.undoStack.length;
    expect(run("no ip nat inside source static tcp 10.0.0.5 80 203.0.113.1 80")).toContain("No port-forward");
    expect(state.undoStack.length).toBe(before);
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
