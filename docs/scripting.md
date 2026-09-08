# Scripting

Every interaction with the simulator is available as a text command. There are three surfaces, all driven by the same command engine (`src/commands.ts`):

1. **Command console** — a panel in the app (the `>_` toolbar button). Type commands at the `routesim>` prompt; ↑/↓ recall history.
2. **`window.routesim`** — a JS API for the browser console or an external/test harness.
3. **Script runner** — run many commands at once (newlines separate commands; blank lines and `#` comments are ignored).

A device is referenced by **name or id** (case-insensitive). Names should be single tokens (no spaces).

## `window.routesim`

```js
routesim.exec("add computer PC1 at 100 200")   // run one command → CommandResult
routesim.run("clear\nadd router R1\n...")       // run a script → CommandResult[]
routesim.export()                               // current topology as a reproducible script (string)
routesim.snapshot()                             // { devices, links, simulation } (read-only live refs)
routesim.diagnose()                             // [] when runtime model invariants hold
routesim.urlSettings()                          // what the current URL query string would apply (ParsedSettings)
routesim.settingsQuery()                        // a shareable query string built from the live settings
```

`CommandResult` is `{ ok: boolean, output: string[], data?: unknown }`. For `run ping`/`run dhcp`, `data` is the `SimResult` (`{ success, ttl, assignedIp, assignedGateway, log, steps }`) and `ok` reflects reachability.

## URL settings

Settings can be supplied in the page's query string and are applied on load — handy for sharing a pre-configured link (`src/settings-url.ts`, applied in `app.ts`). Unknown or unparseable params are ignored (visible via `routesim.urlSettings().ignored`), and `routesim.settingsQuery()` builds the reverse — a query string of just the settings that differ from the defaults.

```
rs-web.html?names=0&ips=1&macs=0&autodhcp=on&apipa=1&theme=dark&speed=400
```

| Param | Setting | Values |
|-------|---------|--------|
| `names` | Show device names | `1`/`0`, `true`/`false`, `yes`/`no`, `on`/`off` |
| `ips` | Show IP addresses | (boolean, as above) |
| `macs` | Show MAC addresses | (boolean, as above) |
| `autodhcp` | Auto-DHCP on boot | (boolean) |
| `apipa` | APIPA fallback | (boolean) |
| `silentarp` | Silent ARP (resolve instantly, no animation) | (boolean) |
| `silentdhcp` | Silent DHCP (instant lease) | (boolean) |
| `silentdns` | Silent DNS (instant resolve) | (boolean) |
| `silentwifi` | Silent WiFi association (instant join) | (boolean) |
| `instantdns` | Instant DNS (resolve device names to IPs without a DNS query; default on) | (boolean) |
| `theme` | Colour theme | `warm-light` (or `light`), `dark`, `blueprint` |
| `speed` | Animation ms/hop | a number, clamped to 200–3000 |

Param keys and boolean values are case-insensitive. Adding a setting is a one-row change in `settings-url.ts`.

## Command reference

### Topology
| Command | Effect |
|---------|--------|
| `add <computer\|laptop\|server\|switch\|router\|firewall\|hub\|access-point> [name] [at <x> <y>]` | Create a device (hosts get a random MAC). A `laptop` is a WiFi-only host; an `access-point` bridges laptops onto the wired LAN. |
| `remove <ref>` / `delete <ref>` | Delete a device and its links. |
| `link <a> <b> [portA portB]` | Connect two devices (optional explicit ports). |
| `linkset <a> <b> <name\|bandwidth\|latency\|loss> <value>` | Set a link attribute (`0` clears a numeric one). |
| `unlink <a> <b>` | Remove the link between two devices. |
| `shut <a> <b>` | Administratively down the link (stays in the topology, carries no traffic). |
| `noshut <a> <b>` | Bring the link back up. |
| `move <ref> <x> <y>` | Reposition a device. |
| `rename <ref> <name>` | Rename a device. For a CLI device the name **is** its hostname (canvas label, prompt, and resolvable name) — the realistic equivalent is `cli <host> hostname <name>` / `hostnamectl set-hostname <name>`, `cli <router> hostname <name>` (config mode), or `cli <switch> config hostname <name>`. |
| `collapse <switch>` / `expand <lan>` | Collapse a switch + hosts into a LAN node / undo. |
| `clear` | Remove all devices and links. |

