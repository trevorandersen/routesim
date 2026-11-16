/**
 * Offensive attack builders (Kali PC + Red Team actor).
 *
 * The frame-sequence builders for the red-team attacks — a SYN port scan, an
 * ICMP ping sweep, and ARP-spoof poisoning — each returning a `PingSetup` the
 * engine animates as sim mode "attack". Extracted from simulation.ts so the
 * offensive feature lives in one place (src/security/offensive/); the general
 * networking builders stay in simulation.ts. This module imports the shared
 * first-hop / name-resolution helpers from simulation.ts and never imports the
 * engine, so engine.ts can import it without forming a cycle.
 */
import type { SimEvent, EthernetFrame } from "../../types";
import { state } from "../../state";
import { isValidIpv4, sameSubnet, prefixOf, networkOf, prefixLengthOfCidr, ipv4ToInt, intToIpv4 } from "../../utils";
import { createArpRequest, createArpReply, createIcmpEchoRequest, createTcpSegment, BROADCAST_MAC } from "../../frame";
import { simRandomInt, seedSimRng } from "../../prng";
import { isHost } from "../../device-registry";
import type { PingSetup } from "../../simulation";
import { findFirstHop, findPingTarget } from "../../simulation";

// A small, recognisable set of common service ports the scan probes.
const SCAN_PORTS = [21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 3306, 3389, 8080];
const SWEEP_HOSTS = 20;   // how many addresses a ping sweep probes (bounded)

// The next-hop IP + a deferred-or-direct send for an attack frame addressed to
// dstIp (same-subnet → the host; else the gateway). Returns null if unroutable.
function attackNextHop(attacker: any, dstIp: string): { nextHopIp: string } | null {
  const cfg = attacker.config;
  if (sameSubnet(cfg.ipv4Address, dstIp, prefixOf(cfg))) return { nextHopIp: dstIp };
  const gw = cfg.gatewayIpv4Address;
  if (!gw || !sameSubnet(gw, cfg.ipv4Address, prefixOf(cfg))) return null;
  return { nextHopIp: gw };
}

// Resolve a scan/sweep target text to an IP (a device name or a bare IP).
function attackTargetIp(text: string): string | null {
  const t = String(text || "").trim();
  if (isValidIpv4(t)) return t;
  const dev = findPingTarget(t);
  return dev?.config?.ipv4Address || null;
}

// nmap -sS: a TCP SYN to each common port on the target. Open ports answer
// SYN-ACK, closed ones RST — the sensor (if a SPAN port mirrors the segment)
// sees a burst of SYNs. ARP-resolves the next hop first (like nc).
export function buildScanEvents(attacker: any, targetText: string): PingSetup | string {
  seedSimRng();   // reseed the run's PRNG (the scan's source port draws from it)
  const cfg = attacker.config;
  if (!cfg?.ipv4Address || !cfg?.macAddress) return `${attacker.name}: eth0 has no address.`;
  const dstIp = attackTargetIp(targetText);
  if (!dstIp) return `nmap: cannot resolve ${targetText}`;
  const firstHop = findFirstHop(attacker);
  if ("blocked" in firstHop) return `nmap: network is unreachable (${firstHop.blocked})`;
  const hop = attackNextHop(attacker, dstIp);
  if (!hop) return `nmap: no route to ${dstIp}`;

  const srcPort = simRandomInt(40000, 60000);
  const syn = (port: number, dstMac: string) => createTcpSegment(cfg.macAddress, dstMac, cfg.ipv4Address, dstIp, srcPort, port, "syn");
  const arpEntry = (cfg.arpTable || []).find((e: any) => e.ipv4Address === hop.nextHopIp);
  const seed = (frame: EthernetFrame) => ({ type: "frame_arrive" as const, frame, deviceId: firstHop.peerId, fromDeviceId: attacker.id, linkId: firstHop.linkId });

  if (arpEntry) {
    return { events: SCAN_PORTS.map(p => seed(syn(p, arpEntry.macAddress))), pendingArp: {} };
  }
  return {
    events: [seed(createArpRequest(cfg.macAddress, cfg.ipv4Address, hop.nextHopIp))],
    pendingArp: { [`${attacker.id}:${hop.nextHopIp}`]: SCAN_PORTS.map(p => syn(p, "00:00:00:00:00:00")) },
  };
}

