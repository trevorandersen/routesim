# Scenarios

A **scenario** is a guided challenge: an initial topology + config and a **goal** (a set of checks). The learner edits the network to satisfy the goal, then verifies it. Scenarios build on the topology system, the command engine, and the headless simulation runner.

## Using scenarios

- **GUI**: the **Scenarios** toolbar button (flag icon) opens a chooser. Loading a scenario resets the canvas to its initial state and shows a **goal banner** (top-left) with the objective and a checklist. Edit the network, then click **Check goal** — each check turns ✓/✗ and a "Scenario complete" message appears when all pass. The × dismisses the scenario.
- **Console / API**: `scenario list`, `scenario load <id>`, `scenario goal`, `scenario check` — available in the console panel, `window.routesim`, and scripts. `scenario check`'s `data` is the `ScenarioResult`.

> Checking the goal runs the real headless simulation, so a `ping` check populates ARP/MAC tables and the Simulation Log — useful feedback on *how* the packet flowed.

## Data model (`src/scenarios.ts`)

```ts
interface Scenario {
  id: string;
  name: string;
  objective: string;          // shown in the banner
  topology: any;              // { version, devices, links } — same shape as built-in topologies
  checks: ScenarioCheck[];    // the goal
}

type ScenarioCheck =
  | { kind: "link";      a: string; b: string; label: string }              // a non-hidden link exists between a and b
  | { kind: "config";    device: string; field: string; equals: unknown; label: string }  // device.config[field] === equals
  | { kind: "ping";      from: string; to: string; label: string }          // a ping from→to succeeds (headless)
  | { kind: "ping-fail"; from: string; to: string; label: string }          // isolation: the ping must NOT succeed
  | { kind: "tcp";       from: string; to: string; port: number; label: string }   // a TCP connect succeeds
  | { kind: "tcp-fail";  from: string; to: string; port: number; label: string }   // the TCP connect must NOT succeed
  | { kind: "dns";       from: string; name: string; ip?: string; label: string }  // the name resolves (optionally to a given address)
  | { kind: "dhcp";      host: string; label: string };                     // a DHCP request from host succeeds (headless)
```

Device references in checks/topology resolve by **name or id**. `checkScenario(scenario)` returns `{ id, name, passed, checks: [{ label, passed }] }` — `passed` is true when every check passes.

- `loadScenario(id)` → `applyConfig(normaliseConfig(topology))` + sets `state.activeScenarioId` + refreshes the banner. Loading a plain topology or clearing the network drops the active scenario.
- `ping`/`dns`/`dhcp` checks reuse `buildPingEvents`/`buildResolveEvents`/`buildDhcpEvents` (simulation.ts) + `runSimulationHeadless` (engine.ts). A `ping`/`tcp` check whose `to` is neither a device nor an IP is a real hostname — the headless run performs the DNS resolution first, so name-based goals exercise the full resolver path.

## Adding a scenario

Add a `Scenario` to `src/scenario-library.ts` (data only) and it joins `SCENARIOS` automatically — or register one at runtime via JSON import (`registerScenario`). Every built-in scenario has a runnable reference solution in [`scenario-solutions/`](../scenario-solutions/) (`<id>.routesim.txt`); `tests/scenarios.test.ts` runs each one to prove the scenario starts unsolved and is solvable, so add one for yours too.

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
| `server-dhcp` | DHCP from the server | Enable `dhcp-range` on the dnsmasq server: the client leases address + nameserver (option 6) and reaches `web.corp` with zero manual config. |
| `wifi-join` | Join a WiFi network | Set the laptop's SSID + password to match the secured access point, then associate it so it reaches the wired server. |
| `troubleshoot-wifi` | Troubleshoot: wrong WiFi password | A laptop is "associated" but offline — a wrong saved password leaves the link unauthenticated; re-join with the correct credentials. |
| `wifi-dhcp` | WiFi hotspot + DHCP | Join an open guest hotspot and let the laptop pull an address from the DHCP server automatically, over the air. |
| `port-auth-8021x` | 802.1X port authentication | Configure the host's supplicant credentials and authenticate (`run dot1x`) so the switch's `auto` port opens and carries data. |
| `macsec-link` | MACsec the inter-switch trunk | A must-secure trunk is down for want of a key — set the matching CAK on the other switch to bring the encrypted link up. |
| `secure-access` | Secure access (802.1X + MACsec) | Capstone: one 802.1X exchange both authorises the port and derives its MACsec key (must-secure), bringing the encrypted link up. |
| `spanning-tree` | Break the loop (spanning tree) | Three managed switches are wired in a triangle with STP disabled, so a redundant link loops broadcasts into a storm and PC-A can't reach PC-B — re-enable spanning tree on all three so the bridges block a port and clear the storm. |

## Solution scripts (answer key)

Each scenario's worked solution is a runnable console script in
[`scenario-solutions/`](../scenario-solutions/) — `<id>.routesim.txt`. A script
loads its scenario, applies the fix, and checks the goal, so you can paste it into
the command console (the `>_` button) or run it with `routesim.run(<contents>)` to
see the answer play out. They double as the curriculum's test fixtures
(`tests/scenarios.test.ts` runs each), so they always match the live scenarios.
