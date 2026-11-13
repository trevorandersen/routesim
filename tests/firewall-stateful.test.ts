/**
 * Stateful firewall — netfilter connection tracking (`-m state` / `--ctstate`)
 * and the REJECT target (a TCP RST / ICMP unreachable, not a silent drop).
 * Builds an inline firewall (PC1 — FW1 — SW1 — PC2) and drives flows headlessly.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { runSimulationHeadless, connectionState, runTraceroute } from "../src/engine";
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

// R20: an ICMP error (Time-Exceeded / Dest-Unreachable) is sourced by an
// intermediate router, so a stateful default-drop firewall read it as NEW and
// dropped it — traceroute showed `* * *` past the firewall. It must be RELATED
// to the flow its quoted datagram belongs to.

describe("stateful firewall lets ICMP errors back as RELATED (R20)", () => {
  beforeEach(() => resetState());

  it("connectionState classifies an ICMP error quoting a tracked flow as related", () => {
    const pc1 = buildInlineFirewall();
    exec("cli FW1 iptables -A FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT");
    exec("cli FW1 iptables -A FORWARD -s 192.168.1.10 -j ACCEPT");
    ping(pc1, "192.168.1.20");   // tracks the icmp flow PC1 → PC2 at FW1

    const errorIpv4: any = {
      type: "ipv4", srcIp: "192.168.1.99", dstIp: "192.168.1.10", ttl: 64, protocol: 1,
      payload: { type: "icmp", icmpType: 11, sequence: 1,
        original: { proto: "icmp", srcIp: "192.168.1.10", dstIp: "192.168.1.20", flowId: 1 } },
    };
    expect(connectionState(dev("FW1"), errorIpv4)).toBe("related");

    // An error quoting an UNTRACKED flow stays new.
    const unrelated = { ...errorIpv4, payload: { ...errorIpv4.payload, original: { proto: "icmp", srcIp: "10.9.9.9", dstIp: "10.8.8.8", flowId: 1 } } };
    expect(connectionState(dev("FW1"), unrelated)).toBe("new");
  });

  it("traceroute past a stateful default-drop firewall still sees the hop", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      add firewall FW1 at 100 0
      add router R1 at 200 0
      add switch SW2 at 300 0
      add computer PC2 at 400 0
      link PC1 FW1
      link FW1 R1
      link R1 SW2
      link SW2 PC2
      ip PC1 10.0.0.10/24
      gateway PC1 10.0.0.1
      ip PC2 10.0.1.10/24
      gateway PC2 10.0.1.1
      interface R1 FW1 ip 10.0.0.1/24
      interface R1 SW2 ip 10.0.1.1/24
      cli FW1 iptables -P FORWARD DROP
      cli FW1 iptables -A FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT
      cli FW1 iptables -A FORWARD -s 10.0.0.10 -j ACCEPT
    `);
    const pc1 = dev("PC1");
    const res = runTraceroute(pc1, "10.0.1.10");
    expect(typeof res).toBe("object");
    const r = res as any;
    expect(r.reached).toBe(true);
    // R1 (the Time-Exceeded responder) shows up — not a vanished `*` hop.
    expect(r.hops.some((h: any) => h.ip === "10.0.0.1")).toBe(true);
  });
});