// nmap -sn: a ping sweep across the subnet — an ICMP echo to each of the first
// SWEEP_HOSTS addresses (ARP-resolved). Live hosts reply; the rest time out.
export function buildSweepEvents(attacker: any, subnetText: string): PingSetup | string {
  const cfg = attacker.config;
  if (!cfg?.ipv4Address || !cfg?.macAddress) return `${attacker.name}: eth0 has no address.`;
  const firstHop = findFirstHop(attacker);
  if ("blocked" in firstHop) return `nmap: network is unreachable (${firstHop.blocked})`;
  // The subnet to sweep: an explicit CIDR/IP, else the attacker's own subnet.
  const t = String(subnetText || "").trim();
  const base = t && (t.includes("/") || isValidIpv4(t)) ? t : `${cfg.ipv4Address}/${prefixOf(cfg)}`;
  const cidr = base.includes("/") ? base : `${base}/${prefixOf(cfg)}`;
  const addr = cidr.split("/")[0];
  // Reject a garbage target (e.g. "foo/24") rather than sweeping 0.0.0.x.
  if (!isValidIpv4(addr)) return `nmap: invalid target`;
  const prefixLen = prefixLengthOfCidr(cidr);
  const network = networkOf(addr, prefixLen);
  const netInt = ipv4ToInt(network.split("/")[0]);
  // Probe only the subnet's usable host addresses, so a small subnet (/29 and
  // below) never spills past its broadcast into the next subnet. A /31 or /32
  // has no usable hosts to sweep.
  const usable = prefixLen >= 31 ? 0 : Math.max(0, (2 ** (32 - prefixLen)) - 2);
  const probeCount = Math.min(SWEEP_HOSTS, usable);

  const events: SimEvent[] = [];
  const pendingArp: Record<string, EthernetFrame[]> = {};
  for (let i = 1; i <= probeCount; i++) {
    const hostIp = intToIpv4(netInt + i);
    if (hostIp === cfg.ipv4Address) continue;   // don't ping ourselves
    // Route each probe like a real ping: a same-subnet target is reached
    // directly, a remote one (a sweep of another subnet) goes via the gateway —
    // so every off-subnet echo shares one ARP for the gateway's MAC.
    const hop = attackNextHop(attacker, hostIp);
    if (!hop) continue;                         // unroutable (remote subnet, no gateway)
    const echo = createIcmpEchoRequest(cfg.macAddress, "00:00:00:00:00:00", cfg.ipv4Address, hostIp, 64);
    const arpEntry = (cfg.arpTable || []).find((e: any) => e.ipv4Address === hop.nextHopIp);
    if (arpEntry) {
      echo.dstMac = arpEntry.macAddress;
      events.push({ type: "frame_arrive", frame: echo, deviceId: firstHop.peerId, fromDeviceId: attacker.id, linkId: firstHop.linkId });
    } else {
      const key = `${attacker.id}:${hop.nextHopIp}`;
      if (!pendingArp[key]) {
        events.push({ type: "frame_arrive", frame: createArpRequest(cfg.macAddress, cfg.ipv4Address, hop.nextHopIp), deviceId: firstHop.peerId, fromDeviceId: attacker.id, linkId: firstHop.linkId });
        pendingArp[key] = [];
      }
      pendingArp[key].push(echo);
    }
  }
  if (!events.length) return `nmap: nothing to sweep`;
  return { events, pendingArp };
}

// The MAC that currently owns an IP anywhere on the topology — a host's NIC or a
// router interface. Lets arpspoof address a *targeted* poison to one victim (or
// the gateway) the way real arpspoof does after ARPing for it first. Null when
// no device holds the address.
export function macForIp(ip: string): string | null {
  const want = String(ip || "").trim();
  if (!isValidIpv4(want)) return null;
  for (const d of state.devices) {
    if (isHost(d.type) && d.config?.ipv4Address === want) return d.config?.macAddress || null;
    for (const iface of (d.config?.interfaces || []) as any[]) {
      if (iface.ipv4Address === want && iface.macAddress) return iface.macAddress;
    }
  }
  return null;
}

