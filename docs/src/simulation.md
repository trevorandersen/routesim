# `src/simulation.ts` — Ping/DHCP setup & reachability

Turns a user request (`ping <target>` or `dhcp`) into the initial queue of simulation events, and provides the reachability/routing helpers the engine and UI need. It does **not** run the animation loop — that's `engine.ts`.

## Key exports

### Event builders
- **`buildPingEvents(source, targetText, { ttl? })`** — validates a ping and decides same-subnet (L2) vs cross-subnet (via the default gateway). The optional `ttl` (default 64) sets the echo request's initial TTL — traceroute uses it to send increasing-TTL probes. Returns either an error string (`"ping: cannot resolve …"` only for an unresolvable *hostname*; `"… Network is unreachable …"` for a local config error like a missing/off-subnet gateway, or when the host's cable cannot carry the frame — `findFirstHop` returns the reason, so the bracket names it: "(no link)" only when there is no cable at all, otherwise `linkDataBlockReason`'s cause (shut, spanning-tree blocked, a WiFi SSID or password mismatch, an unauthorized 802.1X port, a failed MACsec link) or a powered-off peer; every builder — ping, nc, nslookup, dhcp, nmap, arpspoof — shares it) or a `PingSetup` (`{ events, pendingArp }`) — an ARP request (if the MAC is unknown) plus a deferred ICMP held in `pendingArp` until the ARP resolves. **It does not pre-compute reachability:** a bare destination IP that belongs to no device still emits a real ARP (to the target on-subnet, or to the gateway off-subnet), and the *simulation* decides the outcome — a flooded ARP with no reply or a router's "No route" drop both time out as 100% packet loss. The router's own routing table (`routingLookup`, `engine.ts`) is the single source of truth for cross-subnet reachability.
- **`buildDhcpEvents(source)`** — validates a DHCP request and returns the initial DHCP Discover event (or an error string).
- **`buildConnectEvents(source, targetText, port)`** — validates a TCP connect (`nc`) and returns the SYN setup (or an error string).
- **`buildHttpEvents(source, targetText, port?, path?)`** — an HTTP request: reuses `buildConnectEvents` for the handshake (default port 80) and tags the setup with `httpPath` (and `dns.then = "http"` for a by-name flow), so the engine sends the GET once connected. `parseHttpTarget(text, fallbackPath?)` splits a bare host / `host:port` / `http://host[:port][/path]` URL into `{ host, port, path }` (shared by the console `http`/`run http` and the PC terminal `curl`/`wget`).
- **`buildResolveEvents(source, name, …)`** — builds a headless DNS lookup (the real UDP/53 frames) used by resolve-then-act flows and `run resolve`.

### Red Team attack builders

The offensive attack builders — `buildScanEvents` / `buildSweepEvents` / `buildArpSpoofEvents` / `buildAttackEvents`, plus `macForIp`, `SCAN_PORTS`, `attackNextHop` and `attackTargetIp` — **moved out of `simulation.ts` into `src/security/offensive/attacks.ts`** when the offensive code was separated from general networking code, so the general simulation module no longer carries attack technique. They still build a `PingSetup` exactly like the ping builders (an attack animates and runs headless like a ping) and reach **`findFirstHop` / `findPingTarget`** — exported from this module — for the shared first-hop and name-resolution logic. See [red-team.md](red-team.md) for the full attacker model and the per-builder detail.

### Reachability & routing helpers
- **`l2Reachable(fromId, toId, vlanId)`** — VLAN-aware BFS across switches: does a frame on `vlanId` reach `toId` at layer 2? Stops at routers and respects access/trunk port membership. **It is not a pre-check on any run** — no builder calls it: a ping to an unreachable address still ARPs and the simulation decides (the frame path's own chokepoints are `findFirstHop` and the engine transit step). Its one caller in `src/` is `routerIfacesShareSegment` — RIP's neighbour discovery, once per interface per convergence. It goes through the `linksFor` adjacency index and is **benchmarked**. (It had no `src/` caller at all until RIP learnt to cross a switch, while the docs called it a per-ping chokepoint — review R53.)
- **`routerIfacesShareSegment(a, b)`** — are two router interfaces on one L2 segment (would a frame multicast out of `a` arrive on `b`)? Both cables must carry data, both first devices must be powered-on bridges (not a router, the cloud or a host), both ends must sit in the same VLAN (`routerIfaceVlan`: the sub-interface tag, else the access or trunk-native VLAN of the managed-switch port), each plugged-into port must carry it, and `l2Reachable` must find a path between the two bridges. RIP's neighbour discovery (`routing.ts`) is its caller.
- **`getVlanForDevice(deviceId)`** — the VLAN a host sits in (via its switch's access-port assignment). Presentation only: the canvas labels a host with it (`canvas.ts`); the engine never asks — `processAtSwitch` reads the VLAN off the ingress port.
- **`findPingTarget(value)`** — resolve a ping target to a device by name or IP (returns `undefined` for a bare IP that belongs to no device, so the ping still ARPs and times out).

## How it fits

`terminal/` calls `buildPingEvents`/`buildDhcpEvents` when a user types `ping`/`dhcp`, then hands the result to `engine.startSimulation`. The engine consumes the `events` queue and `pendingArp` map, and makes every forwarding decision itself, frame by frame. The two query helpers here feed other readers: `l2Reachable` answers RIP's "who shares this segment?" (`routing.ts`), and `getVlanForDevice` labels hosts on the canvas.

## Notes

- The validation-vs-error split is what makes terminal commands testable without starting a simulation (the error path returns a string and never calls `startSimulation`). See [testing.md](../testing.md).
- A "self-ping" (pinging your own IP) returns an instant string result rather than an event queue.


## `l2Reachable` checks the VLAN on the way OUT of a switch too

The BFS applies the 802.1Q rule at both ends of every managed-switch port it crosses: **entering** a managed switch, the ingress port (toward where the path came from) must carry the VLAN; **leaving** one, the egress port toward the next hop must — `portToward` + `portCarries` (a trunk carries any allowed VLAN, an empty allowed list meaning all; an access port carries its assigned one). The egress half used to be dead code: it searched the switch's ports for a peer equal to the switch *itself*, so it never fired, and two hosts on different access VLANs of one switch read as reachable. The outcome was still right — `processAtSwitch` isolated them on the real frame path — but the query disagreed with the engine and `tests/simulation.test.ts` pinned the disagreement. It now pins agreement — which matters since RIP decides adjacency across a managed switch with it.
