/**
 * IP forwarding on a host (GitHub issue #4). With net.ipv4.ip_forward on, a
 * host relays a frame unicast to its MAC but bound for another IP — the arpspoof
 * MITM that monitors traffic without breaking it — instead of dropping it as
 * "not for us". Off by default.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { addDevice } from "../src/devices";
import { processAtComputer } from "../src/engine";
import { runHostTerminalCommand } from "../src/terminal";
import { createIcmpEchoRequest } from "../src/frame";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());
beforeEach(() => resetState());

const KALI = "02:00:00:00:00:05";
const VICTIM = "02:00:00:00:00:09";
const GW = "02:00:00:00:00:01";
const DEST = "02:00:00:00:00:0a";

// A Kali host at 10.0.0.5/24, gateway 10.0.0.1, with its OWN (unpoisoned) ARP
// cache. The caller passes the entries it should hold.
function kali(arp: Array<{ ipv4Address: string; macAddress: string }> = []) {
  const k = addDevice("kali", 0, 0);
  k.config = { ...k.config, ipv4Address: "10.0.0.5", prefixLength: 24, gatewayIpv4Address: "10.0.0.1", macAddress: KALI, arpTable: arp } as any;
  return k;
}

// An intercepted ICMP echo: sent to the Kali MAC, but addressed to another IP
// (the victim had the gateway poisoned to point at Kali).
const intercepted = (dstIp: string, ttl = 64) =>
  createIcmpEchoRequest(VICTIM, KALI, "10.0.0.9", dstIp, ttl);

describe("a host with ip_forward off does not relay", () => {
  it("drops a frame for another IP (the black-hole an arpspoof is without forwarding)", () => {
    const k = kali([{ ipv4Address: "10.0.0.1", macAddress: GW }]);
    const out = processAtComputer(k, intercepted("8.8.8.8"), "sw");
    expect(out).toEqual([]);
  });
});

describe("a host with ip_forward on relays to the true next hop", () => {
  it("a remote destination goes to the gateway, src MAC rewritten, TTL decremented, IPs untouched", () => {
    const k = kali([{ ipv4Address: "10.0.0.1", macAddress: GW }]);
    k.config!.ipForward = true;
    const out = processAtComputer(k, intercepted("8.8.8.8", 64), "sw");
    expect(out).toHaveLength(1);
    const f = out[0].frame;
    expect(out[0].toDeviceId).toBe("sw");
    expect(f.srcMac).toBe(KALI);                 // relayed from us
    expect(f.dstMac).toBe(GW);                   // to the real gateway (our clean cache)
    const ip = f.payload as any;
    expect(ip.srcIp).toBe("10.0.0.9");           // the victim — unchanged (no NAT)
    expect(ip.dstIp).toBe("8.8.8.8");            // the true destination — unchanged
    expect(ip.ttl).toBe(63);                     // decremented, like a router
  });

  it("an on-subnet destination goes straight to that host", () => {
    const k = kali([{ ipv4Address: "10.0.0.20", macAddress: DEST }]);
    k.config!.ipForward = true;
    const out = processAtComputer(k, intercepted("10.0.0.20"), "sw");
    expect(out[0].frame.dstMac).toBe(DEST);
  });

  it("a cold next-hop MAC is ARP-resolved first, with the frame buffered", () => {
    const k = kali([]);   // no gateway MAC yet
    k.config!.ipForward = true;
    const out = processAtComputer(k, intercepted("8.8.8.8"), "sw");
    expect(out).toHaveLength(1);
    expect((out[0].frame.payload as any).type).toBe("arp");   // an ARP request went out
    expect((out[0].frame.payload as any).targetIp).toBe("10.0.0.1");
    // The intercepted frame waits for the reply.
    expect(state.simulation.pendingArp[`${k.id}:10.0.0.1`]).toHaveLength(1);
  });

  it("does not forward a frame addressed to us (dstIp is ours) — that is processed normally", () => {
    const k = kali([{ ipv4Address: "10.0.0.1", macAddress: GW }]);
    k.config!.ipForward = true;
    // A ping TO the Kali box itself: dstIp === our IP, so it is answered, not relayed.
    const toUs = createIcmpEchoRequest(VICTIM, KALI, "10.0.0.9", "10.0.0.5", 64);
    const out = processAtComputer(k, toUs, "sw");
    // An echo reply (icmpType 0), not a forwarded request.
    expect(out.some(o => (o.frame.payload as any).payload?.icmpType === 0)).toBe(true);
  });

  it("drops with a reason when the TTL is spent", () => {
    const k = kali([{ ipv4Address: "10.0.0.1", macAddress: GW }]);
    k.config!.ipForward = true;
    const out = processAtComputer(k, intercepted("8.8.8.8", 1), "sw");
    expect(out).toEqual([]);
  });
});

describe("the sysctl / proc shell drives the knob", () => {
  it("sysctl -w and echo > /proc both set it, and the reads report it", () => {
    const k = kali();
    runHostTerminalCommand(k, "sysctl -w net.ipv4.ip_forward=1");
    expect(k.config!.ipForward).toBe(true);
    runHostTerminalCommand(k, "cat /proc/sys/net/ipv4/ip_forward");
    expect(state.terminal.lines.at(-1)!.text).toBe("1");

    runHostTerminalCommand(k, "echo 0 > /proc/sys/net/ipv4/ip_forward");
    expect(k.config!.ipForward).toBeUndefined();
    runHostTerminalCommand(k, "sysctl net.ipv4.ip_forward");
    expect(state.terminal.lines.at(-1)!.text).toBe("net.ipv4.ip_forward = 0");
  });
});

// ── End to end: a poisoned victim's ping dies without forwarding, succeeds (via
// the attacker) with it — the whole point of #4. ─────────────────────────────
import { runConsoleScript } from "../src/commands";
import { runSimulationHeadless } from "../src/engine";
import { buildPingEvents } from "../src/simulation";

const dev = (name: string) => state.devices.find(d => d.name === name)!;

function routedWithKali() {
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
  // Warm real ARP caches with honest pings (so Kali knows the real gateway MAC).
  runSimulationHeadless(buildPingEvents(dev("PC-A"), "10.0.1.9") as any, dev("PC-A").id, "10.0.1.9", "ping");
  runSimulationHeadless(buildPingEvents(dev("KALI"), "10.0.1.9") as any, dev("KALI").id, "10.0.1.9", "ping");
  // Poison PC-A: its gateway now resolves to the attacker's MAC.
  const gw = dev("PC-A").config!.arpTable!.find((e: any) => e.ipv4Address === "10.0.0.1")!;
  gw.macAddress = dev("KALI").config!.macAddress!;
}

describe("the MITM end to end", () => {
  it("without forwarding the poisoned ping is black-holed at the attacker", () => {
    routedWithKali();
    delete (dev("KALI").config as any).ipForward;
    const r = runSimulationHeadless(buildPingEvents(dev("PC-A"), "10.0.1.9") as any, dev("PC-A").id, "10.0.1.9", "ping");
    expect(r.success).toBe(false);
  });

  it("with forwarding the ping succeeds and the attacker relays it", () => {
    routedWithKali();
    dev("KALI").config!.ipForward = true;
    const r = runSimulationHeadless(buildPingEvents(dev("PC-A"), "10.0.1.9") as any, dev("PC-A").id, "10.0.1.9", "ping");
    expect(r.success).toBe(true);
    expect(JSON.stringify(r.log)).toContain("ip_forward: relaying");
  });
});
