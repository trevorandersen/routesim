import type { EthernetFrame, ArpPayload, Ipv4Payload, IcmpPayload, DhcpPayload } from "./types";

let frameCounter = 0;
function nextFrameId(): string {
  return `frame-${++frameCounter}-${Date.now()}`;
}

export const BROADCAST_MAC = "FF:FF:FF:FF:FF:FF";

export function createArpRequest(
  senderMac: string,
  senderIp: string,
  targetIp: string,
  vlanTag: number | null = null
): EthernetFrame {
  const payload: ArpPayload = {
    type: "arp",
    operation: "request",
    senderMac,
    senderIp,
    targetMac: "00:00:00:00:00:00",
    targetIp
  };
  return {
    id: nextFrameId(),
    srcMac: senderMac,
    dstMac: BROADCAST_MAC,
    etherType: 0x0806,
    vlanTag,
    payload
  };
}

export function createArpReply(
  senderMac: string,
  senderIp: string,
  targetMac: string,
  targetIp: string,
  vlanTag: number | null = null
): EthernetFrame {
  const payload: ArpPayload = {
    type: "arp",
    operation: "reply",
    senderMac,
    senderIp,
    targetMac,
    targetIp
  };
  return {
    id: nextFrameId(),
    srcMac: senderMac,
    dstMac: targetMac,
    etherType: 0x0806,
    vlanTag,
    payload
  };
}

export function createIcmpEchoRequest(
  srcMac: string,
  dstMac: string,
  srcIp: string,
  dstIp: string,
  ttl: number,
  vlanTag: number | null = null,
  seq: number = 1
): EthernetFrame {
  const icmp: IcmpPayload = { type: "icmp", icmpType: 8, sequence: seq };
  const ipv4: Ipv4Payload = { type: "ipv4", srcIp, dstIp, ttl, protocol: 1, payload: icmp };
  return {
    id: nextFrameId(),
    srcMac,
    dstMac,
    etherType: 0x0800,
    vlanTag,
    payload: ipv4
  };
}

export function createIcmpEchoReply(
  srcMac: string,
  dstMac: string,
  srcIp: string,
  dstIp: string,
  ttl: number,
  vlanTag: number | null = null,
  seq: number = 1
): EthernetFrame {
  const icmp: IcmpPayload = { type: "icmp", icmpType: 0, sequence: seq };
  const ipv4: Ipv4Payload = { type: "ipv4", srcIp, dstIp, ttl, protocol: 1, payload: icmp };
  return {
    id: nextFrameId(),
    srcMac,
    dstMac,
    etherType: 0x0800,
    vlanTag,
    payload: ipv4
  };
}

// ICMP Time-Exceeded (type 11) — sent by a router when a packet's TTL hits 0.
// This is the mechanism traceroute relies on to discover each hop.
export function createIcmpTimeExceeded(
  srcMac: string,
  dstMac: string,
  srcIp: string,
  dstIp: string,
  ttl: number = 64,
  vlanTag: number | null = null
): EthernetFrame {
  const icmp: IcmpPayload = { type: "icmp", icmpType: 11, sequence: 0 };
  const ipv4: Ipv4Payload = { type: "ipv4", srcIp, dstIp, ttl, protocol: 1, payload: icmp };
  return { id: nextFrameId(), srcMac, dstMac, etherType: 0x0800, vlanTag, payload: ipv4 };
}

export function createDhcpDiscover(clientMac: string, transactionId: string, vlanTag: number | null = null): EthernetFrame {
  const dhcp: DhcpPayload = { type: "dhcp", messageType: "discover", transactionId, clientMac };
  const ipv4: Ipv4Payload = { type: "ipv4", srcIp: "0.0.0.0", dstIp: "255.255.255.255", ttl: 64, protocol: 17, payload: dhcp };
  return { id: nextFrameId(), srcMac: clientMac, dstMac: BROADCAST_MAC, etherType: 0x0800, vlanTag, payload: ipv4 };
}

export function createDhcpOffer(serverMac: string, serverIp: string, clientMac: string, assignedIp: string, transactionId: string, vlanTag: number | null = null): EthernetFrame {
  const dhcp: DhcpPayload = { type: "dhcp", messageType: "offer", transactionId, clientMac, assignedIp, gatewayIp: serverIp, serverIp };
  const ipv4: Ipv4Payload = { type: "ipv4", srcIp: serverIp, dstIp: "255.255.255.255", ttl: 64, protocol: 17, payload: dhcp };
  return { id: nextFrameId(), srcMac: serverMac, dstMac: BROADCAST_MAC, etherType: 0x0800, vlanTag, payload: ipv4 };
}

export function createDhcpRequest(clientMac: string, requestedIp: string, serverIp: string, transactionId: string, vlanTag: number | null = null): EthernetFrame {
  const dhcp: DhcpPayload = { type: "dhcp", messageType: "request", transactionId, clientMac, requestedIp, serverIp };
  const ipv4: Ipv4Payload = { type: "ipv4", srcIp: "0.0.0.0", dstIp: "255.255.255.255", ttl: 64, protocol: 17, payload: dhcp };
  return { id: nextFrameId(), srcMac: clientMac, dstMac: BROADCAST_MAC, etherType: 0x0800, vlanTag, payload: ipv4 };
}

export function createDhcpAck(serverMac: string, serverIp: string, clientMac: string, assignedIp: string, transactionId: string, vlanTag: number | null = null): EthernetFrame {
  const dhcp: DhcpPayload = { type: "dhcp", messageType: "ack", transactionId, clientMac, assignedIp, gatewayIp: serverIp, serverIp };
  const ipv4: Ipv4Payload = { type: "ipv4", srcIp: serverIp, dstIp: "255.255.255.255", ttl: 64, protocol: 17, payload: dhcp };
  return { id: nextFrameId(), srcMac: serverMac, dstMac: BROADCAST_MAC, etherType: 0x0800, vlanTag, payload: ipv4 };
}

export function frameLabel(frame: EthernetFrame): string {
  let label: string;
  if (frame.payload.type === "arp") {
    label = frame.payload.operation === "request" ? "ARP Req" : "ARP Reply";
  } else {
    const ipv4 = frame.payload as Ipv4Payload;
    if (ipv4.payload.type === "dhcp") {
      const dhcp = ipv4.payload as DhcpPayload;
      const labels: Record<string, string> = { discover: "DHCP Disc", offer: "DHCP Offer", request: "DHCP Req", ack: "DHCP ACK" };
      label = labels[dhcp.messageType] || "DHCP";
    } else if (ipv4.payload.type === "icmp") {
      label = ipv4.payload.icmpType === 8 ? "ICMP Echo"
        : ipv4.payload.icmpType === 11 ? "ICMP TTL Exceeded"
        : "ICMP Reply";
    } else {
      label = "Frame";
    }
  }
  if (frame.vlanTag != null) label += ` [V${frame.vlanTag}]`;
  return label;
}

export function frameColor(frame: EthernetFrame): string {
  if (frame.payload.type === "arp") return "#f59e0b";    // amber
  const ipv4 = frame.payload as Ipv4Payload;
  if (ipv4.payload.type === "dhcp") return "#a78bfa";    // violet
  if (ipv4.payload.type === "icmp" && ipv4.payload.icmpType === 8) return "#3b82f6"; // blue
  if (ipv4.payload.type === "icmp" && ipv4.payload.icmpType === 11) return "#ef4444"; // red (TTL exceeded)
  return "#22c55e";                                        // green
}
