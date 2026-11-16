# Kali PC & the Red Team actor (offensive hosts)

RouteSim models **Kali Linux** offensive tooling two ways, sharing one attack engine:

- **Kali PC** (`type: "kali"`, the **Computer** tool group) — a pentest *workstation* you control. You open its terminal and run `nmap` / `arpspoof` **by hand** (or `attack <node> …` from the console). It boots like an ordinary PC and never acts on its own.
- **Red Team actor** (`type: "attacker"`, the **Security** tool group) — an *autonomous adversary* you don't control. It carries a configured attack plan (target + enabled attacks) and **launches it on its own** when you press Play. This is the "drop in a threat and watch" device.

Both are real single-NIC hosts (IP/MAC/ARP, reuse `processAtComputer`); the difference is who pulls the trigger and where they live in the ribbon. The blue-team half of the story is the [IDS](ids.md) and [firewall](firewall.md). The offensive code is **separated into the `src/security/offensive/` subtree** so it is reviewable in isolation from general networking code (the general code never carries attack technique); source spread across:

- **`src/security/offensive/attacks.ts`** — the attack builders: `buildScanEvents`, `buildSweepEvents`, `buildArpSpoofEvents`, and `buildAttackEvents` (the merge), plus `macForIp`. They reach the shared `findFirstHop` / `findPingTarget` helpers from `simulation.ts`.
- **`src/security/offensive/engine-logic.ts`** — the engine-side attack logic, injected into the engine through an `AttackContext` so it never imports `engine.ts` (which would form a cycle): `processAttacker` (the reply tally, registered for *both* `attacker` and `kali`), `forwardIntercepted` (the MITM relay), `recordArpPoison`, and `buildAttackReport` (the nmap-style report the `finishSimulation` `"attack"` branch writes).
- **`src/security/offensive/red-team.ts`** — `launchRedTeam` (+ `redTeamNotReadyReason`), the autonomous-Play trigger (**actor only**); called from `ui.ts`.
- **`src/security/offensive/inspector.ts`** — the Red Team actor's inspector panel (`renderAttackerSection` / `bindAttackerControls`).
- **`src/terminal/attacker.ts`** — the Kali CLI (`nmap` / `arpspoof`), shared by both types; it falls through to the host shell for ordinary Linux commands. (Stays under `terminal/`, a device shell in the terminal import cycle; it imports the builders from the offensive subtree.)
- **`src/commands.ts`** — the `attack` / `redteam` console handlers (parse-and-dispatch glue over the builders; they stay with the command engine, whose result helpers they use).

## The two devices

| | Kali PC (`kali`) | Red Team actor (`attacker`) |
|---|---|---|
| Tool group | Computer (shortcut `K`) | Security (shortcut `A`) |
| Icon / palette | monitor + shell prompt, violet | skull, crimson |
| Inspector | plain host (IP/gateway/DNS/MAC) | host **+** attacks/target/spoof + **Launch** |
| Stored attack plan | none (manual) | `attacks` / `attackTarget` / `spoofIp` |
| Autonomous on Play | no — boots like a PC | yes — `launchRedTeam` |
| Terminal, console `attack` | yes | yes |

