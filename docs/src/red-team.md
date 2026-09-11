# Kali PC & the Red Team actor (offensive hosts)

RouteSim models **Kali Linux** offensive tooling two ways, sharing one attack engine:

- **Kali PC** (`type: "kali"`, the **Computer** tool group) — a pentest *workstation* you control. You open its terminal and run `nmap` / `arpspoof` **by hand** (or `attack <node> …` from the console). It boots like an ordinary PC and never acts on its own.
- **Red Team actor** (`type: "attacker"`, the **Security** tool group) — an *autonomous adversary* you don't control. It carries a configured attack plan (target + enabled attacks) and **launches it on its own** when you press Play. This is the "drop in a threat and watch" device.

Both are real single-NIC hosts (IP/MAC/ARP, reuse `processAtComputer`); the difference is who pulls the trigger and where they live in the ribbon. The blue-team half of the story is the [IDS](ids.md) and [firewall](firewall.md). Source spread across:

- **`src/simulation.ts`** — the attack builders: `buildScanEvents`, `buildSweepEvents`, `buildArpSpoofEvents`, and `buildAttackEvents` (the merge).
- **`src/engine.ts` `processAtAttacker`** — tallies replies during an `"attack"` run (registered for *both* `attacker` and `kali`); the `finishSimulation` `"attack"` branch builds the nmap-style report; `launchRedTeam` is the autonomous-Play trigger (**actor only**).
- **`src/terminal/attacker.ts`** — the Kali CLI (`nmap` / `arpspoof`), shared by both types; it falls through to the host shell for ordinary Linux commands.

## The two devices

| | Kali PC (`kali`) | Red Team actor (`attacker`) |
|---|---|---|
| Tool group | Computer (shortcut `K`) | Security (shortcut `A`) |
| Icon / palette | monitor + shell prompt, violet | skull, crimson |
| Inspector | plain host (IP/gateway/DNS/MAC) | host **+** attacks/target/spoof + **Launch** |
| Stored attack plan | none (manual) | `attacks` / `attackTarget` / `spoofIp` |
| Autonomous on Play | no — boots like a PC | yes — `launchRedTeam` |
| Terminal, console `attack` | yes | yes |

Both are full hosts: single-NIC (the `hostNicTaken` / `addLink` guard, `buildPortList`/`openPortSelectionModal`), a MAC on creation, `hasHostname`, `isHost` (so the inspector renders the shared host static-config fields — and those fields drive the device terminal, which is why the Kali CLI **falls through to the host shell**). `AttackerConfig extends ComputerConfig` adds `attackTarget?`, `attacks?: AttackKind[]` (`"scan" | "sweep" | "arp-spoof"`), `spoofIp?`, and `attackLog?` (runtime, last run's report — **not serialised**). The Kali PC uses the plain `ComputerConfig` shape (no autonomous plan).

## The attacks (`simulation.ts`)

Each builder returns a `PingSetup` (seeded frames + deferred `pendingArp`) or an error string — the same shape `buildPingEvents` uses, so the attacks animate and run headless identically to a ping.

- **Port scan** — `buildScanEvents(host, targetText)`. An `nmap -sS` SYN scan: a TCP SYN to each of `SCAN_PORTS` (`21,22,23,25,53,80,110,143,443,445,3306,3389,8080`) on the target, from one ephemeral source port. ARP-resolves the next hop first (`attackNextHop`: direct if same-subnet, else the gateway). An **open** port answers SYN-ACK, a **closed** one RST.
- **Ping sweep** — `buildSweepEvents(host, subnetText)`. An `nmap -sn` host discovery: an ICMP echo to each of the first `SWEEP_HOSTS` (20) addresses of a subnet (the argument, else the host's own). Each probe is **routed like a real ping** — same-subnet targets directly, a remote subnet via the gateway (one shared ARP, all echoes buffered under the gateway's next-hop key) — so sweeping *another* subnet across a router works. Live hosts reply; the rest time out.
- **ARP spoof** — `buildArpSpoofEvents(host, spoofText?)`. A single **gratuitous ARP reply** broadcasting "spoofIp is at \<our MAC\>" (spoofIp = the argument, else `spoofIp`/the gateway), poisoning every victim's ARP cache so traffic to the impersonated IP is redirected to the attacker — a classic MITM. The poisoning *is* ordinary host ARP-cache learning at each victim.

`buildAttackEvents(host, only?)` merges the enabled `config.attacks` (or one named kind) into a single run — concatenating each builder's events and `pendingArp` (arrays merged on key collision). The scan/sweep target is `config.attackTarget` (sweep falls back to the host's own subnet).

