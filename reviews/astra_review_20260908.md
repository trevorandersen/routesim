# RouteSim codebase review — 8 September 2026

Reviewed commit: `7f00c3990cca29c11db50087294e3f84a379a66d`.

The existing tests, both TypeScript checks, and the build pass. Targeted review probes nevertheless identified **14 actionable findings: 3 P1 and 11 P2**. The most consequential problems are configuration loss during export, unbounded allocation from imported port numbers, and incorrect routing and authentication outcomes.

This is a review report; application source and existing tests were not changed. Findings concern the current codebase, rather than a particular patch.

## Findings at a glance

P1 means fix promptly because ordinary persistence can lose configuration or a small imported input can make the application unusable. P2 means a reproducible functional defect or an exposure limited to the development server. Authentication and firewall findings describe the simulated network, not a bypass of the user's operating system security.

| ID | Priority | Finding | Main location |
|---|---|---|---|
| F01 | P1 | Imported port numbers can trigger unbounded allocation | `src/normalise.ts:541` |
| F02 | P1 | Saving a collapsed LAN discards router interface configuration | `src/config.ts:191` |
| F03 | P1 | Script export silently removes firewall, NAT, RIP, and listener settings | `src/commands.ts:1145` |
| F04 | P2 | Longest-prefix lookup selects the wrong egress interface | `src/routing.ts:106` |
| F05 | P2 | Router DHCP leases can fall outside the configured subnet | `src/engine.ts:2119` |
| F06 | P2 | Reply traffic bypasses the destination host's configured gateway | `src/engine.ts:859` |
| F07 | P2 | Explicit router port assignments are renumbered | `src/devices.ts:772` |
| F08 | P2 | RIP exchanges routes over interfaces outside its configured networks | `src/routing.ts:259` |
| F09 | P2 | Duplicate 802.1X identities authenticate the wrong host and port | `src/engine.ts:764` |
| F10 | P2 | The first animated transmission bypasses packet loss | `src/engine.ts:49` |
| F11 | P2 | Hub and Internet port counts do not survive JSON export | `src/config.ts:25` |
| F12 | P2 | Malformed scenario checks remain registered after import fails | `src/io.ts:85` |
| F13 | P2 | Clear leaves an active simulation referencing deleted devices | `src/devices.ts:382` |
| F14 | P2 | Development server exposes repository files and test execution on all interfaces | `test-server.ts:102` |

## Detailed findings

### F01 — [P1] Bound and validate imported link port numbers

**Location:** [normalise.ts:541](/Users/trevorandersen/dev/routesim/src/normalise.ts:541), [devices.ts:555](/Users/trevorandersen/dev/routesim/src/devices.ts:555).

`normaliseConfig()` converts `fromPort` and `toPort` with `Number()` without checking finiteness, integrality, range, or whether another link already occupies the port. `linkedPortsFor()` then fills an array with nulls until it reaches that index. A JSON string value of `"Infinity"` survives normalization as `Infinity`; the allocation loop cannot reach it. A large finite number has the same practical memory-exhaustion risk. Normal topology rendering and STP convergence call this helper.

**Reproduction:** Import two switches and a link with `"fromPort":"Infinity"`. The normalization probe confirmed the stored port is `Infinity`. The dangerous allocation loop was deliberately not executed; its unbounded condition is directly visible in the source. Duplicate positive ports also overwrite an earlier entry in the port view.

**Fix:** Validate ports before applying the topology: require finite positive integers within the endpoint's supported physical port range and reject duplicate assignments. Apply the same upper bound in `resolvePort()`, which currently accepts arbitrarily large positive integers from commands. Keep a defensive bound in `linkedPortsFor()` too.

**Regression coverage:** Nonfinite, fractional, negative, oversized, and duplicate endpoint ports must fail or normalize safely before any rendering or array expansion.

### F02 — [P1] Preserve interfaces attached to collapsed LANs when saving

**Location:** [config.ts:191](/Users/trevorandersen/dev/routesim/src/config.ts:191), [devices.ts:522](/Users/trevorandersen/dev/routesim/src/devices.ts:522).