// arpspoof: a gratuitous ARP reply "spoofIp is at <our MAC>", poisoning a
// victim's ARP cache so its traffic to spoofIp (the gateway) is redirected to
// the attacker — a classic MITM. By default a **broadcast** reply poisons every
// host on the segment; `-t <victim>` **unicasts** it to one victim; `-r` adds
// the mirror-image reply that poisons the **gateway's** entry for the victim, so
// return traffic crosses the attacker too (pair with `net.ipv4.ip_forward` — see
// forwardIntercepted — for a transparent, bidirectional MITM). Issue #5.
export function buildArpSpoofEvents(
  attacker: any, spoofText?: string, opts: { victim?: string; reverse?: boolean } = {}
): PingSetup | string {
  const cfg = attacker.config;
  if (!cfg?.macAddress) return `${attacker.name}: eth0 has no MAC address.`;
  const spoofIp = String(spoofText || cfg.spoofIp || cfg.gatewayIpv4Address || "").trim();
  if (!isValidIpv4(spoofIp)) return `arpspoof: no valid IP to impersonate (set a gateway, or "arp-spoof <ip>").`;
  const firstHop = findFirstHop(attacker);
  if ("blocked" in firstHop) return `arpspoof: network is unreachable (${firstHop.blocked})`;

  // Resolve a target's IP (a name or a bare IP) and the MAC to unicast to — the
  // attacker's own cache first, then the topology; a broadcast fallback still
  // poisons when the MAC can't be resolved (as a broadcast reply reaches it).
  const resolveTarget = (text: string): { ip: string; mac: string } | string => {
    const dev = findPingTarget(text);
    const ip = dev?.config?.ipv4Address || (isValidIpv4(text) ? text : "");
    if (!isValidIpv4(ip)) return `arpspoof: "${text}" is not a host or IP on this network`;
    const cached = (cfg.arpTable || []).find((e: any) => e.ipv4Address === ip)?.macAddress;
    return { ip, mac: cached || macForIp(ip) || BROADCAST_MAC };
  };

  const emit = (frame: EthernetFrame) => ({ type: "frame_arrive" as const, frame, deviceId: firstHop.peerId, fromDeviceId: attacker.id, linkId: firstHop.linkId });

  // No -t: the broadcast poison (every victim learns spoofIp → our MAC).
  if (!opts.victim) {
    return { events: [emit(createArpReply(cfg.macAddress, spoofIp, BROADCAST_MAC, spoofIp))], pendingArp: {} };
  }

  const victim = resolveTarget(opts.victim);
  if (typeof victim === "string") return victim;
  // Forward poison: unicast "spoofIp is-at us" to the victim only.
  const events = [emit(createArpReply(cfg.macAddress, spoofIp, victim.mac, victim.ip))];

  if (opts.reverse) {
    // Reverse poison: tell the gateway "the victim is-at us", so the victim's
    // return traffic is redirected to the attacker as well.
    const gw = resolveTarget(spoofIp);
    if (typeof gw === "string") return gw;
    events.push(emit(createArpReply(cfg.macAddress, victim.ip, gw.mac, gw.ip)));
  }
  return { events, pendingArp: {} };
}

// Merge the enabled attacks (or a specific one) into a single run. The scan/
// sweep targets come from config.attackTarget (sweep falls back to own subnet).
export function buildAttackEvents(attacker: any, only?: string): PingSetup | string {
  const kinds: string[] = only ? [only] : (attacker.config?.attacks || ["scan"]);
  const target = attacker.config?.attackTarget || "";
  const events: SimEvent[] = [];
  const pendingArp: Record<string, EthernetFrame[]> = {};
  const errors: string[] = [];
  const merge = (r: PingSetup | string) => {
    if (typeof r === "string") { errors.push(r); return; }
    events.push(...r.events);
    for (const [k, v] of Object.entries(r.pendingArp)) pendingArp[k] = [...(pendingArp[k] || []), ...v];
  };
  for (const kind of kinds) {
    if (kind === "scan") merge(target ? buildScanEvents(attacker, target) : `nmap: no scan target set`);
    else if (kind === "sweep") merge(buildSweepEvents(attacker, target));
    else if (kind === "arp-spoof") merge(buildArpSpoofEvents(attacker));
  }
  if (!events.length) return errors[0] || `${attacker.name}: no attacks to launch`;
  return { events, pendingArp };
}
