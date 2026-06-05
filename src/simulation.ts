import type { SimEvent, EthernetFrame } from "./types";
import { state } from "./state";
import { getDevice, linkedPortsFor, linksFor } from "./devices";
import { normalisePortVlans, normalisePortModes, normaliseTrunkAllowedVlans, normaliseStaticRoutes } from "./normalise";
import { isValidIpv4, sameSubnet24, ipv4ToInt } from "./utils";
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

function routeCoversSubnet(destIp: string, network: string): boolean {
  const slash = network.indexOf("/");
  const netIp = slash >= 0 ? network.slice(0, slash) : network;
  if (!isValidIpv4(netIp) || !isValidIpv4(destIp)) return false;
  return (ipv4ToInt(destIp) >>> 8) === (ipv4ToInt(netIp) >>> 8);
}

export function findRouterBetweenSubnets(sourceIp: string, destIp: string): any {
  for (const device of state.devices) {
    if (device.type !== "router" || device.hidden || device.poweredOff) continue;
    const ifaces = device.config?.interfaces;
    if (!Array.isArray(ifaces)) continue;
    let sourceIface: any = null;
    let destIface: any = null;
    for (const iface of ifaces) {
      const ip = iface.ipv4Address;
      if (!ip || !isValidIpv4(ip)) continue;
      if (sameSubnet24(ip, sourceIp)) sourceIface = iface;
      if (sameSubnet24(ip, destIp)) destIface = iface;
    }
    if (sourceIface && destIface) {
      return { router: device, sourceIface, destIface };
    }
    // Fallback: source interface is connected, but dest might be reachable via static/RIP route
    if (sourceIface && !destIface) {
      const statics = normaliseStaticRoutes(device.config?.staticRoutes || []);
      const hasStaticRoute = statics.some(r => routeCoversSubnet(destIp, r.network));
      const ripRoutes = device.config?.rip?.enabled && Array.isArray(device.config.rip.learnedRoutes)
        ? device.config.rip.learnedRoutes : [];
      const hasRipRoute = ripRoutes.some((r: any) => routeCoversSubnet(destIp, r.network));
      if (hasStaticRoute || hasRipRoute) {
        return { router: device, sourceIface, destIface: sourceIface };
      }
    }
  }
  return null;
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

  const target = findPingTarget(targetText);
  if (!target) return `ping: cannot resolve ${targetText}`;

  const srcIp = source.config.ipv4Address;
  const srcMac = source.config.macAddress;
  const dstIp = target.config?.ipv4Address;
  if (!dstIp) return `${target.name}: eth0 has no IPv4 address.`;

  // Self-ping: instant
  if (target.id === source.id) {
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

  const routeInfo = findRouterBetweenSubnets(srcIp, dstIp);
  if (!routeInfo) return `PING ${dstIp}\n\n--- ${dstIp} ping statistics ---\n1 packets transmitted, 0 received, 100% packet loss`;
  if (gwIp !== routeInfo.sourceIface.ipv4Address) return `PING ${dstIp}\n\n--- ${dstIp} ping statistics ---\n1 packets transmitted, 0 received, 100% packet loss`;

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