`routerInterfacesForPayload()` retains peer-bound interfaces only when `connectedIds()` contains their peer. That helper excludes hidden links. Collapsing a LAN intentionally hides its physical links and replaces its visible boundary with a proxy link to the LAN object. Consequently, saving while collapsed filters out the real router interface, including its address, prefix, NAT role, and tables.

**Reproduction:** Load `routedTopology()` from `tests/fixtures.ts`, collapse `sw-a`, export with `buildConfigPayload()`, normalize/load that payload, and expand the LAN. Before export the router has interfaces for `sw-a` and `sw-b`; the exported payload retains only `sw-b`. A subsequent PC-A → PC-B ping fails. Expanding cannot recover the omitted configuration.

**Fix:** Determine whether a configured peer is structurally connected using the underlying physical links, including hidden links retained by collapse. Exclude proxy links from that decision. Treat collapse as a presentation change during serialization.

**Regression coverage:** Export/import/expand a collapsed routed topology and compare its complete interface configuration and connectivity to the original. Include a NAT-enabled boundary interface.

### F03 — [P1] Make script export preserve operational configuration

**Location:** [commands.ts:1145](/Users/trevorandersen/dev/routesim/src/commands.ts:1145), [commands.ts:1172](/Users/trevorandersen/dev/routesim/src/commands.ts:1172), [commands.ts:1205](/Users/trevorandersen/dev/routesim/src/commands.ts:1205).

The exporter advertises a reproducible topology script, but it has no firewall configuration branch and does not emit router filter policies/rules, RIP configuration, or interface NAT roles. It also omits an explicitly empty host `openPorts` list. Replaying starts with `clear`, so missing fields silently revert to defaults: a DROP firewall becomes ACCEPT, NAT and RIP disappear, and a host listening on no ports returns to the model's listen-on-any-port default.

**Reproduction:** Export a topology containing a firewall with a DROP policy and an ICMP ACCEPT rule, a router with RIP enabled and an outside NAT interface, and a computer with `openPorts: []`. Replay the returned script. Every command reports success, but the firewall has no rules and an ACCEPT policy, the router has neither RIP nor its NAT role, and the computer has no `openPorts` property. The generated script contains only device creation, the router IP assignment, and the link.

This contradicts the explicit completeness guarantee in [scripting.md:201](/Users/trevorandersen/dev/routesim/docs/scripting.md:201). Other statically omitted persistent fields include device power state and customized port capacities.

**Fix:** Define the persistent fields supported by script export and emit commands that restore each field, adding missing command representations where necessary. Preserve the distinction between an absent listener list and an empty list. Until completeness is implemented, surface unsupported fields before presenting the export as a faithful backup.

**Regression coverage:** Compare normalized operational configuration before and after replay, then rerun firewall isolation, NAT, RIP, and closed-listener behavior checks. Checking names and IP addresses alone is insufficient.

### F04 — [P2] Use the selected route's interface for forwarding

**Location:** [routing.ts:106](/Users/trevorandersen/dev/routesim/src/routing.ts:106), [routing.ts:82](/Users/trevorandersen/dev/routesim/src/routing.ts:82).

The longest-prefix search selects a route correctly, then discards its interface and calls `ifaceOnSubnet()`, which returns the first matching raw interface. With overlapping prefixes, the broader interface can win even though the more specific route was selected. Static/RIP next-hop resolution has the same first-match problem and does not restrict candidates to active connected interfaces.

**Reproduction:** Configure a router's first interface as `10.0.0.1/8` toward `wide`, and its second as `10.1.0.1/16` toward `narrow`. The routing table contains both connected networks. `routingLookup(router, "10.1.2.3")` nevertheless returns the interface toward `wide`.

**Fix:** Resolve a connected route to its selected interface, preserving stable interface identity. For indirect routes, resolve the next hop using the best active connected route rather than the first matching raw configuration entry.

**Regression coverage:** Overlapping prefixes in both configuration orders, plus a matching disconnected or administratively shut interface ahead of a live interface.

### F05 — [P2] Restrict DHCP allocation to the interface's usable subnet

