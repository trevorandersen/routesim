import type { SimEvent, EthernetFrame, Device } from "./types";
import { state } from "./state";
import { getDevice, linkedPortsFor, linksFor, linkAuthorizedForData, linkDataBlockReason, linkName, dot1xLinkInfo, isPhysicalLink } from "./devices";
import { runStpConvergence, isStpParticipant } from "./stp";
import { normalisePortVlans, normalisePortModes, normaliseTrunkAllowedVlans, memoPortVlans } from "./normalise";
import { isValidIpv4, sameSubnet, prefixOf, deriveMac, networkOf, prefixLengthOfCidr, ipv4ToInt, intToIpv4 } from "./utils";
import { createArpRequest, createArpReply, createIcmpEchoRequest, createDhcpDiscover, createTcpSegment, createDnsQuery, createDot11Frame, createDot1xFrame, createBpduFrame, BROADCAST_MAC } from "./frame";
import { simRandomInt, seedSimRng } from "./prng";
import { isHost, isDot1xSupplicant } from "./device-registry";

export interface PingSetup {
  events: SimEvent[];
  pendingArp: Record<string, EthernetFrame[]>;
  // Present when the flow starts with a DNS resolution: the name being
  // resolved and the follow-on flow ("ping"/"tcp"/"http") the origin should
  // launch once the answer arrives (null = bare lookup, e.g. nslookup).
  dns?: { name: string; then: "ping" | "tcp" | "http" | null; port: number | null };
  // The requested path for an HTTP flow (mode "http"); the engine sends the GET
  // once the TCP handshake completes.
  httpPath?: string;
}

// ─── Utilities kept from original simulation ─────────────────────────────────

// Does a managed switch's port carry the VLAN? A trunk carries any allowed
// VLAN (an empty allowed list = all); an access port carries its assigned one.
function portCarries(sw: Device, portName: string, vlanId: number): boolean {
  const mode = normalisePortModes(sw.config?.portModes || {})[portName] || "access";
  if (mode === "trunk") {
    const allowed = normaliseTrunkAllowedVlans(sw.config?.trunkAllowedVlans || {})[portName];
    return !(allowed && allowed.length > 0 && !allowed.includes(vlanId));
  }
  return (normalisePortVlans(sw.config?.portVlans || {})[portName] || 1) === vlanId;
}

// The port of `sw` facing `peerId`, or null if no cable to that peer.
function portToward(sw: Device, peerId: string): string | null {
  const idx = linkedPortsFor(sw.id).findIndex((p: any) => p?.peer?.id === peerId);
  return idx < 0 ? null : `Ethernet${idx + 1}`;
}

export function l2Reachable(fromId: string, toId: string, vlanId: number | null): boolean {
  const queue = [fromId];
  const seen = new Set(queue);
  while (queue.length) {
    const id = queue.shift()!;
    if (id === toId) return true;
    const curr = getDevice(id);
    const leavingManaged = !!curr && curr.type === "switch" && !!curr.config?.managed && vlanId != null;
    for (const link of linksFor(id)) {
      if (!isPhysicalLink(link) || link.shutdown) continue; // a shut link breaks the path
      if (!linkAuthorizedForData(link)) continue;  // unauthenticated WiFi / unauthorized 802.1X port: no data
      const isFrom = link.from === id;
      const nextId = isFrom ? link.to : link.from;
      if (seen.has(nextId)) continue;
      // LEAVING a managed switch: its egress port toward the next hop must
      // carry the VLAN — this is what keeps two hosts on different access
      // VLANs of one switch apart. (The old check searched the switch's ports
      // for a peer equal to the switch ITSELF, so it never fired; the sim's
      // processAtSwitch still isolated them, but this pre-check said otherwise.)
      if (leavingManaged) {
        const egress = portToward(curr!, nextId);
        if (egress && !portCarries(curr!, egress, vlanId!)) continue;
      }
      const next = getDevice(nextId);
      if (!next || next.poweredOff) continue;
      if ((next.type === "router" || next.type === "internet") && nextId !== toId) continue;  // the internet cloud is an L3 boundary, not an L2 bridge
      // ENTERING a managed switch: its ingress port (toward where we came
      // from) must carry the VLAN.
      if (next.type === "switch" && next.config?.managed && vlanId != null) {
        const ingress = portToward(next, id);
        if (!ingress && id !== fromId) continue;
        if (ingress && !portCarries(next, ingress, vlanId)) continue;
      }
      seen.add(nextId);
      queue.push(nextId);
    }
  }
  return false;
}

