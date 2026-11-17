# RouteSim — Roadmap

A living backlog, ranked by fit with the project's north star: *a teaching tool
that makes invisible network behaviour visible, faithfully and fast.* Each item
notes rough effort and how it leverages what already exists. Nothing here is
committed scope — it's a menu for "what next".

> **Released:** [`v0.7.1-alpha`](https://github.com/trevorandersen/routesim/releases/tag/v0.7.1-alpha)
> (2026-11) — a shared link carries the scenario in progress, so an exercise
> arrives with its goal; Clear ends the active scenario along with its
> network.
>
> **Earlier:** [`v0.7.0-alpha`](https://github.com/trevorandersen/routesim/releases/tag/v0.7.0-alpha)
> (2026-11) — **Share and keep**: File → Copy link carries a whole network in
> the link itself; the canvas is autosaved in the browser and restored on the
> next visit; and a failed `ping` typed into a device terminal names its
> likely cause.
>
> **Earlier:** [`v0.6.1-alpha`](https://github.com/trevorandersen/routesim/releases/tag/v0.6.1-alpha)
> (2026-11) — **Likely cause**: a failed scenario check names the most likely
> thing wrong (the cause, never the answer); "Why?" gains a summary line and
> explains a headless `run`; a router shell stays on its port when the cable
> is pulled.
>
> **Earlier:** [`v0.6.0-alpha`](https://github.com/trevorandersen/routesim/releases/tag/v0.6.0-alpha)
> (2026-11) — **Why?**: every captured packet shows the chain of frames that
> led to it, each with its sender's reason, and a failed scenario check lists
> why it failed.
>
> **Earlier:** [`v0.5.2-alpha`](https://github.com/trevorandersen/routesim/releases/tag/v0.5.2-alpha)
> (2026-11) — a router interface's configuration now belongs to its port: an
> address set before the port is cabled follows it onto the cable, and it
> stays on the port when the cable is removed.
>
> **Earlier:** [`v0.5.1-alpha`](https://github.com/trevorandersen/routesim/releases/tag/v0.5.1-alpha)
> (2026-11) — the code-review remediation release: all 117 findings of
> `reviews/2026-11-review.md` are fixed, with no new features. Highlights: RIP
> forms adjacencies across a switch, the same script always builds the same
> spanning tree, failures explain themselves in more places, keyboard and
> screen-reader reach for the packet list, cables and dialogs, and an `any`
> budget that only ratchets down.
>
> **Earlier:** [`v0.5.0-alpha`](https://github.com/trevorandersen/routesim/releases/tag/v0.5.0-alpha)
> (2026-11) — the first tagged release, bundling everything shipped below (the
> netfilter/NAT/STP/IDS model, the Kali offensive hosts, the
> <!--param:SCENARIO_COUNT-->28<!--/param-->-scenario curriculum, and the five
> requested features #1&ndash;#5). The portable
> `rs-web.html` is attached to the release, and `package.json`'s `version` now
> drives the number shown in the About box.

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
> with nameserver option 6, DNS through NAT), **Spanning Tree (802.1D)**
> (managed switches elect a root bridge, block one redundant port to break an
> L2 loop, animate the BPDU exchange, and surface a bounded broadcast storm when
> STP is off), and a **passive Snort IDS** fed by **SPAN port mirroring** (a
> managed switch mirrors traffic to a monitor port; the sensor matches frames
> against Snort rules and raises fast-alerts), and the **Kali offensive hosts** —
> a hand-driven **Kali PC** (Computer group) and an autonomous **Red Team actor**
> (Security group) sharing one engine that runs an nmap SYN port scan, a ping
> sweep, and ARP spoofing, reports an nmap-style result, and pairs with the IDS
> for a red-vs-blue detection exercise, and a **stateful firewall**
> (connection tracking — `-m state`/`--ctstate` ESTABLISHED,RELATED — plus a real
> REJECT that sends a RST / ICMP unreachable) — with the curriculum now at
> **<!--param:SCENARIO_COUNT-->28<!--/param--> scenarios** (including WiFi joins, 802.1X port authentication, MACsec link
> encryption, breaking an L2 loop with spanning tree, catching an intruder
> with an IDS, writing a Snort rule to detect a Red Team port scan, and building
> a stateful firewall that blocks inbound scans while hosts browse out), every
> one carrying a tested reference solution. Plus the
> **unified bottom dock**: per-device terminal sessions as tabs (own
> scrollback/history, the router's CLI mode survives switching), with the
> console and the sim log as sibling panes and a drag-resizable height — the
> floating sim log and the terminal/console either-or are gone. The sim log
> itself is now a **Wireshark-style packet list** (No./Step/Source/
> Destination/Protocol/Info/Link, protocol-coloured rows, click a row for the
> full frame breakdown), with the narrative log kept as an Events view.

## Next up (ranked)

> **Sim log filtering & captures — shipped (2026-06).** The packet list,
> **log ↔ canvas cross-linking** (clicking a packet row glows its wire + endpoint
> devices amber on the canvas), **display filtering**, and **multi-run captures**
> have all shipped.
>
> *Display filtering* (`src/packet-filter.ts`, `state.dock.logFilter`): clickable
> **protocol chips** (OR within the set, dimmed when absent), a **device filter**
> `<select>`, and a free-text **Wireshark-style display-filter expression**
> (`dns || icmp && !arp`, `ip.addr == 10.0.0.0/24`, `tcp.port == 22 && device
> contains PC`) — a real grammar with `&&`/`||`/`!`/parens, `==`/`!=`/`<`/`>`/
> `contains`, and CIDR over `ip`/`eth`/`tcp`/`device`/`frame` fields. All three
> dimensions are ANDed; an invalid expression flags red without emptying the
> list, and a "Showing N of M" status reads out the result.
>
> *Multi-run captures* (`state.savedCaptures`, a 12-run ring): each finished
> animated run is archived with an outcome label; a capture `<select>` switches
> which run the list shows, and a **Compare** toggle renders two runs **side by
> side** (baseline left, current right) so a fix can be checked before/after —
> both panes honour the display filter.

> **STP / L2 loop handling — shipped (2026-06).** Managed switches run Spanning
> Tree (802.1D) by default: `runStpConvergence` (`stp.ts`) elects a root bridge
> per switch component, assigns port roles/states, and blocks one alternate port
> to break a loop (folded into `linkAuthorizedForData`). A faithful BPDU frame
> animates the exchange (`stp` / `run stp`), and with STP off a switching loop
> now forms a **bounded, visualised broadcast storm** (`sim.stormDetected`)
> rather than a silent step-cap. **Later:** per-VLAN trees (PVST/RSTP),
> configurable per-link path cost, and an animated listening/learning state
> machine with timers.

### Requested features (GitHub issues, 2026-11)

Five requests raised on GitHub by a colleague who teaches with the tool. **All
five have shipped and their issues are closed** (#1–#5, closed 2026-11-13 with a
summary comment on each). The notes below record what each one delivered and
what it leaves for later.

> **Placement ghost, and only left-click places — shipped, issue closed (2026-11)**
> ([#3](https://github.com/trevorandersen/routesim/issues/3)). While a placement
> tool is armed a **translucent copy of the device a click would drop** follows
> the cursor, with its managed / border badge and the name it will get
> (`placementPreview` in `devices.ts`, drawn by `drawPlacementGhost` in
> `canvas.ts`; the preview and the click read one table, so they cannot
> disagree). **Left-click places and stays armed; right-click or Escape leaves
> place mode** (a right-click there opens no menu); a middle-click no longer
> drops a device. The status line says how to leave for as long as the tool is
> armed.

> **Kali as a real man-in-the-middle — shipped, issues closed (2026-11)**
> ([#4](https://github.com/trevorandersen/routesim/issues/4) +
> [#5](https://github.com/trevorandersen/routesim/issues/5)). **IP forwarding**
> (`config.ipForward`, `sysctl -w net.ipv4.ip_forward=1`): `forwardIntercepted`
> relays a frame unicast to the attacker's MAC but bound for another IP to the
> true next hop from the attacker's own unpoisoned cache (TTL decremented, IPs
> untouched), so a poisoned victim's ping still succeeds and the extra hop shows.
> **Targeted / reverse `arpspoof`**: `arpspoof [-r] [-t <victim>] <gateway>` —
> `-t` unicasts the poison to one victim (`macForIp` resolves it), `-r` adds the
> mirror reply poisoning the gateway for the victim, so `-r` + forwarding gives a
> transparent **two-way** MITM (the reply returns via the attacker). Both off by
> default, round-trip through JSON + the script, and are proven end to end in
> `tests/forwarding.test.ts` + `tests/arpspoof.test.ts`.
>
> **Next on this thread:** a red-vs-blue *scenario* (intercept without breaking
> the victim; the IDS or a static ARP entry catches it), and the IPv6 forwarding
> knob once IPv6 lands.

> **Packet callouts — shipped, issue closed (2026-11)**
> ([#2](https://github.com/trevorandersen/routesim/issues/2)). A View-tab
> **Packet callouts** toggle (off by default, `state.options.packetCallouts`)
> draws a small field callout beside each frame in flight (`frameCalloutLines`
> in `frame.ts`, `drawPacketCallout` in `canvas.ts`): the network/transport line
> (ARP who-has / is-at; IPv4 `src → dst`; TCP flags + ports; DNS/DHCP) then the
> MAC pair. A field the **last hop rewrote** — diffed against
> `ActiveTransit.prevFrame` — is underlined, marked `✎` and pulsed; a field a
> **reply echoes from its request** is tinted and marked `↩`. The companion NAT
> view is the router inspector's **live translation table**
> (`renderNatTranslations`): it lists every PAT entry and **flashes** (a `●`
> marker) the one a frame just created or used (`NatEntry.lastStep`, stamped by
> `touchNat`, stripped from the payload). Capped (`CALLOUT_CAP`, inspected frame
> first) to stay legible; proven in `tests/callouts.test.ts` + `tests/nat.test.ts`.

> **nftables alongside iptables — shipped, issue closed (2026-11)**
> ([#1](https://github.com/trevorandersen/routesim/issues/1)). `terminal/nftables.ts`
> is a second parser + printer over the one netfilter model (`config.rules` /
> `config.policy`): both the `iptables` and `nft` shells always parse into the
> same `FirewallRule`, so a ruleset written in either language reads back in the
> other (proven both ways in `tests/nftables.test.ts`). A per-device
> `config.ruleLang` toggle (`rulelang <device> …` / the inspector's **Rule
> language** select) picks the dialect the native view, the inspector rule rows
> and the script export speak; it round-trips. First cut covers family `inet`,
> table `filter`, the forward/input chains, `ip saddr`/`daddr`, `ip protocol` /
> `tcp dport` / `icmp type`, `ct state`, accept/drop/reject (with `reject
> with …`), and per-chain policy. **Later:** sets, maps, named tables, other
> families; and deciding which language scenarios speak by default (they stay
> iptables for now).

## Later

### Teaching affordances (from the learner principles)
Three items that flow directly from the learner-facing principles in
`CLAUDE.md` (*Explain, don't just show* · *Failure is a lesson* · *Perceivable
by everyone*). They add teaching depth without a new engine — each composes data
the sim already produces — and they're the clearest near-term expression of the
north star, so they rank ahead of the deeper simulation work below.

- **"Why?" affordance — shipped (2026-11).** Every captured packet explains
  itself. The engine tags each captured frame with what its sender logged
  (`why`), what its receiver logged (`outcome`) and the packet that caused it
  (`cause`); `src/explain.ts` walks that back into a chain. The frame inspector
  shows it under the field table (each earlier packet a jump button), the
  console prints it with `why <packet no>`, and a failed scenario check lists
  the reasons from its own run on the goal banner and in `scenario check`
  (`CheckResult.why`). A one- or two-sentence **summary** sits above the
  chain, and a console `run` (headless) keeps a trace so `why` explains it
  too.
- **Colour-blind-safe encoding — shipped.** Every packet category carries a
  monochrome glyph beside its colour (`frameGlyph` / `toneGlyph`) in the packet
  list and on the transit dots, and each colour-coded link state has a text
  marker. (The broader accessibility pass — touch/mobile, screen-reader review —
  remains under Reach; keyboard reach and ARIA landed with review R103.)
- **Scenario hint/diagnosis layer — shipped (2026-11).** A failed goal check
  names the most likely misconfiguration, not just what happened: a
  nearest-cause probe (`src/hints.ts`) over the failed flow — the origin, name
  resolution, the run's decisive drops, then gateway / target / VLAN /
  return-path addressing — sets `CheckResult.hint`, shown as **Likely cause:**
  on the goal banner and in `scenario check`. It names the cause and never the
  answer, and stays silent where the failure already explains itself. The same
  probe follows a flow typed by hand: a failed `ping` / `nc` / `curl` /
  `nslookup` / `dhcp` / `traceroute` in a device terminal ends with a
  `Likely cause:` line, as do the console's `run` and `traceroute`.

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
The server device hosts more than dnsmasq. **HTTP — shipped (2026-06):** a real
HTTP GET rides the existing TCP handshake (`curl http://host` / `http <src>
<host>`, sim mode `"http"`), and a server with its web service on (`web <host>
on`, the inspector toggle, or the Web-server tool) answers **200 OK** —
`HttpInfo` on a TCP segment, shown as HTTP in the packet list; the `web-service`
scenario + `http` scenario-check ship with it. **DNAT / port-forwarding —
shipped (2026-06):** a static destination-NAT (`ip nat inside source static tcp
<insideIp> <insidePort> <outsideIp> <outsidePort>`, `config.portForwards`)
redirects a connection to the router's published outside IP:port onward to an
inside server and source-translates the reply back (`dnatInbound`/`dnatReturn`),
so an outside client reaches an inside web server through the router — the
`port-forward` scenario pairs it with the HTTP service. **Still to do:** upstream
DNS forwarding. Effort: low–moderate.

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

> **Router roles — shipped (2026-06).** A router carries a **role**
> (`config.role`) that teaches placement, the way the Switch tool splits
> basic/managed: a **Router** tool group with **Internal** (the plain default —
> interior forwarding) and **Border** (`border-router` → `role:"border"`, a
> `Border-N` name + an amber "B" badge — the edge archetype, the natural place
> for NAT + a firewall). Set via the inspector Role select or the `role <router>
> border|internal` console command; round-trips through JSON + the script export.
> **Later:** pre-wiring the border defaults (a designated outside/WAN interface
> with `ip nat outside` + a default route), and the fuller hierarchy (core /
> distribution / access, or interior vs exterior/AS-boundary for BGP) if
> three-tier campus design becomes a teaching goal.

### Configurable links
Mostly shipped. Links are nameable, deletable, and carry **admin status** (shut
without deleting — inspector toggle, `shut`/`noshut` console commands, or a
canvas double-click; dashed-red, frames dropped with a sim-log entry), **canvas
labels for named links**, and now **bandwidth / latency / loss** per link:
latency stretches that wire's transit animation (a far/WAN link visibly
crawls), loss randomly drops forwarded frames in animated runs (headless
reachability stays deterministic), and bandwidth is stored as the capacity
input the *streams* mode will consume. **Latency/loss on the canvas — shipped
(2026-11):** a non-default latency and loss join the link's canvas label as text
(`WAN · 40 ms · 5% loss`), not as a colour. What remains: **per-link
colour/style**. Effort: low (the cosmetic bits).

### Firewall — beyond basic packet filtering
**Stateful filtering + REJECT — shipped (2026-06).** Connection tracking
(`connectionState`/`trackConnection`, `SimulationState.conntrack`) drives
`-m state` / `-m conntrack --ctstate` rules (NEW/ESTABLISHED assigned;
RELATED/INVALID parse but never match), gated by `firewallUsesConntrack` so a
stateless ruleset is free. REJECT now answers — a TCP RST (a scan reads the port
as closed) or an ICMP destination-unreachable — instead of a silent drop. **Later:**
RELATED tracking (ICMP errors, FTP data), an INVALID classifier, and per-flow
NAT-helper conntrack.

### Port security — 802.1X & MACsec
Both reuse the substrate the WiFi auth work built — the EAPOL frame family and
the data-path gate (`l2Reachable`/`findFirstHop`/the engine transit step that
already drop data on an unauthenticated link while letting control frames pass).
- **Phase 0 (groundwork): shipped.** The gate is unified into one
  `linkAuthorizedForData(link)` consulted by all three sites, so WiFi auth, 802.1X
  port control and MACsec must-secure all compose at one chokepoint.
- **Phase 1 (802.1X): shipped.** A **supplicant** host authenticates to a switch
  **authenticator** port (`portauth … auto`) which relays EAP to a **RADIUS
  server** (a role on the server device). `dot1x <host>` / `run dot1x` animate
  EAPOL-Start → EAP-Identity → RADIUS Access-Request → Accept/Reject →
  EAP-Success/Failure (`handleDot1x` reactive state machine across all three
  roles); an `auto` port stays unauthorized (data blocked) until success, like
  the WiFi gate. Config via `supplicant`/`portauth`/`radius` (round-tripped).
  **Later:** the EAP method challenge round, MAB, dynamic VLAN assignment from
  RADIUS, a built-in topology/scenario, inspector controls, and the Cisco-style CLI.
- **Phase 2 (MACsec, 802.1AE): shipped.** Per-link encryption via a pre-shared
  CAK keyed by peer (`macsec <device> <peer> <key> [must|should]`, computed live
  by `macsecState`): matching keys **secure** the link (frames render as
  "MACsec — Encrypted … (SecTAG, ICV)" in the packet list, drawn teal), a
  must-secure mismatch **fails** it (data dropped via the unified gate, drawn
  red), and should-secure falls back to plaintext. **Later:** the SecTAG/ICV as
  real frame fields, and inspector controls.
- **Phase 3 (integration): shipped.** 802.1X-derived MACsec keys — the full
  enterprise "authenticate, then encrypt" story. `macsec <device> <peer> dot1x
  [must|should]` keys a link from the EAP exchange instead of a static CAK:
  `macsecState` reports it unsecured (must-secure → failed, data blocked) until a
  real 802.1X exchange sets `link.dot1xAuthorized`, then secured — so the link
  auto-keys the moment the port authenticates (a derive end facing a static-PSK
  end is an incompatible method). Reuses the unified gate and the `dot1x` flow
  wholesale; no new frame type. **Later:** an animated MKA (Key Agreement)
  handshake distributing the SAK, and the derived CAK/CKN shown in the inspector.
Effort: moderate per phase; the unified gate is the keystone.

### OSPF
A second IGP to contrast with RIP (link-state vs distance-vector, areas, cost).
Pairs with the existing `runRipConvergence` structure. Effort: high.

### Scenario authoring UI
An in-app editor (define topology + goal checks from the UI, export as JSON).
The JSON import path already exists.

### Persistence & sharing
- **Shareable URL — shipped (2026-11).** File → **Copy link** puts the whole
  network in the link's fragment (`rs-web.html#net=…`, deflated with the
  browser's own `CompressionStream`); opening the link loads it, with no server
  and no request. A link is untrusted input and is bounded and normalised like
  an imported file (`src/share-link.ts`). The link carries the scenario in
  progress, so a half-solved exercise arrives with its goal. **Later:** carry
  the *definition* of a scenario imported from a file (today only built-in
  scenarios travel, by id), so a teacher's own exercise can be handed out as a
  link.
- **localStorage autosave — shipped (2026-11).** The network on the canvas
  (with the active scenario and Instant DNS) is kept in the browser and
  restored on the next visit; opt-out in Settings, or `?autosave=0` for a
  visit that keeps nothing. The zero-request principle is about *network*, not
  storage, and the page works identically when storage is missing, blocked or
  full (`src/autosave.ts`). **Later:** keep more than one session (a named
  list), and warn when a second tab is about to overwrite the first's copy.

### UI polish (from the 2026-06 UI review)
> **Shipped (2026-06):** the **floating sim transport** (a play/pause/step/stop
> pill over the canvas while a run is active — `#simControls`, reachable from any
> ribbon tab, lifted clear of the open dock); the **scenario banner collapse** (the
> titlebar control shrinks it to a progress pill "Name — passed/total ✓" instead
> of abandoning the scenario; the pill body re-expands, the pill ✕ dismisses); and
> the **terminal QoL** wins — `Ctrl+C` cancels a running simulation from a terminal
> or the console (echoes `^C`), and a **right-click device context menu** (Terminal
> / Configure / Power / Delete).
- **Tab completion — shipped (2026-11).** The Linux host and server shells
  (and the Kali shells' host commands) complete on Tab as bash does: one
  match completes, several complete their common prefix, a second Tab lists
  them. Commands, the `ip` subcommands, the files the shell reads and device
  names as the target of `ping`/`traceroute`/`nc`/`curl`/`nslookup`; the words
  are read from the shell's own `help`, so they cannot drift. Tab still leaves
  an empty input (keyboard reach). The router keeps `?` + abbreviation.

### Polish
- **Annotations / notes on the canvas** — labels and callouts for teaching.
- **Minimap / fit-to-content for large topologies.**
- **`any`-debt typing pass** — inspector/devices/engine still lean on `any`;
  typed configs would catch field typos in the hottest files.

## Reach

- **IPv6** (addressing, NDP instead of ARP). Large.
- **Guided interactive tutorials.** (Explain-mode shipped as the **"Why?"
  affordance** — Later → Teaching affordances.)
- **Quiz mode** built on the scenario checks.
- **Accessibility pass** — keyboard nav, ARIA, screen-reader, and touch/mobile.
  (Colour-blind-safe encoding — the most urgent slice, since the tool conveys
  meaning by colour — has shipped; see Later → Teaching affordances.)
