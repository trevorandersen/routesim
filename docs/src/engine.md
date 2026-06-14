# `src/engine.ts` — The simulation engine

The largest and most important module. Drives a ping/DHCP simulation through two phases — **process** (dequeue an event, run the per-device handler, collect outgoing frames) and **animate** (interpolate transit dots, deliver on arrival) — and implements per-device packet processing, routing, and RIP.

## Public API (lifecycle)
- **`startSimulation(setup, sourceId, targetIp, mode?)`** — seeds the queue from a `PingSetup`/DHCP setup and starts the rAF animation loop.
- **`stopSimulation`, `pauseSimulation`, `resumeSimulation`, `stepOnce`** — sim controls (wired to the on-canvas play/pause/step buttons).
- **`syncSimLog()`** — rebuilds the sim-log dock pane: the Wireshark-style **packet list** (`renderPacketList` over `sim.capture`, columns via `packetColumns` in `frame.ts`) or the narrative **event view** (`renderEventLog` over `sim.log`), per `state.dock.logView`.
- **`autoBootLinkedHosts(aId, bId)` / `bootHostAutoconf(device)`** — first-boot autoconf: when a cable comes up (the `linkUp` device callback) or a cabled host powers on, an unconfigured host runs a **headless DHCP** exchange and falls back to **APIPA** (`169.254.x.y/16`, no gateway) if no server answers. Guarded against active sims, configured/powered-off hosts, and uncabled boots; the outcome lands in the ribbon status line.
- **`runSimulationHeadless(setup, sourceId, targetIp, mode?)`** — drains the queue synchronously (no rAF, no per-step render/terminal output — it sets `sim.headless`) and returns a `SimResult` (`{ success, ttl, responderIp, timeExceeded, assignedIp, assignedGateway, log, steps }`). Powers the console `run` verb, `window.routesim`, scenario checks, and tests.
- **`runTraceroute(source, target, maxHops?)`** — warms ARP along the path, then sends probes with increasing TTL (1..maxHops) via `runSimulationHeadless`, recording each hop's responder (a router's ICMP Time-Exceeded, or the destination's Echo Reply). Returns a `TracerouteResult`. Backs the `traceroute`/`tracert` command in the PC terminal and console.

> Because `startSimulation` starts a `requestAnimationFrame` loop, it must **not** be called in unit tests with the preload's synchronous rAF stub (infinite recursion). Tests call the `processAt*` handlers (or `runSimulationHeadless`/`runTraceroute`) directly — or, for genuinely animated behaviour, stub rAF to a no-op and pump with `stepOnce()`. See [testing.md](../testing.md).

### Packet capture
During animated delivery, `deliverCompletedTransits` records each wire traversal into `sim.capture` (a `CaptureEntry`: running number, step, frame, endpoint devices, link — capped at 1000). This is the packet list the sim-log pane renders. Headless runs neither record nor clear the capture, so background boot chatter and scenario checks never wipe a visible packet list; `startSimulation`/`stopSimulation` do clear it.

## Per-device processing
Each handler takes a device, an incoming frame, and the ingress peer id, and returns `OutgoingFrame[]`:

- **`processAtComputer`** — answers ARP for its own IP, replies to ICMP echo requests, marks ping success on echo reply, drives the DHCP client (Discover→Offer→Request→Ack, assigning IP/gateway/prefix and learning the router MAC on Ack), and speaks **TCP**: a SYN to a listening port (no `openPorts` list = listen on all; otherwise only those) answers SYN-ACK, a closed port answers RST, and the origin completes the handshake with ACK (`sim.tcpSuccess`).
- **`processAtSwitch`** — MAC-learns on ingress, then forwards (known unicast) or floods (broadcast/unknown). Managed switches enforce 802.1Q VLANs: access ports tag/untag, trunk ports carry allowed VLANs with a native VLAN.
- **`processAtRouter`** — matches the ingress interface by peer, then dispatches: ARP → `handleRouterArp`, broadcast DHCP → `handleRouterDhcp` (allocates a lease, sends Offer/Ack), otherwise → `routeIpv4Frame`. Routing checks TTL **before** the forwarding decision (so an expired packet to an unrouteable destination still replies): on TTL 0 it drops the packet and sends an **ICMP Time-Exceeded** back from the ingress interface (the traceroute signal); otherwise it decrements TTL, rewrites L2 headers, and ARP-resolves on egress (buffering the frame in `pendingArp` on a miss). The self-IP branch answers ICMP echo to the router's own interface IP — and narrows on `payload.type === "icmp"` so a DHCP packet addressed to the router IP isn't mistaken for a self-ping.

`processAtRouter` is decomposed into `handleRouterArp` / `handleRouterDhcp` / `routeIpv4Frame` for clarity; the orchestrator just matches the ingress interface and dispatches. When interfaces carry `ip nat inside`/`outside` marks, `routeIpv4Frame` also translates inside→outside flows and restores the return path (see [nat.md](nat.md)); the router's own netfilter INPUT/FORWARD chains filter before delivery/forwarding (see [firewall.md](firewall.md)).

- **`processAtServer`** — answers DNS queries from its A-records (a `DnsPayload` response; unknown name → NXDOMAIN) and serves DHCP from its configured `dhcp-range` (`handleServerDhcp`, with router + nameserver options), both gated on `dnsmasqRunning`; everything else falls through to `processAtComputer`, so a server is also an ordinary host endpoint. See [dns.md](dns.md).

- **`processAtFirewall`** — a transparent inline packet filter: bridges ARP/control frames to the other port(s) and evaluates each IPv4 packet against the FORWARD chain via `evaluateFirewall` (first-match-wins, else the chain policy) + `firewallRuleMatches` (src/dst CIDR, protocol, ICMP type). ACCEPT forwards, DROP/REJECT discards (logged `Firewall DROP …`). See [firewall.md](firewall.md).

## Routing & RIP
- **`buildRoutingTable(router)`**, **`routingLookup`**, **`runRipConvergence`** now live in **`src/routing.ts`** (re-exported here for compatibility): the table merges connected (metric 0), static (metric 1), and RIP-learned (metric 2+) routes; the lookup resolves a destination to an egress interface.
- **`runRipConvergence()`** — runs automatically before each simulation. Iterates up to 15 rounds exchanging advertisements between RIP-enabled routers until no route changes. Implements split-horizon (don't advertise a route back out the interface it was learned on) and metric 16 = unreachable. Decomposed into advertisement-building and update-applying helpers. Router interface normalisation is **memoised per run** for performance, and the whole thing is benchmarked.

## How it fits

`engine.ts` sits at the centre of the simulation: it consumes `simulation.ts`'s event setup, creates response frames via `frame.ts`, reads/writes device config (ARP/MAC/DHCP tables) on `state`, and calls `sync().render()`/`syncSimLog()` to animate. Forwarding decisions reuse `devices.ts` (interface enumeration) and `simulation.ts`/`utils.ts` (subnet maths).
