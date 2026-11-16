# Scenarios

A **scenario** is a guided challenge: an initial topology + config and a **goal** (a set of checks). The learner edits the network to satisfy the goal, then verifies it. Scenarios build on the topology system, the command engine, and the headless simulation runner.

## Using scenarios

- **GUI**: the File-tab **Scenarios** chooser — a **Load scenario…** button opens a flyout menu of the category labels (Getting started, Switching & VLANs, Routing, Services, Wireless, Security, Troubleshooting), each a submenu that flies out to its scenarios. Loading a scenario resets the canvas to its initial state and shows a **goal banner** (top-left) with the objective and a checklist. Edit the network, then click **Check goal** — each check turns ✓/✗ and a "Scenario complete" message appears when all pass. The × dismisses the scenario.
- **Console / API**: `scenario list`, `scenario load <id>`, `scenario goal`, `scenario check` — available in the console panel, `window.routesim`, and scripts. `scenario check`'s `data` is the `ScenarioResult`.

> Checking the goal runs the real headless simulation, so a `ping` check populates ARP/MAC tables and the Simulation Log — useful feedback on *how* the packet flowed.

**Undo across a load.** Loading a scenario is one undo point. Undo brings back the previous network *and* what stood with it: the scenario that was active then (none, or the one you switched away from) and the name-resolution mode — a scenario turns Instant DNS off, and undoing the load turns it back on if it was on. Redo returns the scenario, its network and its realistic DNS together. (`activeScenarioId` and `options.instantDns` are part of the undo snapshot — `networkSnapshot` in `state.ts`.) Dismissing a scenario is not an undo point; undoing back to an edit made while it was active shows its banner again.

## Data model (`src/scenarios.ts`)

```ts
interface Scenario {
  id: string;
  name: string;
  objective: string;          // shown in the banner
  topology: any;              // { version, devices, links } — same shape as built-in topologies
  checks: ScenarioCheck[];    // the goal
  group?: string;             // chooser category (built-ins are grouped via SCENARIO_GROUPS)
}

type ScenarioCheck =
  | { kind: "link";      a: string; b: string; label: string }              // a real cable exists between a and b (a collapsed LAN's hidden cables count; its proxy links don't)
  | { kind: "config";    device: string; field: string; equals: unknown; label: string }  // device.config[field] === equals
  | { kind: "ping";      from: string; to: string; label: string }          // a ping from→to succeeds (headless)
  | { kind: "ping-fail"; from: string; to: string; blockedBy?: string; label: string }   // isolation: the ping must NOT succeed — because of `blockedBy`, when given
  | { kind: "tcp";       from: string; to: string; port: number; label: string }   // a TCP connect succeeds
  | { kind: "tcp-fail";  from: string; to: string; port: number; blockedBy?: string; label: string }   // the TCP connect must NOT succeed — because of `blockedBy`, when given
  | { kind: "http";      from: string; to: string; path?: string; status?: number; label: string }  // an HTTP GET returns 2xx (or the given status)
  | { kind: "dns";       from: string; name: string; ip?: string; label: string }  // the name resolves (optionally to a given address)
  | { kind: "dhcp";      host: string; label: string }                      // a DHCP request from host succeeds (headless)
  | { kind: "alert";     from: string; to: string; port?: number; contains: string; label: string };  // a flow makes an IDS raise an alert containing the substring — an attacker `from` launches its port scan, otherwise a tcp connect (if port) or ping
```

Device references in checks/topology resolve by **name or id**. `checkScenario(scenario)` returns `{ id, name, passed, checks: [{ label, passed, note? }] }` — `passed` is true when every check passes. A failed check may carry a **`note`**: the reason, when the label alone would mislead. The banner shows it under the goal and `scenario check` prints it on the next line.

### Isolation checks name their cause (`blockedBy`)

A bare `ping-fail`/`tcp-fail` passes on **any** failure, so a scenario built on one can be "solved" without the concept it teaches: closing the server's Telnet port satisfied *firewall-guard* with no firewall rule, re-subnetting the hosts satisfied *vlan-segmentation* with no VLAN, and renumbering the router satisfied *harden-gateway* with an empty INPUT chain.

`blockedBy: "<device>"` closes that. The check then needs two things: the flow fails **and** the same flow *would succeed with that device's policy removed*. The second half is a what-if run (`wouldSucceedWithout` in `scenarios.ts`): every device's config is swapped for a deep copy, the named device's policy is taken out, the flow is re-run headless, and the original configs are put back — so nothing the what-if learns or changes survives it. "Policy" is:

