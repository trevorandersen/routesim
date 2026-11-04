# Firewall — transparent inline packet filter

A `firewall` device is a **transparent, 2-port inline filter** modelled on Linux
**iptables**. You drop it onto a path (e.g. `PC — FW — switch`); it bridges ARP
and other control frames straight through, and evaluates every **IPv4** packet
against the **FORWARD chain** before forwarding it. It has no IP address and does
not route — it just passes or drops traffic.

There is no dedicated `firewall.ts`; the device is spread across the standard
"add a device type" seams plus two focused pieces:

- **Filtering** — `engine.ts`: `processAtFirewall` (dispatch + forwarding),
  `evaluateFirewall` (first-match-wins over the chain's rules, else the chain
  policy), and `firewallRuleMatches` (the per-rule predicate). Logged as
  `Firewall ACCEPT/DROP/REJECT … (FORWARD[, new|established])` in the sim log.
  Evaluation is one pass over the rules (no filtered copy per frame) with the
  frame's src/dst parsed once (`parseIpv4`); each rule's `-s`/`-d` pattern is
  parsed once to a `Cidr` (exact IP = /32; the length read with `parseInt`, as
  before; an unparseable pattern never matches) and memoised by its text, so
  nothing is stored on — or serialised with — the rule. A 50-rule miss fell
  from ~85 µs to ~1.5 µs p50 (R109).
- **Connection tracking** — `engine.ts`: `connectionState` classifies a frame as
  `new`/`established`, `trackConnection` records an accepted flow, and
  `rejectResponse` builds the RST / ICMP-unreachable a REJECT sends back. Gated
  by `firewallUsesConntrack` so a stateless ruleset pays nothing.
- **CLI** — `terminal/firewall.ts`: `runFirewallTerminalCommand` parses an iptables
  subset; `showFirewallRules` renders `iptables -L`.

## Data model (`types.ts`)

```ts
ConnState = "new" | "established" | "related" | "invalid"
FirewallRule  = { chain, target: accept|drop|reject, protocol?, src?, dst?, icmpType?, dport?, states?: ConnState[], rejectWith? }
FirewallConfig = { ethernetPorts, rules: FirewallRule[], policy: { forward: accept|drop } }
ConntrackEntry = { proto, srcIp, dstIp, srcPort, dstPort, established }   // runtime, per device, on SimulationState.conntrack
```

Normalised by `normaliseFirewallRules` / the firewall branch of
`normaliseDeviceConfig` (`normalise.ts`) — `states` + `rejectWith` round-trip
with the rest of the rule. The conntrack table is runtime only (reset each run).

## iptables CLI (FORWARD chain)

```
iptables -L [FORWARD] [--line-numbers]          list rules + policy
iptables -A FORWARD [match...] -j TARGET        append a rule
iptables -I FORWARD [pos] [match...] -j TARGET  insert a rule
iptables -D FORWARD <rulenum>                   delete rule N
iptables -P FORWARD ACCEPT|DROP                 default policy
iptables -F [FORWARD]                           flush rules
  matches: -s <ip/cidr>  -d <ip/cidr>  -p icmp|tcp|udp|all  --icmp-type <t>  --dport <port>
           -m state --state NEW,ESTABLISHED  (or -m conntrack --ctstate ...)
  targets: ACCEPT  DROP  REJECT [--reject-with tcp-reset|icmp-port-unreachable]
```

Scriptable via the console: `cli <fw> iptables -A FORWARD -p icmp -j DROP`. The
inspector's add-rule form mirrors this, including a **connection-state** dropdown.

## Scope (what filters today)

Matching covers **src/dst IP (CIDR), protocol (`icmp`/`tcp`/`udp`/`all`), ICMP
type, TCP destination port** (`-p tcp --dport 80` — exercised by the
`nc`/`connect` TCP traffic generator), and **connection state** (`-m state` /
`-m conntrack`).

## Stateful filtering (connection tracking)

The firewall tracks connections (netfilter conntrack), so a rule can match a
frame's **connection state** — the canonical "allow the replies, block new
inbound" pattern:

```
iptables -P FORWARD DROP
iptables -A FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT   # return traffic
iptables -A FORWARD -s 10.0.0.5 -j ACCEPT                            # this host may initiate
```

