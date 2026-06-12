# RouteSim — Roadmap

A living backlog, ranked by fit with the project's north star: *a teaching tool
that makes invisible network behaviour visible, faithfully and fast.* Each item
notes rough effort and how it leverages what already exists. Nothing here is
committed scope — it's a menu for "what next".

> Shipped so far (2026-06): traceroute (ICMP Time-Exceeded), real subnet
> prefixes (longest-prefix routing, DHCP mask option), the firewall device
> (iptables, live `-p tcp --dport` rules), the L4 TCP layer (`nc`/`connect`
> three-way handshake), the FRR/SONiC-faithful CLIs, the device registry +
> terminal/engine split, redo, the click-a-packet frame inspector, **NAT/PAT
> on routers** (`ip nat inside/outside`, translation table, un-PAT return
> path), **router netfilter chains** (iptables INPUT/FORWARD via a shared
> engine; the transparent firewall device stays FORWARD-only), and the
> **server device with DNS + DHCP via dnsmasq** (A-records, UDP/53 frames,
> resolve-then-ping/connect, `/etc/resolv.conf`, server `dhcp-range` leases
> with nameserver option 6, DNS through NAT) — with the curriculum now at
> **16 scenarios**, every one carrying a tested reference solution. Plus the
> **unified bottom dock**: per-device terminal sessions as tabs (own
> scrollback/history, the router's CLI mode survives switching), with the
> console and the sim log as sibling panes and a drag-resizable height — the
> floating sim log and the terminal/console either-or are gone. The sim log
> itself is now a **Wireshark-style packet list** (No./Step/Source/
> Destination/Protocol/Info/Link, protocol-coloured rows, click a row for the
> full frame breakdown), with the narrative log kept as an Events view.

## Next up (ranked)

### 1. Sim log filtering & captures
The packet list shipped; what remains is making it queryable: **protocol
chips and a device filter** (aspiring to a Wireshark display-filter
expression like `dns || icmp && !arp`), **multi-run captures** kept side by
side so a troubleshooting fix can be compared before/after, and
**cross-linking** (a packet row highlights its wire/devices on the canvas).
Effort: low–moderate, all renderer/filter-model work on data already
captured.

### 2. STP / L2 loop handling
The last real correctness gap: a switching loop is only saved by the engine's
step-cap — broadcast storms aren't modelled and spanning tree doesn't exist.
Add Spanning Tree (block redundant links, elect a root) or at least loop
detection + a visualised storm. Effort: moderate–high.

## Later

### Server — more services
The server device is built to host more than dnsmasq: an HTTP service (a real
GET riding the existing TCP handshake), DNAT/port-forwarding on NAT routers so
inbound connections can reach an inside server, upstream DNS forwarding.
Effort: low–moderate each.

### Configurable links
Links are now nameable (inspector; the default name is the endpoint combo and
the packet list's Link column shows it). Make them properly configurable:
**bandwidth/latency/loss** (per-hop transit time and drop probability would
make speed and reliability teachable), **admin status** (shut a link without
deleting it — instant troubleshooting scenarios), canvas labels for named
links, and per-link colour/style. Effort: low (status, labels) to moderate
(latency/loss touching the transit model).

### Firewall — beyond basic packet filtering
**Stateful filtering + REJECT replies** (conntrack-style `-m state`, and an
ICMP-unreachable for REJECT instead of a silent drop).

### OSPF
A second IGP to contrast with RIP (link-state vs distance-vector, areas, cost).
Pairs with the existing `runRipConvergence` structure. Effort: high.

### Scenario authoring UI
An in-app editor (define topology + goal checks from the UI, export as JSON).
The JSON import path already exists.

### Persistence & sharing
- **Shareable URL** — encode the topology in the URL hash; perfect for a
  single-file tool, no server needed. Effort: low.
- **localStorage autosave** (opt-out) — "lost my work on refresh" starts to
  matter once strangers use it. The zero-request principle is about *network*,
  not storage. Effort: low.

### UI polish (from the 2026-06 UI review)
- **Floating sim transport** — a small play/pause/step/stop pill over the
  canvas while a simulation is active, so pausing doesn't require switching
  to the Simulate ribbon tab.
- **Scenario banner: collapse, don't dismiss** — shrink to a progress pill
  ("Name service (DNS) — 1/3 ✓"); the ✕ currently abandons the scenario.
- **Terminal QoL** — `Ctrl+C` cancels a running simulation from the terminal;
  tab completion for the Linux host/server commands (the router already has
  `?` + abbreviation); a right-click device context menu (Terminal /
  Configure / Power / Delete).
- **Log ↔ canvas cross-linking** — a packet row already opens the frame
  breakdown; highlighting its wire/devices on the canvas is the missing half
  (also listed under "Sim log filtering & captures").

### Polish
- **Annotations / notes on the canvas** — labels and callouts for teaching.
- **Minimap / fit-to-content for large topologies.**
- **`any`-debt typing pass** — inspector/devices/engine still lean on `any`;
  typed configs would catch field typos in the hottest files.

## Reach

- **IPv6** (addressing, NDP instead of ARP). Large.
- **Guided interactive tutorials / explain-mode overlays.**
- **Quiz mode** built on the scenario checks.
- **Accessibility pass** (keyboard nav, ARIA, screen-reader) and **touch/mobile**.
