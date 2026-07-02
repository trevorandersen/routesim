# `src/packet-filter.ts` — Packet-list display filter

The sim-log packet list is filterable, Wireshark-style. This module is the pure,
DOM-free heart of that: it classifies frames by protocol and compiles a
display-filter expression into a predicate. The engine ([engine.md](engine.md))
owns the toolbar DOM and calls in here; the filter state itself is
`state.dock.logFilter` (a `LogFilter`).

## The dimensions

A `LogFilter` has orthogonal parts, **ANDed** together (`applyLogFilter`):

- **`protocols: string[]`** — the active protocol **chips**. Empty = all; a
  non-empty set is an **OR** (a frame shows if it matches any selected token).
- **`device: string`** — a device **id**. A frame shows only if the wire it
  crossed has that device as an endpoint. `""` = any.
- **`link?: string`** — a link **id** (optional). A frame shows only if it
  crossed that specific wire (`row.linkId === filter.link`). Set by the link
  inspector's **View frames in the packet log** jump; surfaced as a dismissible
  pill, not an always-present control. Absent/`""` = any.
- **`expr: string`** — a free-text **display-filter expression** (the power
  tool). `""` = no constraint.

A frame is shown iff it passes all of them. `isFilterActive` reports whether any
dimension is set (drives the "Showing N of M" line and the Clear button).

## Protocol tokens

`frameMatchesToken(row, token)` is the atom both the chips and bare expression
keywords use. The vocabulary (`PROTOCOL_TOKENS`) is faithful to Wireshark's
protocol names where they exist:

| token | matches |
|-------|---------|
| `arp` | ARP frames |
| `ip` / `ipv4` | any IPv4 frame (not ARP/BPDU/802.11) |
| `icmp` `tcp` `dns` `dhcp` | the IPv4 payload kind |
| `udp` | DNS or DHCP (IP protocol 17) |
| `stp` / `bpdu` | spanning-tree BPDUs |
| `wlan` / `dot11` | 802.11 management **and** the WPA2 4-way (EAPOL-Key rides 802.11) |
| `dot1x` | the whole 802.1X family (EAPOL/EAP/RADIUS) |
| `eapol` | EAPOL frames — both the 802.1X EAPOL-Start and the WPA2 EAPOL-Key |
| `eap` | 802.1X EAP request/response/success/failure |
| `radius` | 802.1X RADIUS Access-Request/Accept/Reject |
| `macsec` | a frame captured encrypted on a MACsec-secured wire (the row's flag) |

`PROTOCOL_CHIPS` is the curated, ordered subset shown as toggle chips (ARP /
ICMP / TCP / DNS / DHCP / STP / 802.1X / 802.11 / MACsec). `presentTokens(rows)`
reports which chip tokens actually occur in a capture, so the engine can dim the
chips for protocols that aren't present.

## The expression grammar

`compileFilter(expr)` lexes and parses the expression into a predicate, returning
`{ ok: true, test }` or `{ ok: false, error }` (cached by source text). An empty
expression matches everything. Grammar (precedence **not > and > or**, matching
Wireshark):

```
orExpr  := andExpr ( ("||" | "or")  andExpr )*
andExpr := notExpr ( ("&&" | "and") notExpr )*
notExpr := ("!" | "not") notExpr | primary
primary := "(" orExpr ")" | field comparator value | protocolToken
```

**Fields** and their comparators:

- IP: `ip.addr` / `ip.src` / `ip.dst` — `==` `!=` `contains`, and a value with a
  `/` is a **CIDR** prefix match (`ip.addr == 10.0.0.0/24`).
- MAC: `eth.addr` / `eth.src` / `eth.dst` — `==` `!=` `contains` (case-insensitive).
- TCP: `tcp.port` / `tcp.srcport` / `tcp.dstport` — `==` `!=` `<` `>` `<=` `>=`.
- Numbers: `ip.ttl`, `frame.no` (or `no`), `frame.step` (or `step`) — same
  numeric comparators.
- Device: `device` (or `dev`) — `==` `!=` `contains` against either endpoint name.

Only the **numeric** fields take the relational operators (`<` `>` `<=` `>=`);
the string-valued fields (`ip`/`eth`/`device`) accept `==` `!=` `contains` (and
`ip` also CIDR), and a relational op on one is a **parse error** — rejected at
compile time so it can never throw from inside the predicate at render time.

A field that reads two values (e.g. `ip.addr` = src **or** dst, `tcp.port` = src
**or** dst) matches if **either** side satisfies `==`/`<`/`contains`/… . `!=`
means **field present and no side equals** — so a non-TCP frame is excluded by
both `tcp.port == 80` and `tcp.port != 80` (faithful to Wireshark's
field-presence rule). Note this **deliberately diverges** from Wireshark's
notorious multi-field `!=` quirk, where `ip.addr != x` is true whenever *either*
side differs (so it never excludes a frame that has `x` on one side); RouteSim's
`ip.addr != x` means "neither side is `x`", which is the intuitive reading and
the better teaching default. Values with spaces or that collide with a keyword
(`and`/`or`/`not`/`contains`) can be double-quoted.

An **invalid** expression returns `{ ok: false }` and is treated by the engine as
**no constraint** (the list isn't emptied, just flagged red) — like Wireshark
keeping the table while you finish typing.

## Why pure

Keeping all matching logic here (no `dom`, no `state`, no `engine` import) makes
the parser and every comparator unit-testable in isolation —
`tests/packet-filter.test.ts` covers the token classifier, each field, CIDR, the
boolean precedence, `!=` field-presence, parse errors, and the three-dimension
combinator. The engine layer is then a thin renderer over the result.
