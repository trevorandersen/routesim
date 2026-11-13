import type { EthernetFrame, ArpPayload, Ipv4Payload, IcmpPayload, IcmpOriginal, DhcpPayload, TcpPayload, TcpFlags, HttpInfo, DnsPayload, Dot11Payload, Dot11Subtype, Dot1xPayload, Dot1xSubtype, BpduPayload } from "./types";

let frameCounter = 0;
function nextFrameId(): string {
  // A monotonic counter already makes this unique per session; no wall-clock
  // component, so an identical run reproduces identical frame ids (determinism).
  return `frame-${++frameCounter}`;
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

// The embedded-original summary an ICMP error carries — derived from the
// offending datagram at the point of failure (post-NAT, exactly as a real
// router copies the in-flight header). A NAT router on the return path uses it
// to match the error to a translation (natRestoreInbound), which is what makes
// traceroute work from behind NAT.
export function icmpOriginalOf(ipv4: Ipv4Payload): IcmpOriginal | undefined {
  const p = ipv4.payload;
  if (p.type === "icmp") return { srcIp: ipv4.srcIp, dstIp: ipv4.dstIp, proto: "icmp", flowId: p.sequence };
  if (p.type === "tcp") return { srcIp: ipv4.srcIp, dstIp: ipv4.dstIp, proto: "tcp", flowId: p.srcPort };
  if (p.type === "dns") return { srcIp: ipv4.srcIp, dstIp: ipv4.dstIp, proto: "udp", flowId: p.id };
  return undefined;
}

// ICMP Time-Exceeded (type 11) — sent by a router when a packet's TTL hits 0.
// This is the mechanism traceroute relies on to discover each hop.
export function createIcmpTimeExceeded(
  srcMac: string,
  dstMac: string,
  srcIp: string,
  dstIp: string,
  ttl: number = 64,
  vlanTag: number | null = null,
  original?: IcmpOriginal
): EthernetFrame {
  const icmp: IcmpPayload = { type: "icmp", icmpType: 11, sequence: 0, ...(original ? { original } : {}) };
  const ipv4: Ipv4Payload = { type: "ipv4", srcIp, dstIp, ttl, protocol: 1, payload: icmp };
  return { id: nextFrameId(), srcMac, dstMac, etherType: 0x0800, vlanTag, payload: ipv4 };
}

// ICMP Destination Unreachable (type 3) — a firewall/router sends this when it
// REJECTs a non-TCP packet (a TCP REJECT sends a RST instead, so a scan reads
// the port as closed).
export function createIcmpDestUnreachable(
  srcMac: string,
  dstMac: string,
  srcIp: string,
  dstIp: string,
  ttl: number = 64,
  vlanTag: number | null = null,
  original?: IcmpOriginal
): EthernetFrame {
  const icmp: IcmpPayload = { type: "icmp", icmpType: 3, sequence: 0, ...(original ? { original } : {}) };
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

// HTTP rides an established TCP connection: the request/response is carried on a
// data (ACK) segment, tagged with the HTTP payload so the packet list shows it
// as HTTP. GET request →
export function createHttpRequest(
  srcMac: string, dstMac: string,
  srcIp: string, dstIp: string,
  srcPort: number, dstPort: number,
  path: string, host: string,
  ttl = 64, vlanTag: number | null = null
): EthernetFrame {
  const http: HttpInfo = { kind: "request", method: "GET", path, host };
  const tcp: TcpPayload = { type: "tcp", srcPort, dstPort, flags: "ack", http };
  const ipv4: Ipv4Payload = { type: "ipv4", srcIp, dstIp, ttl, protocol: 6, payload: tcp };
  return { id: nextFrameId(), srcMac, dstMac, etherType: 0x0800, vlanTag, payload: ipv4 };
}

// ← response (status + the served page's one-line body).
export function createHttpResponse(
  srcMac: string, dstMac: string,
  srcIp: string, dstIp: string,
  srcPort: number, dstPort: number,
  status: number, statusText: string, title: string,
  ttl = 64, vlanTag: number | null = null
): EthernetFrame {
  const http: HttpInfo = { kind: "response", status, statusText, title };
  const tcp: TcpPayload = { type: "tcp", srcPort, dstPort, flags: "ack", http };
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

// An 802.11 management / EAPOL frame (the join handshake between a laptop and
// its access point). etherType 0x888e is EAPOL's real value; the management
// subtypes reuse it as a single "this is a WiFi control frame" marker.
export function createDot11Frame(srcMac: string, dstMac: string, subtype: Dot11Subtype, ssid: string): EthernetFrame {
  const payload: Dot11Payload = { type: "dot11", subtype, ssid };
  return { id: nextFrameId(), srcMac, dstMac, etherType: 0x888e, vlanTag: null, payload };
}

// An 802.1X EAPOL / EAP / RADIUS frame (etherType 0x888e — EAPOL; RADIUS is
// really UDP/1812, abstracted here to one authenticator↔server hop).
export function createDot1xFrame(srcMac: string, dstMac: string, subtype: Dot1xSubtype, identity?: string, supplicantMac?: string): EthernetFrame {
  const payload: Dot1xPayload = { type: "dot1x", subtype, ...(identity ? { identity } : {}), ...(supplicantMac ? { supplicantMac } : {}) };
  return { id: nextFrameId(), srcMac, dstMac, etherType: 0x888e, vlanTag: null, payload };
}

// The IEEE 802.1D bridge group address — every bridge listens for BPDUs here.
export const BPDU_GROUP_MAC = "01:80:C2:00:00:00";

// A Spanning Tree Configuration BPDU. Always addressed to the bridge group MAC,
// never VLAN-tagged. (Real BPDUs are LLC-framed with no EtherType; we tag a
// sentinel 0x0802 — see BpduPayload.)
export function createBpduFrame(srcMac: string, rootId: string, bridgeId: string, rootCost: number, portId: string, flavour: "config" | "tcn" = "config"): EthernetFrame {
  const payload: BpduPayload = { type: "bpdu", flavour, rootId, bridgeId, rootCost, portId };
  return { id: nextFrameId(), srcMac, dstMac: BPDU_GROUP_MAC, etherType: 0x0802, vlanTag: null, payload };
}

// ── Packet-list columns (the Wireshark-style sim log) ────────────────────────

export interface PacketColumns {
  src: string;
  dst: string;
  protocol: string;
  info: string;
  tone: string;   // row colour class suffix: arp/icmp/icmp-reply/tcp/dns/dhcp/dot11/stp/bad
}

// Wireshark-style Info text for an 802.11 management / EAPOL frame.
function dot11Info(subtype: Dot11Subtype, ssid: string): string {
  switch (subtype) {
    case "probe-req": return `Probe Request, SSID="${ssid}"`;
    case "probe-resp": return `Probe Response, SSID="${ssid}"`;
    case "auth-req": return "Authentication, Open System (seq 1)";
    case "auth-resp": return "Authentication, Open System (seq 2, Successful)";
    case "assoc-req": return `Association Request, SSID="${ssid}"`;
    case "assoc-resp": return "Association Response, Successful (AID 1)";
    case "eapol-start": return "Key (EAPOL Start)";
    case "eapol-m1": return "Key (Message 1 of 4)";
    case "eapol-m2": return "Key (Message 2 of 4)";
    case "eapol-m3": return "Key (Message 3 of 4)";
    case "eapol-m4": return "Key (Message 4 of 4)";
    case "deauth": return "Deauthentication, reason 15 (4-way handshake timeout / MIC failure)";
  }
}

// Wireshark-style Info + protocol for an 802.1X EAPOL / EAP / RADIUS frame.
function dot1xInfo(subtype: Dot1xSubtype, identity?: string): { protocol: string; info: string } {
  const id = identity ? ` (id "${identity}")` : "";
  switch (subtype) {
    case "eapol-start": return { protocol: "EAPOL", info: "Start" };
    case "eap-req-id": return { protocol: "EAP", info: "Request, Identity" };
    case "eap-resp-id": return { protocol: "EAP", info: `Response, Identity${id}` };
    case "radius-request": return { protocol: "RADIUS", info: `Access-Request${id}` };
    case "radius-accept": return { protocol: "RADIUS", info: "Access-Accept" };
    case "radius-reject": return { protocol: "RADIUS", info: "Access-Reject" };
    case "eap-success": return { protocol: "EAP", info: "Success" };
    case "eap-failure": return { protocol: "EAP", info: "Failure" };
  }
}

export function dot1xLabel(subtype: Dot1xSubtype): string {
  const labels: Record<Dot1xSubtype, string> = {
    "eapol-start": "EAPOL Start", "eap-req-id": "EAP Req-ID", "eap-resp-id": "EAP Resp-ID",
    "radius-request": "RADIUS Req", "radius-accept": "RADIUS Accept", "radius-reject": "RADIUS Reject",
    "eap-success": "EAP Success", "eap-failure": "EAP Failure",
  };
  return labels[subtype];
}

// Short label for the canvas transit dot.
export function dot11Label(subtype: Dot11Subtype): string {
  const labels: Record<Dot11Subtype, string> = {
    "probe-req": "Probe Req", "probe-resp": "Probe Resp",
    "auth-req": "Auth", "auth-resp": "Auth OK",
    "assoc-req": "Assoc Req", "assoc-resp": "Assoc OK",
    "eapol-start": "EAPOL Start", "eapol-m1": "EAPOL M1", "eapol-m2": "EAPOL M2",
    "eapol-m3": "EAPOL M3", "eapol-m4": "EAPOL M4", "deauth": "Deauth",
  };
  return labels[subtype];
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
  if (frame.payload.type === "dot11") {
    const d = frame.payload;
    const eapol = d.subtype.startsWith("eapol");
    return { src: frame.srcMac, dst: frame.dstMac, protocol: eapol ? "EAPOL" : "802.11", info: dot11Info(d.subtype, d.ssid), tone: d.subtype === "deauth" ? "bad" : "dot11" };
  }
  if (frame.payload.type === "dot1x") {
    const d = frame.payload;
    const { protocol, info } = dot1xInfo(d.subtype, d.identity);
    const bad = d.subtype === "radius-reject" || d.subtype === "eap-failure";
    return { src: frame.srcMac, dst: frame.dstMac, protocol, info, tone: bad ? "bad" : "dot11" };
  }
  if (frame.payload.type === "bpdu") {
    const b = frame.payload;
    const info = b.flavour === "tcn"
      ? "Topology Change Notification"
      : `Conf. Root = ${b.rootId}  Cost = ${b.rootCost}  Bridge = ${b.bridgeId}  Port = ${b.portId}`;
    return { src: frame.srcMac, dst: "Spanning-tree (bridges)", protocol: "STP", info, tone: "stp" };
  }
  const ipv4 = frame.payload; // narrowed to Ipv4Payload after the arp/dot11/bpdu branches return
  const src = ipv4.srcIp;
  const dst = ipv4.dstIp;
  const p = ipv4.payload;
  if (p.type === "icmp") {
    if (p.icmpType === 8) return { src, dst, protocol: "ICMP", info: `Echo (ping) request  seq=${p.sequence}, ttl=${ipv4.ttl}`, tone: "icmp" };
    if (p.icmpType === 0) return { src, dst, protocol: "ICMP", info: `Echo (ping) reply  seq=${p.sequence}, ttl=${ipv4.ttl}`, tone: "icmp-reply" };
    if (p.icmpType === 3) return { src, dst, protocol: "ICMP", info: "Destination unreachable (Port unreachable)", tone: "bad" };
    return { src, dst, protocol: "ICMP", info: "Time-to-live exceeded (Time to live exceeded in transit)", tone: "bad" };
  }
  if (p.type === "tcp") {
    if (p.http) {
      const info = p.http.kind === "request"
        ? `${p.http.method} ${p.http.path} HTTP/1.1  (Host: ${p.http.host})`
        : `HTTP/1.1 ${p.http.status} ${p.http.statusText}`;
      const bad = p.http.kind === "response" && (p.http.status == null || p.http.status >= 400);
      return { src, dst, protocol: "HTTP", info, tone: bad ? "bad" : "http" };
    }
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
  } else if (frame.payload.type === "dot11") {
    label = dot11Label(frame.payload.subtype);
  } else if (frame.payload.type === "dot1x") {
    label = dot1xLabel(frame.payload.subtype);
  } else if (frame.payload.type === "bpdu") {
    label = frame.payload.flavour === "tcn" ? "STP TCN" : "BPDU";
  } else {
    const ipv4 = frame.payload; // narrowed to Ipv4Payload after the arp branch returns
    if (ipv4.payload.type === "dhcp") {
      const dhcp = ipv4.payload as DhcpPayload;
      const labels: Record<string, string> = { discover: "DHCP Disc", offer: "DHCP Offer", request: "DHCP Req", ack: "DHCP ACK" };
      label = labels[dhcp.messageType] || "DHCP";
    } else if (ipv4.payload.type === "tcp") {
      if (ipv4.payload.http) {
        label = ipv4.payload.http.kind === "request" ? "HTTP GET" : `HTTP ${ipv4.payload.http.status}`;
      } else {
        const labels: Record<string, string> = { "syn": "TCP SYN", "syn-ack": "TCP SYN-ACK", "ack": "TCP ACK", "rst": "TCP RST" };
        label = labels[ipv4.payload.flags] || "TCP";
      }
    } else if (ipv4.payload.type === "dns") {
      label = ipv4.payload.op === "query" ? "DNS Query"
        : ipv4.payload.address ? "DNS Answer" : "DNS NXDOMAIN";
    } else if (ipv4.payload.type === "icmp") {
      label = ipv4.payload.icmpType === 8 ? "ICMP Echo"
        : ipv4.payload.icmpType === 11 ? "ICMP TTL Exceeded"
        : ipv4.payload.icmpType === 3 ? "ICMP Unreachable"
        : "ICMP Reply";
    } else {
      label = "Frame";
    }
  }
  if (frame.vlanTag != null) label += ` [V${frame.vlanTag}]`;
  return label;
}

// A monochrome glyph per packet category — the redundant, colour-blind-safe
// channel that pairs with `frameColor`/the row tint, so meaning is never carried
// by colour alone (see the "Perceivable by everyone" principle in CLAUDE.md).
// Keyed off `packetColumns`' `tone`, so the packet list and the canvas transit
// dots speak the same language. Errors collapse to "✕" (the protocol still reads
// in the Protocol/Info columns); the mnemonic letters sit next to the protocol
// name in the list, so the mapping is self-documenting.
const TONE_GLYPH: Record<string, string> = {
  arp: "A", icmp: "I", "icmp-reply": "I", tcp: "T", http: "H",
  dns: "N", dhcp: "D", stp: "S", dot11: "W", macsec: "K", bad: "✕",
};
export function toneGlyph(tone: string): string { return TONE_GLYPH[tone] ?? "•"; }
export function frameGlyph(frame: EthernetFrame): string { return toneGlyph(packetColumns(frame).tone); }

export function frameColor(frame: EthernetFrame): string {
  if (frame.payload.type === "arp") return "#f59e0b";    // amber
  if (frame.payload.type === "dot11") return "#14b8a6";  // teal (802.11 management)
  if (frame.payload.type === "dot1x") {
    const bad = frame.payload.subtype === "radius-reject" || frame.payload.subtype === "eap-failure";
    return bad ? "#ef4444" : "#14b8a6"; // teal, red on reject/failure
  }
  if (frame.payload.type === "bpdu") return "#818cf8";   // indigo (spanning-tree BPDU)
  const ipv4 = frame.payload; // narrowed to Ipv4Payload after the arp/dot11/bpdu branches return
  if (ipv4.payload.type === "dhcp") return "#a78bfa";    // violet
  if (ipv4.payload.type === "dns") return ipv4.payload.op === "response" && !ipv4.payload.address ? "#ef4444" : "#22d3ee"; // cyan (NXDOMAIN red)
  if (ipv4.payload.type === "tcp") {
    if (ipv4.payload.http) {
      const bad = ipv4.payload.http.kind === "response" && (ipv4.payload.http.status == null || ipv4.payload.http.status >= 400);
      return bad ? "#ef4444" : "#a3e635"; // lime (HTTP); red on a 4xx/5xx
    }
    return ipv4.payload.flags === "rst" ? "#ef4444" : "#fb923c"; // orange (RST red)
  }
  if (ipv4.payload.type === "icmp" && ipv4.payload.icmpType === 8) return "#3b82f6"; // blue
  if (ipv4.payload.type === "icmp" && (ipv4.payload.icmpType === 11 || ipv4.payload.icmpType === 3)) return "#ef4444"; // red (TTL exceeded / unreachable)
  return "#22c55e";                                        // green
}

// ─── Packet callouts (issue #2) ──────────────────────────────────────────────

// One token of a callout line. `changed` marks a field the device at the last
// hop rewrote (vs the frame it received), so the callout can flag it — with a
// marker, never colour alone.
export interface CalloutToken { t: string; changed?: boolean; echoed?: boolean }

// A MAC shown short: the last two octets (…:aa:bb), enough to tell hops apart
// without widening the callout. Broadcast/zero stay recognisable.
export function shortMac(mac: string): string {
  if (!mac) return "—";
  if (/^ff:ff:ff:ff:ff:ff$/i.test(mac)) return "bcast";
  if (/^0{2}(:0{2}){5}$/.test(mac)) return "—";
  const parts = mac.split(":");
  return parts.length >= 2 ? `…${parts.slice(-2).join(":")}` : mac;
}

// A flat field map of a frame, for diffing one hop against the previous.
function calloutFieldMap(frame: EthernetFrame): Record<string, string> {
  const f: Record<string, string> = { srcMac: frame.srcMac || "", dstMac: frame.dstMac || "" };
  const p: any = frame.payload;
  if (p.type === "arp") { f.senderIp = p.senderIp; f.senderMac = p.senderMac; f.targetIp = p.targetIp; }
  else if (p.type === "ipv4") {
    f.srcIp = p.srcIp; f.dstIp = p.dstIp; f.ttl = String(p.ttl);
    const inner = p.payload;
    if (inner?.type === "tcp") { f.srcPort = String(inner.srcPort); f.dstPort = String(inner.dstPort); f.flags = inner.flags; }
    else if (inner?.type === "dns") { f.dnsName = inner.name; }
  }
  return f;
}

// The callout for a frame in flight: up to two lines of tokens — the network/
// transport summary, then the link (MAC) pair — with each field that the last
// hop rewrote flagged `changed`. `prevFrame` is the frame the hop received; with
// none (the first leg) nothing is flagged.
export function frameCalloutLines(frame: EthernetFrame, prevFrame?: EthernetFrame): CalloutToken[][] {
  const cur = calloutFieldMap(frame);
  const old = prevFrame ? calloutFieldMap(prevFrame) : null;
  const chg = (k: string) => !!old && k in old && k in cur && old[k] !== cur[k];
  const lines: CalloutToken[][] = [];
  const p: any = frame.payload;

  if (p.type === "arp") {
    if (p.operation === "request") lines.push([{ t: "who-has " }, { t: p.targetIp, changed: chg("targetIp") }]);
    // Reply: the senderIp is the address the request asked about — echoed back —
    // while is-at carries the new answer (the MAC).
    else lines.push([{ t: p.senderIp, changed: chg("senderIp"), echoed: true }, { t: " is-at " }, { t: shortMac(p.senderMac), changed: chg("senderMac") }]);
  } else if (p.type === "ipv4") {
    const inner = p.payload;
    // A reply returns to whoever asked: its destination echoes the request's
    // source. Marked on the clear response types so the conversation is legible.
    const isReply = (inner?.type === "icmp" && inner.icmpType === 0)
      || (inner?.type === "tcp" && inner.flags === "syn-ack")
      || (inner?.type === "dns" && inner.op === "response");
    lines.push([{ t: p.srcIp, changed: chg("srcIp") }, { t: " → " }, { t: p.dstIp, changed: chg("dstIp"), echoed: isReply }]);
    if (inner?.type === "tcp") {
      // A SYN-ACK echoes the handshake's ports (swapped from the SYN).
      const echoed = inner.flags === "syn-ack";
      lines.push([{ t: `${String(inner.flags).toUpperCase()} ` }, { t: `:${inner.dstPort}`, changed: chg("dstPort"), echoed }, { t: ` ←:${inner.srcPort}`, changed: chg("srcPort"), echoed }]);
    } else if (inner?.type === "dns") {
      // The response echoes the queried name; the address is the new answer.
      const echoed = inner.op === "response";
      const line: CalloutToken[] = [{ t: "dns " }, { t: inner.name, echoed }];
      if (inner.address) line.push({ t: ` = ${inner.address}` });
      lines.push(line);
    } else if (inner?.type === "dhcp") {
      lines.push([{ t: `dhcp ${inner.messageType}` }]);
    }
  } else if (p.type === "bpdu") {
    lines.push([{ t: "BPDU" }]);
  } else if (p.type === "dot11" || p.type === "dot1x") {
    lines.push([{ t: String(p.subtype || p.type) }]);
  }

  // The link (MAC) pair — always, since it is what a router rewrites each hop.
  lines.push([{ t: shortMac(frame.srcMac), changed: chg("srcMac") }, { t: " ▸ " }, { t: shortMac(frame.dstMac), changed: chg("dstMac") }]);
  return lines;
}