| Named device | What the what-if removes |
|---|---|
| firewall, router | every netfilter rule; all chain policies back to ACCEPT |
| switch | management (`managed: false`) — one flat broadcast domain, no VLANs |
| anything else | nothing — the check fails (that device cannot be the cause) |

A flow that is dead for another reason stays dead in the what-if, so the check fails with a note: *"It is blocked, but not by FW-1: with FW-1's rules out of the way it still fails, so something else is stopping it. The goal is to block it at FW-1."* A flow that simply gets through fails with no note — the label already says what is wrong.

**Every built-in isolation check names its device.** Give a new `ping-fail`/`tcp-fail` a `blockedBy` unless any failure genuinely satisfies the goal; the check without it is kept for imported scenarios and that rare case.

- `loadScenario(id)` → `applyConfig(normaliseConfig(topology))` + sets `state.activeScenarioId` + refreshes the banner. Loading a plain topology or clearing the network drops the active scenario.
- `ping`/`dns`/`dhcp` checks reuse `buildPingEvents`/`buildResolveEvents`/`buildDhcpEvents` (simulation.ts) + `runSimulationHeadless` (engine.ts). A `ping`/`tcp` check whose `to` is neither a device nor an IP is a real hostname — the headless run performs the DNS resolution first, so name-based goals exercise the full resolver path.
- An `alert` check branches on its source. When `from` is an **attacker** (a Red Team host) it launches that host's **port scan** against `to` (`buildScanEvents(from, check.to)`, sim mode `"attack"`) — the burst of SYN probes is what an IDS rule matches; for any other source it falls back to a TCP connect when a `port` is given, else a ping. Either way the check first clears every sensor's runtime `alerts`, runs the flow headless, and passes when some IDS raised an alert containing `contains`.

## Adding a scenario

