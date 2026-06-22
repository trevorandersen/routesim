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
  collision/broadcast domains. The ambition runs deeper than logical layer 1:
  model the **geometry and radio-acoustics of a building** — rooms and floors,
  real **cable lengths** and runs (with distance limits, e.g. ~100 m copper),
  attenuation through walls, and wireless coverage/interference (pairs with
  **WiFi** below). Bring in the structured-cabling kit that the logical view
  hides — **patch panels**, wall jacks, racks — so a "cable" becomes a path
  through real plant. Eventually a **3D rendering** of the space, not just the
  schematic. Best for *what's actually wired, how far, and whether the signal
  makes it*.
- **Streams** — drop the individual packets and model **aggregate traffic**:
  flows with rates, link utilisation, queues, and **congestion** (bottlenecks,
  drops, backpressure). A link carries load against its bandwidth rather than
  one dot per frame, so you can drive *high* traffic and watch flow and
  congestion form — what the packet model can't show at scale. Best for
  *throughput and capacity*.

Effort: high overall, and staged. Physical starts moderate (a layer-1 overlay
on the existing model) but the building/cabling/3D ambition is large — a
spatial model, a cabling-plant layer, and eventually a 3D renderer, each
shippable on its own. Streams is a second, **fluid** simulation engine (rates
and queues, not discrete frame events) sharing the topology/inspector but not
the step loop. Depends on **Configurable links** below for per-link bandwidth
(streams' capacity input) and per-link length/latency (the physical model's
distance metric).

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
**Shipped (2026-06):** a WiFi-only **laptop** that associates to an **access
point** (a transparent L2 bridge reusing `processAtSwitch`, with a single wired
uplink), drawn over a dotted **wireless link** (`Link.wireless`); the Connect
tool only lets a laptop associate to one AP, and ARP/DHCP/IP work through the AP
onto the wired LAN exactly as a switch would. Both the AP (broadcast) and the
laptop (join) carry an **SSID** plus an optional **password**, and a laptop only
associates when its SSID — and password, if the AP is secured — match (set via
the inspector or the `ssid` command; shown on the canvas). A built-in
**`wifi-vlan`** topology ships this as a worked example: a secured staff SSID on
VLAN 10 and an open guest SSID on VLAN 20, one access point each, a shared server
on a Servers VLAN (30) reachable by every VLAN, a router-on-a-stick gateway, and
a FORWARD rule isolating guests from staff. The **802.11 management frames** are
now simulated: `associate <laptop>` animates the real join — Probe / open-system
Authentication / Association, plus the WPA2 4-way (EAPOL M1–M4) key handshake on a
secured AP — as `dot11` frames in the packet list (a `handleDot11` reactive state
machine across the laptop and AP; a Silent WiFi toggle suppresses them like the
other silent protocols). A **wrong password** is modelled faithfully: the SSID
match lets the association *form* (probe/auth/assoc all succeed), but the WPA2
4-way handshake fails at the MIC check and the AP sends a **Deauthentication** —
the link stays unauthenticated (drawn red), carries no data (`wifiLinkAuthenticated`
gates `l2Reachable`/`findFirstHop`/the transit path), and authenticates live once
the password is corrected. **Still to do:** signal range/strength (clients
auto-associating to an in-range AP — pairs with the **physical** mode),
channels/interference, multiple SSIDs mapped to VLANs, and beacons/roaming. The
wireless link already carries loss/bandwidth (it's a normal link), so per-link
signal degradation is cheap to layer on.

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
Mostly shipped. Links are nameable, deletable, and carry **admin status** (shut
without deleting — inspector toggle, `shut`/`noshut` console commands, or a
canvas double-click; dashed-red, frames dropped with a sim-log entry), **canvas
labels for named links**, and now **bandwidth / latency / loss** per link:
latency stretches that wire's transit animation (a far/WAN link visibly
crawls), loss randomly drops forwarded frames in animated runs (headless
reachability stays deterministic), and bandwidth is stored as the capacity
input the *streams* mode will consume. What remains: **per-link colour/style**,
and surfacing latency/loss on the canvas (currently inspector-only). Effort: low
(the cosmetic bits).

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