`connectionState(device, ipv4)` classifies each frame: **`new`** (the first
packet of a flow — no matching conntrack entry) or **`established`** (the reply
of a flow we already let out, matched on the swapped 5-tuple, or a later packet
of such a flow). On an ACCEPT, `trackConnection` records the flow so its reply
matches. The key is `(proto, srcIp, dstIp, srcPort, dstPort)` — TCP carries the
ports; ICMP/UDP key on the address pair (so a DNS reply still matches its query).
**`related`/`invalid` parse in a rule but are never assigned** — a documented
simplification; the common `ESTABLISHED,RELATED` accept rule still works because
it lists `established`. Conntrack only runs when a rule uses `-m state`
(`firewallUsesConntrack`), so a stateless ruleset has no per-frame overhead.
NAT composes correctly: the un-NAT happens before the FORWARD chain, so both
directions present consistent tuples to conntrack.

## REJECT (vs DROP)

A **DROP** is silent — the sender times out. A **REJECT** sends a response so
the sender learns the connection was refused: a **TCP RST** for a TCP segment
(so a scan reads the port as *closed* and a `connect` reports *refused*), or an
**ICMP destination-unreachable** otherwise (`createIcmpDestUnreachable`,
`frame.ts`). The response goes back out the ingress; on the transparent firewall
it stands in for the target (src = the intended destination), on a router it
comes from the ingress interface. `--reject-with` parses for fidelity; the
response type follows the protocol.

## Routers are firewalls too

netfilter is always present on a router (a Linux box routing packets), so the
**router terminal accepts the same `iptables` commands** (privileged mode) on
two chains, via the shared engine in `src/terminal/iptables.ts`:

- **INPUT** — traffic addressed to the router itself, evaluated before the
  self-IP handling (e.g. drop pings *to* the gateway while still routing).
- **FORWARD** — routed traffic, evaluated after the routing decision (like
  netfilter), before NAT translation.

An empty ruleset with ACCEPT policies is a pass-through — no enable toggle
needed (this deliberately differs from the switches' managed/unmanaged split:
unmanaged switches are a distinct device class; un-firewalled Linux routers
are not). The transparent firewall device remains FORWARD-only.

## How it fits

`processAtFirewall` is dispatched from the engine's per-device step (alongside
`processAtComputer/Switch/Router`). It uses `linkedPortsFor` to forward an
accepted frame to every linked port except the ingress one (so a 2-port firewall
is a filtering pass-through). The inspector's `renderFirewallControls` panel
(routers: INPUT + FORWARD; firewall: FORWARD) lists each rule (deletable), a
per-chain default-policy select, and an add-rule form — target / protocol /
**connection-state** / src / dst / dport — writing the same `config.rules` the
iptables CLI does. Powered-off firewalls drop everything.


## `ruleToIptables` — the parser's inverse

`terminal/iptables.ts` also exports **`ruleToIptables(rule)`**, which renders one `FirewallRule` as an `iptables -A CHAIN … -j TARGET` line that `runIptablesCommand` re-parses to the same rule (`-p`, `-s`, `-d`, `--icmp-type`, `--dport`, `-m state --state A,B`, `--reject-with`). The script export replays a device's netfilter state through it, `iptables-save`-style — a DROP policy and its allow-list used to be dropped from the export entirely, so a replayed firewall came back as an empty ACCEPT. The formatter and the parser live in the same module so they stay in step; `tests/firewall.test.ts` round-trips every field through both.


## The CLI validates what it stores

`parseFirewallRule` refuses a `-s`/`-d` that is not an IPv4 address or CIDR (`host/network "…" not found`, as iptables says), a `--dport` outside 1–65535, and `--icmp-type` without `-p icmp`. Each used to be accepted with "Appended", listed by `-L`, persisted — and never able to match a packet. The inspector's add-rule form already validated; the CLI the firewall scenarios are taught through did not.


## Reads do not write

`runIptablesCommand` no longer defaults every chain's policy into `config.policy` (and `rules` into `config.rules`) on every command: `iptables -L` used to persist `policy: { forward: "accept", … }` noise into the JSON payload. Mutating operations materialise only the fields they touch; `evaluateFirewall` already treats a missing policy as ACCEPT.
