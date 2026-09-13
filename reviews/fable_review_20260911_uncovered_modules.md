# RouteSim review — the four modules neither prior review covered — 11 September 2026

Reviewer: Claude Fable 5.1. Reviewed commit: `062a64b` (after the LOW sweep). Scope, as agreed: **(1)** `state` / `config` / `io` / `settings-url`; **(2)** the terminal NOS shells (`terminal/*.ts`); **(3)** firewall/iptables (`terminal/iptables.ts` plus the engine's conntrack/evaluate/processAtFirewall block); **(4)** `scenarios` / `scenario-ui` / `scenario-library` / `help` / `tutorial`. About 5,300 lines.

## Method

Every line of the four groups was read. Each candidate defect was then **probed with a throwaway Bun test against the real modules** before it was listed; candidates that did not reproduce were withdrawn (they are recorded at the end so nobody re-chases them). Probes were deleted afterwards; no source was changed. The existing suite is green at this commit (893 non-bench tests, both TypeScript checks at zero).

Priority: **P1** — a documented workflow cannot be completed, or work is lost. **P2** — a reproducible wrong outcome or silent failure a learner can hit. **P3** — fidelity, consistency, or cleanup.

## Findings at a glance

| ID | Pri | Finding | Location | Verified |
|---|---|---|---|---|
| G2-01 | P1 | Router-on-a-stick cannot be configured from the FRR shell | `terminal/router.ts:513–568` | reproduced |
| G1-01 | P1 | `undo()` tears the run down by hand and incompletely; `redo()` has no guard at all | `state.ts:580–614` | reproduced |
| G4-01 | P2 | Pressing Check during an animated run replaces it and leaves `headless=true` | `scenario-ui.ts:49`, `scenarios.ts:143` | reproduced |
| G4-02 | P2 | The tutorial clears the learner's topology unasked; rebuilds bury it under the undo cap | `tutorial.ts:233–266, 279–293` | measured |
| G2-02 | P2 | Terminal `ping`/`nc`/`curl` to a laptop, Kali or Red Team host *by name* always reports failure | `terminal/host.ts:344–352` | reproduced |
| G1-03 | P2 | Script import reports success whatever was rejected, and floods undo one entry per line | `io.ts:118–123` | reproduced |
| G1-02 | P2 | Undo/redo leaves terminal sessions pointing at devices the restored topology lacks | `state.ts:559–578` | reproduced |
| G2-03 | P2 | The IDS shell breaks the undo contract (no `pushUndo` anywhere) | `terminal/ids.ts` | by code |
| G2-04 | P2 | `no network X` never removes what `network X` added (add masks, remove doesn't) | `terminal/router.ts:626, 661` | reproduced |
| G3-01 | P2 | `iptables -s/-d` accept any string; `--dport 0`; `--icmp-type` without `-p icmp` | `terminal/iptables.ts:77–85` | reproduced |
| G1-04 | P3 | Topology load resets every selection field except `selectedLinkId` | `config.ts:222–261` | reproduced |
| G2-05 | P3 | `pushUndo` before validation in `setSwitchMirror`; no-op `vlan member del` wipes redo | `terminal/switch.ts:130, 317` | by code |
| G2-06 | P3 | `config vlan del` leaves trunk allow-lists / native VLANs referencing the deleted VLAN | `terminal/switch.ts:172–185` | by code |
| G2-07 | P3 | `show runningconfiguration` cannot represent a trunk with an empty allow-list | `terminal/switch.ts:65–85` | by code |
| G2-08 | P3 | Router shell: `iptables` accepted outside the modes the registry advertises; "Removed" on a no-op; unvalidated `passive-interface`; running-config omits port-forwards | `terminal/router.ts:364, 301, 674, 117` | by code |
| G3-02 | P3 | Any `iptables` command — including `-L` — writes default policies into config | `terminal/iptables.ts:150–152` | by code |
| G4-03 | P3 | Scenario checks mutate runtime tables; a `dhcp` check assigns the address it verifies | `scenarios.ts:143–217` | by code |
| G1-05 | P3 | `pickFile` never resolves when the picker is cancelled | `io.ts:35–50` | by code |
| G4-04 | P3 | Tutorial Esc/arrow keys fire while focus is in an input | `tutorial.ts:339–344` | by code |

Clean, with nothing to report: `settings-url.ts` (a well-built pure parser), the `config.ts` payload helpers, `terminal/core.ts` (the session/dock model is sound), `terminal/server.ts`, `terminal/firewall.ts`, `terminal/attacker.ts` (post-sweep), `help.ts`, `scenario-ui.ts`, and the **scenario library** — 29 scenarios, unique ids, every check well-formed, every cited device present in its topology, a solution script for every one. (The four `to: "web.corp"` references are DNS names the learner creates; that is the point of those scenarios.)

## Detailed findings

### G2-01 — [P1] Router-on-a-stick cannot be configured from the FRR shell

`encapsulation dot1q N` sets the tag on **whichever interface is currently selected** (`routerInterfaceFor(router, interfacePeerId, interfaceVlanTag)`). The only way to reach an interface is `interface <name>`, and `routerInterfaceByName` resolves **existing** names only.

**Reproduction** (router R1 cabled to a managed switch, config mode):

| Step | Command | Result |
|---|---|---|
| 1 | `interface Ethernet1` | ok |
| 2 | `encapsulation dot1q 10` | the base interface becomes `Ethernet1.10` |
| 3 | `ip address 192.168.10.1/24` | ok |
| 4 | `interface Ethernet1` | **% Unknown interface** (the named view now lists only sub-interfaces) |
| 5 | `interface Ethernet1.20` | **% Unknown interface** (it does not exist yet, so it cannot be named) |
| 6 | `interface Ethernet1.10` → `encapsulation dot1q 20` | `.10` is **retagged** to `.20`, keeping its address — no second sub-interface |

So a second VLAN sub-interface cannot be created from the terminal by any sequence. The **VLAN Router-on-a-Stick** built-in topology — the FRR/IOS workflow this shell exists to teach — is buildable only through the console's `interface R1 SW ip X vlan N` (keyed by peer+VLAN).

**Fix:** `interface <base>.<N>` creates the sub-interface when it does not exist (IOS/FRR semantics: naming it creates it); `encapsulation dot1q` sets the tag of a **sub**-interface only and errors on the base; keep the base interface addressable in the named view even when sub-interfaces exist. **Regression:** the six-step sequence above, ending with two addressed sub-interfaces and an intact base.

### G1-01 — [P1] `undo()` tears the run down by hand; `redo()` not at all

`undo()` (state.ts:580) cancels an active run by setting `status="idle"` and clearing four queues and two DOM nodes by id. It does not stop the animation loop, cancel the boot queue, clear conntrack/DNAT sessions, or hide the transport pill — everything `stopSimulation()` does. `redo()` has **no guard**: reproduced — redo during a run leaves `status="running"` with a transit in flight over a topology that was just replaced. This is the F13 class (a topology-replacing path that re-derives teardown or skips it); F13 closed `clearNetwork` and `applyConfigWithoutUndo`, and these two doors are still open.

**Fix:** `state.ts` cannot import `engine.ts` (cycle), which is why the teardown was hand-rolled — add `stopSimulation` to the `SyncCallbacks` registry (the bridge that already exists for this purpose) and call it at the top of both `undo()` and `redo()`. Delete the hand-rolled block. **Regression:** undo and redo mid-run each leave `status="idle"`, empty queues, and a clean `diagnoseState`.

### G4-01 — [P2] Pressing Check during an animated run replaces it

`runActiveScenarioCheck` has no guard, and every ping/tcp/http/dns/dhcp/alert check calls `runSimulationHeadless`, which writes the **live** `state.simulation` (events, transits, pendingArp, origin, log, headless). Reproduced: an animated run (`running`, one transit, origin pc1) → Check → `status="done"`, no transits, origin is the check's device, the log is the check's, and `headless` is left `true` on the shared state. The learner's run silently vanishes and the sim-log/transport show the checker's run as the last one.

**Fix:** refuse Check while a run is active (or stop it first through the same bridge as G1-01), and have `runSimulationHeadless` restore `headless`/origin/log on exit — or run against a scratch simulation state. **Regression:** Check mid-run either refuses or leaves the animated run untouched; `headless` is never left true after a headless run.

### G4-02 — [P2] The tutorial clears the learner's topology unasked, then buries it

`startTutorial` → `clearTopologyAndView` → `exec("clear")`, with no confirmation and no snapshot. `clear` is undoable, but the demo then runs ~20 undoable actions, and **Back/Forward rebuild by replaying every action from `clear`** (`goToStep`), so each press pushes another ~20 entries.

**Measured** (a learner's four-device topology, then the demo's actions): 20 undo entries after launch; **68 of 80** after three Back/Forward rebuilds — the original is still on the stack, **64 consecutive undos** away; the fourth rebuild pushes it off the cap. Same class as the `stress` command's destructiveness flagged this week, but reached from Help → Tutorial by a beginner mid-build.

**Fix:** confirm when the topology is non-empty (or auto-snapshot on start and restore on exit), and run the demo under `isApplyingCompositeChange` so the whole tutorial is one undo point. **Regression:** after start + three rebuilds + exit, a single undo restores the learner's topology.

### G2-02 — [P2] Terminal `ping`/`nc`/`curl` to a laptop, Kali or Red Team host *by name* always fails

`host.ts`'s private `resolvePingTargetIp` resolves a name among `computer`/`server` devices only, but its result is what `startSimulation` records as the target the echo-reply check compares against (`ipv4.srcIp === sim.pingTargetIp`). Reproduced: `ping L` (a laptop) starts a run whose target is the literal string `"L"` — frames flow, the reply arrives, and success is impossible. The shared helpers (`findPingTarget`, `hostnameToIp`) already cover laptop/kali/attacker; the private helper drifted. `nc` and `curl` share it.

**Fix:** delete `resolvePingTargetIp` and use `findPingTarget`/`hostnameToIp`. (Pinging a **router** by name resolves nowhere, by documented design — a router has several addresses. Not a defect; "the interface facing the querier" would be a reasonable extension.) **Regression:** `ping <laptop-name>` from a PC terminal succeeds when `ping <its-ip>` does.

### G1-03 — [P2] Script import: silent failures, and one undo entry per line

`importScript` runs `runConsoleScript(text)` and discards the results — the mode label says "Ran imported script." however many lines were rejected. And each command pushes its own undo entry: measured, a 30-line script pushes **30** entries, so a real script is neither reversible in one step nor even fully reversible (80-entry cap) — while `isApplyingCompositeChange` exists for exactly this and `importConfig` already gets one undo point via `applyConfig`.

**Fix:** `pushUndo()` once, run under the composite flag, and report `N of M lines rejected — first: …` (the console pane is the natural place). **Regression:** a script with a bad line reports it; one undo reverts the whole import.

### G1-02 — [P2] Undo/redo leaves terminal sessions pointing at vanished devices

`restoreSnapshot` restores devices/links but never drops terminal sessions for devices the restored topology lacks (`applyConfigWithoutUndo` does). Reproduced: add a device, open its terminal, undo → a session and the **active** terminal reference a missing device; `diagnoseState` reports both. `core.ts` only cleans such a session when it is activated (tabs show "(removed)" meanwhile).

**Fix:** in `restoreSnapshot`, `dropTerminalSessions(ids of sessions whose device is not in restored.devices)`. **Regression:** the probe above, asserting `diagnoseState` is clean.

### G2-03 — [P2] The IDS shell breaks the undo contract

`terminal/ids.ts` contains no `pushUndo`. `echo 'alert …' >> local.rules` (→ `addIdsRule`) and `echo -n > local.rules` mutate `config.idsRules` with no undo point; every setter in `host.ts`, `switch.ts`, `router.ts` pushes one. The console `idsrule` pushes its own before calling `addIdsRule`, and the inspector textarea uses `captureUndoOnFocus`, so only the terminal path is exposed.

**Fix:** `pushUndo()` in `addIdsRule` after `parseSnortRule` succeeds, and before the truncation. **Regression:** add a rule via the shell, undo, rule gone.

### G2-04 — [P2] `no network` cannot remove what `network` added

`network 192.168.1.5/24` stores the **masked** network (`192.168.1.0/24`, router.ts:626 — correct, and what F08's gating matches). `no network 192.168.1.5/24` compares the **unmasked** token (router.ts:661). Reproduced: after add then remove of the same token, `networks = ["192.168.1.0/24"]`. A learner must know to type the network address on removal but not on addition.

**Fix:** mask in both paths (and accept `no network <ifname>` symmetrically with the add path). **Regression:** add/remove of the same token leaves an empty list.

### G3-01 — [P2] `iptables` accepts addresses and ports that can never match

`parseFirewallRule` stores `-s`/`-d` values verbatim. Reproduced: `iptables -A FORWARD -s bogus.host -j DROP` → "Appended FORWARD rule (DROP)" — listed, persisted, never matches. `--dport 0` is likewise accepted, and `--icmp-type` without `-p icmp`. The inspector's add-rule form validates IPv4/CIDR; the CLI, which the firewall scenarios are taught through, does not. Real iptables rejects all three. A rule that "doesn't work, no error" is the anti-lesson.

**Fix:** validate `-s`/`-d` with the existing `isValidIpv4`/CIDR helpers, `--dport` 1–65535, `--icmp-type` requires `-p icmp`. **Regression:** each of the three is refused with an iptables-style message.

### P3 items

- **G1-04** — `applyConfigWithoutUndo` resets `selectedId`, `configuringId`, `linkStartId`, `drag`, `panDrag`, `pointer` — not `selectedLinkId`. Reproduced (`diagnoseState`: "Selection references missing link"). F13 closed this in `clearNetwork` only.
- **G2-05** — `setSwitchMirror` pushes undo before validating its ports (an invalid dest returns after the push); `sonicVlanMemberDel` pushes before it knows nothing changed. Both leave a spurious entry and wipe redo — the class fixed in `commands.ts` this week.
- **G2-06** — `config vlan del N` strips access memberships but leaves `trunkAllowedVlans`/`trunkNativeVlans` entries for N. SONiC refuses to delete a VLAN with members; either refuse or clean up.
- **G2-07** — `show runningconfiguration all` claims to emit "the config commands that would recreate the state", but a trunk with an empty allow-list (= all VLANs) emits no `-t` line, so replay leaves the port in access mode.
- **G2-08** — `iptables` runs in interface/rip mode though the registry (and `?`) say privileged/config; `no ip nat inside source static …` prints "Removed" when nothing matched; `passive-interface` accepts any string; `show running-config` omits the port-forwards configured in this same mode.
- **G3-02** — every `iptables` command, including `-L`, writes `policy[chain]="accept"` defaults into config, which then persist in the JSON payload — a read with a write side effect.
- **G4-03** — checks run headless simulations that mutate ARP/MAC/conntrack tables, and a `dhcp` check assigns the address it verifies; evaluation is order-dependent. Arguably the assignment *is* the verification; noting it.
- **G1-05** — `pickFile` resolves only on `change`; a cancelled picker leaves a pending promise and a detached input. `input.addEventListener("cancel", () => resolve(null))`.
- **G4-04** — the tutorial's document-level Esc/arrow handler fires with focus in an input.

## Checked and cleared

- **Conntrack keys ICMP/UDP on the address pair alone** (ports 0,0). By reading, an outside-initiated echo request would classify as ESTABLISHED after any inside-initiated one to the same host. **Probed: it does not** — the table is reset per run, so the entry cannot leak into the next flow; the outside-initiated ping is correctly dropped by a stateful default-DROP. It would become a real defect if conntrack ever persisted across runs; a one-line comment at `connTuple` saying so is worth adding.
- **Routers unreachable by name** under instant DNS — documented design (`hostnameToIp`: "hosts only, they own a single IP").
- **Undo snapshots include runtime tables** (ARP/MAC/NAT/leases), so two structurally identical topologies differ after a run: the top-of-stack dedup misses, and `captureUndoOnFocus` can push an entry for a field the user never changed. A design choice with a mild cost; noting, not filing.

## Cross-cutting

1. **The lifecycle class is not closed.** F13 fixed two topology-replacing paths. This review found three more that replace or run over the simulation state without going through the same teardown: `undo`/`redo` (G1-01), scenario Check (G4-01), and script import (G1-03, indirectly). One `stopSimulation` entry in the `SyncCallbacks` registry, called from each, plus a lifecycle test that runs `diagnoseState` after every such transition during an active run, would close it — this is precisely Astra's test-strategy point 3, still the cheapest high-value test in the project.
2. **The undo contract drifts in the terminal layer.** `ids.ts` has none; `switch.ts` pushes before validation twice. `commands.ts` was brought into line this week; the shells were not. Worth one pass with the same rule: *validate, then push, then mutate.*
3. **Private helpers drift from shared ones.** `resolvePingTargetIp` (G2-02) is the same shape as the `networkOf` misuse caught during F05: a local re-implementation that silently diverged from the module that owns the concept. Prefer deleting the private copy.

## Suggested implementation order

1. **G2-01** (router-on-a-stick) and the **lifecycle bridge** (G1-01 + G4-01 + G1-02 together — one callback, three call sites, one test).
2. **Learner-visible correctness:** G2-02, G4-02, G1-03, G3-01, G2-04, G2-03.
3. **The P3 sweep**, grouped by file.

## Verification performed

| Check | Result |
|---|---|
| Commit reviewed | `062a64b` |
| Existing suite | 893 non-bench pass, 0 fail; `tsc --noEmit` and `tsc -p tsconfig.tests.json` at zero |
| Probes | 9 throwaway Bun tests against the real modules (undo/redo/import/selection; ping-by-name; router sub-interfaces; conntrack + iptables + RIP network; Check-during-run; tutorial undo burial; library integrity) — all deleted afterwards |
| Source changed | none |

## Status — applied 13 September 2026

All 19 findings addressed in three commits, in the order suggested above:

| Commit | Group | Findings |
|---|---|---|
| `0cb85c1` | Lifecycle bridge + router-on-a-stick | G2-01, G1-01, G4-01, G1-02, G1-04 |
| `023c5df` | Learner-visible correctness | G2-02, G4-02, G1-03, G3-01, G2-04, G2-03, G1-05 |
| (this) | P3 sweep | G2-05, G2-06, G2-07, G2-08, G3-02, G4-04, and the `connTuple` comment from "checked and cleared" |

G4-03 (checks mutate runtime tables; a `dhcp` check assigns what it verifies) is left as recorded: the assignment *is* the verification, and the headless-flag half was fixed under G4-01. Two of the fixes required updating tests that had encoded the old behaviour (`enableNat()` leaves the router shell in interface mode, and two NAT tests ran `iptables` from there); both now `end` first, as the third test in that file already did.
