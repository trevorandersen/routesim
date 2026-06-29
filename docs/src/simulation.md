# `src/simulation.ts` — Ping/DHCP setup & reachability

Turns a user request (`ping <target>` or `dhcp`) into the initial queue of simulation events, and provides the reachability/routing helpers the engine and UI need. It does **not** run the animation loop — that's `engine.ts`.

## Key exports

### Event builders
- **`buildPingEvents(source, targetText, { ttl? })`** — validates a ping and decides same-subnet (L2) vs cross-subnet (via the default gateway). The optional `ttl` (default 64) sets the echo request's initial TTL — traceroute uses it to send increasing-TTL probes. Returns either an error string (`"ping: cannot resolve …"` only for an unresolvable *hostname*; `"… Network is unreachable …"` for a local config error like a missing/off-subnet gateway) or a `PingSetup` (`{ events, pendingArp }`) — an ARP request (if the MAC is unknown) plus a deferred ICMP held in `pendingArp` until the ARP resolves. **It does not pre-compute reachability:** a bare destination IP that belongs to no device still emits a real ARP (to the target on-subnet, or to the gateway off-subnet), and the *simulation* decides the outcome — a flooded ARP with no reply or a router's "No route" drop both time out as 100% packet loss. The router's own routing table (`routingLookup`, `engine.ts`) is the single source of truth for cross-subnet reachability.
- **`buildDhcpEvents(source)`** — validates a DHCP request and returns the initial DHCP Discover event (or an error string).
- **`buildConnectEvents(source, targetText, port)`** — validates a TCP connect (`nc`) and returns the SYN setup (or an error string).
- **`buildHttpEvents(source, targetText, port?, path?)`** — an HTTP request: reuses `buildConnectEvents` for the handshake (default port 80) and tags the setup with `httpPath` (and `dns.then = "http"` for a by-name flow), so the engine sends the GET once connected. `parseHttpTarget(text, fallbackPath?)` splits a bare host / `host:port` / `http://host[:port][/path]` URL into `{ host, port, path }` (shared by the console `http`/`run http` and the PC terminal `curl`/`wget`).
- **`buildResolveEvents(source, name, …)`** — builds a headless DNS lookup (the real UDP/53 frames) used by resolve-then-act flows and `run resolve`.

### Red Team attack builders

These build offensive flows the same way the ping builders do: each returns a `PingSetup` (seeded frames plus a deferred `pendingArp`) or an error string, so an attack animates on the canvas and runs headless exactly like a ping. Each takes any **offensive host** as its first argument and reads that host's config — they don't care which type, so the hand-driven **Kali PC** (`type: "kali"`, Computer group) and the autonomous **Red Team actor** (`type: "attacker"`, Security group) share the same builders. They ARP-resolve the next hop first — direct if the target is same-subnet, otherwise the gateway (`attackNextHop`) — and resolve a target argument (a device name or a bare IP) via `attackTargetIp`. See [red-team.md](red-team.md) for the full Red Team story.

- **`buildScanEvents(host, targetText)`** — an `nmap -sS` SYN scan: a TCP SYN to each of `SCAN_PORTS` (`21,22,23,25,53,80,110,143,443,445,3306,3389,8080`) on the target, all from one ephemeral source port. An open port answers SYN-ACK, a closed one RST.
- **`buildSweepEvents(host, subnetText)`** — an `nmap -sn` ping sweep: an ICMP echo to each of the first `SWEEP_HOSTS` (20) addresses of a subnet (the argument, else the host's own subnet). Each probe is **routed like a real ping** via `attackNextHop` — a same-subnet target directly, a target in a **remote** subnet via the **gateway** (one shared ARP, all echoes buffered under the gateway's next-hop key) — so sweeping *another* subnet across a router works. (Previously it ARP-resolved every remote host directly on the local wire, so a sweep of another subnet found nothing.) If no gateway is set for a remote sweep, it returns `"nmap: nothing to sweep"`. Live hosts reply; the rest time out.
- **`buildArpSpoofEvents(host, spoofText?)`** — a single **gratuitous ARP reply** broadcasting "spoofIp is at <our MAC>" (spoofIp = the argument, else `config.spoofIp`, else the gateway), poisoning every host's ARP cache for a man-in-the-middle. The poisoning itself is ordinary host ARP learning at each victim.
- **`buildAttackEvents(host, only?)`** — merges the enabled `config.attacks` (or one named kind) into a single run, concatenating each builder's events and `pendingArp` (arrays merged on key collision). The scan/sweep target is `config.attackTarget` (sweep falls back to the host's own subnet).

### Reachability & routing helpers
- **`l2Reachable(fromId, toId, vlanId)`** — VLAN-aware BFS across switches: does a frame on `vlanId` reach `toId` at layer 2? Stops at routers and respects access/trunk port membership. Runs on every ping/DHCP validation, so it goes through the `linksFor` adjacency index and is **benchmarked**.
- **`getVlanForDevice(deviceId)`** — the VLAN a host sits in (via its switch's access-port assignment).
- **`findPingTarget(value)`** — resolve a ping target to a device by name or IP (returns `undefined` for a bare IP that belongs to no device, so the ping still ARPs and times out).

## How it fits

`terminal/` calls `buildPingEvents`/`buildDhcpEvents` when a user types `ping`/`dhcp`, then hands the result to `engine.startSimulation`. The engine consumes the `events` queue and `pendingArp` map; `l2Reachable`/`getVlanForDevice` are reused both here (validation) and by the engine (forwarding decisions).

## Notes

- The validation-vs-error split is what makes terminal commands testable without starting a simulation (the error path returns a string and never calls `startSimulation`). See [testing.md](../testing.md).
- A "self-ping" (pinging your own IP) returns an instant string result rather than an event queue.
