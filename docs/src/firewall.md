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
  `Firewall ACCEPT/DROP …` in the sim log.
- **CLI** — `terminal.ts`: `runFirewallTerminalCommand` parses an iptables
  subset; `showFirewallRules` renders `iptables -L`.

## Data model (`types.ts`)

```ts
FirewallRule  = { chain, target: accept|drop|reject, protocol?, src?, dst?, icmpType?, dport? }
FirewallConfig = { ethernetPorts, rules: FirewallRule[], policy: { forward: accept|drop } }
```

Normalised by `normaliseFirewallRules` / the firewall branch of
`normaliseDeviceConfig` (`normalise.ts`). Rules round-trip through config
export/import like any other device config.

## iptables CLI (FORWARD chain)

```
iptables -L [FORWARD] [--line-numbers]          list rules + policy
iptables -A FORWARD [match...] -j TARGET        append a rule
iptables -I FORWARD [pos] [match...] -j TARGET  insert a rule
iptables -D FORWARD <rulenum>                   delete rule N
iptables -P FORWARD ACCEPT|DROP                 default policy
iptables -F [FORWARD]                           flush rules
  matches: -s <ip/cidr>  -d <ip/cidr>  -p icmp|udp|all  --icmp-type <t>
  targets: ACCEPT  DROP  REJECT
```

Scriptable via the console: `cli <fw> iptables -A FORWARD -p icmp -j DROP`.

## Scope (what filters today)

Matching covers **src/dst IP (CIDR), protocol (`icmp`/`tcp`/`udp`/`all`), ICMP
type, and TCP destination port** (`-p tcp --dport 80` — exercised by the
`nc`/`connect` TCP traffic generator). REJECT behaves like DROP for now (no
ICMP-unreachable reply). See `FUTURE_PLANS.md` for stateful filtering and the
plan to let **routers** be configured as routing firewalls (reusing this rule
engine on the INPUT/FORWARD path, like switches' managed mode).

## How it fits

`processAtFirewall` is dispatched from the engine's per-device step (alongside
`processAtComputer/Switch/Router`). It uses `linkedPortsFor` to forward an
accepted frame to every linked port except the ingress one (so a 2-port firewall
is a filtering pass-through). The inspector shows a read-only rule list
(`renderFirewallRules`) + the FORWARD policy; rules are edited through the
iptables terminal. Powered-off firewalls drop everything.