**Location:** [engine.ts:2091](/Users/trevorandersen/dev/routesim/src/engine.ts:2091), [engine.ts:2119](/Users/trevorandersen/dev/routesim/src/engine.ts:2119).

The router allocator always searches the interface's textual `/24` slice from `.100` through `.254`. Although it reads the actual prefix when gathering used addresses, it never checks that a candidate belongs to that prefix. The offer and ACK then advertise the configured prefix alongside an incompatible lease.

**Reproduction:** Set the router's LAN interface to `192.168.10.129/25`, clear the attached PC's address, and run DHCP. The run reports success and assigns `192.168.10.100/25` with gateway `192.168.10.129`. Client and gateway are in different `/25` networks.

**Fix:** Derive the usable address interval from the configured network and prefix. Intersect any preferred pool with that interval, exclude reserved addresses, and report exhaustion if no usable address remains.

**Regression coverage:** Both halves of a `/25`, a small `/30`, and exhaustion. Assert that every successful lease shares the advertised subnet with its gateway, rather than only checking the DHCP success flag.

### F06 — [P2] Route host replies through their configured next hop

**Location:** [engine.ts:859](/Users/trevorandersen/dev/routesim/src/engine.ts:859), [engine.ts:1645](/Users/trevorandersen/dev/routesim/src/engine.ts:1645).

`hostHasReturnRoute()` treats any nonempty gateway as a usable return route. ICMP and TCP reply construction then sends directly to the incoming frame's source MAC and ingress peer. It never resolves or uses the configured gateway. Thus an incorrect gateway can still produce successful cross-subnet replies, masking exactly the sort of misconfiguration this simulator teaches users to diagnose.

**Reproduction:** In `routedTopology()`, change PC-B's gateway from the real `192.168.20.1` to nonexistent `192.168.20.254`. PC-A → PC-B ping still returns `success: true`.

**Fix:** Apply the same subnet/next-hop decision and ARP resolution used for host-originated traffic to replies. Validate on-link gateway reachability and forward using that gateway's resolved MAC.

**Regression coverage:** A wrong but on-subnet gateway, an off-subnet gateway, and a valid alternate gateway. Cover TCP and DNS responses as well as ICMP.

### F07 — [P2] Keep router interface names aligned with physical port selection

**Location:** [devices.ts:772](/Users/trevorandersen/dev/routesim/src/devices.ts:772), [devices.ts:785](/Users/trevorandersen/dev/routesim/src/devices.ts:785), [devices.ts:897](/Users/trevorandersen/dev/routesim/src/devices.ts:897).

`linkedPortsFor()` preserves explicit port positions, but `routerInterfacesWithNames()` removes empty slots and renumbers the remaining links sequentially by type. The picker in turn maps the resulting interface list back to `index + 1`. A selected physical port therefore does not reliably identify the same interface in the picker, inspector, and terminal; adding or removing another cable can change the apparent interface name.

**Reproduction:** Connect a router to a switch with `fromPort: 4`. `linkedPortsFor(router.id)` places the peer at index 3, while `routerInterfacesWithNames(router)` calls that occupied interface `Ethernet1` and treats `Ethernet4` as empty.

**Fix:** Define one stable mapping between physical port identity, media type, and interface name. Preserve that identity through sparse views and use it directly in the picker rather than deriving it from array position.

**Regression coverage:** A sole link on Ethernet4, adding an earlier port, removing an earlier port, and mixed Ethernet/serial links. Assert interface identity and attached configuration, not just absence of exceptions.

### F08 — [P2] Enforce RIP interface activation during route exchange

**Location:** [routing.ts:259](/Users/trevorandersen/dev/routesim/src/routing.ts:259).

RIP `networks` determine which connected routes are advertised, but the exchange loop sends and accepts advertisements across every directly attached RIP-enabled router. Neither endpoint's link address has to match an enabled network. A router with an empty network list can therefore learn routes, and a transit interface omitted from RIP can still carry advertisements.