Add a `Scenario` to `src/scenario-library.ts` (data only), append it to `CURRICULUM`, and add its id to a group in `SCENARIO_GROUPS` (the ordered grouping that drives the chooser's flyout submenus and `scenario list`) — a `tests/scenarios.test.ts` check enforces that every scenario is grouped exactly once, so an ungrouped one is caught (it would otherwise show under "Other"). It joins `SCENARIOS` automatically — or register one at runtime via JSON import (`registerScenario`), where an imported scenario's own `group` field (or "Other") places it. Every built-in scenario has a runnable reference solution in [`scenario-solutions/`](../scenario-solutions/) (`<id>.routesim.txt`); `tests/scenarios.test.ts` runs each one to prove the scenario starts unsolved and is solvable, so add one for yours too.

```ts
{
  id: "my-scenario",
  name: "My Scenario",
  objective: "Do the thing.",
  topology: { version: 1, devices: [ /* {id,type,name,x,y,config} */ ], links: [ /* {from,to} */ ] },
  checks: [
    { kind: "link", a: "PC-A", b: "Switch-1", label: "PC-A linked to Switch-1" },
    { kind: "ping", from: "PC-A", to: "PC-B", label: "PC-A can ping PC-B" },
  ],
}
```

It automatically appears in the chooser, the console (`scenario list/load`), and is checkable. Use distinct device ids (e.g. a per-scenario prefix) to avoid clashes. Give intermediate `link`/`config` checks before the final `ping` so the learner gets step-by-step feedback.

## Built-in scenarios

The curriculum is a progression from L2 basics to routing, services, security, and troubleshooting (`src/scenarios.ts` + `src/scenario-library.ts`):

| id | Name | Goal |
|----|------|------|
| `connect-lan` | Connect a LAN | Link PC-A and PC-B to Switch-1 (both pre-addressed in `192.168.1.0/24`), then ping PC-B from PC-A. |
| `vlan-segmentation` | VLAN segmentation | Put Sales on VLAN 10 and Engineering on VLAN 20 so the teams are isolated (`ping-fail` checks prove isolation). |
| `router-on-a-stick` | Router on a stick | Add dot1q sub-interfaces (192.168.10.1 / 192.168.20.1) so the VLANs route to each other over the trunk. |
| `static-routes` | Static routes | Add a static route on each of two routers so the offices reach each other over the serial link. |
| `dhcp-service` | DHCP service | Cable PC-A → SW-1 → R1 and obtain a lease from R1's 192.168.50.0/24 pool. |
| `rip-convergence` | RIP convergence | Enable RIP (with the right `network` statements) on a 3-router chain so the end LANs converge. |
| `firewall-guard` | Firewall: allow SSH, block Telnet | Write iptables rules on FW-1 so Telnet (23) is blocked while SSH (22) and ping keep working. |
| `troubleshoot-gateway` | Troubleshoot: broken gateway | One-way reachability — find and fix PC-A's wrong default gateway. |
| `troubleshoot-vlan` | Troubleshoot: wrong VLAN | A re-cabled PC landed on the wrong access VLAN — find the misassigned port. |
| `troubleshoot-firewall` | Troubleshoot: overzealous firewall | The change blocked SSH (22) instead of Telnet (23) — inspect and fix the rules. |
| `troubleshoot-static-route` | Troubleshoot: bad static route | A typo'd next-hop broke inter-office routing — read `show ip route` and repair it. |
| `nat-gateway` | NAT gateway | The ISP server has no route back to the LAN — configure PAT (`ip nat inside/outside`) so the private network reaches it. |
| `harden-gateway` | Harden the gateway | Drop pings to the router itself with the INPUT chain while traffic through it keeps flowing — INPUT vs FORWARD. |
| `dns-service` | Name service (DNS) | Point PC-A at the nameserver (`/etc/resolv.conf`) and add a dnsmasq A-record so `web.corp` resolves, pings, and serves port 80 by name. |
| `troubleshoot-dns` | Troubleshoot: name vs address | The IP pings but the name doesn't — find and fix the stale A-record on the dnsmasq server. |
| `port-forward` | Publish a web server (port-forward) | An outside client must reach the inside web server through R1's public IP. R1's NAT interfaces are marked, but no destination-NAT exists — add `ip nat inside source static tcp 10.0.0.80 80 203.0.113.1 80` so TCP 80 on the public address is forwarded to the inside server, and an `http` check (CLIENT → 203.0.113.1 → 200) passes. |
| `across-the-internet` | Reach a server across the internet | Two sites on **separate public links** (203.0.113.0/30 and 198.51.100.0/30) meet over the **Internet cloud**, which routes between them and hands each router a default route. R2 already publishes WEB with a port-forward, but R1 isn't NAT'ing PC-A, so the reply can't get home. Mark R1's LAN interface `ip nat inside` and its internet interface `ip nat outside` — then an `http` check (PC-A → R2's public 198.51.100.1 → 200) passes. The capstone for NAT + port-forwarding + the internet's L3 routing. |
| `server-dhcp` | DHCP from the server | Enable `dhcp-range` on the dnsmasq server: the client leases address + nameserver (option 6) and reaches `web.corp` with zero manual config. |
| `web-service` | Publish a web page | PC-A can already open a TCP connection to WEB on port 80, but no web service is running, so an HTTP GET gets no reply. Start the service (`web WEB on`) so WEB answers with 200 OK — an `http` check proves it. |
| `wifi-join` | Join a WiFi network | Set the laptop's SSID + password to match the secured access point, then associate it so it reaches the wired server. |
| `troubleshoot-wifi` | Troubleshoot: wrong WiFi password | A laptop is "associated" but offline — a wrong saved password leaves the link unauthenticated; re-join with the correct credentials. |
| `wifi-dhcp` | WiFi hotspot + DHCP | Join an open guest hotspot and let the laptop pull an address from the DHCP server automatically, over the air. |
| `port-auth-8021x` | 802.1X port authentication | Configure the host's supplicant credentials and authenticate (`run dot1x`) so the switch's `auto` port opens and carries data. |
| `macsec-link` | MACsec the inter-switch trunk | A must-secure trunk is down for want of a key — set the matching CAK on the other switch to bring the encrypted link up. |
| `secure-access` | Secure access (802.1X + MACsec) | Capstone: one 802.1X exchange both authorises the port and derives its MACsec key (must-secure), bringing the encrypted link up. |
| `spanning-tree` | Break the loop (spanning tree) | Three managed switches are wired in a triangle with STP disabled, so a redundant link loops broadcasts into a storm and PC-A can't reach PC-B — re-enable spanning tree on all three so the bridges block a port and clear the storm. |
| `ids-monitor` | Catch the intruder (IDS + SPAN) | An attacker telnets to a server and an IDS is cabled to SW-1, but no SPAN session feeds it — set the switch's monitor port (`mirror SW-1 Ethernet3`) so the mirrored traffic reaches the sensor and the `alert` check fires. |
| `red-team-scan` | Detect the Red Team scan (IDS rule) | Red Team host RT-1 is set to port-scan SRV through SW-1, whose SPAN session already mirrors to IDS-1's monitor port (Ethernet3) — but the Snort sensor's rule set is empty, so the scan slips past. Author a Snort rule that flags the scan's Telnet probe (TCP 23) so IDS-1 alerts. Where `ids-monitor` teaches wiring the SPAN session, this teaches writing the detection rule. See [red-team.md](src/red-team.md). |
| `stateful-firewall` | Stateful firewall: browse out, block scans in | PC-A (inside) — FW-1 — SW-1 — { SRV (web server, TCP 80), RT (a Red Team host) }, with FW-1 starting wide open. Write a stateful FORWARD ruleset so PC-A can still reach SRV on 80 (its replies come back ESTABLISHED) while RT cannot open a new connection in to PC-A — the crux is a `-m state --state ESTABLISHED,RELATED -j ACCEPT` rule, since a plain default-drop would also break PC-A's own return traffic. A `tcp` check (PC-A → SRV:80) and a `tcp-fail` check (RT → PC-A:22) prove it. |

## Solution scripts (answer key)

Each scenario's worked solution is a runnable console script in
[`scenario-solutions/`](../scenario-solutions/) — `<id>.routesim.txt`. A script
loads its scenario, applies the fix, and checks the goal, so you can paste it into
the command console (the `>_` button) or run it with `routesim.run(<contents>)` to
see the answer play out. They double as the curriculum's test fixtures
(`tests/scenarios.test.ts` runs each), so they always match the live scenarios.


## A failed check says why

`CheckResult.why` holds the reasons a check failed, recorded by whichever step decided it: a builder's refusal, `explainFailedRun` over the headless run (the drops in order, then the post-mortem's diagnosis), or a direct statement for checks that run nothing (no cable between two devices, a field's actual value against the goal, an HTTP status, a sensor that raised nothing, a DHCP Discover nobody served). The goal banner lists them under the failed check and `scenario check` prints them as `why:` lines. `tests/explain.test.ts` loads every built-in scenario and asserts each check that fails at the start carries a reason. This is the explanation of *what happened*.

## …and what is most likely wrong

`CheckResult.hint` goes one step further ([hints.md](src/hints.md)): a nearest-cause probe over the failed flow names the most likely misconfiguration — "No device has PC-A's default gateway address 192.168.1.254.", "R1's static route to 192.168.2.0/24 points at next hop 10.0.0.5, an address no device has." — **the cause, never the answer**. It is absent when the failure already names its cause (an unauthenticated link, a switching loop) or no probe fits. The banner shows it as **Likely cause:** under the reasons. When you add a scenario, load it and read the hints its failing checks produce: `tests/hints.test.ts` pins the troubleshooting scenarios' hints to the faults they plant.

## Import validation

`importScenario` (io.ts) validates **everything `loadScenario` will touch before registering**: the topology (via `normaliseConfig`) *and* every check via **`isValidScenarioCheck`** (scenarios.ts) — a known `kind`, a `label`, and the fields that kind's evaluator and the goal banner read (`from`/`to`, a 1–65535 `port` for `tcp`/`tcp-fail`, `contains` for `alert`, …). A scenario with any invalid check is skipped, not registered. Previously only `Array.isArray(checks)` was checked, so `checks: [null]` registered fine and then threw `c.label` in the banner on every re-select — a permanently broken dropdown entry. If a validated scenario still fails to load, `unregisterScenario` rolls the registration back.

**The scenario's own fields and the optional check fields are typed too** (`scenarioIssue`, review R83): `id` and `name` must be non-empty text, `objective` must be text (a scenario without one registered, and `scenario goal` then threw printing it), `group` must be text when present; an `http` check's `path` must be text and its `status` an integer 100–599 (a string `"200"` could never equal the status a run returns, so the check could never pass), a `dns` check's `ip` must be text, an `alert` check's `port` an integer 1–65535. A skipped scenario is named on the status line with the reason (`No valid scenarios in file — "x" needs an objective (text).`), instead of a bare "no valid scenarios". Replacing a built-in id stays allowed, as documented.


## Check tears an active run down first

The goal checks run headless simulations on the shared `state.simulation`. Pressing Check mid-run used to replace the learner's run silently (status "done", the checker's log, and `headless` left `true`); `runActiveScenarioCheck` then stopped the run itself through the `stopSimulation` bridge. That now lives in the engine, for every headless run: `runSimulationHeadless` goes through `beginRun`, which stops a running or paused animated run first (the Stop teardown) and says so in its terminal and on the status line — see [engine.md](src/engine.md#run-ownership). `runSimulationHeadless` also restores `headless = false` on exit: the flag belongs to the run, not to whatever comes after it.