### Device config
| Command | Effect |
|---------|--------|
| `ip <host> <addr/prefix>` | Set a host IPv4 (e.g. `192.168.1.10/24`). |
| `gateway <host> <ip>` | Set a host default gateway. |
| `nameserver <host> <ip>` | Set a host DNS server (`/etc/resolv.conf`). |
| `mac <host> <addr>` | Set a host MAC. |
| `ssid <laptop\|access-point> <name> [password]` | Set the WiFi network a laptop joins or an access point broadcasts. Omitting the password opens the network (and clears any existing one). A laptop only associates if its SSID — and password, if set — match the AP's. |
| `supplicant <host> <identity> <password>` | Set a host's 802.1X credentials (the supplicant). |
| `portauth <switch> <EthN> <auto\|force-authorized\|force-unauthorized>` | Set a switch port's 802.1X control. `auto` blocks data until the host authenticates; `force-authorized` (default) is open. |
| `radius <server> <identity> <password>` | Add/update a RADIUS user on a server (enables the authentication back end). |
| `ports <host> <port[,port…]>` | Set a host's listening TCP ports (what `nc`/`connect` find open); comma- or space-separated. `ports <host> none` clears the list (accept on **any** port); `ports <host> closed` sets an explicitly **empty** list (refuse every connection). Different states — the export preserves which you meant. |
| `power <device> on\|off` | Power a device on or off (the canvas power state). |
| `portcount <device> [serial] <n>` | Set a device's physical port capacity (each type keeps its own range; `serial` is routers only). |
| `macsec <device> <peer> <key\|dot1x> [must\|should]` | Set MACsec (802.1AE) for the link to a peer (`off` clears it). A literal key is a static pre-shared CAK (both ends must match); `dot1x` instead **derives** the key from a successful 802.1X exchange on the link (MKA) — it secures only after the port authenticates. `must` drops traffic when it can't secure, `should` falls back to plaintext. |
| `interface <router> <peer> ip <addr> [vlan <tag>]` | Set a router interface IP (by connected peer; optional sub-interface VLAN). |
| `route <router> <net/prefix> <nextHop>` | Add a static route. |
| `managed <switch> [on\|off]` | Turn a switch's management plane on/off (no arg reports the current state). A managed switch carries VLANs, STP, and a SONiC CLI; an unmanaged one is a transparent L2 bridge. |
| `vlan <switch> add\|del <id>` | Add/remove a VLAN on a managed switch. |
| `stp <switch> on\|off` | Enable/disable spanning tree on a managed switch (default on). With STP off, an L2 loop becomes a broadcast storm. |
| `stp <switch> priority <n>` | Set the bridge priority (`0`–`61440`, multiples of `4096`; default `32768`). Lowest priority (then MAC) in a connected component wins the root election. |
| `port <switch> <EthN> vlan <id>` | Access VLAN for a port. |
| `port <switch> <EthN> mode <access\|trunk>` | Port mode. |
| `port <switch> <EthN> native <id>` | Trunk native VLAN. |
| `port <switch> <EthN> allowed add\|remove <id>` | Trunk allowed VLANs. |
| `mirror <switch> <dst-port> [src…]` / `mirror <switch> off` | Set/clear a SPAN session on a managed switch: mirror ingress frames to the `dst-port` monitor port (no `src…` = all ports). Realistic equivalent `config mirror_session span add <name> <dst> [src]`. |
| `idsrule <ids> <snort rule>` / `idsrule <ids> clear` | Append a raw Snort rule to an IDS sensor's `local.rules` / remove every rule. |
| `redteam <node> target <ip>` / `attacks <scan,sweep,arp-spoof>` / `spoof <ip>` | Configure a **Red Team actor**'s (`type: "attacker"`) stored plan: `target` sets the scan/sweep target, `attacks` sets the enabled-attack list (comma-separated; invalid kinds are filtered out), `spoof` sets the ARP-spoof IP to impersonate. A Kali PC (`type: "kali"`) is hand-driven and carries no stored plan, so it has nothing to configure here. |
| `cli <ref> <raw CLI…>` | Run a raw per-device CLI command (the device terminal language; mode persists across `cli` calls to the same device). |

