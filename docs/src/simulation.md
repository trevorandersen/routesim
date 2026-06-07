# `src/simulation.ts` — Ping/DHCP setup & reachability

Turns a user request (`ping <target>` or `dhcp`) into the initial queue of simulation events, and provides the reachability/routing helpers the engine and UI need. It does **not** run the animation loop — that's `engine.ts`.

## Key exports

### Event builders
- **`buildPingEvents(source, targetText)`** — validates a ping and decides same-subnet (L2) vs cross-subnet (via the default gateway). Returns either an error string (`"ping: cannot resolve …"` only for an unresolvable *hostname*; `"… Network is unreachable …"` for a local config error like a missing/off-subnet gateway) or a `PingSetup` (`{ events, pendingArp }`) — an ARP request (if the MAC is unknown) plus a deferred ICMP held in `pendingArp` until the ARP resolves. **It does not pre-compute reachability:** a bare destination IP that belongs to no device still emits a real ARP (to the target on-subnet, or to the gateway off-subnet), and the *simulation* decides the outcome — a flooded ARP with no reply or a router's "No route" drop both time out as 100% packet loss. The router's own routing table (`routingLookup`, `engine.ts`) is the single source of truth for cross-subnet reachability.
- **`buildDhcpEvents(source)`** — validates a DHCP request and returns the initial DHCP Discover event (or an error string).

### Reachability & routing helpers
- **`l2Reachable(fromId, toId, vlanId)`** — VLAN-aware BFS across switches: does a frame on `vlanId` reach `toId` at layer 2? Stops at routers and respects access/trunk port membership. Runs on every ping/DHCP validation, so it goes through the `linksFor` adjacency index and is **benchmarked**.
- **`devicesHavePath`** — coarse connectivity check.
- **`getVlanForDevice(deviceId)`** — the VLAN a host sits in (via its switch's access-port assignment).
- **`findPingTarget(value)`** — resolve a ping target to a device by name or IP (returns `undefined` for a bare IP that belongs to no device, so the ping still ARPs and times out).

## How it fits

`terminal.ts` calls `buildPingEvents`/`buildDhcpEvents` when a user types `ping`/`dhcp`, then hands the result to `engine.startSimulation`. The engine consumes the `events` queue and `pendingArp` map; `l2Reachable`/`getVlanForDevice` are reused both here (validation) and by the engine (forwarding decisions).

## Notes

- The validation-vs-error split is what makes terminal commands testable without starting a simulation (the error path returns a string and never calls `startSimulation`). See [testing.md](../testing.md).
- A "self-ping" (pinging your own IP) returns an instant string result rather than an event queue.
