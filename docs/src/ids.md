# IDS (Snort) + SPAN port mirroring

A passive **intrusion detection** sensor modelled on **Snort 3**, plus the **SPAN port mirroring** on managed switches that feeds it. Two source files:

- **`src/snort.ts`** — a small, faithful subset of the Snort rule language: parse `local.rules` text, match a rule against an `EthernetFrame`, and format a Snort "fast" alert.
- **`src/engine.ts` `processAtIds`** — the passive sensor handler, plus the SPAN copy in `processAtSwitch`.

## The deployment model

The sensor is **passive**: it cables to a managed switch's **monitor (SPAN destination) port** and watches a *copy* of traffic. It is never in the data path, so it can **alert** but never **drop** (that would need an inline IPS). Workflow: place a managed switch, cable the IDS to a port, configure a SPAN session that mirrors the LAN to that port, then run traffic — the sensor sees the mirrored copy and alerts on matches.

## SPAN port mirroring (`SwitchConfig.mirror`)

A managed switch can carry one SPAN session: `{ name, dest, sources? }` (sources empty/absent = mirror every port). In `processAtSwitch`:

1. The **monitor port** (`dest`) is **excluded from normal forwarding** — a SPAN destination carries only mirrored traffic (faithful to real switches).
2. Each **ingress** frame whose source port matches the session is **copied** to the monitor port's peer (the frame as it ingressed; `id` suffixed `-span`). One copy per frame, regardless of the normal forwarding outcome.

Control frames terminated earlier in the switch (BPDU / 802.11 / EAPOL) aren't mirrored — a documented simplification; the sensor's rules target IP traffic anyway. Configure via the SONiC CLI (`config mirror_session span add <name> <dst> [src]`, `show mirror_session`), the console (`mirror <switch> <dst> [src…]` / `mirror <switch> off`), or the managed-switch inspector — a monitor-port dropdown plus per-port **source checkboxes** (all ticked = mirror the whole switch; untick to mirror a subset). Round-trips through JSON + the script (`mirror <name> <dst>`).

## The Snort rule engine (`snort.ts`)

Supported header — `action proto src_ip src_port dir dst_ip dst_port`:
- **action** — alert / log / pass / drop / reject (a passive sensor treats any non-`pass` as an alert).
- **proto** — `ip` (any IP frame) / `icmp` / `tcp` / `udp`.
- **ip** — `any` / `A.B.C.D` / CIDR (`cidrContains`).
- **port** — `any`, a number, a range (`80:443`, `:1024`, `1024:`), a list (`[22,80,8000:8080]`), or any of those negated with `!`. **dir** — `->` or `<>` (either orientation).

Supported options: `msg`, `sid`, `rev`, `gid`, `priority`, `itype` (ICMP type), `flags` (TCP flag letters S/A/F/R; exact by default, `+` for these-plus-any, `*` for any-of), `content` (substring, matched against a **DNS query name** — the one "content" the frame model carries). `frameCtx` extracts proto/IPs/ports/icmp-type/tcp-flags/dns-name from an `EthernetFrame`; non-IP frames (ARP/802.11/EAPOL/BPDU) never match. `formatAlert` emits the Snort fast line `[**] [gid:sid:rev] msg [**] [Priority: N] {PROTO} src(:port) -> dst(:port)` (timestamp omitted so alerts are deterministic for tests). `parseRules` memoises parsed rules by the raw-array identity (recomputed when the user edits `local.rules`). Out of scope (documented): pcre, byte_test, flow, thresholds, rule variables. **Validation (review R26):** `snortRuleIssue(line)` returns why a header-shaped rule can never match — an unknown action or protocol (`tpc`), an IP spec that is not `any`/address/CIDR (a rule variable like `$HOME_NET`, negation, or a list), a malformed port, or an **unsupported option** (an unknown key such as `flow` is refused rather than silently dropped, which would make the rule fire more widely than written) — or null for a blank/comment line or a rule the sensor can evaluate. `parseSnortRule` refuses to load a rule with an issue (so it never silently joins the active set), and the reason is surfaced in three places: `addIdsRule` / the `idsrule` console verb return it, `snort -T` lists each bad rule's reason, and the IDS inspector marks the rules that won't load.

## The sensor (`processAtIds`)

A passive sink: it runs the rule set against the mirrored frame (`runIdsRules`), appends a fast-alert line to `config.alerts` (capped, **not serialised** — it's a runtime log), logs a `sim-ids` line, and returns no outgoing frames. Registered in `PROCESSORS`. The rule set lives in `config.idsRules` (raw Snort lines — named `idsRules` to avoid colliding with `FirewallConfig.rules` in the permissive `DeviceConfig` superset); it persists, the alerts do not.

## CLI, inspector, console

- **Terminal** ([terminal/ids.ts](terminal.md)) — Snort 3 on Linux: `snort -V`, `snort -T` (validate), `cat`/`echo …>>`/`echo -n >` on `/etc/snort/rules/local.rules`, and `cat /var/log/snort/alert`. (Snort isn't an interactive CLI; you edit rule files and run the sensor.)
- **Inspector** ([inspector.md](inspector.md)) — `renderIdsSection`: a `local.rules` textarea + the alert log (with a Clear button). Managed switches get `renderMirrorSection`: a monitor-port dropdown plus per-port source checkboxes (which ports' traffic to mirror).
- **Console** ([scripting.md](../scripting.md)) — `idsrule <ids> <rule>` / `idsrule <ids> clear`, and `mirror <switch> <dst> [src…]` / `mirror <switch> off`.

## Scenario

`ids-monitor` ("Catch the intruder") ships an attacker telnetting to a server with an IDS already cabled to SW-1 but no SPAN session — the goal is the new **`alert`** scenario check (an IDS raises an alert containing a substring for a given flow), satisfied once the learner runs `mirror SW-1 Ethernet3`.

## Simplifications (teaching scope)

One SPAN session per switch, rx mirroring only; the Snort subset above; alert-only (passive, never inline/IPS); control frames not mirrored. The sensor is single-NIC (one monitoring interface).


## Snort fidelity notes (LOW sweep)

- **`flags:` is exact by default.** `flags:S` matches a segment whose flags are *exactly* S — a SYN-ACK does not match (the old subset match fired `flags:S` on every SYN-ACK). Snort's modifiers are honoured: `flags:S+` matches S plus any others, `flags:A*` matches any of the listed bits.
- **Port specs** accept what Snort accepts: a port, `any`, a range (`80:443`, `:1024`, `1024:`), a list (`[22,80,8000:8080]`), and any of those negated with a leading `!`.
- **`formatAlert`** no longer asserts an IP context — a non-IP frame renders as `{NON-IP}` rather than throwing (it is only reached after a match, so this is defence in depth).