### Simulation
| Command | Effect |
|---------|--------|
| `ping <src> <dst>` | Start an **animated** ping (watch it on the canvas). |
| `dhcp <host>` | Start an **animated** DHCP request. |
| `connect <src> <dst> <port>` | Start an **animated** TCP three-way handshake. |
| `associate <laptop>` | Animate the **802.11 join** to the laptop's access point: probe / open-system auth / association, plus the WPA2 4-way key handshake when the AP is secured. |
| `dot1x <host>` | Animate the **802.1X** port authentication: EAPOL-Start → EAP-Identity → RADIUS Access-Request → Accept/Reject → EAP-Success/Failure. An `auto` port carries no data until it succeeds. |
| `stp` | Animate the **spanning-tree** BPDU flood: each root bridge floods Configuration BPDUs out its designated ports toward the other switches. |
| `attack <node> [scan\|sweep\|arp-spoof] [target]` | Launch an offensive host's simulated **attack(s)** (sim mode `"attack"`). Works on **both** a Kali PC (`kali`) and a Red Team actor (`attacker`); any other type is rejected with "is not a Kali PC or Red Team host". With an explicit kind, run just that one — for `scan`/`sweep` an optional `target` overrides **and remembers** `config.attackTarget`; for `arp-spoof` the argument is the IP to impersonate (not a target). With no kind, a bare `target` sets `config.attackTarget`, then **all enabled attacks** run (`buildAttackEvents`). The nmap-style report lands in the node's terminal session. |
| `run ping <src> <dst>` | **Headless** ping → returns reachable/unreachable + TTL + step count. |
| `run dhcp <host>` | **Headless** DHCP → returns the assigned lease (or no response). |
| `run resolve <src> <name>` | **Headless** DNS lookup → returns the resolved IP (or NXDOMAIN). Alias: `run dns`. |
| `run connect <src> <dst> <port>` | **Headless** TCP connect → open / refused (RST) / timed out. |
| `run associate <laptop>` | **Headless** 802.11 association → joined / did-not-complete + frame count. |
| `run dot1x <host>` | **Headless** 802.1X authentication → authorised / failed + frame count. |
| `run stp` | **Headless** BPDU flood → frame count (the spanning tree is computed before every run regardless). |
| `traceroute <src> <dst>` | **Headless** hop-by-hop path discovery via increasing TTL; `data` is `{ targetIp, hops, reached }`. Also `tracert`. |
| `play` / `pause` / `step` / `stop` | Drive an animated run. |
| `speed <ms>` | Milliseconds per hop. |
| `seed [<n>\|off]` | Pin the run's random seed for reproducible ephemeral ports / DHCP ids / NAT translations (default: the wall clock, so runs vary). `seed <n>` pins; `seed off` unpins; `seed` reports the current state (and, unpinned, the last run's seed to reproduce it). Session-level — not serialised. |

### Management
| Command | Effect |
|---------|--------|
| `topology <basic\|vlan-roas\|router-mesh\|wifi-vlan>` | Load a built-in topology. `wifi-vlan` is a campus WiFi with staff (secured SSID, VLAN 10) and guest (open SSID, VLAN 20) separated by VLAN, plus a shared server on a Servers VLAN (30) reachable by all VLANs, routed by a gateway that isolates guests from the staff subnet. |
| `save <name>` / `load <name>` | Save/load to the in-memory config store. |
| `undo` / `redo` | Undo / redo the last change. |
| `export` | Print the current topology as a reproducible command script. |
| `stress [seed] [steps]` | **Destructive dev tool — replaces the current topology and mutates it randomly; the run is far longer than the 80-entry undo stack, so your work is not recoverable.** Runs a repeatable mutation/invariant test from a fresh Basic topology (defaults: seed `20260706`, 250 actions; maximum 5000). The full action log is returned in `data`; failures include a replay command. |

### Quoting

Arguments split on whitespace, so a value containing a space must be quoted:

```
add computer "My PC" at 0 0
ssid AP1 "Guest WiFi" "pass phrase"
linkset "My PC" AP1 name "Back haul"
```

`"…"` and `'…'` both group one argument; inside double quotes `\"` and `\\`
escape. An unterminated quote is rejected with an error rather than silently
truncated. `exportTopologyScript()` applies the inverse (`quoteArg`), quoting
any value that would not survive bare — so a topology using such names exports
to a script that replays into exactly the same topology. Free-text tails (`cli
<device> <shell line>`, `idsrule <ids> <snort rule>`) are taken raw from the
source after the device argument, so quotes *inside* a Snort rule reach it
untouched.

### Query
| Command | Effect |
|---------|--------|
| `list [links]` | List devices (or links). |
| `show <ref>` | A device's config summary. |
| `status` | Simulation status + last result + counts. |
| `log` | The hop-by-hop log of the last/current simulation. |

### Scenarios
| Command | Effect |
|---------|--------|
| `scenario list` | List the built-in scenarios (`id — name`). |
| `scenario load <id>` | Load a scenario topology + goals. |
| `scenario goal` | Print the active scenario's objective + checklist. |
| `scenario check` | Run the goal checks against the current topology. |

Each scenario's worked answer is a runnable script in [`scenario-solutions/`](../scenario-solutions/) (`<id>.routesim.txt`) — it loads the scenario, applies the fix, and checks the goal, so `routesim.run(<contents>)` plays the whole solution through.

### View
`select <ref>` · `tool <name>` · `theme <warm-light\|dark\|blueprint>` · `zoom <scale>` · `fit` · `help [command]`

## Examples

Build and test a small network:

