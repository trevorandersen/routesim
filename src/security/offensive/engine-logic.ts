/**
 * Offensive engine logic (Kali PC + Red Team actor).
 *
 * The parts of the attack feature that run inside the simulation engine: the
 * per-frame attacker processor (scan/sweep tally), the transparent-MITM relay
 * (`forwardIntercepted`), the ARP-poison detector (`recordArpPoison`), and the
 * nmap-style run report. These used to live in engine.ts; they move here so the
 * offensive technique is in one place, out of the general engine.
 *
 * To keep engine.ts in no import cycle (tests/architecture.test.ts), this module
 * never imports engine.ts at runtime: the two engine-private helpers these
 * functions need — `logStep` and the `processAtComputer` fallthrough — are passed
 * in as an `AttackContext`, and `OutgoingFrame` is a type-only import (erased at
 * build). engine.ts imports these functions and supplies the context.
 */
import type { Device, EthernetFrame, Ipv4Payload, ArpPayload, SimulationState } from "../../types";
import type { OutgoingFrame } from "../../engine";
import { state } from "../../state";
import { getDevice } from "../../devices";
import { sameSubnet, prefixOf, normaliseMacAddress } from "../../utils";
import { createArpRequest, frameLabel } from "../../frame";

// The engine-private helpers the offensive logic needs, injected by engine.ts so
// this module does not import the engine (which would form a cycle).
export interface AttackContext {
  logStep: (device: Device, kind: string, summary: string) => void;
  processAtComputer: (device: Device, frame: EthernetFrame, fromDeviceId: string | null) => OutgoingFrame[];
}

// Service names for the Red Team scan report (nmap-style PORT/SERVICE column).
const SERVICE_NAMES: Record<number, string> = {
  21: "ftp", 22: "ssh", 23: "telnet", 25: "smtp", 53: "domain", 80: "http",
  110: "pop3", 143: "imap", 443: "https", 445: "microsoft-ds", 3306: "mysql",
  3389: "ms-wbt-server", 8080: "http-proxy",
};

// A Kali PC / Red Team actor processing a frame: during an "attack" run it tallies
// the replies to its own scan/sweep (open/closed ports, live hosts) and does NOT
// complete a scan's handshake (a half-open SYN scan). Everything else — and every
// frame outside an attack run — falls through to the ordinary host handler, so the
// attacker is a full host (ARP, ICMP, its own client flows).
export function processAttacker(device: Device, frame: EthernetFrame, fromDeviceId: string | null, ctx: AttackContext): OutgoingFrame[] {
  if (device.poweredOff) return [];
  const sim = state.simulation;
  if (sim.mode === "attack" && device.id === sim.originDeviceId && frame.payload.type === "ipv4") {
    const ipv4 = frame.payload as Ipv4Payload;
    if (ipv4.dstIp === device.config?.ipv4Address) {
      const inner = ipv4.payload;
      if (inner.type === "tcp" && inner.flags === "syn-ack") {
        if (!sim.scanOpen.includes(inner.srcPort)) { sim.scanOpen.push(inner.srcPort); ctx.logStep(device, "sim-attack", `${ipv4.srcIp}:${inner.srcPort} open (SYN-ACK)`); }
        return [];   // half-open scan: don't complete the handshake
      }
      if (inner.type === "tcp" && inner.flags === "rst") {
        if (!sim.scanClosed.includes(inner.srcPort)) sim.scanClosed.push(inner.srcPort);
        return [];
      }
      if (inner.type === "icmp" && inner.icmpType === 0) {
        if (!sim.sweepLive.includes(ipv4.srcIp)) { sim.sweepLive.push(ipv4.srcIp); ctx.logStep(device, "sim-attack", `host up: ${ipv4.srcIp}`); }
        return [];
      }
    }
  }
  return ctx.processAtComputer(device, frame, fromDeviceId);
}

