# RouteSim — Roadmap

A living backlog, ranked by fit with the project's north star: *a teaching tool
that makes invisible network behaviour visible, faithfully and fast.* Each item
notes rough effort and how it leverages what already exists. Nothing here is
committed scope — it's a menu for "what next".

> Shipped so far (2026-06): traceroute (ICMP Time-Exceeded), real subnet
> prefixes (longest-prefix routing, DHCP mask option), the firewall device
> (iptables, live `-p tcp --dport` rules), the L4 TCP layer (`nc`/`connect`
> three-way handshake), the FRR/SONiC-faithful CLIs, the device registry +
> terminal/engine split, and the curriculum — now **11 scenarios** with tested
> reference solutions — plus redo and the click-a-packet frame inspector
> (click a transit dot to pause and read every frame field).

## Next up (ranked)

### 1. Ship a release
The project has crossed from "engine" to "product": one self-contained file with
a course in it. Tag **v0.1.0** so there's a pinnable artifact; when the repo goes
public, **GitHub Pages** can serve `rs-web.html` directly (it's tailor-made for
it). An hour of work that converts everything above into something learners can
open from a URL. Effort: low.

### 2. NAT / PAT on routers
Unblocked by the L4 layer — port translation is meaningless without ports, and
we now have ports. The biggest remaining teaching concept (every home network
does it) and the realistic "edge of the internet" story. Shape: `ip nat
inside/outside` on router interfaces (FRR-adjacent syntax), a translation table
you can `show`, a scenario ("give the private LAN internet access through one
public IP"). Composes with the firewall work. Effort: moderate–high.

### 3. Routers as routing firewalls
Designed during the firewall work: a firewall-enabled mode on routers (exactly
like switches' managed/unmanaged toggle), reusing the existing iptables rule
engine on the INPUT/FORWARD path — perimeter filtering rather than only inline
bumps. Mostly wiring. Effort: moderate.

### 4. DNS
Small now that L4 exists: a DNS-server role (name → IP records on a host or
router), UDP/53 query–response frames, and `ping web.corp` resolving before it
ARPs. High realism-per-line-of-code, plus a classic troubleshooting scenario
("the IP pings but the name doesn't"). Effort: low–moderate.

### 5. STP / L2 loop handling
The last real correctness gap: a switching loop is only saved by the engine's
step-cap — broadcast storms aren't modelled and spanning tree doesn't exist.
Add Spanning Tree (block redundant links, elect a root) or at least loop
detection + a visualised storm. Effort: moderate–high.

## Later

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