**Reproduction:** Connect R1 and R2 using `10.0.0.1/24` and `10.0.0.2/24`. Enable RIP on R1 only for its separate `192.168.1.0/24` LAN; enable RIP on R2 with `networks: []`. After `runRipConvergence()`, R2 learns `192.168.1.0/24` via `10.0.0.1`, despite neither router enabling RIP on the transit subnet.

**Fix:** Gate sending and receiving on the relevant interface's RIP activation, separately from choosing routes to advertise. Validate participating neighbor/link state in that same path.

**Regression coverage:** Empty network lists and a transit subnet omitted on either endpoint must prevent the corresponding exchange; enabling the transit network must restore convergence.

### F09 — [P2] Correlate 802.1X exchanges by session and ingress port

**Location:** [engine.ts:764](/Users/trevorandersen/dev/routesim/src/engine.ts:764), [engine.ts:726](/Users/trevorandersen/dev/routesim/src/engine.ts:726), [engine.ts:769](/Users/trevorandersen/dev/routesim/src/engine.ts:769).

RADIUS obtains the supplicant password by finding the first device anywhere in `state.devices` with the supplied identity. On return, the switch authorizes the first attached host with that identity. Neither operation retains which host or ingress port initiated the exchange. Identities need not be globally unique, so another host's credentials and port can be used.

**Reproduction:** Attach PC1 and PC2 to separate `auto` ports on one switch. Both identify as `alice`; PC1 has the correct password and PC2 has a wrong password. Start `runSimulationHeadless(buildDot1xEvents(PC2), PC2.id, "", "dot1x")`. It reports success, authorizes PC1's link, and leaves PC2's link unauthorized.

**Fix:** Carry a transaction/session identifier and initiating host/port through the exchange. Validate that session's credentials and apply the result only to its originating port. Record success only for the intended origin.

**Regression coverage:** Duplicate identities with different passwords on the same switch and on different switches; confirm both the reported result and the specific authorized link.

### F10 — [P2] Apply packet loss to the initial transmission

**Location:** [engine.ts:49](/Users/trevorandersen/dev/routesim/src/engine.ts:49), [engine.ts:590](/Users/trevorandersen/dev/routesim/src/engine.ts:590).

`startSimulation()` creates first-leg transits directly. Packet loss is evaluated only when `processNextStep()` emits subsequent transits. The initial frame therefore crosses even a 100% loss link. This is particularly visible for one-way traffic whose effect does not require a return packet.

**Reproduction:** Use the basic two-host/switch topology, make PC1 an attacker, and set its link loss to 100%. Launch an animated ARP-spoof run and pump it with `stepOnce()`. PC2 still learns the attacker's MAC for the impersonated gateway. The log contains no loss event for the source link.

**Fix:** Centralize transmission admission so seeded and subsequent frames pass through the same link-loss handling. Keep the documented headless exception, but emit its skipped-loss note for an initial lossy link too.

**Regression coverage:** A one-way initial frame must not affect another device over a 100% loss link. Compare behavior when the lossy link is first versus later in the path.

### F11 — [P2] Serialize hub and Internet device configuration

**Location:** [config.ts:25](/Users/trevorandersen/dev/routesim/src/config.ts:25), [normalise.ts:334](/Users/trevorandersen/dev/routesim/src/normalise.ts:334).

`buildConfigPayload()` contains per-type configuration branches but none for `hub` or `internet`. Both support configurable Ethernet port counts. Their exported device records lack `config`, so importing resets their capacities to the type defaults.

**Reproduction:** Round-trip a 16-port hub and a 20-port Internet cloud through `buildConfigPayload()` and `normaliseConfig()`. The resulting capacities are 4 and 8, respectively. Links are retained independently, so the resulting model can have connections beyond the displayed capacity.

**Fix:** Add serialization for these device types and use a complete device-type mapping or an exhaustive check to prevent omissions when the registry grows.

**Regression coverage:** Round-trip nondefault persistent configuration for every device type in `DEVICE_TYPES`, including port capacity.

### F12 — [P2] Validate scenario checks before registering or loading an import