export function getVlanForDevice(deviceId: string): number {
  for (const link of linksFor(deviceId)) {
    if (!isPhysicalLink(link)) continue;
    const isFrom = link.from === deviceId;
    const switchId = isFrom ? link.to : link.from;
    const sw = getDevice(switchId);
    if (!sw || sw.type !== "switch" || !sw.config?.managed) continue;
    const ports = linkedPortsFor(sw.id);
    const portIdx = ports.findIndex((p: any) => p?.peer?.id === deviceId);
    if (portIdx === -1) continue;
    const portName = `Ethernet${portIdx + 1}`;
    const portVlans = memoPortVlans(sw.config.portVlans); // read-only; recomputed on edit
    return portVlans[portName] || 1;
  }
  return 1;
}

// A ping/name target is any host (the registry's host role).
export function findPingTarget(value: string): any {
  const target = String(value || "").trim().toLowerCase();
  return state.devices.find(device =>
    isHost(device.type) && (
      String(device.config?.ipv4Address || "").toLowerCase() === target ||
      device.name.toLowerCase() === target
    )
  );
}

// The DNS auto-zone: a device's hostname → its IPv4, so any DNS server resolves
// device names without a manually-added A-record. Hosts/servers only (they own a
// single IP). Used by the server's query handler (engine.ts) and the resolver.
export function hostnameToIp(name: string): string | null {
  const n = String(name || "").trim().toLowerCase();
  const d = state.devices.find(dev =>
    isHost(dev.type) && dev.name.toLowerCase() === n);
  return d?.config?.ipv4Address || null;
}

// ─── Build initial simulation events for a ping ──────────────────────────────

/**
 * Validates inputs and generates the initial SimEvent(s) for a ping.
 * Returns a string error message if validation fails, or a PingSetup object.
 */
