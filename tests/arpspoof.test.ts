/**
 * Targeted and reverse ARP spoofing (GitHub issue #5). `-t <victim>` unicasts
 * the poison to one victim (not the whole segment); `-r` adds the mirror reply
 * that poisons the gateway's entry for the victim, so return traffic crosses the
 * attacker too (pairs with net.ipv4.ip_forward, issue #4).
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { runConsoleScript } from "../src/commands";
import { buildArpSpoofEvents, macForIp, buildPingEvents } from "../src/simulation";
import { runSimulationHeadless } from "../src/engine";
import { runAttackerTerminalCommand } from "../src/terminal";
import { BROADCAST_MAC } from "../src/frame";
import { registerNoopCallbacks, resetState } from "./helpers";

let raf: any, caf: any;
beforeAll(() => {
  registerNoopCallbacks();
  raf = (globalThis as any).requestAnimationFrame;
  caf = (globalThis as any).cancelAnimationFrame;
  (globalThis as any).requestAnimationFrame = () => 0;   // no-op: don't recurse the sync stub
  (globalThis as any).cancelAnimationFrame = () => {};
});
beforeEach(() => resetState());

const dev = (name: string) => state.devices.find(d => d.name === name)!;
const arp = (name: string, ip: string) =>
  dev(name).config!.arpTable!.find((e: any) => e.ipv4Address === ip)?.macAddress;

// A flat segment: attacker + victim + gateway (router), all on 10.0.0.0/24.
function segment() {
  runConsoleScript(`
    add kali KALI at 100 100
    add computer VICTIM at 100 250
    add computer BYSTANDER at 100 400
    add switch SW at 300 250
    add router RTR at 500 250
    link KALI SW
    link VICTIM SW
    link BYSTANDER SW
    link SW RTR
    ip KALI 10.0.0.5/24
    ip VICTIM 10.0.0.9/24
    ip BYSTANDER 10.0.0.8/24
    gateway KALI 10.0.0.1
    gateway VICTIM 10.0.0.1
    interface RTR SW ip 10.0.0.1/24
  `);
}

describe("macForIp resolves a host NIC or a router interface", () => {
  it("finds both kinds, and nothing for an unused address", () => {
    segment();
    expect(macForIp("10.0.0.9")).toBe(dev("VICTIM").config!.macAddress!);
    expect(macForIp("10.0.0.1")).toBe((dev("RTR").config!.interfaces as any)[0].macAddress);
    expect(macForIp("10.0.0.254")).toBeNull();
  });
});

describe("buildArpSpoofEvents — targeting", () => {
  it("no -t: one broadcast reply claiming the gateway", () => {
    segment();
    const r: any = buildArpSpoofEvents(dev("KALI"), "10.0.0.1");
    expect(r.events).toHaveLength(1);
    const f = r.events[0].frame;
    expect(f.dstMac).toBe(BROADCAST_MAC);
    expect(f.payload.senderIp).toBe("10.0.0.1");
    expect(f.payload.senderMac).toBe(dev("KALI").config!.macAddress);
  });

  it("-t <victim>: one reply unicast to the victim only", () => {
    segment();
    const r: any = buildArpSpoofEvents(dev("KALI"), "10.0.0.1", { victim: "VICTIM" });
    expect(r.events).toHaveLength(1);
    const f = r.events[0].frame;
    expect(f.dstMac).toBe(dev("VICTIM").config!.macAddress);   // not broadcast
    expect(f.payload.senderIp).toBe("10.0.0.1");               // "the gateway is at us"
    expect(f.payload.targetIp).toBe("10.0.0.9");
  });

  it("-r: a second reply poisons the gateway for the victim", () => {
    segment();
    const r: any = buildArpSpoofEvents(dev("KALI"), "10.0.0.1", { victim: "VICTIM", reverse: true });
    expect(r.events).toHaveLength(2);
    const toGw = r.events[1].frame;
    expect(toGw.dstMac).toBe(macForIp("10.0.0.1"));            // to the router interface
    expect(toGw.payload.senderIp).toBe("10.0.0.9");            // "the victim is at us"
    expect(toGw.payload.senderMac).toBe(dev("KALI").config!.macAddress);
  });

  it("resolves a victim given by IP; a name on no device is rejected", () => {
    segment();
    const byIp: any = buildArpSpoofEvents(dev("KALI"), "10.0.0.1", { victim: "10.0.0.9" });
    expect(byIp.events[0].frame.dstMac).toBe(dev("VICTIM").config!.macAddress);
    // A name that is no device fails; a bare unassigned IP falls back to broadcast.
    expect(buildArpSpoofEvents(dev("KALI"), "10.0.0.1", { victim: "ghost" })).toContain("not a host or IP");
    const byUnknownIp: any = buildArpSpoofEvents(dev("KALI"), "10.0.0.1", { victim: "10.0.0.254" });
    expect(byUnknownIp.events[0].frame.dstMac).toBe(BROADCAST_MAC);
  });
});

describe("the poison lands in the right caches (headless run)", () => {
  function warmSwitch() {
    // A ping from each host so SW learns their MACs and the unicast poison is
    // delivered to the one victim rather than flooded.
    runSimulationHeadless(buildPingEvents(dev("VICTIM"), "10.0.0.1") as any, dev("VICTIM").id, "10.0.0.1", "ping");
    runSimulationHeadless(buildPingEvents(dev("BYSTANDER"), "10.0.0.1") as any, dev("BYSTANDER").id, "10.0.0.1", "ping");
    runSimulationHeadless(buildPingEvents(dev("KALI"), "10.0.0.9") as any, dev("KALI").id, "10.0.0.9", "ping");
  }

  it("-t poisons the victim, not a bystander", () => {
    segment();
    warmSwitch();
    const setup = buildArpSpoofEvents(dev("KALI"), "10.0.0.1", { victim: "VICTIM" });
    runSimulationHeadless(setup as any, dev("KALI").id, "", "attack");
    expect(arp("VICTIM", "10.0.0.1")).toBe(dev("KALI").config!.macAddress);   // victim fooled
    expect(arp("BYSTANDER", "10.0.0.1")).not.toBe(dev("KALI").config!.macAddress);  // bystander untouched
    // R48: only the poisoned victim is tallied for the report.
    expect(state.simulation.arpPoisoned).toContain("VICTIM");
    expect(state.simulation.arpPoisoned).not.toContain("BYSTANDER");
  });

  it("-r also poisons the gateway's entry for the victim", () => {
    segment();
    warmSwitch();
    const setup = buildArpSpoofEvents(dev("KALI"), "10.0.0.1", { victim: "VICTIM", reverse: true });
    runSimulationHeadless(setup as any, dev("KALI").id, "", "attack");
    const rtrIface: any = (dev("RTR").config!.interfaces as any)[0];
    const learned = (rtrIface.arpTable || []).find((e: any) => e.ipv4Address === "10.0.0.9")?.macAddress;
    expect(learned).toBe(dev("KALI").config!.macAddress);
    // R48: the reverse poison lands on the router (exercises the router ARP path).
    expect(state.simulation.arpPoisoned).toContain("RTR");
  });
});

describe("the arpspoof shell parses the flags", () => {
  it("flags in any order; -r needs a victim", () => {
    segment();
    runAttackerTerminalCommand(dev("KALI"), "arpspoof -r 10.0.0.1");
    expect(state.terminal.lines.at(-1)!.text).toContain("-r (reverse) needs a victim");

    runAttackerTerminalCommand(dev("KALI"), "arpspoof");
    expect(state.terminal.lines.at(-1)!.text).toContain("usage");

    // A well-formed targeted spoof launches (no error line).
    state.terminal.lines = [];
    runAttackerTerminalCommand(dev("KALI"), "arpspoof -r -t VICTIM 10.0.0.1");
    expect(state.terminal.lines.some(l => l.kind === "error")).toBe(false);
  });
});

// ── -r + ip_forward: a full bidirectional MITM. Both the victim's request and
// the reply cross the attacker, and the ping still succeeds. ──────────────────
describe("reverse spoof + forwarding = two-way interception", () => {
  function routed() {
    runConsoleScript(`
      add computer PC-A at 100 100
      add kali KALI at 100 250
      add switch SW at 300 150
      add router RTR at 500 150
      add switch SW2 at 700 150
      add computer PC-B at 900 150
      link PC-A SW
      link KALI SW
      link SW RTR
      link RTR SW2
      link SW2 PC-B
      ip PC-A 10.0.0.9/24
      ip KALI 10.0.0.5/24
      ip PC-B 10.0.1.9/24
      gateway PC-A 10.0.0.1
      gateway KALI 10.0.0.1
      gateway PC-B 10.0.1.1
      interface RTR SW ip 10.0.0.1/24
      interface RTR SW2 ip 10.0.1.1/24
    `);
    // Warm honest caches so the attacker knows the real gateway MAC and the
    // switches have learnt the hosts.
    runSimulationHeadless(buildPingEvents(dev("PC-A"), "10.0.1.9") as any, dev("PC-A").id, "10.0.1.9", "ping");
    runSimulationHeadless(buildPingEvents(dev("KALI"), "10.0.1.9") as any, dev("KALI").id, "10.0.1.9", "ping");
  }

  it("the reply comes back through the attacker, and the ping succeeds", () => {
    routed();
    // Poison both directions: PC-A's gateway, and the gateway's entry for PC-A.
    runSimulationHeadless(buildArpSpoofEvents(dev("KALI"), "10.0.0.1", { victim: "PC-A", reverse: true }) as any, dev("KALI").id, "", "attack");
    dev("KALI").config!.ipForward = true;

    const r = runSimulationHeadless(buildPingEvents(dev("PC-A"), "10.0.1.9") as any, dev("PC-A").id, "10.0.1.9", "ping");
    expect(r.success).toBe(true);
    // The attacker forwarded in BOTH directions: the request onward to the remote
    // destination, and the reply back to the victim (the reply reaches it because
    // the reverse poison redirected the gateway's return traffic to the attacker).
    const kaliFwd = r.log.filter(l => l.deviceName === "KALI" && l.summary?.includes("ip_forward:"));
    expect(kaliFwd.some(l => l.summary.includes("10.0.1.9"))).toBe(true);   // request relayed onward
    expect(kaliFwd.some(l => l.summary.includes("10.0.0.9"))).toBe(true);   // reply relayed back to the victim
    // And the gateway's ARP for PC-A points at the attacker (reverse poison held).
    const rtrIface: any = (dev("RTR").config!.interfaces as any)[0];
    expect((rtrIface.arpTable || []).find((e: any) => e.ipv4Address === "10.0.0.9")?.macAddress).toBe(dev("KALI").config!.macAddress);
  });
});