// A frame unicast to OUR MAC but bound for another IP was handed to us — the
// signature of an arpspoof victim whose ARP cache we poisoned. With
// net.ipv4.ip_forward on, relay it toward its true destination from our own
// (unpoisoned) ARP cache instead of dropping it: the silent MITM the tool is
// known for, so the victim's ping still succeeds and the extra hop shows. Issue #4.
export function forwardIntercepted(device: Device, config: any, frame: EthernetFrame, ipv4: Ipv4Payload, fromDeviceId: string | null, outgoing: OutgoingFrame[], ctx: AttackContext): void {
  if (!fromDeviceId) return;
  if (ipv4.ttl <= 1) {
    ctx.logStep(device, "sim-drop", `ip_forward: TTL expired forwarding to ${ipv4.dstIp} — dropped`);
    return;
  }
  // Next hop: on our subnet → the destination itself; otherwise our gateway.
  let nextHopIp = ipv4.dstIp;
  if (!sameSubnet(config.ipv4Address, ipv4.dstIp, prefixOf(config))) {
    if (!config.gatewayIpv4Address) {
      ctx.logStep(device, "sim-drop", `ip_forward: no route to ${ipv4.dstIp} (no default gateway) — dropped`);
      return;
    }
    nextHopIp = config.gatewayIpv4Address;
  }
  const forwarded: EthernetFrame = { ...frame, srcMac: config.macAddress || "", payload: { ...ipv4, ttl: ipv4.ttl - 1 } };
  const entry = (config.arpTable || []).find((e: any) => e.ipv4Address === nextHopIp);
  if (entry) {
    forwarded.dstMac = entry.macAddress;
    ctx.logStep(device, "sim-forward", `ip_forward: relaying ${frameLabel(frame)} for ${ipv4.dstIp} via ${nextHopIp} (TTL ${ipv4.ttl}→${ipv4.ttl - 1})`);
    outgoing.push({ frame: forwarded, toDeviceId: fromDeviceId });
  } else {
    const key = `${device.id}:${nextHopIp}`;
    (state.simulation.pendingArp[key] ||= []).push(forwarded);
    ctx.logStep(device, "sim-arp", `ip_forward: ${nextHopIp} unknown — ARPing before relaying to ${ipv4.dstIp}`);
    outgoing.push({ frame: createArpRequest(config.macAddress || "", config.ipv4Address || "", nextHopIp, frame.vlanTag), toDeviceId: fromDeviceId });
  }
}

// During an attack run, flag a victim whose ARP cache we just poisoned — an ARP
// reply whose sender MAC is the attacker's but whose sender IP belongs to another
// host (the gateway we are impersonating), not an honest self-announcement.
export function recordArpPoison(victim: Device, arp: ArpPayload, ctx: AttackContext): void {
  const sim = state.simulation;
  if (sim.mode !== "attack") return;
  const atk = getDevice(sim.originDeviceId);
  if (!atk?.config || victim.id === atk.id) return;
  const atkMac = normaliseMacAddress(atk.config.macAddress || "");
  if (!atkMac || normaliseMacAddress(arp.senderMac) !== atkMac) return;
  if (arp.senderIp === atk.config.ipv4Address) return;   // an honest self-announcement, not a poison
  if (!sim.arpPoisoned.includes(victim.name)) {
    sim.arpPoisoned.push(victim.name);
    ctx.logStep(victim, "sim-attack", `ARP cache poisoned: ${arp.senderIp} is-at ${arp.senderMac}`);
  }
}

// The nmap-style report of what a Red Team run found: open/closed ports, live
// hosts from a sweep, and victims whose ARP cache was poisoned. engine.ts writes
// the returned lines to the attacker's session and stashes them on its config.
export function buildAttackReport(sim: SimulationState): string[] {
  const open = [...sim.scanOpen].sort((a, b) => a - b);
  const closed = [...sim.scanClosed].sort((a, b) => a - b);
  const lines: string[] = [];
  if (open.length || closed.length) {
    lines.push("PORT      STATE  SERVICE");
    for (const p of open) lines.push(`${String(p + "/tcp").padEnd(10)}open   ${SERVICE_NAMES[p] || "unknown"}`);
    for (const p of closed) lines.push(`${String(p + "/tcp").padEnd(10)}closed ${SERVICE_NAMES[p] || "unknown"}`);
  }
  if (sim.sweepLive.length) lines.push(`Hosts up: ${sim.sweepLive.length} (${[...sim.sweepLive].sort().join(", ")})`);
  if (sim.arpPoisoned.length) lines.push(`ARP cache poisoned on: ${[...sim.arpPoisoned].sort().join(", ")}`);
  if (!lines.length) lines.push("No open ports or live hosts found (target unreachable, filtered, or no attack target set).");
  return lines;
}