Both are full hosts — `HOST_ROLES` in `device-registry.ts`: single-NIC (the `hostNicTaken` / `addLink` guard, `buildPortList`/`openPortSelectionModal`), a MAC on creation, `hasHostname`, network-bootable, an 802.1X supplicant (`supplicant <node> …`; on a locked port it is blocked like any host until it authenticates), `isHost` (so the inspector renders the shared host static-config fields — and those fields drive the device terminal, which is why the Kali CLI **falls through to the host shell**). `AttackerConfig extends ComputerConfig` adds `attackTarget?`, `attacks?: AttackKind[]` (`"scan" | "sweep" | "arp-spoof"`), `spoofIp?`, and `attackLog?` (runtime, last run's report — **not serialised**). The Kali PC uses the plain `ComputerConfig` shape (no autonomous plan).

## The attacks (`simulation.ts`)

Each builder returns a `PingSetup` (seeded frames + deferred `pendingArp`) or an error string — the same shape `buildPingEvents` uses, so the attacks animate and run headless identically to a ping.

- **Port scan** — `buildScanEvents(host, targetText)`. An `nmap -sS` SYN scan: a TCP SYN to each of `SCAN_PORTS` (`21,22,23,25,53,80,110,143,443,445,3306,3389,8080`) on the target, from one ephemeral source port. ARP-resolves the next hop first (`attackNextHop`: direct if same-subnet, else the gateway). An **open** port answers SYN-ACK, a **closed** one RST.
- **Ping sweep** — `buildSweepEvents(host, subnetText)`. An `nmap -sn` host discovery: an ICMP echo to each of the first `SWEEP_HOSTS` (20) **usable host** addresses of a subnet (the argument, else the host's own), **capped at the subnet's usable-host count** so a small subnet never spills into the next (review R27); a garbage target is rejected with `"nmap: invalid target"`. Each probe is **routed like a real ping** — same-subnet targets directly, a remote subnet via the gateway (one shared ARP, all echoes buffered under the gateway's next-hop key) — so sweeping *another* subnet across a router works. Live hosts reply; the rest time out.
- **ARP spoof** — `buildArpSpoofEvents(host, spoofText?, { victim?, reverse? })`. A **gratuitous ARP reply** "spoofIp is at \<our MAC\>" (spoofIp = the last positional, else `config.spoofIp`/the gateway) that poisons a victim's ARP cache so its traffic to spoofIp is redirected to the attacker. Three modes (issue #5): **no `-t`** broadcasts it, poisoning the whole segment (the default); **`-t <victim>`** unicasts it to one victim (resolved to a MAC via the attacker's cache, then `macForIp` over the topology, else a broadcast fallback); **`-r`** adds the mirror reply "victim is at us" to the **gateway**, so return traffic crosses the attacker too. Pair `-r` with `net.ipv4.ip_forward` for a transparent, bidirectional MITM (the reply returns via the attacker — see `tests/arpspoof.test.ts`). The poisoning *is* ordinary ARP-cache learning at each target.

`buildAttackEvents(host, only?)` merges the enabled `config.attacks` (or one named kind) into a single run — concatenating each builder's events and `pendingArp` (arrays merged on key collision). The scan/sweep target is `config.attackTarget` (sweep falls back to the host's own subnet).

## Running an attack (`engine.ts`)

An attack run is `startSimulation(setup, host.id, "", "attack")` — sim mode `"attack"`. `processAttacker` (in `src/security/offensive/engine-logic.ts`, wired into the engine's `PROCESSORS` map) is the frame handler for **both** `attacker` and `kali`: during an `"attack"` run, for replies addressed to it (the run origin) it records findings — **SYN-ACK → `sim.scanOpen`**, **RST → `sim.scanClosed`**, **ICMP echo reply (`icmpType 0`) → `sim.sweepLive`** — logging a `sim-attack` line; a half-open scan never completes the handshake. An **ARP-cache poison** is tallied separately by `recordArpPoison` at each ARP-reply learn site (host `learnArp`, router `learnRouterArp`): a gratuitous reply whose sender MAC is the origin's but whose sender IP is another host's pushes the victim's name to **`sim.arpPoisoned`** (an honest reply's MAC and IP belong to one device, so it never fires on normal traffic). Everything else falls through to `processAtComputer`. The per-run reset clears `scanOpen`/`scanClosed`/`sweepLive`/`arpPoisoned` and each offensive host's `attackLog`.

`finishSimulation`'s `"attack"` branch builds an **nmap-style report** — a `PORT  STATE  SERVICE` table of the **open and closed** ports (`SERVICE_NAMES` maps the port to a name), a `Hosts up:` line for a sweep, and an `ARP cache poisoned on: …` line listing the poisoned devices — writes it to the origin terminal session, and stashes it on `origin.config.attackLog` for the inspector. A run "succeeds" (`SimResult.success`) when it found at least one open port or live host, **or poisoned a cache** (closed ports are reported but do not by themselves count as success). Before review R48 an arp-spoof run reported failure and the "No open ports or live hosts found" fallback even after poisoning its victims, because success and the report were built from the scan/sweep accumulators only.

`launchRedTeam()` is the autonomous **Play** trigger and is filtered to **`type === "attacker"`** — a Kali PC is never launched this way. When the canvas is idle and a ready actor exists (an IP and ≥1 enabled attack), pressing Play finds the first one, `buildAttackEvents`, and starts the run. Wired after `startNetworkBoot` in the Play handler ([ui.ts](ui.md)); an unconfigured offensive host — the actor itself or a Kali PC — boots over DHCP like any other host instead (both carry the registry's `bootable` role), and the next Play launches the plan. With actors placed but none ready, Play says why (powered off, no IP / no cable, no attacks enabled).

## Triggers — CLI, console, inspector

- **Kali terminal** ([terminal/attacker.ts](terminal.md), used by both types) — `nmap -sS <target>` (scan), `nmap -sn <subnet>` (sweep), `arpspoof [-r] [-t <victim>] <gateway>` (spoof; the last arg is the impersonated IP, `-t` targets one victim, `-r` poisons both ways), `nmap -V`, `clear`, `?`/`help`; plus (via the host shell) `sysctl -w net.ipv4.ip_forward=1` to become a transparent MITM. **Anything else falls through to the host shell** (`runHostTerminalCommand`: `ip addr`, `ip route`, `ping`, `traceroute`, `nc`, `hostname`, `/etc/resolv.conf`) — which is also what the inspector's IP/gateway/DNS/MAC fields commit through. Each attack starts the animated run; results land in this session when it finishes.
- **Console** ([scripting.md](../scripting.md)) — `attack <node> [scan|sweep|arp-spoof] [target]` launches (works on either type; a scan/sweep target arg overrides and remembers `config.attackTarget`); `redteam <node> target <ip> | attacks <scan,sweep,arp-spoof> | spoof <ip>` configures an **actor's** plan.
- **Inspector** ([inspector.md](inspector.md)) — the actor gets `renderAttackerSection`: a target field, three attack checkboxes, a **Launch attacks** button, and the last run's report. The Kali PC gets the plain host inspector only (drive it from the terminal).

## Persistence

The actor serialises via the shared host helpers (`hostConfigForPayload` / `normaliseHostFields`, so IP/prefix/gateway/DNS/MAC/MACsec all round-trip) plus `attacks` (filtered to the valid kinds), `attackTarget`, and `spoofIp` — **not** `attackLog` (runtime). The Kali PC serialises as a plain host. Script export emits `ip`/`gateway`/`mac`/`nameserver` then, for the actor, `redteam <name> attacks/target/spoof` lines. All round-trip in `tests/attacker.test.ts`.

## Detecting it (red vs blue)

The point of these devices. A scan's port-23 SYN probe trips a [Snort](ids.md) Telnet rule on an IDS fed by a SPAN port; the `alert` [scenario check](../scenarios.md) launches the scan when its `from` is an attacker. The `red-team-scan` scenario ("Detect the Red Team scan") ships a pre-mirrored IDS with an empty rule set — the learner authors the rule that catches the actor's scan.

## IP forwarding — the transparent MITM (issue #4)

A Kali host (any host, really) carries **`config.ipForward`** (`net.ipv4.ip_forward`, off by default). With it on, `forwardIntercepted` (in `src/security/offensive/engine-logic.ts`, called from `processAtComputer`) relays an IPv4 frame **unicast to our MAC but bound for another IP** — the signature of an arpspoof victim whose ARP cache we poisoned — instead of dropping it as "not for us":

- next hop = the destination if on our subnet, else our gateway;
- the frame is re-sent from our **own (unpoisoned) ARP cache**, source MAC rewritten to ours, **TTL decremented**, the src/dst **IPs untouched** (no NAT);
- a cold next-hop MAC is ARP-resolved first (the frame buffered in `pendingArp`, flushed by the host's ARP-reply handler, exactly like the router's egress ARP).

So a poisoned victim's traffic reaches its real destination and the reply returns — the silent man-in-the-middle, where without forwarding `arpspoof` is a black hole the victim notices. The knob is driven by the host shell (`sysctl -w net.ipv4.ip_forward=1`, `echo 1 > /proc/sys/net/ipv4/ip_forward`, and the `cat`/`sysctl` reads), round-trips through JSON + the script export (`cli <kali> sysctl …`), and is covered end to end in `tests/forwarding.test.ts`.

## Simplifications (teaching scope)

Fixed scan port list and sweep size; a half-open (SYN) scan with no service fingerprinting; ARP spoofing as a single gratuitous reply (no sustained re-poisoning or actual relay of intercepted traffic); single-NIC; one attack run at a time.


## Kali shell guards (LOW sweep)

- Launching an attack is refused while a run is **paused** as well as running — a paused run used to be stomped.
- An **unmodelled `nmap` option** (`-sT`, `-sU`, `-p`, `-A`, …) gets an explanation listing what *is* modelled (`-sS <target>`, `-sn <subnet>`, `-V`), instead of falling through to the host shell's "unknown command".
