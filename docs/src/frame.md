# `src/frame.ts` — Ethernet frame factories

Builds the `EthernetFrame` objects that flow through the simulation, plus helpers to label and colour them for display.

## Key exports

- **`BROADCAST_MAC`** — `ff:ff:ff:ff:ff:ff`.
- **Factories** — each returns a fully-formed `EthernetFrame` with the right `etherType`, MACs, IPv4 envelope (where applicable), and a unique frame id:
  - `createArpRequest`, `createArpReply`
  - `createIcmpEchoRequest`, `createIcmpEchoReply`, `createIcmpTimeExceeded` (type 11 — sent by a router on TTL 0; the signal traceroute discovers each hop from), `createIcmpDestUnreachable` (type 3 — sent by a firewall/router when it REJECTs a non-TCP packet; a TCP REJECT sends a RST via `createTcpSegment` with flag `"rst"` instead)
  - `createDhcpDiscover`, `createDhcpOffer`, `createDhcpRequest`, `createDhcpAck` (Offer/Ack also carry the prefix length, gateway — defaulting to the server itself, as dnsmasq does — and optional nameserver, option 6)
  - `createTcpSegment` (SYN/SYN-ACK/ACK/RST — the L4 handshake)
  - `createDnsQuery`, `createDnsResponse` (UDP/53; `address: null` = NXDOMAIN; a module counter issues transaction ids)
  - `createDot11Frame`, `createDot1xFrame` (WiFi association / 802.1X port auth — etherType `0x888e`, no IPv4 envelope)
  - `createBpduFrame` (a Configuration BPDU for spanning tree — see Notes)
  - All accept an optional `vlanTag` for 802.1Q tagging.
- **`frameLabel(frame)`** — a short human label (e.g. `"ARP Req"`, `"ICMP Echo"`, `"ICMP TTL Exceeded"`, `"ICMP Unreachable"`, `"DHCP Offer"`) shown on transit dots and in link history.
- **`frameColor(frame)`** — the colour for the frame type (amber ARP, blue ICMP request, green ICMP reply, violet DHCP, orange TCP, cyan DNS, teal 802.11/802.1X, indigo `#818cf8` BPDU; red for ICMP Time-Exceeded, ICMP Destination Unreachable, TCP RST, NXDOMAIN, and WiFi/802.1X deauth/reject).
- **`packetColumns(frame)`** — the Wireshark-style packet-list mapping: `{ src, dst, protocol, info, tone }` with conventional Info strings (`"Who has X? Tell Y"`, `"Standard query 0xNNNN A name"`, `"30000 → 80 [SYN]"`, `"Echo (ping) request … ttl=…"`, `"Destination unreachable (Port unreachable)"`). `tone` drives the row colour classes (`.pkt-*`); error frames read `bad`. Control frames get their own protocol/tone: `"802.11"`/`"EAPOL"`/`"EAP"`/`"RADIUS"` (tone `dot11`) and `"STP"` for a BPDU (tone `stp`, Info `Conf. Root = … Cost = … Bridge = … Port = …`).

## How it fits

`simulation.ts` and `engine.ts` create frames via these factories rather than building literals, which keeps frame structure consistent (and is exactly what the unit tests assert against). `canvas.ts` and `inspector.ts` use `frameLabel`/`frameColor` for rendering. The frame shapes are defined in [types.md](types.md) (`EthernetFrame`, `ArpPayload`, `IcmpPayload`, `DhcpPayload`, `Ipv4Payload`).

## Notes

- DHCP `Discover`/`Request` are broadcast (dst IP `255.255.255.255`, dst MAC broadcast); `Offer`/`Ack` carry the assigned addresses. The router's DHCP handling in `engine.ts` keys off `messageType`.
- `createBpduFrame` builds a faithful Configuration BPDU for spanning tree (`BpduPayload`, [types.md](types.md)): dst `01:80:C2:00:00:00` (the IEEE 802.1D bridge group address, `BPDU_GROUP_MAC`), `vlanTag: null`, and a **sentinel** `etherType` `0x0802` — real BPDUs are LLC-framed with no EtherType, so this is a documented simplification that lets the frame ride the same `etherType`-keyed paths as everything else. Fields: `flavour` (`config`/`tcn`), `rootId`, `bridgeId`, `rootCost`, `portId`. `frameLabel` is `"BPDU"` (`"STP TCN"` for a TCN), `frameColor` indigo `#818cf8`. The spanning-tree model that emits these lives in [stp.md](stp.md).
- Adding a new protocol means adding a factory here, handling it in the relevant `processAt*` in `engine.ts`, and extending `frameLabel`/`frameColor`.
