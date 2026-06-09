# `src/frame.ts` — Ethernet frame factories

Builds the `EthernetFrame` objects that flow through the simulation, plus helpers to label and colour them for display.

## Key exports

- **`BROADCAST_MAC`** — `ff:ff:ff:ff:ff:ff`.
- **Factories** — each returns a fully-formed `EthernetFrame` with the right `etherType`, MACs, IPv4 envelope (where applicable), and a unique frame id:
  - `createArpRequest`, `createArpReply`
  - `createIcmpEchoRequest`, `createIcmpEchoReply`, `createIcmpTimeExceeded` (type 11 — sent by a router on TTL 0; the signal traceroute discovers each hop from)
  - `createDhcpDiscover`, `createDhcpOffer`, `createDhcpRequest`, `createDhcpAck`
  - All accept an optional `vlanTag` for 802.1Q tagging.
- **`frameLabel(frame)`** — a short human label (e.g. `"ARP Req"`, `"ICMP Echo"`, `"ICMP TTL Exceeded"`, `"DHCP Offer"`) shown on transit dots and in link history.
- **`frameColor(frame)`** — the colour for the frame type (amber ARP, blue ICMP request, green ICMP reply, red ICMP Time-Exceeded, violet DHCP).

## How it fits

`simulation.ts` and `engine.ts` create frames via these factories rather than building literals, which keeps frame structure consistent (and is exactly what the unit tests assert against). `canvas.ts` and `inspector.ts` use `frameLabel`/`frameColor` for rendering. The frame shapes are defined in [types.md](types.md) (`EthernetFrame`, `ArpPayload`, `IcmpPayload`, `DhcpPayload`, `Ipv4Payload`).

## Notes

- DHCP `Discover`/`Request` are broadcast (dst IP `255.255.255.255`, dst MAC broadcast); `Offer`/`Ack` carry the assigned addresses. The router's DHCP handling in `engine.ts` keys off `messageType`.
- Adding a new protocol means adding a factory here, handling it in the relevant `processAt*` in `engine.ts`, and extending `frameLabel`/`frameColor`.
