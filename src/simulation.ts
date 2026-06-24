import type { SimEvent, EthernetFrame } from "./types";
import { state } from "./state";
import { getDevice, linkedPortsFor, linksFor, linkAuthorizedForData, dot1xLinkInfo } from "./devices";
import { runStpConvergence, isStpParticipant } from "./stp";
import { normalisePortVlans, normalisePortModes, normaliseTrunkAllowedVlans, memoPortVlans } from "./normalise";
import { isValidIpv4, sameSubnet, prefixOf, deriveMac } from "./utils";
import { createArpRequest, createIcmpEchoRequest, createDhcpDiscover, createTcpSegment, createDnsQuery, createDot11Frame, createDot1xFrame, createBpduFrame } from "./frame";

export interface PingSetup {
  events: SimEvent[];
  pendingArp: Record<string, EthernetFrame[]>;
  // Present when the flow starts with a DNS resolution: the name being
  // resolved and the follow-on flow ("ping"/"tcp") the origin should launch
  // once the answer arrives (null = bare lookup, e.g. nslookup).
  dns?: { name: string; then: "ping" | "tcp" | null; port: number | null };
}

// ─── Utilities kept from original simulation ─────────────────────────────────

export function l2Reachable(fromId: string, toId: string, vlanId: number | null): boolean {
  const queue = [fromId];
  const seen = new Set(queue);
  while (queue.length) {
    const id = queue.shift()!;
    if (id === toId) return true;
    for (const link of linksFor(id)) {
      if (link.hidden || link.shutdown) continue; // a shut link breaks the path
      if (!linkAuthorizedForData(link)) continue;  // unauthenticated WiFi / unauthorized 802.1X port: no data
      const isFrom = link.from === id;
      const nextId = isFrom ? link.to : link.from;
      if (seen.has(nextId)) continue;
      const next = getDevice(nextId);
      if (!next || next.hidden || next.poweredOff) continue;
      if (next.type === "router" && nextId !== toId) continue;
      if (next.type === "switch" && next.config?.managed && vlanId != null) {
        const portVlans = normalisePortVlans(next.config.portVlans || {});
        const portModes = normalisePortModes(next.config.portModes || {});
        const trunkAllowed = normaliseTrunkAllowedVlans(next.config.trunkAllowedVlans || {});
        const ports = linkedPortsFor(next.id);
        const ingressIdx = ports.findIndex((p: any) => p?.peer?.id === id);
        const egressIdx = ports.findIndex((p: any) => p?.peer?.id === nextId);
        if (ingressIdx === -1 && id !== fromId) continue;
        const ingressPort = ingressIdx >= 0 ? `Ethernet${ingressIdx + 1}` : null;
        const egressPort = egressIdx >= 0 ? `Ethernet${egressIdx + 1}` : null;
        // Check ingress: trunk ports carry any allowed VLAN, access ports carry their assigned VLAN
        if (ingressPort) {
          const mode = portModes[ingressPort] || "access";
          if (mode === "trunk") {
            const allowed = trunkAllowed[ingressPort];
            if (allowed && allowed.length > 0 && !allowed.includes(vlanId)) continue;
          } else {
            if ((portVlans[ingressPort] || 1) !== vlanId) continue;
          }
        }
        // Check egress
        if (egressPort) {
          const mode = portModes[egressPort] || "access";
          if (mode === "trunk") {
            const allowed = trunkAllowed[egressPort];
            if (allowed && allowed.length > 0 && !allowed.includes(vlanId)) continue;
          } else {
            if ((portVlans[egressPort] || 1) !== vlanId) continue;
          }
        }
      }
      seen.add(nextId);
      queue.push(nextId);
    }
  }
  return false;
}

