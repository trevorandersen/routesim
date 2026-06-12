import type { EthernetFrame, ArpPayload, Ipv4Payload, IcmpPayload, DhcpPayload, TcpPayload, TcpFlags, DnsPayload } from "./types";

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

// TCP segment (protocol 6) — the simulator models the three-way handshake
// (SYN / SYN-ACK / ACK) plus RST for refused connections.
export function createTcpSegment(
  srcMac: string, dstMac: string,
  srcIp: string, dstIp: string,
  srcPort: number, dstPort: number,
  flags: TcpFlags,
  ttl = 64, vlanTag: number | null = null
): EthernetFrame {
  const tcp: TcpPayload = { type: "tcp", srcPort, dstPort, flags };
  const ipv4: Ipv4Payload = { type: "ipv4", srcIp, dstIp, ttl, protocol: 6, payload: tcp };
  return { id: nextFrameId(), srcMac, dstMac, etherType: 0x0800, vlanTag, payload: ipv4 };
}

// DNS over UDP/53 (protocol 17). One question per query; the response carries
// the A-record address or null (NXDOMAIN). The id doubles as the PAT flow id.
let dnsIdCounter = 0;

export function createDnsQuery(
  srcMac: string, dstMac: string,
  srcIp: string, dstIp: string,
  name: string,
  id: number = ++dnsIdCounter,
  ttl = 64, vlanTag: number | null = null
): EthernetFrame {
  const dns: DnsPayload = { type: "dns", op: "query", id, name, address: null };
  const ipv4: Ipv4Payload = { type: "ipv4", srcIp, dstIp, ttl, protocol: 17, payload: dns };
  return { id: nextFrameId(), srcMac, dstMac, etherType: 0x0800, vlanTag, payload: ipv4 };
}

export function createDnsResponse(
  srcMac: string, dstMac: string,
  srcIp: string, dstIp: string,
  name: string, address: string | null,
  id: number,
  ttl = 64, vlanTag: number | null = null
): EthernetFrame {
  const dns: DnsPayload = { type: "dns", op: "response", id, name, address };
  const ipv4: Ipv4Payload = { type: "ipv4", srcIp, dstIp, ttl, protocol: 17, payload: dns };
  return { id: nextFrameId(), srcMac, dstMac, etherType: 0x0800, vlanTag, payload: ipv4 };
}

export function createDhcpDiscover(clientMac: string, transactionId: string, vlanTag: number | null = null): EthernetFrame {
  const dhcp: DhcpPayload = { type: "dhcp", messageType: "discover", transactionId, clientMac };
  const ipv4: Ipv4Payload = { type: "ipv4", srcIp: "0.0.0.0", dstIp: "255.255.255.255", ttl: 64, protocol: 17, payload: dhcp };
  return { id: nextFrameId(), srcMac: clientMac, dstMac: BROADCAST_MAC, etherType: 0x0800, vlanTag, payload: ipv4 };
}

export function createDhcpOffer(serverMac: string, serverIp: string, clientMac: string, assignedIp: string, transactionId: string, vlanTag: number | null = null, prefixLength?: number, gatewayIp: string = serverIp, dnsServerIp?: string): EthernetFrame {
  const dhcp: DhcpPayload = { type: "dhcp", messageType: "offer", transactionId, clientMac, assignedIp, prefixLength, gatewayIp, serverIp, ...(dnsServerIp ? { dnsServerIp } : {}) };
  const ipv4: Ipv4Payload = { type: "ipv4", srcIp: serverIp, dstIp: "255.255.255.255", ttl: 64, protocol: 17, payload: dhcp };
  return { id: nextFrameId(), srcMac: serverMac, dstMac: BROADCAST_MAC, etherType: 0x0800, vlanTag, payload: ipv4 };
}

export function createDhcpRequest(clientMac: string, requestedIp: string, serverIp: string, transactionId: string, vlanTag: number | null = null): EthernetFrame {
  const dhcp: DhcpPayload = { type: "dhcp", messageType: "request", transactionId, clientMac, requestedIp, serverIp };
  const ipv4: Ipv4Payload = { type: "ipv4", srcIp: "0.0.0.0", dstIp: "255.255.255.255", ttl: 64, protocol: 17, payload: dhcp };
  return { id: nextFrameId(), srcMac: clientMac, dstMac: BROADCAST_MAC, etherType: 0x0800, vlanTag, payload: ipv4 };
}

export function createDhcpAck(serverMac: string, serverIp: string, clientMac: string, assignedIp: string, transactionId: string, vlanTag: number | null = null, prefixLength?: number, gatewayIp: string = serverIp, dnsServerIp?: string): EthernetFrame {
  const dhcp: DhcpPayload = { type: "dhcp", messageType: "ack", transactionId, clientMac, assignedIp, prefixLength, gatewayIp, serverIp, ...(dnsServerIp ? { dnsServerIp } : {}) };
  const ipv4: Ipv4Payload = { type: "ipv4", srcIp: serverIp, dstIp: "255.255.255.255", ttl: 64, protocol: 17, payload: dhcp };
  return { id: nextFrameId(), srcMac: serverMac, dstMac: BROADCAST_MAC, etherType: 0x0800, vlanTag, payload: ipv4 };
}