## Running an attack (`engine.ts`)

An attack run is `startSimulation(setup, host.id, "", "attack")` — sim mode `"attack"`. `processAtAttacker` is the frame handler for **both** `attacker` and `kali`: during an `"attack"` run, for replies addressed to it (the run origin) it records findings — **SYN-ACK → `sim.scanOpen`**, **RST → `sim.scanClosed`**, **ICMP echo reply (`icmpType 0`) → `sim.sweepLive`** — logging a `sim-attack` line; a half-open scan never completes the handshake. Everything else falls through to `processAtComputer`. The per-run reset clears `scanOpen`/`scanClosed`/`sweepLive` and each offensive host's `attackLog`.

`finishSimulation`'s `"attack"` branch builds an **nmap-style report** — a `PORT  STATE  SERVICE` table of the open ports (`SERVICE_NAMES` maps the port to a name) and a `Hosts up:` line for a sweep — writes it to the origin terminal session, and stashes it on `origin.config.attackLog` for the inspector. A run "succeeds" (`SimResult.success`) when it found at least one open port or live host.

`launchRedTeam()` is the autonomous **Play** trigger and is filtered to **`type === "attacker"`** — a Kali PC is never launched this way. When the canvas is idle and a ready actor exists (an IP and ≥1 enabled attack), pressing Play finds the first one, `buildAttackEvents`, and starts the run. Wired after `startNetworkBoot` in the Play handler ([ui.ts](ui.md)); an unconfigured offensive host (including a Kali PC) boots over DHCP like any other host instead.

## Triggers — CLI, console, inspector

- **Kali terminal** ([terminal/attacker.ts](terminal.md), used by both types) — `nmap -sS <target>` (scan), `nmap -sn <subnet>` (sweep), `arpspoof [-t <victim>] <gateway>` (spoof; the last arg is the impersonated IP), `nmap -V`, `clear`, `?`/`help`. **Anything else falls through to the host shell** (`runHostTerminalCommand`: `ip addr`, `ip route`, `ping`, `traceroute`, `nc`, `hostname`, `/etc/resolv.conf`) — which is also what the inspector's IP/gateway/DNS/MAC fields commit through. Each attack starts the animated run; results land in this session when it finishes.
- **Console** ([scripting.md](../scripting.md)) — `attack <node> [scan|sweep|arp-spoof] [target]` launches (works on either type; a scan/sweep target arg overrides and remembers `config.attackTarget`); `redteam <node> target <ip> | attacks <scan,sweep,arp-spoof> | spoof <ip>` configures an **actor's** plan.
- **Inspector** ([inspector.md](inspector.md)) — the actor gets `renderAttackerSection`: a target field, three attack checkboxes, a **Launch attacks** button, and the last run's report. The Kali PC gets the plain host inspector only (drive it from the terminal).

## Persistence

The actor serialises via the shared host helpers (`hostConfigForPayload` / `normaliseHostFields`, so IP/prefix/gateway/DNS/MAC/MACsec all round-trip) plus `attacks` (filtered to the valid kinds), `attackTarget`, and `spoofIp` — **not** `attackLog` (runtime). The Kali PC serialises as a plain host. Script export emits `ip`/`gateway`/`mac`/`nameserver` then, for the actor, `redteam <name> attacks/target/spoof` lines. All round-trip in `tests/attacker.test.ts`.

## Detecting it (red vs blue)

The point of these devices. A scan's port-23 SYN probe trips a [Snort](ids.md) Telnet rule on an IDS fed by a SPAN port; the `alert` [scenario check](../scenarios.md) launches the scan when its `from` is an attacker. The `red-team-scan` scenario ("Detect the Red Team scan") ships a pre-mirrored IDS with an empty rule set — the learner authors the rule that catches the actor's scan.

## Simplifications (teaching scope)

Fixed scan port list and sweep size; a half-open (SYN) scan with no service fingerprinting; ARP spoofing as a single gratuitous reply (no sustained re-poisoning or actual relay of intercepted traffic); single-NIC; one attack run at a time.


## Kali shell guards (LOW sweep)

- Launching an attack is refused while a run is **paused** as well as running — a paused run used to be stomped.
- An **unmodelled `nmap` option** (`-sT`, `-sU`, `-p`, `-A`, …) gets an explanation listing what *is* modelled (`-sS <target>`, `-sn <subnet>`, `-V`), instead of falling through to the host shell's "unknown command".