export function getVlanForDevice(deviceId: string): number {
  for (const link of linksFor(deviceId)) {
    if (link.hidden) continue;
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

export function findPingTarget(value: string): any {
  const target = String(value || "").trim().toLowerCase();
  return state.devices.find(device =>
    (device.type === "computer" || device.type === "laptop" || device.type === "server") && (
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
    (dev.type === "computer" || dev.type === "laptop" || dev.type === "server") &&
    dev.name.toLowerCase() === n);
  return d?.config?.ipv4Address || null;
}

// ─── Build initial simulation events for a ping ──────────────────────────────

/**
 * Validates inputs and generates the initial SimEvent(s) for a ping.
 * Returns a string error message if validation fails, or a PingSetup object.
 */
export function buildPingEvents(source: any, targetText: string, options: { ttl?: number } = {}): PingSetup | string {
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
  if (!firstHop) return `ping: connect: Network is unreachable (no link)`;

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
  if (!source.config?.ipv4Address) return `${source.name}: eth0 has no IPv4 address.`;
  if (!source.config?.macAddress) return `${source.name}: eth0 has no MAC address.`;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return `nc: invalid port ${port}`;

  const srcIp = source.config.ipv4Address;
  const srcMac = source.config.macAddress;
  const srcPort = 30000 + Math.floor(Math.random() * 20000); // ephemeral

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
  if (!firstHop) return `nc: Network is unreachable (no link)`;

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
 * Builds the initial events for a DNS lookup: a UDP/53 query to the host's
 * configured nameserver (ARP-ing the next hop first when its MAC is unknown,
 * exactly like ping). `then` names the follow-on flow the origin launches when
 * the answer arrives — "ping"/"tcp" for ping/nc-by-name, null for a bare
 * lookup (nslookup). The engine handles the response (engine.ts).
 */
export function buildResolveEvents(source: any, name: string, then: "ping" | "tcp" | null = null, port: number | null = null): PingSetup | string {
  if (!source.config?.ipv4Address) return `${source.name}: eth0 has no IPv4 address.`;
  if (!source.config?.macAddress) return `${source.name}: eth0 has no MAC address.`;
  const dnsIp = source.config?.dnsServerIp;
  if (!dnsIp || !isValidIpv4(dnsIp)) return `;; no nameserver configured (/etc/resolv.conf)`;

  const srcIp = source.config.ipv4Address;
  const srcMac = source.config.macAddress;
  const firstHop = findFirstHop(source);
  if (!firstHop) return `;; connection timed out; no servers could be reached (no link)`;

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
  let initialFrame: EthernetFrame;
  if (arpEntry) {
    initialFrame = createDnsQuery(srcMac, arpEntry.macAddress, srcIp, dnsIp, name);
  } else {
    initialFrame = createArpRequest(srcMac, srcIp, nextHopIp, null);
    pendingArp[`${source.id}:${nextHopIp}`] = [createDnsQuery(srcMac, "00:00:00:00:00:00", srcIp, dnsIp, name)];
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
  if (!source.config?.macAddress) return `${source.name}: eth0 has no MAC address.`;
  const firstHop = findFirstHop(source);
  if (!firstHop) return `dhcp: Network is unreachable (no link)`;

  const srcMac = source.config.macAddress;
  const transactionId = `dhcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
    if (!link.wireless || link.hidden || link.shutdown) continue;
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
  if (!["computer", "laptop", "server"].includes(host.type)) return `${host.name} is not a host (802.1X supplicant).`;
  const srcMac = host.config?.macAddress;
  if (!srcMac) return `${host.name}: eth0 has no MAC address.`;
  if (!host.config?.dot1x?.identity) return `${host.name} has no 802.1X identity — set one with "supplicant ${host.name} <identity> <password>".`;
  for (const link of linksFor(host.id)) {
    if (link.hidden || link.shutdown) continue;
    const info = dot1xLinkInfo(link);
    if (info && info.host.id === host.id) {
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

function findFirstHop(source: any): { peerId: string; linkId: string } | null {
  for (const link of linksFor(source.id)) {
    if (link.hidden || link.shutdown) continue; // a shut link carries no traffic
    if (!linkAuthorizedForData(link)) continue;  // unauthenticated WiFi / unauthorized 802.1X port: no data
    const isFrom = link.from === source.id;
    const peerId = isFrom ? link.to : link.from;
    const peer = getDevice(peerId);
    if (peer && !peer.hidden && !peer.poweredOff) return { peerId: peer.id, linkId: link.id };
  }
  return null;
}
