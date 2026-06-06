# `src/simulation.ts` — Ping/DHCP setup & reachability

Turns a user request (`ping <target>` or `dhcp`) into the initial queue of simulation events, and provides the reachability/routing helpers the engine and UI need. It does **not** run the animation loop — that's `engine.ts`.

## Key exports

### Event builders
- **`buildPingEvents(source, targetText)`** — validates a ping: resolves the target (name or IP), checks connectivity, decides same-subnet (L2) vs cross-subnet (route via gateway). Returns either an error string (`"ping: cannot resolve …"`, `"… Network is unreachable …"`) or a `PingSetup` (`{ events, pendingArp }`) — an ARP request (if the MAC is unknown) plus a deferred ICMP held in `pendingArp` until the ARP resolves.
- **`buildDhcpEvents(source)`** — validates a DHCP request and returns the initial DHCP Discover event (or an error string).

### Reachability & routing helpers
- **`l2Reachable(fromId, toId, vlanId)`** — VLAN-aware BFS across switches: does a frame on `vlanId` reach `toId` at layer 2? Stops at routers and respects access/trunk port membership. Runs on every ping/DHCP validation, so it goes through the `linksFor` adjacency index and is **benchmarked**.
- **`devicesHavePath`** — coarse connectivity check.
- **`getVlanForDevice(deviceId)`** — the VLAN a host sits in (via its switch's access-port assignment).
- **`findRouterBetweenSubnets`, `findPingTarget`** — locate the routing device between two subnets / resolve a ping target device.

## How it fits

`terminal.ts` calls `buildPingEvents`/`buildDhcpEvents` when a user types `ping`/`dhcp`, then hands the result to `engine.startSimulation`. The engine consumes the `events` queue and `pendingArp` map; `l2Reachable`/`getVlanForDevice` are reused both here (validation) and by the engine (forwarding decisions).

## Notes

- The validation-vs-error split is what makes terminal commands testable without starting a simulation (the error path returns a string and never calls `startSimulation`). See [testing.md](../testing.md).
- A "self-ping" (pinging your own IP) returns an instant string result rather than an event queue.