**Location:** [io.ts:85](/Users/trevorandersen/dev/routesim/src/io.ts:85), [scenario-ui.ts:37](/Users/trevorandersen/dev/routesim/src/scenario-ui.ts:37).

Scenario import checks only that `checks` is an array and that the topology normalizes. Invalid check elements remain accepted. Registration happens before loading, and the outer catch does not roll it back. A load-time rendering exception can therefore leave an invalid scenario in the registry and can replace the current topology before displaying an import error.

**Reproduction:** Import a scenario with valid metadata, an empty valid topology, and `checks: [null]`. A FileReader-backed probe through `importScenario()` confirmed that the scenario remains registered. Selecting it again throws `TypeError: null is not an object (evaluating 'c.label')`.

**Fix:** Validate required metadata and every check's discriminant and fields before any registry or topology mutation. Make registration/application transactional so a failed import cannot leave a permanently broken selectable entry.

**Regression coverage:** Null and primitive checks, unknown check kinds, missing required reference fields, and invalid port/label shapes. Verify both registry and current topology remain intact on rejection.

### F13 — [P2] Stop simulations before clearing their topology

**Location:** [devices.ts:382](/Users/trevorandersen/dev/routesim/src/devices.ts:382), [engine.ts:565](/Users/trevorandersen/dev/routesim/src/engine.ts:565).

`clearNetwork()` removes devices, links, sessions, and captures without stopping the simulation or clearing its events and transits. The ribbon and console allow this operation during a run. The next arrival can reference a missing device; `processNextStep()` returns immediately for that case without completing the run. This can leave active controls and stale simulation state against an empty canvas.

**Reproduction:** Start an animated ping on `basicTopology()` with requestAnimationFrame stubbed to a no-op, then call `clearNetwork()`. Status remains `running` with one transit. The project's own `diagnoseRuntimeState()` reports missing simulation origin, transit source, transit target, and transit link.

**Fix:** Use a shared topology-teardown path that stops animation, cancels boot work, and clears pending simulation state before deleting the network. `applyConfigWithoutUndo()` already follows the required stop-before-replace order.

**Regression coverage:** Clear a running and a paused simulation; assert idle status, empty queues, no stale references, and usable controls. Cover in-flight link/device deletion as a related lifecycle case.

### F14 — [P2] Restrict the development server's network and file exposure

**Location:** [test-server.ts:102](/Users/trevorandersen/dev/routesim/test-server.ts:102), [test-server.ts:119](/Users/trevorandersen/dev/routesim/test-server.ts:119), [test-server.ts:90](/Users/trevorandersen/dev/routesim/test-server.ts:90).

The server does not specify a loopback hostname, serves arbitrary existing files beneath the repository root, and exposes unauthenticated `/api/run` test execution. JSON responses enable wildcard CORS. The `startsWith(ROOT)` check is not meaningful validation because `resolved` was constructed by prepending `ROOT` immediately beforehand; it also does nothing to exclude dotfiles or Git metadata.

**Reproduction:** A briefly started instance on port 18769 listened on `*:18769`, confirmed with `lsof`. `GET /.git/HEAD` returned HTTP 200 and the Git reference file. `/api/tests` returned HTTP 200 with `Access-Control-Allow-Origin: *` when supplied an unrelated Origin. The probe stopped its server afterward. No arbitrary-path traversal or remote code execution exploit is claimed here.

**Impact:** While this development server runs, reachable network clients can read repository files, including Git metadata, and request test runs. Repeated runs can consume development-machine resources; private repository-local files may be exposed. This does not affect a standalone `rs-web.html` opened without the server.

**Fix:** Bind to loopback by default, allowlist the intended static artifacts, remove unnecessary wildcard CORS, and restrict test filenames to the enumerated suite. Bound concurrent executions. Require explicit configuration for any intended network sharing.

**Regression coverage:** Listener address, forbidden dotfiles/Git metadata, valid static assets, rejected unknown test files, and concurrency limits.

## Verification performed

