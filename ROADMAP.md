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
The packet list and **log ↔ canvas cross-linking** shipped (clicking a packet
row glows its wire + endpoint devices amber on the canvas). What remains is
making the list queryable: **protocol chips and a device filter** (aspiring to
a Wireshark display-filter expression like `dns || icmp && !arp`) and
**multi-run captures** kept side by side so a troubleshooting fix can be
compared before/after. Effort: low–moderate, all renderer/filter-model work on
data already captured.

### 2. STP / L2 loop handling
The last real correctness gap: a switching loop is only saved by the engine's
step-cap — broadcast storms aren't modelled and spanning tree doesn't exist.
Add Spanning Tree (block redundant links, elect a root) or at least loop
detection + a visualised storm. Effort: moderate–high.

## Later

### Simulation modes — frame/packet · physical · streams
Three complementary lenses on the same topology, switchable per run, so a
learner can move from one packet, to the wires beneath, to a network under
load:

- **Frame/packet** *(today)* — individual Ethernet frames (ARP/ICMP/DHCP/DNS/
  TCP) animated hop-by-hop; the model the whole engine is built on. Best for
  *how a protocol works*.
- **Physical** — the layer-1 view: media and link state, signal propagation,
  collision/broadcast domains. Best for *what's actually wired and up*.
- **Streams** — drop the individual packets and model **aggregate traffic**:
  flows with rates, link utilisation, queues, and **congestion** (bottlenecks,
  drops, backpressure). A link carries load against its bandwidth rather than
  one dot per frame, so you can drive *high* traffic and watch flow and
  congestion form — what the packet model can't show at scale. Best for
  *throughput and capacity*.

Effort: high. Physical is moderate (a layer-1 overlay on the existing model);
streams is a second, **fluid** simulation engine (rates and queues, not
discrete frame events) sharing the topology/inspector but not the step loop.
Depends on **Configurable links** below for per-link bandwidth, which the
streams model needs as its capacity input.

### Server — more services
The server device is built to host more than dnsmasq: an HTTP service (a real
GET riding the existing TCP handshake), DNAT/port-forwarding on NAT routers so
inbound connections can reach an inside server, upstream DNS forwarding.
Effort: low–moderate each.

### Multi-NIC hosts
Hosts currently model a single NIC (eth0) and so take one cable. Allow
multiple interfaces on a computer/server (eth0/eth1/…, each with its own
address and the port-selection modal already used by switches/routers) for
multi-homed hosts and dual-NIC servers. Effort: moderate (host config grows an
interfaces array; the engine's per-host handlers pick the ingress NIC).

### WiFi — access points & wireless clients
A wireless **access point** that bridges associated clients onto the wired LAN
(like a switch, but the "cable" is an association), and workstations that
**connect over the air** instead of a port. Minimum viable: an AP with an SSID,
clients that associate to an in-range AP (a wireless "link" — drawn, or
auto-forming by range), and frames bridged AP↔wired exactly as a switch does,
so ARP/DHCP/IP all work unchanged once associated. Richer later: signal
range/strength, channels, multiple SSIDs mapped to VLANs, association/auth as a
visible step. Effort: moderate–high (a new device + a wireless link type; the
forwarding reuses the switch path). Pairs with the **physical** simulation mode
(range/signal is a layer-1 story) and **Configurable links** (a wireless link
is just a link with loss/bandwidth).

### Router roles — border vs internal
Give routers a **role** that sets sensible defaults and teaches placement, the
way the Switch tool now splits basic/managed (a Router tool group mirroring
Endpoint/Switch/Security):
- **Border / edge router** — faces the outside: a designated outside/WAN
  interface with `ip nat outside` and a default route pre-wired, naturally
  pairing with a firewall. The AS boundary (BGP) lives here in the real world —
  out of scope now, but this is where it would go.
- **Internal / core router** — interior forwarding only: an IGP (RIP today,
  OSPF later), no NAT.

Terminology: **border/edge vs internal/core** is the clearest two-way split for
teaching. The fuller hierarchy — **core / distribution / access**, or the
routing-role framing **interior vs exterior (AS-boundary)** — is a later
refinement if three-tier campus design becomes a teaching goal. Mostly a
defaults + label/icon change, so effort: low–moderate.

### Configurable links
Links are nameable, deletable, and now carry **admin status** — a link can be
shut (administratively down) without deleting it: it stays in the topology but
carries no traffic (inspector toggle, `shut`/`noshut` console commands, or a
canvas double-click; dashed-red on the canvas, frames dropped with a sim-log
entry). **Canvas labels
for named links** also shipped (a named link shows its name at the midpoint).
What remains:
**bandwidth/latency/loss** (per-hop transit time and drop probability would
make speed and reliability teachable — also the capacity input the *streams*
simulation mode needs), and per-link colour/style. Effort: moderate (the
transit model gains a per-link cost).

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
  canvas while a simulation is active. The transport now lives on the Main
  tab beside the tools, which softens this; the pill would still help when
  the ribbon sits on another tab.
- **Scenario banner: collapse, don't dismiss** — shrink to a progress pill
  ("Name service (DNS) — 1/3 ✓"); the ✕ currently abandons the scenario.
- **Terminal QoL** — `Ctrl+C` cancels a running simulation from the terminal;
  tab completion for the Linux host/server commands (the router already has
  `?` + abbreviation); a right-click device context menu (Terminal /
  Configure / Power / Delete).

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
