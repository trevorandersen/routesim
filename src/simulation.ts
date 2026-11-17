import type { SimEvent, EthernetFrame, Device, NamedRouterIface } from "./types";
import { state } from "./state";
import { getDevice, linkedPortsFor, linksFor, linkAuthorizedForData, linkDataBlockReason, linkName, linkPortName, dot1xLinkInfo, isPhysicalLink } from "./devices";
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
  const idx = linkedPortsFor(sw.id).findIndex((p) => p?.peer?.id === peerId);
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

// The VLAN a router interface's frames travel in on the segment its cable
// joins: its dot1q tag for a sub-interface; otherwise whatever the managed
// switch port it is plugged into puts untagged frames in (the access VLAN, or
// a trunk's native VLAN) — as processAtSwitch does on ingress. Null when the
// first device on the segment is not a managed switch (no VLAN in play yet).
function routerIfaceVlan(iface: NamedRouterIface, peer: Device, port: string | null): number | null {
  if (iface.config.vlanTag != null) return iface.config.vlanTag;
  if (peer.type !== "switch" || !peer.config?.managed || !port) return null;
  const mode = normalisePortModes(peer.config.portModes || {})[port] || "access";
  const vlans = mode === "trunk" ? peer.config.trunkNativeVlans : peer.config.portVlans;
  return normalisePortVlans(vlans || {})[port] || 1;
}

// Are two router interfaces on one L2 segment — would a frame multicast out of
// `a` (a RIP update) arrive on `b`? Both cables must carry data (not shut, not
// failing an auth or MACsec gate), both first devices must be powered on and
// bridge (a switch, hub or access point — not another router, which is the
// direct-cable case, nor the internet cloud), both ends must sit in the same
// VLAN, and l2Reachable must find a path between the two bridges for it.
export function routerIfacesShareSegment(a: NamedRouterIface, b: NamedRouterIface): boolean {
  if (!a.peer || !b.peer || !a.link || !b.link) return false;
  if (!linkAuthorizedForData(a.link) || !linkAuthorizedForData(b.link)) return false;
  for (const peer of [a.peer, b.peer]) {
    if (peer.poweredOff || peer.type === "router" || peer.type === "internet" || isHost(peer.type)) return false;
  }
  const portA = linkPortName(a.link, a.peer.id);
  const portB = linkPortName(b.link, b.peer.id);
  const vlanA = routerIfaceVlan(a, a.peer, portA);
  const vlanB = routerIfaceVlan(b, b.peer, portB);
  if (vlanA != null && vlanB != null && vlanA !== vlanB) return false;
  const vlan = vlanA ?? vlanB;
  if (vlan != null) {
    // The port each router plugs into must carry the VLAN (a trunk's allowed
    // list can exclude a sub-interface's tag).
    if (a.peer.type === "switch" && a.peer.config?.managed && portA && !portCarries(a.peer, portA, vlan)) return false;
    if (b.peer.type === "switch" && b.peer.config?.managed && portB && !portCarries(b.peer, portB, vlan)) return false;
  }
  return l2Reachable(a.peer.id, b.peer.id, vlan);
}

export function getVlanForDevice(deviceId: string): number {
  for (const link of linksFor(deviceId)) {
    if (!isPhysicalLink(link)) continue;
    const isFrom = link.from === deviceId;
    const switchId = isFrom ? link.to : link.from;
    const sw = getDevice(switchId);
    if (!sw || sw.type !== "switch" || !sw.config?.managed) continue;
    const ports = linkedPortsFor(sw.id);
    const portIdx = ports.findIndex((p) => p?.peer?.id === deviceId);
    if (portIdx === -1) continue;
    const portName = `Ethernet${portIdx + 1}`;
    const portVlans = memoPortVlans(sw.config.portVlans); // read-only; recomputed on edit
    return portVlans[portName] || 1;
  }
  return 1;
}

// A ping/name target is any host (the registry's host role).
export function findPingTarget(value: string): Device | undefined {
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
export function buildPingEvents(source: Device, targetText: string, options: { ttl?: number } = {}): PingSetup | string {
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
    const arpEntry = (source.config.arpTable || []).find((e) => e.ipv4Address === dstIp);
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
  const gwArpEntry = (source.config.arpTable || []).find((e) => e.ipv4Address === gwIp);
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
export function buildConnectEvents(source: Device, targetText: string, port: number): PingSetup | string {
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
    const arpEntry = (source.config.arpTable || []).find((e) => e.ipv4Address === dstIp);
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
    const gwArpEntry = (source.config.arpTable || []).find((e) => e.ipv4Address === gwIp);
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

export function buildHttpEvents(source: Device, targetText: string, port = 80, path = "/"): PingSetup | string {
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
export function buildResolveEvents(source: Device, name: string, then: "ping" | "tcp" | "http" | null = null, port: number | null = null): PingSetup | string {
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
  const arpEntry = (source.config.arpTable || []).find((e) => e.ipv4Address === nextHopIp);
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

export function buildDhcpEvents(source: Device): PingSetup | string {
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
export function associatedAp(laptop: Device): { ap: Device; linkId: string } | null {
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
export function buildAssociationEvents(laptop: Device): PingSetup | string {
  if (laptop.type !== "laptop") return `${laptop.name} is not a wireless client.`;
  const srcMac = laptop.config?.macAddress;
  if (!srcMac) return `${laptop.name}: the WiFi NIC has no MAC address.`;
  const assoc = associatedAp(laptop);
  if (!assoc) return `${laptop.name} is not associated to an access point.`;
  const { ap, linkId } = assoc;
  // Probe with the laptop's own SSID — the network it is looking for — not the
  // AP's, so the AP can reject a probe for a different network (R15).
  const ssid = (laptop.config?.ssid || "").trim();
  if (!ssid) return `${laptop.name} has no SSID set — give it a network name first.`;
  const bssid = ap.config?.macAddress || deriveMac(ap.id);
  const probe = createDot11Frame(srcMac, bssid, "probe-req", ssid);
  return {
    events: [{ type: "frame_arrive" as const, frame: probe, deviceId: ap.id, fromDeviceId: laptop.id, linkId }],
    pendingArp: {}
  };
}

// Seed the 802.1X exchange: a supplicant host sends EAPOL-Start to its
// authenticator switch (the port it's on must be under 802.1X port control).
export function buildDot1xEvents(host: Device): PingSetup | string {
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
    ports.forEach((port, idx: number) => {
      if (!port?.peer || !isStpParticipant(port.peer)) return;
      const name = `Ethernet${idx + 1}`;
      if (root.config?.stp?.ports?.[name]?.role !== "designated") return;
      events.push({ type: "frame_arrive" as const, frame: createBpduFrame(srcMac, rootId, bridgeId, 0, name), deviceId: port.peer.id, fromDeviceId: root.id, linkId: port.link.id });
    });
  }
  if (events.length === 0) return "No inter-switch links for spanning tree to advertise on (a single switch, or no loop to resolve).";
  return { events, pendingArp: {} };
}

// The source's first hop for an originated frame — or, when no cable can carry
// it, WHY, in the learner's words: "no link" only when there is no cable at
// all; otherwise the data gate's reason (shut, spanning-tree blocked, a WiFi
// password mismatch, an unauthorized 802.1X port, a failed MACsec link) or a
// powered-off peer. The builders put it in their "Network is unreachable (…)"
// error, so the troubleshooting lesson is in the message rather than hidden.
export type FirstHop = { peerId: string; linkId: string } | { blocked: string };
export function findFirstHop(source: Device): FirstHop {
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