export function buildPingEvents(source: any, targetText: string, options: { ttl?: number } = {}): PingSetup | string {
  seedSimRng();   // reseed the run's PRNG (clock by default; pinned via `seed <n>`)
  const ttl = options.ttl ?? 64;
  if (!source.config?.ipv4Address) return `${source.name}: eth0 has no IPv4 address.`;
  if (!source.config?.macAddress) return `${source.name}: eth0 has no MAC address.`;

  const srcIp = source.config.ipv4Address;
  const srcMac = source.config.macAddress;

  // Resolve the destination IP. The target may be a known device (matched by
  // name or IP) or a bare IP address that belongs to no device. In the latter
  // case we still emit a real ARP request and let it time out, rather than
  // "magically" reporting the host as unreachable before any frame is sent.
  const target = findPingTarget(targetText);
  const instant = state.options?.instantDns !== false;   // default on
  const trimmed = targetText.trim();
  let dstIp: string;
  if (isValidIpv4(trimmed)) {
    dstIp = trimmed;
  } else if (instant && target) {
    // Instant DNS: a device name resolves straight to its IP, no query.
    if (!target.config?.ipv4Address) return `${target.name}: eth0 has no IPv4 address.`;
    dstIp = target.config.ipv4Address;
  } else if (source.config?.dnsServerIp) {
    // A real hostname: resolve via the configured nameserver first (UDP/53), then
    // ping the answer — the exchange is real frames, and the DNS auto-zone means
    // a device's own hostname resolves even without a manual A-record.
    return buildResolveEvents(source, trimmed, "ping", null);
  } else {
    return `ping: cannot resolve ${targetText}`;
  }

  // Self-ping: instant
  if (target && target.id === source.id) {
    return `PING ${srcIp}\n64 bytes from ${srcIp}: icmp_seq=1 ttl=64 time=0.1 ms\n\n--- ${srcIp} ping statistics ---\n1 packets transmitted, 1 received, 0% packet loss`;
  }

  const vlanTag = null;
  const pendingArp: Record<string, EthernetFrame[]> = {};

  // Find the first connected device to send the initial frame to
  const firstHop = findFirstHop(source);
  if ("blocked" in firstHop) return `ping: connect: Network is unreachable (${firstHop.blocked})`;

  if (sameSubnet(srcIp, dstIp, prefixOf(source.config))) {
    // Same subnet — check ARP cache
    const arpEntry = (source.config.arpTable || []).find((e: any) => e.ipv4Address === dstIp);
    let initialFrame;
    if (arpEntry) {
      initialFrame = createIcmpEchoRequest(srcMac, arpEntry.macAddress, srcIp, dstIp, ttl, vlanTag);
    } else {
      // ARP first, defer the ICMP
      initialFrame = createArpRequest(srcMac, srcIp, dstIp, vlanTag);
      const deferredIcmp = createIcmpEchoRequest(srcMac, "00:00:00:00:00:00", srcIp, dstIp, ttl, vlanTag);
      pendingArp[`${source.id}:${dstIp}`] = [deferredIcmp];
    }
    return {
      events: [{
        type: "frame_arrive" as const,
        frame: initialFrame,
        deviceId: firstHop.peerId,
        fromDeviceId: source.id,
        linkId: firstHop.linkId
      }],
      pendingArp
    };
  }

  // Cross-subnet — need gateway
  if (!source.config?.gatewayIpv4Address) return `ping: connect: Network is unreachable (no default gateway)`;
  const gwIp = source.config.gatewayIpv4Address;
  if (!sameSubnet(gwIp, srcIp, prefixOf(source.config))) return `ping: connect: Network is unreachable (gateway not on source subnet)`;

  // Always hand the packet to the default gateway via an ARP (unless the gateway
  // MAC is already cached). Whether the destination is actually routable is then
  // decided by the simulation — the router forwards it or drops it ("No route"),
  // and a non-existent gateway/host makes the ARP or routed packet time out.
  // We deliberately do NOT pre-check reachability here, so the ARP is always seen.
  const gwArpEntry = (source.config.arpTable || []).find((e: any) => e.ipv4Address === gwIp);
  let initialFrame;
  if (gwArpEntry) {
    initialFrame = createIcmpEchoRequest(srcMac, gwArpEntry.macAddress, srcIp, dstIp, ttl, vlanTag);
  } else {
    initialFrame = createArpRequest(srcMac, srcIp, gwIp, vlanTag);
    const deferredIcmp = createIcmpEchoRequest(srcMac, "00:00:00:00:00:00", srcIp, dstIp, ttl, vlanTag);
    pendingArp[`${source.id}:${gwIp}`] = [deferredIcmp];
  }

  return {
    events: [{
      type: "frame_arrive" as const,
      frame: initialFrame,
      deviceId: firstHop.peerId,
      fromDeviceId: source.id,
      linkId: firstHop.linkId
    }],
    pendingArp
  };
}

/**
 * Validates a TCP connect (`nc <host> <port>`) and generates its initial
 * events: a SYN to the target (same subnet) or via the default gateway —
 * ARP-ing first when the next-hop MAC is unknown, exactly like ping. The
 * handshake itself (SYN-ACK / ACK / RST) runs in the engine.
 */
export function buildConnectEvents(source: any, targetText: string, port: number): PingSetup | string {
  seedSimRng();   // reseed the run's PRNG (also covers buildHttpEvents, which delegates here)
  if (!source.config?.ipv4Address) return `${source.name}: eth0 has no IPv4 address.`;
  if (!source.config?.macAddress) return `${source.name}: eth0 has no MAC address.`;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return `nc: invalid port ${port}`;

  const srcIp = source.config.ipv4Address;
  const srcMac = source.config.macAddress;
  const srcPort = simRandomInt(30000, 50000); // ephemeral (seeded — reproducible when the seed is pinned)

  const target = findPingTarget(targetText);
  const instant = state.options?.instantDns !== false;   // default on
  const trimmed = targetText.trim();
  let dstIp: string;
  if (isValidIpv4(trimmed)) {
    dstIp = trimmed;
  } else if (instant && target) {
    if (!target.config?.ipv4Address) return `${target.name}: eth0 has no IPv4 address.`;
    dstIp = target.config.ipv4Address;
  } else if (source.config?.dnsServerIp) {
    return buildResolveEvents(source, trimmed, "tcp", port);
  } else {
    return `nc: cannot resolve ${targetText}`;
  }

  const pendingArp: Record<string, EthernetFrame[]> = {};
  const firstHop = findFirstHop(source);
  if ("blocked" in firstHop) return `nc: Network is unreachable (${firstHop.blocked})`;

  const syn = (dstMac: string) => createTcpSegment(srcMac, dstMac, srcIp, dstIp, srcPort, port, "syn");

  let initialFrame: EthernetFrame;
  if (sameSubnet(srcIp, dstIp, prefixOf(source.config))) {
    const arpEntry = (source.config.arpTable || []).find((e: any) => e.ipv4Address === dstIp);
    if (arpEntry) {
      initialFrame = syn(arpEntry.macAddress);
    } else {
      initialFrame = createArpRequest(srcMac, srcIp, dstIp, null);
      pendingArp[`${source.id}:${dstIp}`] = [syn("00:00:00:00:00:00")];
    }
  } else {
    if (!source.config?.gatewayIpv4Address) return `nc: connect: Network is unreachable (no default gateway)`;
    const gwIp = source.config.gatewayIpv4Address;
    if (!sameSubnet(gwIp, srcIp, prefixOf(source.config))) return `nc: connect: Network is unreachable (gateway not on source subnet)`;
    const gwArpEntry = (source.config.arpTable || []).find((e: any) => e.ipv4Address === gwIp);
    if (gwArpEntry) {
      initialFrame = syn(gwArpEntry.macAddress);
    } else {
      initialFrame = createArpRequest(srcMac, srcIp, gwIp, null);
      pendingArp[`${source.id}:${gwIp}`] = [syn("00:00:00:00:00:00")];
    }
  }

  return {
    events: [{
      type: "frame_arrive" as const,
      frame: initialFrame,
      deviceId: firstHop.peerId,
      fromDeviceId: source.id,
      linkId: firstHop.linkId
    }],
    pendingArp
  };
}