```
clear
add computer PC1 at 100 100
add computer PC2 at 300 100
add switch SW1 at 200 100
link SW1 PC1
link SW1 PC2
ip PC1 192.168.1.10/24
ip PC2 192.168.1.20/24
run ping PC1 PC2          # → ping PC2: reachable (ttl=64) — N steps
```

Router config via the raw passthrough (IOS sequence; mode persists):

```
cli R1 enable
cli R1 configure terminal
cli R1 interface Ethernet1
cli R1 ip address 192.168.10.1/24
cli FW1 iptables -A FORWARD -p icmp -s 192.168.1.0/24 -j DROP
```

…or the clean convenience verbs (no mode machine):

```
interface R1 SW1 ip 192.168.10.1/24
route R1 10.0.0.0/24 192.168.10.254
```

## Round-trip

`export` serialises the topology back into commands so that replaying the script rebuilds the **same operational configuration**, not just the same names and addresses. Everything the JSON payload persists is covered — including the parts that used to be silently dropped (a firewall's policy and rules, a router's netfilter policy/rules, RIP configuration, NAT interface roles, an explicitly *empty* listener list, power state, and non-default port capacities):

- Device-level fields replay through console verbs (`ip`, `interface`, `route`, `ports`, `power`, `portcount`, …).
- Anything whose natural home is a device's own CLI replays through **`cli <device> …`** exactly as a person would type it: a router's `router rip` / `network` / `passive-interface`, `interface EthernetN` + `ip nat inside|outside`, static port-forwards, and `iptables -P` / `iptables -A …` (each `FirewallRule` formatted by `ruleToIptables`, the parser's inverse); a firewall's `iptables` lines directly.
- **Cables are emitted before per-device config**, because port and interface names (`port SW Ethernet2 …`, `mirror … Ethernet3`, the CLI's `interface Ethernet1`) only resolve once the link exists.

The round-trip test in `tests/commands.test.ts` compares the replayed *configuration* — policy, rules, RIP, NAT role, listener list, power, port counts — not merely device names.

```js
const script = routesim.export();   // "clear\nadd computer PC1 at …\nip PC1 …\nlink …"
routesim.exec("clear");
routesim.run(script);               // recreates the identical topology
```

This is the completeness guarantee — the command set can express everything the GUI can build. The export emits `managed <name>` (before a switch's VLAN/STP config) and only the STP deviations — `stp <name> off` or `stp <name> priority <n>` — since the default-on, default-priority spanning tree round-trips implicitly. A switch's SPAN session emits `mirror <name> <dst>`; an IDS sensor emits `idsrule <name> clear` followed by one `idsrule <name> <rule>` per rule (so the device's default rule set is re-established exactly). A Kali PC (`kali`) exports as a plain host — its `ip`/`gateway`/`mac`/`nameserver` lines, with **no** `redteam` lines (it is hand-driven and carries no stored plan). A Red Team actor (`attacker`) emits those host lines too, then `redteam <name> attacks <list>`, `redteam <name> target <t>`, and `redteam <name> spoof <ip>` (only the non-empty ones) — its runtime `attackLog` is not exported. Both serialise via the shared host helpers, so a non-/24 prefix and the nameserver survive the round-trip (a prior bug dropped them for the attacker).

## Headless vs animated

`ping`/`dhcp` run the **animated** simulation (transit dots on the canvas) and return immediately. `run ping`/`run dhcp` run **headless** — the engine drains the event queue synchronously (no animation) and returns the result plus log. Use `run` in scripts and tests where you want a deterministic pass/fail; use the animated form to watch a packet traverse the network. Both are backed by the same per-device processing in `engine.ts` (see [src/engine.md](src/engine.md)).

## JSON import/export

The app is a single self-contained file with no server, so persistence is **file import/export** (download + a file picker), in the ribbon's **File** tab and on `window.routesim`. Implemented in `src/io.ts`.

| Artifact | Export | Import |
|----------|--------|--------|
| **Config** (topology) | `topology.json` ← `buildConfigPayload()` | `applyConfig(parseConfig(text))` |
| **Scenario(s)** | `scenarios.json` ← the registry | register + load (`registerScenario`) |
| **Script** | `topology.routesim.txt` ← `exportTopologyScript()` | `runConsoleScript(text)` |
| **Log** | `simlog.json` ← `state.simulation.log` | load into the Sim Log viewer |

```js
routesim.exportConfig(); routesim.importConfig();      // topology JSON
routesim.exportScenarios(); routesim.importScenario();  // scenario JSON
routesim.exportScript(); routesim.importScript();        // command script
routesim.exportLog(); routesim.importLog();              // simulation log JSON
```

Default topologies and scenarios are compiled in (`state.ts` / `scenarios.ts`), so a fresh page already has them — import is only for sharing/restoring your own.
