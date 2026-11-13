# Scripting

Every interaction with the simulator is available as a text command. There are three surfaces, all driven by the same command engine (`src/commands.ts`):

1. **Command console** — a panel in the app (the `>_` toolbar button). Type commands at the `routesim>` prompt; ↑/↓ recall history.
2. **`window.routesim`** — a JS API for the browser console or an external/test harness.
3. **Script runner** — run many commands at once (newlines separate commands; blank lines and `#` comments are ignored).

A device is referenced by **name or id** (case-insensitive). A name containing a space must be quoted (see [Quoting](#quoting)).

## `window.routesim`

```js
routesim.exec("add computer PC1 at 100 200")   // run one command → CommandResult
routesim.run("clear\nadd router R1\n...")       // run a script → CommandResult[]
routesim.export()                               // current topology as a reproducible script (string)
routesim.importScript()                         // file picker → runImportedScript(text): ONE undo point, status line names rejected lines
routesim.snapshot()                             // { devices, links, simulation } (read-only live refs)
routesim.diagnose()                             // [] when runtime model invariants hold
routesim.urlSettings()                          // what the current URL query string would apply (ParsedSettings)
routesim.settingsQuery()                        // a shareable query string built from the live settings
```

`CommandResult` is `{ ok: boolean, output: string[], data?: unknown }`. For `run ping`/`run dhcp`, `data` is the `SimResult` (`{ success, ttl, assignedIp, assignedGateway, storm, diagnosis, log, steps }`) and `ok` reflects reachability. A failed `run` appends the run's post-mortem (`diagnosis`) to `output` — a broadcast storm, or an ARP nobody answered (naming the gateway when it is the cause) — and `run ping` notes an ICMP error it got back (`unreachable (Time to live exceeded from 10.0.0.1)`).

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
| `add <computer\|laptop\|server\|switch\|router\|firewall\|hub\|access-point> [name] [at <x> <y>]` | Create a device (hosts get a random MAC). A `laptop` is a WiFi-only host; an `access-point` bridges laptops onto the wired LAN. The position is the *trailing* `at <x> <y>`, so a device may itself be named `at`. **Names are unique, ignoring case** — every reference is matched that way, so `add computer pc1` is refused while a `PC1` exists (as are `rename` and the shells' `hostname` onto a taken name), and an auto-generated name skips any the learner already typed. |
| `remove <ref>` / `delete <ref>` | Delete a device and its links. |
| `link <a> <b> [portA portB]` | Connect two devices. A port number **pins** that end to the port (`link R1 SW 3 1` → R1 Ethernet3, SW Ethernet1); `auto` (or `-`) leaves an end to the next free port (`link R1 SW auto 4`). On a router the number counts within the cable's own kind of port — serial to another router, Ethernet otherwise. A port that is already cabled (by any cable, pinned or not) or does not exist is **not honoured**: the cable is still made on the next free port, and the output says which port was refused, why, and where the cable went. Linking a pair that is already linked is a no-op that says so (and says when the ports asked for were not applied); a WiFi association with the wrong password links with a warning. |
| `linkset <a> <b> <name\|bandwidth\|latency\|loss> <value>` | Set a link attribute (`0` clears a numeric one). |
| `unlink <a> <b>` | Remove the link between two devices. |
| `shut <a> <b>` | Administratively down the link (stays in the topology, carries no traffic). |
| `noshut <a> <b>` | Bring the link back up. |
| `move <ref> <x> <y>` | Reposition a device. |
| `rename <ref> <name>` | Rename a device. The new name must not be another device's (ignoring case; a device may change the case of its own). For a CLI device the name **is** its hostname (canvas label, prompt, and resolvable name) — the realistic equivalent is `cli <host> hostname <name>` / `hostnamectl set-hostname <name>`, `cli <router> hostname <name>` (config mode), or `cli <switch> config hostname <name>`. |
| `collapse <switch>` / `expand <lan>` | Collapse a switch + hosts into a LAN node / undo. Each says what it did, and fails with the reason when there is nothing to do (not a switch, nothing attached, already collapsed, not a collapsed LAN). |
| `clear` | Remove all devices and links. |

### Device config
| Command | Effect |
|---------|--------|
| `ip <host> <addr/prefix>` | Set a host IPv4 (e.g. `192.168.1.10/24`). |
| `gateway <host> <ip>` | Set a host default gateway. |
| `nameserver <host> <ip>` | Set a host DNS server (`/etc/resolv.conf`). |
| `mac <host\|switch> <addr>` | Set a host MAC, or a switch's base MAC — the tie-break in its spanning-tree bridge id (the tree is recomputed). |
| `ssid <laptop\|access-point> <name> [password]` | Set the WiFi network a laptop joins or an access point broadcasts. Omitting the password opens the network (and clears any existing one). A laptop only associates if its SSID — and password, if set — match the AP's. `ssid <laptop> ""` clears the name (a laptop with no network configured). |
| `supplicant <host> <identity> <password>` | Set a host's 802.1X credentials (the supplicant). |
| `portauth <switch> <EthN> <auto\|force-authorized\|force-unauthorized>` | Set a switch port's 802.1X control. `auto` blocks data until the host authenticates; `force-authorized` (default) is open. `force-unauthorized` is closed whatever the host presents (a login gets an immediate failure). Changing the mode ends the port's 802.1X session, so the host must authenticate again. |
| `radius <server> <identity> <password>` | Add/update a RADIUS user on a server (enables the authentication back end). |
| `ports <host> <port[,port…]>` | Set a host's listening TCP ports (what `nc`/`connect` find open); comma- or space-separated. `ports <host> none` clears the list (accept on **any** port); `ports <host> closed` sets an explicitly **empty** list (refuse every connection). Different states — the export preserves which you meant. |
| `power <device> on\|off` | Power a device on or off (the canvas power state). A powered-off device refuses its shell (`cli <device> …` answers `<name> is powered off.`), so power it off after configuring it — the export writes its `power … off` lines last for that reason. |
| `portcount <device> [serial] <n>` | Set a device's physical port capacity (each type keeps its own range — switch, hub and internet cloud 4–24, router 0–12 per media, access point 1–4, firewall 2–8; `serial` is routers only). A value outside the range is refused. |
| `macsec <device> <peer> <key\|dot1x> [must\|should]` | Set MACsec (802.1AE) for the link to a peer (`off` clears it). A literal key is a static pre-shared CAK (both ends must match); `dot1x` instead **derives** the key from a successful 802.1X exchange on the link (MKA) — it secures only after the port authenticates. `must` drops traffic when it can't secure, `should` falls back to plaintext. |
| `interface <router> <peer> ip <addr> [vlan <tag>]` | Set a router interface IP (by connected peer; optional sub-interface VLAN). |
| `route <router> <net/prefix> <nextHop>` | Add a static route — the same mutator as the router shell's `ip route` (`addStaticRoute`), so it validates the same way: the network must be CIDR (`192.168.2.0/24`; a bare `192.168.2.0` is refused) and the next hop a valid IPv4 address. The network is stored canonically (`192.168.2.77/24` → `192.168.2.0/24`), and a route that is already there is a no-op that says so. Remove one with `cli <router> no ip route <net/prefix> [nextHop]` (config mode). |
| `managed <switch> [on\|off]` | Turn a switch's management plane on/off (no argument turns it on, as the script export writes it). A managed switch carries VLANs, STP, and a SONiC CLI; an unmanaged one is a transparent L2 bridge. |
| `vlan <switch> add <id> [name]` / `vlan <switch> del <id>` | Add/remove a VLAN on a managed switch. A name is optional (`vlan SW add 10 Sales`; default `Vlan10`); adding an existing id with a name renames it. |
| `stp <switch> on\|off` | Enable/disable spanning tree on a managed switch (default on). With STP off, an L2 loop becomes a broadcast storm. |
| `stp <switch> priority <n>` | Set the bridge priority (`0`–`61440`, multiples of `4096`; default `32768`). Lowest priority (then MAC) in a connected component wins the root election. |
| `port <switch> <EthN> vlan <id>` | Access VLAN for a port. |
| `port <switch> <EthN> mode <access\|trunk>` | Port mode. |
| `port <switch> <EthN> native <id>` | Trunk native VLAN. |
| `port <switch> <EthN> allowed add\|remove <id>` | Trunk allowed VLANs. |
| `mirror <switch> <dst-port> [src…]` / `mirror <switch> off` | Set/clear a SPAN session on a managed switch: mirror ingress frames to the `dst-port` monitor port (no `src…` = all ports). Realistic equivalent `config mirror_session span add <name> <dst> [src]`. |
| `idsrule <ids> <snort rule>` / `idsrule <ids> clear` | Append a raw Snort rule to an IDS sensor's `local.rules` / remove every rule. |
| `redteam <node> target <ip>` / `attacks <scan,sweep,arp-spoof>` / `spoof <ip>` | Configure a **Red Team actor**'s (`type: "attacker"`) stored plan: `target` sets the scan/sweep target, `attacks` sets the enabled-attack list (comma-separated; invalid kinds are filtered out), `spoof` sets the ARP-spoof IP to impersonate. A Kali PC (`type: "kali"`) is hand-driven and carries no stored plan, so it has nothing to configure here. |
| `cli <ref> <raw CLI…>` | Run a raw per-device CLI command (the device terminal language; mode persists across `cli` calls to the same device). The result is the shell's: `ok` is false when the device printed an error (`% Enter router rip mode first.`, a rejected `iptables` rule, a bad `dhcp-range`), so a script import reports those lines as rejected. A command that starts an animation (`ping`) is ok once it has started. |

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
| `undo` / `redo` | Undo / redo the last change. Refused, with the reason, while the tutorial is playing (its one undo snapshot is the learner's own network). |
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
- Anything whose natural home is a device's own CLI replays through **`cli <device> …`** exactly as a person would type it: a router's `router rip` / `network` / `passive-interface`, `interface EthernetN` + `ip nat inside|outside`, static port-forwards, and the netfilter ruleset in the device's chosen language — `iptables -P`/`iptables -A …` (via `ruleToIptables`) or `nft add chain … { policy … }`/`nft add rule …` (via `ruleToNft`), preceded by a top-level `rulelang <device> nftables` line when the device is set to nftables so the dialect round-trips; a firewall's rules the same way.
- **A managed switch's base MAC** is written (`mac <switch> <addr>`) when it is not the one `add` derives from the switch's name — a renamed switch, a `mac` edit, a saved network's id-derived MAC — so the replay elects the same spanning-tree root and blocks the same link (review R12).
- **Power state is emitted last**, after every `cli` line: a powered-off device has no working shell (review R42), so its shell-set configuration must replay while it is still on.
- **Cables are emitted before per-device config**, because port and interface names (`port SW Ethernet2 …`, `mirror … Ethernet3`, the CLI's `interface Ethernet1`) only resolve once the link exists.

**The guarantee is tested for every built-in network.** `tests/roundtrip.test.ts` exports each of the four topologies and every scenario, replays the script from an empty canvas, and compares the two saved configurations field by field (ids mapped to names; an address with no stored prefix compared as the `/24` it means) — nothing may be rejected and nothing may differ, and re-exporting must give the same script. It also covers the awkward corners:

- **Credentials** are always written, quoted: an empty password as `""` (it used to be dropped, leaving `supplicant PC alice`, a usage error on replay), and a MACsec key as one token (`"my key" must` used to replay as the key `my` in should-secure mode — a silent downgrade). Review R36.
- **VLAN names** are written when they are not the default (`vlan SW add 10 Sales`); they used to come back as `Vlan10`. Review R79.
- **A laptop's SSID is always stated**, as `""` when unconfigured — a new laptop defaults to the shared SSID, so an empty one has to be written out.
- **Collapsed LANs** are rebuilt last: the LAN node and its stand-in cable are views, so they are never `add`ed or `link`ed; the script ends with `collapse <switch>` for each, then a `rename` / `move` for the LAN node. They used to emit `link "SW LAN" R1`, which was rejected, and came back expanded. Review R81.
- **A device named `at`** exports and replays (`add computer at at 120 240`).
- **Duplicate names** cannot be made with the commands, but a JSON import (or a LAN collapsed around a switch whose default LAN name is taken) can still carry them, and the script addresses devices by name. The export keeps the first holder's name and writes each later one as `<name>-2`, `-3`, … (the lowest suffix no device uses, matched ignoring case), in creation order — the same script every time — with a `#` comment line per rename, so the script replays instead of failing every line with "Ambiguous device". Review R38.

When you add a field to a device, this suite fails until the export can express it.

```js
const script = routesim.export();   // "clear\nadd computer PC1 at …\nip PC1 …\nlink …"
routesim.exec("clear");
routesim.run(script);               // recreates the identical topology
```

**Ports in the export.** A `link` line never states a made-up port. A pinned end states its pin; an unpinned end is `auto`; and on a device that has *any* pinned cable, every cable states the port it occupies now — where an unpinned cable sits depends on the pins around it, and a replay adds one cable at a time, so the layout is written out. The result replays onto the same named port at both ends of every cable (`tests/ports.test.ts` checks every built-in topology and scenario) and re-exports unchanged. (The export used to write `1` for an unpinned end; on replay that took port 1 first and pushed the real pin elsewhere, so the VLAN, mirror, `portauth` and NAT-role lines landed on the wrong cable — review R32.)

This is the completeness guarantee — the command set can express everything the GUI can build. The export emits `managed <name>` (before a switch's VLAN/STP config) and only the STP deviations — `stp <name> off` or `stp <name> priority <n>` — since the default-on, default-priority spanning tree round-trips implicitly. A switch's SPAN session emits `mirror <name> <dst>`; an IDS sensor emits `idsrule <name> clear` followed by one `idsrule <name> <rule>` per rule (so the device's default rule set is re-established exactly). A Kali PC (`kali`) exports as a plain host — its `ip`/`gateway`/`mac`/`nameserver` lines, with **no** `redteam` lines (it is hand-driven and carries no stored plan). A Red Team actor (`attacker`) emits those host lines too, then `redteam <name> attacks <list>`, `redteam <name> target <t>`, and `redteam <name> spoof <ip>` (only the non-empty ones) — its runtime `attackLog` is not exported. Both serialise via the shared host helpers, so a non-/24 prefix and the nameserver survive the round-trip (a prior bug dropped them for the attacker).

## Headless vs animated

`ping`/`dhcp` run the **animated** simulation (transit dots on the canvas) and return immediately. `run ping`/`run dhcp` run **headless** — the engine drains the event queue synchronously (no animation) and returns the result plus log. Use `run` in scripts and tests where you want a deterministic pass/fail; use the animated form to watch a packet traverse the network. Both are backed by the same per-device processing in `engine.ts` (see [src/engine.md](src/engine.md)).

Only one run owns the simulator at a time ([run ownership](src/engine.md#run-ownership)). While an animated run is running or paused, a second animated verb (`ping`, `connect`, `http`, `dhcp`, `associate`, `dot1x`, `attack`, bare `stp`) fails with *"A simulation is already running (or paused) — wait for it to finish, or stop it first (Ctrl+C or Stop)."* — the run on screen is left alone. A headless verb (`run …`, `traceroute`, `scenario check`) instead stops the animated run first and puts a note as the first line of its output (*"Simulation stopped before it finished — the console's `run ping` needed the simulator."*, or *"… — a traceroute from PC3 …"* / *"… — the scenario Check …"*). A network boot started by Play gives way to either kind of run, and the rest of its queue is cancelled (*"Network boot interrupted — …; 2 hosts still unassigned (press Play to finish booting)."*).

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
