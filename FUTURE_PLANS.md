# RouteSim — Future Plans

A living backlog of ideas, ranked by fit with the project's north star: *a teaching
tool that makes invisible network behaviour visible, faithfully and fast.* Each
item notes rough effort and how it leverages what already exists. Nothing here is
committed scope — it's a menu for "what next".

> Status note (2026-06): **Traceroute** is done — ICMP Time-Exceeded (type 11),
> a router that checks TTL before forwarding, `runTraceroute`, and a
> `traceroute`/`tracert` command in the PC terminal and console. The items below
> are the remainder.

## Tier 1 — best value for effort

### Scenario curriculum (+ optional authoring UI)
The scenario framework is complete (`scenarios.ts`, `checkScenario`, the headless
runner, the goal banner, JSON import/export) but ships with **one** scenario
(`connect-lan`). Content is the missing piece. A progression turns RouteSim from a
sandbox into a course:
- Connect a LAN (done) → VLAN segmentation → router-on-a-stick → static routing
  across subnets → DHCP setup → RIP convergence.
- **Troubleshooting** scenarios that start broken: missing default gateway, wrong
  trunk/native VLAN, duplicate IP, powered-off device, wrong subnet mask.
- Optional: an in-app **scenario editor** (define topology + goal checks from the
  UI, export as JSON).

Effort: low–moderate (mostly data + a few new check kinds). Highest absolute
teaching value.

## Tier 2 — richer, more effort

### STP / L2 loop handling
Today a switching loop is only saved by the engine's step-cap — broadcast storms
aren't modelled and spanning tree doesn't exist. Add Spanning Tree (block
redundant links, elect a root) or at least loop detection + a visualised storm.
Closes a real correctness gap and teaches a core switching concept.
Effort: moderate–high (touches L2 forwarding in `engine.ts`).

### Firewall — beyond basic packet filtering
The **transparent inline firewall** device (iptables CLI, FORWARD chain, L3
matching) is **done** — see `docs/src/firewall.md`. Next layers:
- **L4 traffic + ports.** The frame model has no TCP/UDP ports yet, so `-p tcp` /
  `--dport` rules parse but never match. Add a TCP/UDP "connection test" traffic
  generator (e.g. `nc`/`curl`-style) so port rules become meaningful.
- **Routers as routing firewalls.** Let a router be put into a firewall-enabled
  mode (exactly like switches' managed/unmanaged toggle), reusing the same
  iptables rule engine on its INPUT/FORWARD path — a realistic perimeter device.
- **Stateful filtering + REJECT replies** (conntrack-style `-m state`, and an
  ICMP-unreachable for REJECT instead of a silent drop).

### NAT / PAT on routers
Source NAT / port address translation on a router's "outside" interface. Rich,
high-value concept and the realistic way to revisit an internet edge later.
Effort: moderate–high (new translation table + rewrite step in routing).

### OSPF
A second IGP to contrast with RIP (link-state vs distance-vector, areas, cost).
Pairs with the existing `runRipConvergence` structure.
Effort: high.

### DNS
A DNS server device/service so `ping <hostname>` resolves names → IPs. Small and
pairs nicely with NAT/internet-edge teaching.
Effort: low–moderate.

### ACLs / firewall rules
Per-interface permit/deny rules on routers. Security teaching; pairs with NAT.
Effort: moderate.

## Tier 3 — cheap wins / polish

- **Shareable URL** — encode the topology in the URL hash so people can pass
  networks around by link. Perfect for a single-file tool; no server needed.
  Effort: low.
- **Click-a-packet frame inspector** — click a transit dot to see full frame
  fields (we already record per-link frame history). Effort: low.
- **Redo** — pair with the existing 80-deep undo stack. Effort: low.
- **Arbitrary subnet masks** — the app assumes /24 in several places; supporting
  real prefixes would deepen realism but is invasive. Effort: moderate–high.
- **Annotations / notes on the canvas** — labels and callouts for teaching.
  Effort: low.
- **Minimap / fit-to-content for large topologies.** Effort: low–moderate.

## Tier 4 — reach

- **IPv6** (addressing, NDP instead of ARP). Large.
- **Guided interactive tutorials / explain-mode overlays.**
- **Quiz mode** built on the scenario checks.
- **Accessibility pass** (keyboard nav, ARIA, screen-reader) and **touch/mobile**.
