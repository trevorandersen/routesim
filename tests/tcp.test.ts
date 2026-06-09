/**
 * L4 TCP traffic — the three-way handshake (SYN / SYN-ACK / ACK), the listener
 * model (openPorts), RST refusal, and firewall port filtering.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { runSimulationHeadless } from "../src/engine";
import { buildConnectEvents } from "../src/simulation";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());

function lanPair() {
  runConsoleScript(`
    add computer PC1 at 0 0
    add computer PC2 at 200 0
    add switch SW1 at 100 0
    link SW1 PC1
    link SW1 PC2
    ip PC1 192.168.1.10/24
    ip PC2 192.168.1.20/24
  `);
  return state.devices.find(d => d.name === "PC1")!;
}

describe("tcp — three-way handshake", () => {
  beforeEach(() => resetState());

  it("completes a same-subnet handshake (cold ARP)", () => {
    const pc1 = lanPair();
    const setup = buildConnectEvents(pc1, "192.168.1.20", 80);
    expect(typeof setup).not.toBe("string");
    const r = runSimulationHeadless(setup as any, pc1.id, "192.168.1.20", "tcp", 80);
    expect(r.success).toBe(true);
    expect(r.log.some(l => /SYN-ACK/.test(l.summary))).toBe(true);
    expect(r.log.some(l => /handshake complete/.test(l.summary))).toBe(true);
  });

  it("connects across a router", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      add router R1 at 100 0
      add computer PC2 at 200 0
      link PC1 R1
      link R1 PC2
      ip PC1 192.168.1.10/24
      ip PC2 192.168.2.10/24
      gateway PC1 192.168.1.1
      gateway PC2 192.168.2.1
      interface R1 PC1 ip 192.168.1.1
      interface R1 PC2 ip 192.168.2.1
    `);
    const r = exec("run connect PC1 PC2 443");
    expect(r.ok).toBe(true);
  });

  it("a closed port answers RST (connection refused)", () => {
    const pc1 = lanPair();
    const pc2 = state.devices.find(d => d.name === "PC2")!;
    pc2.config.openPorts = [22]; // listening on 22 only
    const refused = runSimulationHeadless(buildConnectEvents(pc1, "192.168.1.20", 80) as any, pc1.id, "192.168.1.20", "tcp", 80);
    expect(refused.success).toBe(false);
    expect(refused.refused).toBe(true);
    const open = runSimulationHeadless(buildConnectEvents(pc1, "192.168.1.20", 22) as any, pc1.id, "192.168.1.20", "tcp", 22);
    expect(open.success).toBe(true);
  });

  it("validates the port and target", () => {
    const pc1 = lanPair();
    expect(typeof buildConnectEvents(pc1, "192.168.1.20", 0)).toBe("string");
    expect(typeof buildConnectEvents(pc1, "no-such-host", 80)).toBe("string");
  });
});

describe("tcp — firewall port filtering", () => {
  beforeEach(() => resetState());

  function inlineFirewall() {
    runConsoleScript(`
      add computer PC1 at 0 0
      add firewall FW1 at 100 0
      add computer PC2 at 200 0
      link PC1 FW1
      link FW1 PC2
      ip PC1 192.168.1.10/24
      ip PC2 192.168.1.20/24
    `);
    return state.devices.find(d => d.name === "PC1")!;
  }

  it("-p tcp --dport blocks that port and only that port", () => {
    inlineFirewall();
    exec("cli FW1 iptables -A FORWARD -p tcp --dport 23 -j DROP");
    const telnet = exec("run connect PC1 PC2 23");
    expect(telnet.ok).toBe(false);
    expect((telnet.data as any).refused).toBe(false); // dropped, not refused
    const ssh = exec("run connect PC1 PC2 22");
    expect(ssh.ok).toBe(true);
    const ping = exec("run ping PC1 PC2"); // ICMP unaffected by the tcp rule
    expect(ping.ok).toBe(true);
  });

  it("-p tcp without --dport blocks all TCP but not ICMP", () => {
    inlineFirewall();
    exec("cli FW1 iptables -A FORWARD -p tcp -j DROP");
    expect(exec("run connect PC1 PC2 80").ok).toBe(false);
    expect(exec("run ping PC1 PC2").ok).toBe(true);
  });
});
