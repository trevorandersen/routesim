# NAT / PAT — routers translate inside flows onto a public address

RouteSim models **source NAT with port overload (PAT)** — the "home router"
model: every inside flow is translated onto the router's single outside
interface address, distinguished by an allocated identifier (TCP source port,
or the ICMP sequence used as a flow id).

## Configuring (Cisco-style, in the router terminal)

```
R1> enable
R1# configure terminal
R1(config)# interface Ethernet1
R1(config-if)# ip nat inside        ! LAN side
R1(config-if)# exit
R1(config)# interface Ethernet2
R1(config-if)# ip nat outside       ! ISP side
R1# show ip nat translations
R1# clear ip nat translation *
```

Marking interfaces is the whole configuration — overload on the outside
interface address is implicit (a deliberate simplification of Cisco's
`ip nat inside source list … overload`; the marks are the teaching core).

## How translation works (`engine.ts`)

- **Outbound** (`natTranslateOutbound`): a packet entering an `inside`
  interface and routed out an `outside` interface gets its source rewritten to
  the outside interface IP. TCP: the source port becomes an allocated PAT port;
  ICMP echo: the sequence becomes an allocated flow id. Each flow is recorded
  in `config.natTranslations` (`NatEntry`: protocol, inside ip/port, outside
  ip/port, destination) and reused for subsequent packets of the same flow.
- **Return** (`natRestoreInbound`): traffic addressed to an outside interface
  IP is checked against the table *before* the router's self-IP handling — a
  match restores the inside destination (ip + port/sequence) and the packet is
  routed inward. No match → the packet is genuinely for the router (INPUT
  chain + self handling apply), so pinging the public IP still gets the
  router's own reply.
- **ICMP errors** (Time-Exceeded / Dest-Unreachable): the sender is an
  intermediate router, not the flow's destination, so the reply-tuple match
  can't work — instead the error carries the **embedded original datagram**
  (`IcmpPayload.original`, the sim's equivalent of real ICMP quoting the
  original header + 8 bytes, populated by every error-generation site from the
  in-flight, already-translated packet). `natRestoreInbound` matches it on the
  translated flow id + real destination, restores the outer destination *and*
  rewrites the quoted header (as real NAT does). This is what makes
  **traceroute from behind NAT** show every hop — including the internet
  cloud's gateway — instead of dying at the edge.
- **Composition with netfilter**: the un-NAT runs *before* the FORWARD chain,
  so connection tracking sees consistent, un-translated tuples in both
  directions — an inside→outside flow's return traffic is correctly classified
  `established`. See [firewall.md](firewall.md) for the stateful filter and
  REJECT detail.
- Both directions log `sim-nat` (teal) lines: `NAT a.b.c.d → w.x.y.z (PAT …)`
  and `(un-PAT return flow)`.

## DNAT / port-forwarding (the inbound mirror)

Where PAT publishes *inside→outside* flows, a **static destination-NAT** publishes
an *outside→inside* one: a port on the router's public address is forwarded to an
inside server. Configure it in router config mode:

```
R1(config)# ip nat inside source static tcp 10.0.0.80 80 203.0.113.1 80
```

stored as `config.portForwards` (`PortForward`: proto/outsideIp/outsidePort/
insideIp/insidePort) and listed by `show ip nat translations`.

- **Inbound** (`dnatInbound`): a TCP segment to a published outside IP:port has
  its **destination** rewritten to the inside server — applied *before* the
  self/route decision, so the packet is forwarded inward rather than consumed by
  the router. (The natRestoreInbound PAT-return check runs first; a new inbound
  connection has no PAT entry, so it falls through to DNAT.)
- **Return** (`dnatReturn`): a reply from the inside server's published port has
  its **source** rewritten back to the outside IP:port the client connected to —
  checked *before* the PAT block so the reply isn't source-PAT'd to a fresh port
  instead. The client therefore sees the response come from the public address it
  dialled.
- It doesn't require the inside/outside interface marks (the rule is the
  mapping); logs `NAT 203.0.113.1:80 → 10.0.0.80:80 (port-forward)` and
  `(port-forward reply)`. The `port-forward` scenario pairs it with the HTTP web
  service so an outside client loads an inside page through the router.

## What this teaches

The reference scenario (`nat-gateway`) gives the outside server **no route
back** to the private LAN — without NAT nothing gets a reply (the host
correctly refuses to answer a source it cannot route to). Marking the two
interfaces makes the same ping/TCP connect succeed, because replies now target
the router's public address. `show ip nat translations` shows the live table.

## Limits (v1)

- Source NAT only — no port-forwarding/DNAT (an unsolicited inbound SYN to the
  public IP is not forwarded; the router has no listener, so it is dropped).
- ICMP Time-Exceeded is not un-translated (real NAT parses the embedded
  original headers, which the frame model doesn't carry) — traceroute through
  NAT shows `*` for outside hops.
- Translations live in `config.natTranslations` and round-trip with config
  export/import like ARP/MAC tables; `clear ip nat translation *` empties.