// ── Packet-list columns (the Wireshark-style sim log) ────────────────────────

export interface PacketColumns {
  src: string;
  dst: string;
  protocol: string;
  info: string;
  tone: string;   // row colour class suffix: arp/icmp/icmp-reply/tcp/dns/dhcp/bad
}

// Wireshark-conventional Source/Destination/Protocol/Info for one frame.
// ARP rows show L2 addresses (as Wireshark does); IPv4 rows show addresses
// from the IP header. "bad" tones (RST, NXDOMAIN, TTL exceeded) colour red.
export function packetColumns(frame: EthernetFrame): PacketColumns {
  if (frame.payload.type === "arp") {
    const arp = frame.payload;
    return arp.operation === "request"
      ? { src: frame.srcMac, dst: "Broadcast", protocol: "ARP", info: `Who has ${arp.targetIp}? Tell ${arp.senderIp}`, tone: "arp" }
      : { src: frame.srcMac, dst: frame.dstMac, protocol: "ARP", info: `${arp.senderIp} is at ${arp.senderMac}`, tone: "arp" };
  }
  const ipv4 = frame.payload as Ipv4Payload;
  const src = ipv4.srcIp;
  const dst = ipv4.dstIp;
  const p = ipv4.payload;
  if (p.type === "icmp") {
    if (p.icmpType === 8) return { src, dst, protocol: "ICMP", info: `Echo (ping) request  seq=${p.sequence}, ttl=${ipv4.ttl}`, tone: "icmp" };
    if (p.icmpType === 0) return { src, dst, protocol: "ICMP", info: `Echo (ping) reply  seq=${p.sequence}, ttl=${ipv4.ttl}`, tone: "icmp-reply" };
    return { src, dst, protocol: "ICMP", info: "Time-to-live exceeded (Time to live exceeded in transit)", tone: "bad" };
  }
  if (p.type === "tcp") {
    const flags: Record<string, string> = { "syn": "[SYN]", "syn-ack": "[SYN, ACK]", "ack": "[ACK]", "rst": "[RST]" };
    return { src, dst, protocol: "TCP", info: `${p.srcPort} → ${p.dstPort} ${flags[p.flags] || ""} Len=0`, tone: p.flags === "rst" ? "bad" : "tcp" };
  }
  if (p.type === "dns") {
    const id = `0x${p.id.toString(16).padStart(4, "0")}`;
    if (p.op === "query") return { src, dst, protocol: "DNS", info: `Standard query ${id} A ${p.name}`, tone: "dns" };
    return p.address
      ? { src, dst, protocol: "DNS", info: `Standard query response ${id} A ${p.name} A ${p.address}`, tone: "dns" }
      : { src, dst, protocol: "DNS", info: `Standard query response ${id} No such name A ${p.name}`, tone: "bad" };
  }
  if (p.type === "dhcp") {
    const names: Record<string, string> = { discover: "DHCP Discover", offer: "DHCP Offer", request: "DHCP Request", ack: "DHCP ACK" };
    return { src, dst, protocol: "DHCP", info: `${names[p.messageType] || "DHCP"} - Transaction ID ${p.transactionId.slice(-8)}`, tone: "dhcp" };
  }
  return { src, dst, protocol: "IPv4", info: "", tone: "" };
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
    } else if (ipv4.payload.type === "tcp") {
      const labels: Record<string, string> = { "syn": "TCP SYN", "syn-ack": "TCP SYN-ACK", "ack": "TCP ACK", "rst": "TCP RST" };
      label = labels[ipv4.payload.flags] || "TCP";
    } else if (ipv4.payload.type === "dns") {
      label = ipv4.payload.op === "query" ? "DNS Query"
        : ipv4.payload.address ? "DNS Answer" : "DNS NXDOMAIN";
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
  if (ipv4.payload.type === "dns") return ipv4.payload.op === "response" && !ipv4.payload.address ? "#ef4444" : "#22d3ee"; // cyan (NXDOMAIN red)
  if (ipv4.payload.type === "tcp") return ipv4.payload.flags === "rst" ? "#ef4444" : "#fb923c"; // orange (RST red)
  if (ipv4.payload.type === "icmp" && ipv4.payload.icmpType === 8) return "#3b82f6"; // blue
  if (ipv4.payload.type === "icmp" && ipv4.payload.icmpType === 11) return "#ef4444"; // red (TTL exceeded)
  return "#22c55e";                                        // green
}