/**
 * Builds the initial events for an HTTP request: the TCP three-way handshake to
 * the web port (default 80), after which the engine sends the GET once the
 * connection is established (mode "http"). Reuses buildConnectEvents for the
 * handshake/ARP/DNS plumbing and just tags the flow with the requested path.
 */
// Parse an HTTP target into host / port / path. Accepts a bare host/IP, a
// `host:port`, or a `http://host[:port][/path]` URL; `fallbackPath` (a separate
// path argument) is used only when the target carries no path of its own.
export function parseHttpTarget(text: string, fallbackPath = "/"): { host: string; port: number; path: string } {
  let s = String(text || "").trim().replace(/^https?:\/\//i, "");
  let path = fallbackPath || "/";
  const slash = s.indexOf("/");
  if (slash >= 0) { path = s.slice(slash); s = s.slice(0, slash); }
  let port = 80;
  const colon = s.indexOf(":");
  if (colon >= 0) {
    const p = Number(s.slice(colon + 1));
    // A present-but-invalid port is NaN (not silently 80) so the caller can reject it.
    port = (Number.isInteger(p) && p > 0 && p < 65536) ? p : NaN;
    s = s.slice(0, colon);
  }
  if (!path.startsWith("/")) path = "/" + path;
  return { host: s, port, path };
}

export function buildHttpEvents(source: any, targetText: string, port = 80, path = "/"): PingSetup | string {
  const setup = buildConnectEvents(source, targetText, port);
  if (typeof setup === "string") return setup;
  setup.httpPath = path || "/";
  if (setup.dns) setup.dns.then = "http"; // by-name: resolve, then run HTTP (not a bare connect)
  return setup;
}

/**
 * Builds the initial events for a DNS lookup: a UDP/53 query to the host's
 * configured nameserver (ARP-ing the next hop first when its MAC is unknown,
 * exactly like ping). `then` names the follow-on flow the origin launches when
 * the answer arrives — "ping"/"tcp" for ping/nc-by-name, null for a bare
 * lookup (nslookup). The engine handles the response (engine.ts).
 */
export function buildResolveEvents(source: any, name: string, then: "ping" | "tcp" | "http" | null = null, port: number | null = null): PingSetup | string {
  seedSimRng();   // reseed the run's PRNG (the DNS transaction id draws from it)
  if (!source.config?.ipv4Address) return `${source.name}: eth0 has no IPv4 address.`;
  if (!source.config?.macAddress) return `${source.name}: eth0 has no MAC address.`;
  const dnsIp = source.config?.dnsServerIp;
  if (!dnsIp || !isValidIpv4(dnsIp)) return `;; no nameserver configured (/etc/resolv.conf)`;

  const srcIp = source.config.ipv4Address;
  const srcMac = source.config.macAddress;
  const firstHop = findFirstHop(source);
  if ("blocked" in firstHop) return `;; connection timed out; no servers could be reached (${firstHop.blocked})`;

  // Next hop toward the nameserver: on-subnet → the server itself, otherwise
  // the default gateway (same decision a ping makes).
  let nextHopIp = dnsIp;
  if (!sameSubnet(srcIp, dnsIp, prefixOf(source.config))) {
    if (!source.config?.gatewayIpv4Address) return `;; no route to nameserver ${dnsIp} (no default gateway)`;
    const gwIp = source.config.gatewayIpv4Address;
    if (!sameSubnet(gwIp, srcIp, prefixOf(source.config))) return `;; no route to nameserver ${dnsIp} (gateway not on source subnet)`;
    nextHopIp = gwIp;
  }

  const pendingArp: Record<string, EthernetFrame[]> = {};
  const arpEntry = (source.config.arpTable || []).find((e: any) => e.ipv4Address === nextHopIp);
  const dnsId = simRandomInt(0x1000, 0x10000);   // seeded xid — reproducible when the seed is pinned (also the PAT flow id)
  let initialFrame: EthernetFrame;
  if (arpEntry) {
    initialFrame = createDnsQuery(srcMac, arpEntry.macAddress, srcIp, dnsIp, name, dnsId);
  } else {
    initialFrame = createArpRequest(srcMac, srcIp, nextHopIp, null);
    pendingArp[`${source.id}:${nextHopIp}`] = [createDnsQuery(srcMac, "00:00:00:00:00:00", srcIp, dnsIp, name, dnsId)];
  }

  return {
    events: [{
      type: "frame_arrive" as const,
      frame: initialFrame,
      deviceId: firstHop.peerId,
      fromDeviceId: source.id,
      linkId: firstHop.linkId
    }],
    pendingArp,
    dns: { name, then, port }
  };
}

export function buildDhcpEvents(source: any): PingSetup | string {
  seedSimRng();   // reseed the run's PRNG (the DHCP transaction id draws from it)
  if (!source.config?.macAddress) return `${source.name}: eth0 has no MAC address.`;
  const firstHop = findFirstHop(source);
  if ("blocked" in firstHop) return `dhcp: Network is unreachable (${firstHop.blocked})`;

  const srcMac = source.config.macAddress;
  const transactionId = `dhcp-${simRandomInt(0x1000, 0x100000).toString(16)}`; // seeded xid
  const discover = createDhcpDiscover(srcMac, transactionId);

  return {
    events: [{
      type: "frame_arrive" as const,
      frame: discover,
      deviceId: firstHop.peerId,
      fromDeviceId: source.id,
      linkId: firstHop.linkId
    }],
    pendingArp: {}
  };
}

// The access point a laptop is associated with (its wireless link peer), or null.
export function associatedAp(laptop: any): { ap: any; linkId: string } | null {
  for (const link of state.links) {
    if (!link.wireless || !isPhysicalLink(link) || link.shutdown) continue;
    if (link.from !== laptop.id && link.to !== laptop.id) continue;
    const ap = getDevice(link.from === laptop.id ? link.to : link.from);
    if (ap && ap.type === "access-point" && !ap.poweredOff) return { ap, linkId: link.id };
  }
  return null;
}

// Seed the 802.11 association handshake: a laptop probes the access point it is
// linked to. The reactive chain in the engine (handleDot11) plays out the rest.
export function buildAssociationEvents(laptop: any): PingSetup | string {
  if (laptop.type !== "laptop") return `${laptop.name} is not a wireless client.`;
  const srcMac = laptop.config?.macAddress;
  if (!srcMac) return `${laptop.name}: the WiFi NIC has no MAC address.`;
  const assoc = associatedAp(laptop);
  if (!assoc) return `${laptop.name} is not associated to an access point.`;
  const { ap, linkId } = assoc;
  const ssid = ap.config?.ssid || "";
  if (!ssid) return `${ap.name} has no SSID set.`;
  const bssid = ap.config?.macAddress || deriveMac(ap.id);
  const probe = createDot11Frame(srcMac, bssid, "probe-req", ssid);
  return {
    events: [{ type: "frame_arrive" as const, frame: probe, deviceId: ap.id, fromDeviceId: laptop.id, linkId }],
    pendingArp: {}
  };
}

// Seed the 802.1X exchange: a supplicant host sends EAPOL-Start to its
// authenticator switch (the port it's on must be under 802.1X port control).
export function buildDot1xEvents(host: any): PingSetup | string {
  if (!isDot1xSupplicant(host.type)) return `${host.name} is not a host (802.1X supplicant).`;
  const srcMac = host.config?.macAddress;
  if (!srcMac) return `${host.name}: eth0 has no MAC address.`;
  if (!host.config?.dot1x?.identity) return `${host.name} has no 802.1X identity — set one with "supplicant ${host.name} <identity> <password>".`;
  for (const link of linksFor(host.id)) {
    if (!isPhysicalLink(link) || link.shutdown) continue;
    const info = dot1xLinkInfo(link);
    if (info && info.peer.id === host.id) {
      const start = createDot1xFrame(srcMac, "01:80:C2:00:00:03", "eapol-start", host.config.dot1x.identity);
      return { events: [{ type: "frame_arrive" as const, frame: start, deviceId: info.sw.id, fromDeviceId: host.id, linkId: link.id }], pendingArp: {} };
    }
  }
  return `${host.name} is not on an 802.1X-controlled port (set one with "portauth <switch> <EthN> auto").`;
}

// Seed the animated spanning-tree run: each root bridge advertises a
// Configuration BPDU out its designated ports toward neighbouring switches. The
// engine's handleBpdu relays them down the tree (root path cost + 1 per hop).
export function buildStpEvents(): PingSetup | string {
  runStpConvergence();
  const participants = state.devices.filter(isStpParticipant);
  if (participants.length === 0) return "No managed switch is running spanning tree (enable STP on a managed switch).";
  const roots = participants.filter(s => s.config?.stp?.bridgeId && s.config.stp.bridgeId === s.config.stp.rootId);
  const events: SimEvent[] = [];
  for (const root of roots) {
    const srcMac = root.config?.macAddress || deriveMac(root.id);
    const rootId = root.config!.stp!.rootId || "";
    const bridgeId = root.config!.stp!.bridgeId || "";
    const ports = linkedPortsFor(root.id);
    ports.forEach((port: any, idx: number) => {
      if (!port?.peer || !isStpParticipant(port.peer)) return;
      const name = `Ethernet${idx + 1}`;
      if (root.config?.stp?.ports?.[name]?.role !== "designated") return;
      events.push({ type: "frame_arrive" as const, frame: createBpduFrame(srcMac, rootId, bridgeId, 0, name), deviceId: port.peer.id, fromDeviceId: root.id, linkId: port.link.id });
    });
  }
  if (events.length === 0) return "No inter-switch links for spanning tree to advertise on (a single switch, or no loop to resolve).";
  return { events, pendingArp: {} };
}

// ─── Red Team attacks ────────────────────────────────────────────────────────

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
  const network = networkOf(cidr.split("/")[0], prefixLengthOfCidr(cidr));
  const netInt = ipv4ToInt(network.split("/")[0]);

  const events: SimEvent[] = [];
  const pendingArp: Record<string, EthernetFrame[]> = {};
  for (let i = 1; i <= SWEEP_HOSTS; i++) {
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

  const emit = (frame: any) => ({ type: "frame_arrive" as const, frame, deviceId: firstHop.peerId, fromDeviceId: attacker.id, linkId: firstHop.linkId });

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

// The source's first hop for an originated frame — or, when no cable can carry
// it, WHY, in the learner's words: "no link" only when there is no cable at
// all; otherwise the data gate's reason (shut, spanning-tree blocked, a WiFi
// password mismatch, an unauthorized 802.1X port, a failed MACsec link) or a
// powered-off peer. The builders put it in their "Network is unreachable (…)"
// error, so the troubleshooting lesson is in the message rather than hidden.
type FirstHop = { peerId: string; linkId: string } | { blocked: string };
function findFirstHop(source: Device): FirstHop {
  let blocked: string | null = null;
  for (const link of linksFor(source.id)) {
    if (!isPhysicalLink(link)) continue;   // a collapsed LAN hides the cable, it doesn't unplug it
    const reason = linkDataBlockReason(link);
    if (reason) { blocked ??= reason; continue; }
    const peer = getDevice(link.from === source.id ? link.to : link.from);
    if (!peer) continue;
    if (peer.poweredOff) { blocked ??= `${peer.name}, at the other end of ${linkName(link)}, is powered off`; continue; }
    return { peerId: peer.id, linkId: link.id };
  }
  return { blocked: blocked ?? "no link" };
}
