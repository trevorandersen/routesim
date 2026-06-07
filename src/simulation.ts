import type { SimEvent, EthernetFrame } from "./types";
import { state } from "./state";
import { getDevice, linkedPortsFor, linksFor } from "./devices";
import { normalisePortVlans, normalisePortModes, normaliseTrunkAllowedVlans } from "./normalise";
import { isValidIpv4, sameSubnet24 } from "./utils";
import { createArpRequest, createIcmpEchoRequest, createDhcpDiscover } from "./frame";

export interface PingSetup {
  events: SimEvent[];
  pendingArp: Record<string, EthernetFrame[]>;
}

// ─── Utilities kept from original simulation ─────────────────────────────────

export function l2Reachable(fromId: string, toId: string, vlanId: number | null): boolean {
  const queue = [fromId];
  const seen = new Set(queue);
  while (queue.length) {
    const id = queue.shift()!;
    if (id === toId) return true;
    for (const link of linksFor(id)) {
      if (link.hidden) continue;
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
        const ingressIdx = ports.findIndex((p: any) => p.peer.id === id);
        const egressIdx = ports.findIndex((p: any) => p.peer.id === nextId);
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

export function devicesHavePath(fromId: string, toId: string): boolean {
  return l2Reachable(fromId, toId, null);
}

export function getVlanForDevice(deviceId: string): number {
  for (const link of linksFor(deviceId)) {
    if (link.hidden) continue;
    const isFrom = link.from === deviceId;
    const switchId = isFrom ? link.to : link.from;
    const sw = getDevice(switchId);
    if (!sw || sw.type !== "switch" || !sw.config?.managed) continue;
    const ports = linkedPortsFor(sw.id);
    const portIdx = ports.findIndex((p: any) => p.peer.id === deviceId);
    if (portIdx === -1) continue;
    const portName = `Ethernet${portIdx + 1}`;
    const portVlans = normalisePortVlans(sw.config.portVlans || {});
    return portVlans[portName] || 1;
  }
  return 1;
}

export function findPingTarget(value: string): any {
  const target = String(value || "").trim().toLowerCase();
  return state.devices.find(device =>
    device.type === "computer" && (
      String(device.config?.ipv4Address || "").toLowerCase() === target ||
      device.name.toLowerCase() === target
    )
  );
}

// ─── Build initial simulation events for a ping ──────────────────────────────

/**
 * Validates inputs and generates the initial SimEvent(s) for a ping.
 * Returns a string error message if validation fails, or a PingSetup object.
 */
export function buildPingEvents(source: any, targetText: string): PingSetup | string {
  if (!source.config?.ipv4Address) return `${source.name}: eth0 has no IPv4 address.`;
  if (!source.config?.macAddress) return `${source.name}: eth0 has no MAC address.`;

  const srcIp = source.config.ipv4Address;
  const srcMac = source.config.macAddress;

  // Resolve the destination IP. The target may be a known device (matched by
  // name or IP) or a bare IP address that belongs to no device. In the latter
  // case we still emit a real ARP request and let it time out, rather than
  // "magically" reporting the host as unreachable before any frame is sent.
  const target = findPingTarget(targetText);
  let dstIp: string;
  if (target) {
    if (!target.config?.ipv4Address) return `${target.name}: eth0 has no IPv4 address.`;
    dstIp = target.config.ipv4Address;
  } else if (isValidIpv4(targetText.trim())) {
    dstIp = targetText.trim();
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

  if (sameSubnet24(srcIp, dstIp)) {
    // Same subnet — check ARP cache
    const arpEntry = (source.config.arpTable || []).find((e: any) => e.ipv4Address === dstIp);
    let initialFrame;
    if (arpEntry) {
      initialFrame = createIcmpEchoRequest(srcMac, arpEntry.macAddress, srcIp, dstIp, 64, vlanTag);
    } else {
      // ARP first, defer the ICMP
      initialFrame = createArpRequest(srcMac, srcIp, dstIp, vlanTag);
      const deferredIcmp = createIcmpEchoRequest(srcMac, "00:00:00:00:00:00", srcIp, dstIp, 64, vlanTag);
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
  if (!sameSubnet24(gwIp, srcIp)) return `ping: connect: Network is unreachable (gateway not on source subnet)`;

  // Always hand the packet to the default gateway via an ARP (unless the gateway
  // MAC is already cached). Whether the destination is actually routable is then
  // decided by the simulation — the router forwards it or drops it ("No route"),
  // and a non-existent gateway/host makes the ARP or routed packet time out.
  // We deliberately do NOT pre-check reachability here, so the ARP is always seen.
  const gwArpEntry = (source.config.arpTable || []).find((e: any) => e.ipv4Address === gwIp);
  let initialFrame;
  if (gwArpEntry) {
    initialFrame = createIcmpEchoRequest(srcMac, gwArpEntry.macAddress, srcIp, dstIp, 64, vlanTag);
  } else {
    initialFrame = createArpRequest(srcMac, srcIp, gwIp, vlanTag);
    const deferredIcmp = createIcmpEchoRequest(srcMac, "00:00:00:00:00:00", srcIp, dstIp, 64, vlanTag);
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

function findFirstHop(source: any): { peerId: string; linkId: string } | null {
  for (const link of linksFor(source.id)) {
    if (link.hidden) continue;
    const isFrom = link.from === source.id;
    const peerId = isFrom ? link.to : link.from;
    const peer = getDevice(peerId);
    if (peer && !peer.hidden && !peer.poweredOff) return { peerId: peer.id, linkId: link.id };
  }
  return null;
}
