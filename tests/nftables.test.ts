/**
 * nftables front door (GitHub issue #1). nft is a second parser + printer over
 * the one netfilter rule model the iptables shell already drives, so a rule
 * written in either language yields the same FirewallRule and the two native
 * views can never disagree.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { addDevice } from "../src/devices";
import { runNftCommand, ruleToNft, showNftRuleset } from "../src/terminal/nftables";
import { runIptablesCommand, ruleToIptables } from "../src/terminal/iptables";
import { runFirewallTerminalCommand, runRouterTerminalCommand } from "../src/terminal";
import type { FirewallRule } from "../src/types";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());
beforeEach(() => resetState());

const FW = ["forward"];
const ROUTER = ["input", "forward"];

function firewall() { return addDevice("firewall", 0, 0); }
function rules(d: any): FirewallRule[] { return d.config.rules || []; }
const lastError = () => [...state.terminal.lines].reverse().find(l => l.kind === "error")?.text;

describe("nft parses into the shared rule model", () => {
  it("add rule: tcp dport → protocol tcp + dport", () => {
    const fw = firewall();
    expect(runNftCommand(fw, "nft add rule inet filter forward tcp dport 22 accept", FW)).toBe(true);
    expect(rules(fw)).toEqual([{ chain: "forward", target: "accept", protocol: "tcp", dport: 22 }]);
  });

  it("every modelled match clause", () => {
    const fw = firewall();
    runNftCommand(fw, "nft add rule inet filter forward ip saddr 10.0.0.5 ip daddr 10.0.0.9 accept", FW);
    runNftCommand(fw, "nft add rule inet filter forward ip protocol icmp drop", FW);
    runNftCommand(fw, "nft add rule inet filter forward icmp type echo-request drop", FW);
    runNftCommand(fw, "nft add rule inet filter forward ct state established,related accept", FW);
    runNftCommand(fw, "nft add rule inet filter forward tcp dport 23 reject with tcp reset", FW);
    expect(rules(fw)).toEqual([
      { chain: "forward", target: "accept", src: "10.0.0.5", dst: "10.0.0.9" },
      { chain: "forward", target: "drop", protocol: "icmp" },
      { chain: "forward", target: "drop", protocol: "icmp", icmpType: "echo-request" },
      { chain: "forward", target: "accept", states: ["established", "related"] },
      { chain: "forward", target: "reject", protocol: "tcp", dport: 23, rejectWith: "tcp-reset" },
    ]);
  });

  it("a verdict is required, and the shared field checks still bite", () => {
    const fw = firewall();
    expect(runNftCommand(fw, "nft add rule inet filter forward tcp dport 22", FW)).toBe(true);
    expect(lastError()).toContain("verdict");
    runNftCommand(fw, "nft add rule inet filter forward udp dport 53 accept", FW);
    expect(lastError()).toContain("--dport requires -p tcp");   // model only matches tcp dport
    runNftCommand(fw, "nft add rule inet filter forward ip saddr nonsense accept", FW);
    expect(lastError()).toContain("not found");
    expect(rules(fw)).toEqual([]);
  });

  it("rejects a chain the device does not have", () => {
    const fw = firewall();
    runNftCommand(fw, "nft add rule inet filter input tcp dport 22 accept", FW);  // firewall has no INPUT
    expect(lastError()).toContain("chain must be forward");
    expect(rules(fw)).toEqual([]);
  });
});

describe("nft and iptables are one model", () => {
  it("the same logical rule parses identically from either language", () => {
    const a = firewall();
    const b = firewall();
    runNftCommand(a, "nft add rule inet filter forward ip saddr 10.0.0.5 tcp dport 22 ct state new accept", FW);
    runIptablesCommand(b, "iptables -A FORWARD -s 10.0.0.5 -p tcp --dport 22 -m state --state NEW -j ACCEPT", FW);
    expect(rules(a)).toEqual(rules(b));
  });

  it("a ruleset written with nft reads back under iptables and vice versa", () => {
    const fw = firewall();
    runNftCommand(fw, "nft add rule inet filter forward tcp dport 80 accept", FW);
    runNftCommand(fw, "nft add rule inet filter forward ip protocol icmp drop", FW);
    // Each rule's iptables rendering re-parses to the same rule.
    for (const r of rules(fw)) {
      const probe = firewall();
      runIptablesCommand(probe, ruleToIptables(r), FW);
      expect(rules(probe)).toEqual([r]);
    }
    // And each rule's nft rendering re-parses to the same rule.
    for (const r of rules(fw)) {
      const probe = firewall();
      runNftCommand(probe, `nft add rule inet filter forward ${ruleToNft(r)}`, FW);
      expect(rules(probe)).toEqual([r]);
    }
  });
});

describe("nft list ruleset", () => {
  it("prints the table, chain, policy and statements", () => {
    const fw = firewall();
    runNftCommand(fw, "nft add chain inet filter forward { policy drop ; }", FW);
    runNftCommand(fw, "nft add rule inet filter forward ct state established,related accept", FW);
    runNftCommand(fw, "nft add rule inet filter forward tcp dport 22 reject with icmp type port-unreachable", FW);
    const out = showNftRuleset(fw, FW);
    expect(out).toContain("table inet filter {");
    expect(out).toContain("chain forward {");
    expect(out).toContain("type filter hook forward priority 0; policy drop;");
    expect(out).toContain("ct state established,related accept");
    expect(out).toContain("tcp dport 22 reject with icmp type port-unreachable");
  });

  it("a router shows both chains", () => {
    const r = addDevice("router", 0, 0);
    runNftCommand(r, "nft add rule inet filter input ip protocol icmp drop", ROUTER);
    runNftCommand(r, "nft add rule inet filter forward tcp dport 22 accept", ROUTER);
    const out = showNftRuleset(r, ROUTER);
    expect(out).toContain("chain input {");
    expect(out).toContain("chain forward {");
    expect(out).toContain("ip protocol icmp drop");
  });
});

describe("nft policy, insert, delete, flush", () => {
  it("add chain … { policy drop ; } sets the policy both views read", () => {
    const fw = firewall();
    runNftCommand(fw, "nft add chain inet filter forward { policy drop ; }", FW);
    expect(fw.config!.policy!.forward).toBe("drop");
    expect(showNftRuleset(fw, FW)).toContain("policy drop;");
  });

  it("insert index places a rule ahead of another", () => {
    const fw = firewall();
    runNftCommand(fw, "nft add rule inet filter forward tcp dport 22 accept", FW);
    runNftCommand(fw, "nft insert rule inet filter forward index 1 tcp dport 80 drop", FW);
    expect(rules(fw).map(r => [r.dport, r.target])).toEqual([[80, "drop"], [22, "accept"]]);
  });

  it("delete rule … handle N removes the Nth rule (1-based)", () => {
    const fw = firewall();
    runNftCommand(fw, "nft add rule inet filter forward tcp dport 22 accept", FW);
    runNftCommand(fw, "nft add rule inet filter forward tcp dport 80 drop", FW);
    runNftCommand(fw, "nft delete rule inet filter forward handle 1", FW);
    expect(rules(fw).map(r => r.dport)).toEqual([80]);
  });

  it("flush chain and flush ruleset clear rules", () => {
    const fw = firewall();
    runNftCommand(fw, "nft add rule inet filter forward tcp dport 22 accept", FW);
    runNftCommand(fw, "nft flush chain inet filter forward", FW);
    expect(rules(fw)).toEqual([]);
    runNftCommand(fw, "nft add rule inet filter forward tcp dport 22 accept", FW);
    runNftCommand(fw, "nft flush ruleset", FW);
    expect(rules(fw)).toEqual([]);
  });
});

describe("runNftCommand only claims nft lines", () => {
  it("returns false for a non-nft command", () => {
    const fw = firewall();
    expect(runNftCommand(fw, "iptables -L", FW)).toBe(false);
    expect(runNftCommand(fw, "show", FW)).toBe(false);
  });
});

describe("the shells accept nft alongside iptables", () => {
  it("the firewall terminal routes an nft rule and lists it", () => {
    const fw = firewall();
    runFirewallTerminalCommand(fw, "nft add rule inet filter forward tcp dport 22 accept");
    expect(rules(fw)).toEqual([{ chain: "forward", target: "accept", protocol: "tcp", dport: 22 }]);
    runFirewallTerminalCommand(fw, "nft list ruleset");
    expect(state.terminal.lines.some(l => l.text.includes("table inet filter {"))).toBe(true);
    // iptables still works on the same device/ruleset.
    runFirewallTerminalCommand(fw, "iptables -A FORWARD -p icmp -j DROP");
    expect(rules(fw).length).toBe(2);
  });

  it("the router terminal routes nft on INPUT and FORWARD in privileged mode", () => {
    const r = addDevice("router", 0, 0);
    runRouterTerminalCommand(r, "enable");
    runRouterTerminalCommand(r, "nft add rule inet filter input ip protocol icmp drop");
    runRouterTerminalCommand(r, "nft add rule inet filter forward tcp dport 22 accept");
    expect(rules(r).map(x => [x.chain, x.target])).toEqual([["input", "drop"], ["forward", "accept"]]);
  });

  it("the router refuses nft outside privileged/config mode", () => {
    const r = addDevice("router", 0, 0);
    runRouterTerminalCommand(r, "nft list ruleset");   // exec mode
    expect(lastError()).toContain("Privileged mode required");
    expect(rules(r)).toEqual([]);
  });
});
