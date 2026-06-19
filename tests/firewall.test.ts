/**
 * Firewall device tests — rule matching, the iptables CLI, and packet filtering
 * in the simulation. The firewall is a transparent inline filter (FORWARD chain).
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { evaluateFirewall, firewallRuleMatches, processAtFirewall, runSimulationHeadless } from "../src/engine";
import { runFirewallTerminalCommand } from "../src/terminal";
import { buildPingEvents } from "../src/simulation";
import { createArpRequest } from "../src/frame";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

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
