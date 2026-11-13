/**
 * Firewall device tests — rule matching, the iptables CLI, and packet filtering
 * in the simulation. The firewall is a transparent inline filter (FORWARD chain).
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { ruleToIptables as _fmt, runIptablesCommand as _runIpt } from "../src/terminal/iptables";
import { addDevice as _addFw } from "../src/devices";
import { resetState as _resetFw, registerNoopCallbacks as _noopFw } from "./helpers";
import { state } from "../src/state";
import { evaluateFirewall, firewallRuleMatches, processAtFirewall, runSimulationHeadless } from "../src/engine";
import { runFirewallTerminalCommand } from "../src/terminal";
import { buildPingEvents } from "../src/simulation";
import { createArpRequest, createIcmpEchoRequest } from "../src/frame";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";
import { state as _state2 } from "../src/state";

beforeAll(() => registerNoopCallbacks());

const icmpV4 = (src: string, dst: string, icmpType = 8): any => ({
  type: "ipv4", srcIp: src, dstIp: dst, ttl: 64, protocol: 1,
  payload: { type: "icmp", icmpType, sequence: 1 },
});

describe("firewall — rule matching", () => {
  it("matches by protocol (tcp/udp never match — no L4 traffic)", () => {
    expect(firewallRuleMatches({ chain: "forward", target: "drop", protocol: "icmp" }, icmpV4("1.1.1.1", "2.2.2.2"))).toBe(true);
    expect(firewallRuleMatches({ chain: "forward", target: "drop", protocol: "udp" }, icmpV4("1.1.1.1", "2.2.2.2"))).toBe(false);
    expect(firewallRuleMatches({ chain: "forward", target: "drop", protocol: "tcp" }, icmpV4("1.1.1.1", "2.2.2.2"))).toBe(false);
  });
  it("matches src/dst by exact IP and CIDR", () => {
    expect(firewallRuleMatches({ chain: "forward", target: "drop", src: "192.168.1.0/24" }, icmpV4("192.168.1.50", "10.0.0.1"))).toBe(true);
    expect(firewallRuleMatches({ chain: "forward", target: "drop", src: "192.168.1.0/24" }, icmpV4("192.168.2.50", "10.0.0.1"))).toBe(false);
    expect(firewallRuleMatches({ chain: "forward", target: "drop", dst: "10.0.0.1" }, icmpV4("1.1.1.1", "10.0.0.1"))).toBe(true);
  });
  it("matches by icmp-type", () => {
    expect(firewallRuleMatches({ chain: "forward", target: "drop", icmpType: "echo-request" }, icmpV4("1.1.1.1", "2.2.2.2", 8))).toBe(true);
    expect(firewallRuleMatches({ chain: "forward", target: "drop", icmpType: "echo-reply" }, icmpV4("1.1.1.1", "2.2.2.2", 8))).toBe(false);
    // R21: "any" is a wildcard, and type 3 is now named and matchable.
    expect(firewallRuleMatches({ chain: "forward", target: "drop", icmpType: "any" }, icmpV4("1.1.1.1", "2.2.2.2", 8))).toBe(true);
    expect(firewallRuleMatches({ chain: "forward", target: "drop", icmpType: "any" }, icmpV4("1.1.1.1", "2.2.2.2", 3))).toBe(true);
    expect(firewallRuleMatches({ chain: "forward", target: "drop", icmpType: "destination-unreachable" }, icmpV4("1.1.1.1", "2.2.2.2", 3))).toBe(true);
    expect(firewallRuleMatches({ chain: "forward", target: "drop", icmpType: "destination-unreachable" }, icmpV4("1.1.1.1", "2.2.2.2", 8))).toBe(false);
  });
});

describe("firewall — evaluate (first match wins, else policy)", () => {
  it("falls through to the chain policy when nothing matches", () => {
    expect(evaluateFirewall({ config: { rules: [], policy: { forward: "drop" } } } as any, icmpV4("1.1.1.1", "2.2.2.2"))).toBe("drop");
    expect(evaluateFirewall({ config: { rules: [], policy: { forward: "accept" } } } as any, icmpV4("1.1.1.1", "2.2.2.2"))).toBe("accept");
  });
  it("the first matching rule wins over later rules and the policy", () => {
    const fw: any = { config: { rules: [
      { chain: "forward", target: "accept", src: "192.168.1.10" },
      { chain: "forward", target: "drop", protocol: "icmp" },
    ], policy: { forward: "drop" } } };
    expect(evaluateFirewall(fw, icmpV4("192.168.1.10", "2.2.2.2"))).toBe("accept");
    expect(evaluateFirewall(fw, icmpV4("192.168.1.20", "2.2.2.2"))).toBe("drop");
  });
});

describe("firewall — address patterns (parsed once, matched as integers)", () => {
  const rule = (src: string): any => ({ chain: "forward", target: "drop", src });

  it("an exact IP matches only itself; a CIDR its whole network", () => {
    expect(firewallRuleMatches(rule("10.0.0.1"), icmpV4("10.0.0.1", "2.2.2.2"))).toBe(true);
    expect(firewallRuleMatches(rule("10.0.0.1"), icmpV4("10.0.0.2", "2.2.2.2"))).toBe(false);   // not a /24
    expect(firewallRuleMatches(rule("0.0.0.0/0"), icmpV4("203.0.113.9", "2.2.2.2"))).toBe(true);
    expect(firewallRuleMatches(rule("255.255.255.0/24"), icmpV4("255.255.255.200", "2.2.2.2"))).toBe(true);
  });

  it("reads the length as iptables does, and never matches an unparseable pattern", () => {
    expect(firewallRuleMatches(rule("10.0.0.0/8abc"), icmpV4("10.9.9.9", "2.2.2.2"))).toBe(true);   // parseInt reads 8
    for (const bad of ["10.0.0.0/33", "10.0.0.0/", "10.0.0.0/-1", "10.0.0.256/8", "010.0.0.1", "bogus"]) {
      expect(firewallRuleMatches(rule(bad), icmpV4("10.0.0.1", "2.2.2.2"))).toBe(false);
    }
  });

  it("a frame with an invalid address matches no address rule", () => {
    expect(firewallRuleMatches(rule("0.0.0.0/0"), icmpV4("1.2.3", "2.2.2.2"))).toBe(false);
    expect(firewallRuleMatches({ chain: "forward", target: "drop", dst: "0.0.0.0/0" }, icmpV4("1.1.1.1", ""))).toBe(false);
  });

  it("evaluates only the asked-for chain, in rule order, without touching the rules", () => {
    const fw: any = { config: { rules: [
      { chain: "input", target: "accept", src: "10.0.0.0/8" },
      { chain: "forward", target: "reject", src: "10.1.0.0/16" },
      { chain: "forward", target: "accept", src: "10.0.0.0/8" },
    ], policy: { forward: "drop", input: "drop" } } };
    const before = JSON.stringify(fw.config);
    expect(evaluateFirewall(fw, icmpV4("10.1.2.3", "2.2.2.2"), "forward")).toBe("reject");
    expect(evaluateFirewall(fw, icmpV4("10.2.2.3", "2.2.2.2"), "forward")).toBe("accept");
    expect(evaluateFirewall(fw, icmpV4("10.1.2.3", "2.2.2.2"), "input")).toBe("accept");
    expect(evaluateFirewall(fw, icmpV4("192.0.2.1", "2.2.2.2"), "input")).toBe("drop");
    expect(JSON.stringify(fw.config)).toBe(before);   // no parse cached on (and serialised with) the rule
  });
});

describe("firewall — iptables CLI", () => {
  beforeEach(() => resetState());
  function loadFw() {
    runConsoleScript("add firewall FW1 at 0 0");
    const fw = state.devices.find(d => d.name === "FW1")!;
    state.terminal.deviceId = fw.id;
    return fw;
  }

  it("-A appends, -P sets policy, -D deletes, -F flushes", () => {
    const fw = loadFw();
    runFirewallTerminalCommand(fw, "iptables -A FORWARD -p icmp -s 10.0.0.0/8 -j DROP");
    expect(fw.config.rules!).toHaveLength(1);
    expect(fw.config.rules![0]).toMatchObject({ target: "drop", protocol: "icmp", src: "10.0.0.0/8" });
    runFirewallTerminalCommand(fw, "iptables -P FORWARD DROP");
    expect(fw.config.policy!.forward).toBe("drop");
    runFirewallTerminalCommand(fw, "iptables -D FORWARD 1");
    expect(fw.config.rules!).toHaveLength(0);
    runFirewallTerminalCommand(fw, "iptables -A FORWARD -j ACCEPT");
    runFirewallTerminalCommand(fw, "iptables -F");
    expect(fw.config.rules!).toHaveLength(0);
  });

  it("-I inserts at a position", () => {
    const fw = loadFw();
    runFirewallTerminalCommand(fw, "iptables -A FORWARD -p icmp -j DROP");
    runFirewallTerminalCommand(fw, "iptables -I FORWARD 1 -s 192.168.1.10 -j ACCEPT");
    expect(fw.config.rules![0]).toMatchObject({ target: "accept", src: "192.168.1.10" });
    expect(fw.config.rules![1]).toMatchObject({ target: "drop", protocol: "icmp" });
  });

  it("rejects a non-FORWARD chain and reports unknown ops", () => {
    const fw = loadFw();
    runFirewallTerminalCommand(fw, "iptables -A INPUT -j DROP");
    expect(state.terminal.lines.some(l => l.kind === "error")).toBe(true);
    expect(fw.config.rules ?? []).toHaveLength(0);
  });

  it("rejects a non-numeric --dport instead of storing a NaN rule that never matches", () => {
    const fw = loadFw();
    runFirewallTerminalCommand(fw, "iptables -A FORWARD -p tcp --dport 80x -j DROP");
    expect(state.terminal.lines.some(l => l.kind === "error")).toBe(true);
    expect(fw.config.rules ?? []).toHaveLength(0);
  });

  it("accepts a valid numeric --dport", () => {
    const fw = loadFw();
    runFirewallTerminalCommand(fw, "iptables -A FORWARD -p tcp --dport 80 -j DROP");
    expect(fw.config.rules![0]).toMatchObject({ target: "drop", protocol: "tcp", dport: 80 });
  });

  it("rejects --dport without -p tcp (the rule would never match)", () => {
    const fw = loadFw();
    runFirewallTerminalCommand(fw, "iptables -A FORWARD -p udp --dport 53 -j DROP");
    expect(state.terminal.lines.some(l => l.kind === "error")).toBe(true);
    expect(fw.config.rules ?? []).toHaveLength(0);
  });
});

describe("firewall — packet filtering in the simulation", () => {
  beforeEach(() => resetState());

  function buildInlineFirewall() {
    runConsoleScript(`
      add computer PC1 at 0 0
      add firewall FW1 at 100 0
      add switch SW1 at 200 0
      add computer PC2 at 300 0
      link PC1 FW1
      link FW1 SW1
      link SW1 PC2
      ip PC1 192.168.1.10/24
      ip PC2 192.168.1.20/24
    `);
    return state.devices.find(d => d.name === "PC1")!;
  }

  it("forwards ARP through (transparent bridge)", () => {
    buildInlineFirewall();
    const fw = state.devices.find(d => d.name === "FW1")!;
    const arp = createArpRequest("02:00:00:00:01:10", "192.168.1.10", "192.168.1.20");
    const out = processAtFirewall(fw, arp, state.devices.find(d => d.name === "PC1")!.id);
    expect(out).toHaveLength(1);
    expect(out[0].toDeviceId).toBe(state.devices.find(d => d.name === "SW1")!.id);
  });

  it("learns MACs and forwards a known unicast to one leg, not every leg (R93)", () => {
    runConsoleScript(`
      add firewall FW1 at 0 0
      add computer PC1 at -100 0
      add computer PC2 at 0 -100
      add computer PC3 at 100 0
      ip PC1 192.168.1.10/24
      ip PC2 192.168.1.20/24
      ip PC3 192.168.1.30/24
      link PC1 FW1
      link PC2 FW1
      link PC3 FW1
    `);
    const fw = state.devices.find(d => d.name === "FW1")!;
    const pc1 = state.devices.find(d => d.name === "PC1")!;
    const pc2 = state.devices.find(d => d.name === "PC2")!;
    const pc3 = state.devices.find(d => d.name === "PC3")!;
    const mac = (d: any) => d.config.macAddress as string;
    expect(mac(pc1) && mac(pc2) && mac(pc3)).toBeTruthy();
    // PC2 speaks first → the firewall learns PC2's MAC on PC2's leg.
    processAtFirewall(fw, createArpRequest(mac(pc2), "192.168.1.20", "192.168.1.10"), pc2.id);
    // A unicast from PC1 to PC2's MAC now reaches only PC2, not PC3.
    const unicast = createIcmpEchoRequest(mac(pc1), mac(pc2), "192.168.1.10", "192.168.1.20", 64);
    expect(processAtFirewall(fw, unicast, pc1.id).map(o => o.toDeviceId)).toEqual([pc2.id]);
    // A broadcast (or an unknown unicast) still floods to every leg except ingress.
    const flood = processAtFirewall(fw, createArpRequest(mac(pc1), "192.168.1.10", "192.168.1.30"), pc1.id);
    expect(new Set(flood.map(o => o.toDeviceId))).toEqual(new Set([pc2.id, pc3.id]));
  });

  it("a DROP rule stops a ping through the firewall", () => {
    const pc1 = buildInlineFirewall();
    const ok = buildPingEvents(pc1, "192.168.1.20");
    expect(runSimulationHeadless(ok as any, pc1.id, "192.168.1.20", "ping").success).toBe(true);

    exec("cli FW1 iptables -A FORWARD -p icmp -j DROP");
    const blocked = buildPingEvents(pc1, "192.168.1.20");
    const result = runSimulationHeadless(blocked as any, pc1.id, "192.168.1.20", "ping");
    expect(result.success).toBe(false);
    expect(result.log.some(l => /Firewall DROP/i.test(l.summary))).toBe(true);
  });

  it("a default DROP policy with a per-source ACCEPT exception lets that host through", () => {
    const pc1 = buildInlineFirewall();
    exec("cli FW1 iptables -P FORWARD DROP");
    expect(runSimulationHeadless(buildPingEvents(pc1, "192.168.1.20") as any, pc1.id, "192.168.1.20", "ping").success).toBe(false);
    exec("cli FW1 iptables -A FORWARD -s 192.168.1.10 -j ACCEPT");
    exec("cli FW1 iptables -A FORWARD -d 192.168.1.10 -j ACCEPT");
    expect(runSimulationHeadless(buildPingEvents(pc1, "192.168.1.20") as any, pc1.id, "192.168.1.20", "ping").success).toBe(true);
  });
});

describe("ruleToIptables round-trips through the iptables parser", () => {
  beforeAll(() => _noopFw());
  beforeEach(() => _resetFw());
  it("every field survives format → parse", () => {
    const rules: any[] = [
      { chain: "forward", target: "accept", protocol: "icmp", icmpType: "echo-request" },
      { chain: "forward", target: "drop", protocol: "tcp", src: "10.0.0.0/24", dst: "192.168.1.5", dport: 443 },
      { chain: "forward", target: "accept", protocol: "all", states: ["established", "related"] },
      { chain: "forward", target: "reject", protocol: "tcp", dport: 22, rejectWith: "tcp-reset" },
    ];
    const fw = _addFw("firewall", 0, 0);
    fw.config!.rules = [];
    for (const r of rules) expect(_runIpt(fw, _fmt(r), ["forward"])).toBe(true);
    expect(fw.config!.rules!).toHaveLength(rules.length);
    // `protocol: "all"` is the documented default and is left unset by the
    // parser (the formatter omits `-p all`), so compare without that key.
    rules.forEach((r: any, i: number) => {
      const { protocol, ...rest } = r;
      expect(fw.config!.rules![i]).toMatchObject(protocol === "all" ? rest : r);
    });
  });
});

describe("iptables validates what it stores (G3-01)", () => {
  beforeAll(() => _noopFw());
  beforeEach(() => _resetFw());
  const fw = () => { const f = _addFw("firewall", 0, 0); f.config!.rules = []; return f; };
  const out = () => JSON.stringify(_state2.terminal.lines.map((l: any) => l.text));
  it("rejects a non-address -s/-d, port 0, and --icmp-type without -p icmp", () => {
    const f = fw();
    _runIpt(f, "iptables -A FORWARD -s bogus.host -j DROP", ["forward"]);
    _runIpt(f, "iptables -A FORWARD -p tcp --dport 0 -j DROP", ["forward"]);
    _runIpt(f, "iptables -A FORWARD --icmp-type echo-request -j DROP", ["forward"]);
    expect(f.config!.rules).toEqual([]);                          // nothing stored (each used to be "Appended")
    expect(out()).toContain("not found");
    expect(out()).toContain("1-65535");
    expect(out()).toContain("requires -p icmp");
  });
  it("accepts an address, a CIDR, and a real port", () => {
    const f = fw();
    expect(_runIpt(f, "iptables -A FORWARD -s 10.0.0.0/24 -d 192.168.1.5 -p tcp --dport 443 -j DROP", ["forward"])).toBe(true);
    expect(f.config!.rules).toHaveLength(1);
  });
  it("canonicalises --icmp-type and rejects one that can never match (R21)", () => {
    const f = fw();
    // Numeric 8 is stored as its canonical name, so the tutorial rule that used
    // to be accepted-but-inert now actually matches echo requests.
    expect(_runIpt(f, "iptables -A FORWARD -p icmp --icmp-type 8 -j DROP", ["forward"])).toBe(true);
    expect(f.config!.rules![0].icmpType).toBe("echo-request");
    // Named, type-3 and the 'any' wildcard are all accepted.
    expect(_runIpt(f, "iptables -A FORWARD -p icmp --icmp-type destination-unreachable -j DROP", ["forward"])).toBe(true);
    expect(_runIpt(f, "iptables -A FORWARD -p icmp --icmp-type any -j DROP", ["forward"])).toBe(true);
    expect(f.config!.rules).toHaveLength(3);
    // A type the model can never carry is refused, not silently stored.
    _runIpt(f, "iptables -A FORWARD -p icmp --icmp-type 5 -j DROP", ["forward"]);
    _runIpt(f, "iptables -A FORWARD -p icmp --icmp-type nonsense -j DROP", ["forward"]);
    expect(f.config!.rules).toHaveLength(3);                     // neither was stored
    expect(out()).toContain("unknown ICMP type");
  });
});

describe("iptables -L does not write (G3-02)", () => {
  beforeAll(() => _noopFw());
  beforeEach(() => _resetFw());
  it("listing leaves no policy/rules keys behind; a -P materialises only the policy", () => {
    const f = _addFw("firewall", 0, 0);
    delete (f.config as any).policy; delete (f.config as any).rules;
    _runIpt(f, "iptables -L", ["forward"]);
    expect((f.config as any).policy).toBeUndefined();
    expect((f.config as any).rules).toBeUndefined();
    _runIpt(f, "iptables -P FORWARD DROP", ["forward"]);
    expect((f.config as any).policy).toEqual({ forward: "drop" });
    expect((f.config as any).rules).toBeUndefined();
  });
});
