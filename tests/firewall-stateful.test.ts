/**
 * Stateful firewall — netfilter connection tracking (`-m state` / `--ctstate`)
 * and the REJECT target (a TCP RST / ICMP unreachable, not a silent drop).
 * Builds an inline firewall (PC1 — FW1 — SW1 — PC2) and drives flows headlessly.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { runSimulationHeadless, connectionState } from "../src/engine";
import { buildPingEvents, buildConnectEvents } from "../src/simulation";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { buildConfigPayload } from "../src/config";
import { normaliseConfig } from "../src/normalise";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());

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
const dev = (n: string) => state.devices.find(d => d.name === n)!;
const ping = (from: any, to: string) => runSimulationHeadless(buildPingEvents(from, to) as any, from.id, to, "ping");
const connect = (from: any, to: string, port: number) => runSimulationHeadless(buildConnectEvents(from, to, port) as any, from.id, to, "tcp", port);

describe("stateful firewall — connection tracking", () => {
  beforeEach(() => resetState());

  it("an ESTABLISHED,RELATED rule lets the return traffic back without an explicit inbound rule", () => {
    const pc1 = buildInlineFirewall();
    exec("cli FW1 iptables -P FORWARD DROP");
    exec("cli FW1 iptables -A FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT");
    exec("cli FW1 iptables -A FORWARD -s 192.168.1.10 -j ACCEPT");   // PC1 may initiate (NEW)
    // The echo is NEW (allowed by the -s rule); the reply is ESTABLISHED (allowed
    // by the state rule) — no `-d 192.168.1.10` return rule is needed.
    expect(ping(pc1, "192.168.1.20").success).toBe(true);
  });

  it("without the ESTABLISHED rule, allowing only the outbound NEW is not enough — the reply is dropped", () => {
    const pc1 = buildInlineFirewall();
    exec("cli FW1 iptables -P FORWARD DROP");
    exec("cli FW1 iptables -A FORWARD -s 192.168.1.10 -j ACCEPT");   // out only, no state rule
    expect(ping(pc1, "192.168.1.20").success).toBe(false);           // the reply hits the default DROP
  });

  it("an outside-initiated NEW connection is blocked while the inside host can still reach out", () => {
    const pc1 = buildInlineFirewall();
    exec("cli FW1 iptables -P FORWARD DROP");
    exec("cli FW1 iptables -A FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT");
    exec("cli FW1 iptables -A FORWARD -s 192.168.1.10 -j ACCEPT");   // only PC1 initiates
    expect(ping(pc1, "192.168.1.20").success).toBe(true);            // inside → outside OK
    expect(ping(dev("PC2"), "192.168.1.10").success).toBe(false);    // outside → inside (NEW) blocked
  });

  it("classifies the echo as NEW and its reply as ESTABLISHED on the firewall", () => {
    const pc1 = buildInlineFirewall();
    exec("cli FW1 iptables -A FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT");  // a state rule activates conntrack
    const fw = dev("FW1");
    ping(pc1, "192.168.1.20");                                 // run it — tracks the echo flow
    const reply: any = { type: "ipv4", srcIp: "192.168.1.20", dstIp: "192.168.1.10", ttl: 64, protocol: 1, payload: { type: "icmp", icmpType: 0, sequence: 1 } };
    const fresh: any = { type: "ipv4", srcIp: "10.9.9.9", dstIp: "10.8.8.8", ttl: 64, protocol: 1, payload: { type: "icmp", icmpType: 8, sequence: 1 } };
    expect(connectionState(fw, reply)).toBe("established");    // the reply matches the swapped tuple
    expect(connectionState(fw, fresh)).toBe("new");            // an unrelated flow
  });
});

describe("stateful firewall — REJECT", () => {
  beforeEach(() => resetState());

  it("REJECT --reject-with tcp-reset sends a RST so a TCP connect is refused (not timed out)", () => {
    const pc1 = buildInlineFirewall();
    exec("cli FW1 iptables -A FORWARD -p tcp --dport 23 -j REJECT --reject-with tcp-reset");
    const r = connect(pc1, "192.168.1.20", 23);
    expect(r.success).toBe(false);
    expect(r.refused).toBe(true);     // a RST came back → "connection refused"
  });

  it("DROP times out instead — no response comes back", () => {
    const pc1 = buildInlineFirewall();
    exec("cli FW1 iptables -A FORWARD -p tcp --dport 24 -j DROP");
    const r = connect(pc1, "192.168.1.20", 24);
    expect(r.success).toBe(false);
    expect(r.refused).toBe(false);    // silently dropped → timeout, not refused
  });
});

describe("stateful firewall — persistence", () => {
  beforeEach(() => resetState());

  it("the state match and --reject-with round-trip through the JSON config", () => {
    buildInlineFirewall();
    exec("cli FW1 iptables -A FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT");
    exec("cli FW1 iptables -A FORWARD -p tcp --dport 23 -j REJECT --reject-with tcp-reset");
    const re = normaliseConfig(buildConfigPayload() as any).devices.find((d: any) => d.name === "FW1")!;
    expect(re.config.rules![0].states).toEqual(["established", "related"]);
    expect(re.config.rules![1].target).toBe("reject");
    expect(re.config.rules![1].rejectWith).toBe("tcp-reset");
  });
});