| Check | Result |
|---|---|
| Initial Git working tree | Clean |
| Complete existing suite: `bun test` | **895 pass, 0 fail**, 2,848 assertions across 43 test files; 31.70 seconds |
| Existing benchmarks and deterministic stress tests | Included in the passing full suite |
| Source type check | Passed: `tsc --noEmit` |
| Source plus tests type check | Passed: `tsc --noEmit -p tsconfig.tests.json` |
| Build pipeline | Passed: esbuild bundle plus the actual `build-inline.ts`, writing the final HTML to a temporary output |
| Committed artifact consistency | Rebuilt HTML was byte-for-byte identical to `rs-web.html` |
| Targeted model probes | Reproduced the functional findings described above; verified dangerous port acceptance without running the unbounded allocation |
| Development-server probe | Verified wildcard listener, repository-file serving, and API CORS; stopped the temporary server |

Tools used were Bun **1.3.14**, esbuild **0.28.0**, and TypeScript **7.0.2**. TypeScript was fetched into a temporary cache because it was not already available. The two successful checks used `bunx --package typescript tsc` with the corresponding arguments and did not add project dependencies.

The committed and rebuilt HTML shared SHA-256:

```text
d58c1d7af69a6a2c2565f0d2a66247dbd79ffb663b5c046c4ebb5c973e4bc076
```

The review probes used the actual source modules with the repository's existing DOM preload and no-op callbacks. Animated probes disabled requestAnimationFrame scheduling and advanced runs with `stepOnce()`. Reported runtime results are therefore source-level integration results, not screenshots or an end-to-end browser certification. The scenario-import probe exercised the real import function with a simulated file picker/FileReader.

## Review coverage and remaining gaps

The review covered repository architecture and build/test tooling; configuration normalization and persistence; device/link lifecycle and port mapping; simulation setup, animated delivery, and headless execution; routing, RIP, DHCP, DNS, TCP/HTTP, NAT, firewall, WiFi, 802.1X, MACsec, STP, and IDS interactions; command and terminal dispatch; scenarios; and browser-facing state/rendering paths. Deeper tracing and additional probes concentrated on boundaries between these systems, where the existing tests leave gaps.

The codebase has useful foundations: one source bundle, a reproducible committed artifact, explicit normalization, shared simulation processors, substantial behavior tests, benchmark budgets, and runtime invariant checks. The main weakness is that successful component tests do not establish preservation of complete configuration or correctness when independently supported features interact.

Priority improvements to the test strategy:

1. **Persistence properties:** Exercise all registered device types with nondefault fields. Compare canonical operational configuration after JSON and script replay, then verify representative connectivity/isolation behavior.
2. **Protocol combinations:** Add overlapping prefixes, non-/24 DHCP, incorrect return gateways, duplicate authentication identities, and inactive routing interfaces.
3. **Lifecycle invariants:** Run the existing diagnostics after clearing, loading, deleting, undoing, and redoing while a simulation is active. Current stress coverage does not establish these transitions are safe.
4. **Import boundary tests:** Exercise the public file-import paths and nested malformed values, including allocation bounds and failure atomicity. Existing IO tests mainly cover helpers and well-formed round trips.
5. **Browser smoke coverage:** The current preload substitutes DOM elements and a null canvas context. Add a small real-browser suite for port selection, save/import, simulation controls, scenario loading, and keyboard/dock behavior. This review did not perform cross-browser, touch, accessibility, or visual-layout certification.

Documented teaching simplifications were not treated as defects merely because they differ from a complete network stack—for example, fixed STP link cost, direct managed-switch STP scope, and the documented headless packet-loss exception. The findings above concern unsupported input handling, loss of saved configuration, contradictions between existing code paths, or incorrect behavior within the advertised model.

## Suggested implementation order

First address F01–F03 to prevent freezes and backup/configuration loss. Then fix routing/addressing and interface identity together (F04–F08), followed by authentication and transmission consistency (F09–F10). Complete the remaining persistence/import/lifecycle fixes (F11–F13). F14 is a small independent hardening change and can be handled alongside the first group.

For each fix, add the targeted regression described in its finding and rerun both TypeScript checks, relevant behavior tests, and the build. Preserve the current dependency-light architecture; none of these fixes requires a framework rewrite.
