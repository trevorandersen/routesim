# hints.ts — likely-cause hints

The *Failure is a lesson* principle, one step past ["Why?"](explain.md). "Why?"
says what **happened** (`R1: No route to 192.168.2.10 — dropping`, `ARP for
192.168.1.254 got no reply`); a hint says what is most likely **wrong** (`No
device has PC-A's default gateway address 192.168.1.254.`).

## Two rules

- **Name the cause, not the answer.** "PC-A's default gateway 192.168.1.254
  belongs to no device" — never "set it to 192.168.1.1". The learner still has
  to work out the fix.
- **Say nothing rather than repeat or guess.** Where the failure already names
  its cause and remedy — an unauthenticated WiFi link, an 802.1X port, a failed
  MACsec link, a switching loop — there is no hint. Where no probe fits there is
  none either.

## The probe

`likelyCause(flow: FailedFlow): string | null` takes a failed flow (origin,
target, kind, and either the builder's refusal or the failed headless run's log
and diagnosis) and tries, in order — the first that fits is the hint:

1. **The origin itself** — powered off, no cable (a laptop: not associated),
   no IP address.
2. **DHCP** (`dhcp` flows) — is anything on the segment able to lease: a
   stopped dnsmasq, a server with no `dhcp-range` or no address, a router
   whose interface there is unaddressed, or no server at all.
3. **Name resolution** (a target that is not an address) — no nameserver, a
   nameserver address nobody has, a nameserver that is not a DNS server, a
   stopped dnsmasq, no record, or a record that resolves to an address no
   device has. Otherwise the probe carries on with the resolved address.
4. **What the log says decisively** — a router with no route (naming the
   target's network), a filter chain dropping or rejecting the flow, a reply
   that cannot get back (a missing gateway, or — a private source seen by a
   public host — no NAT on the way), a router port with no service and no
   port-forward, a web service that is off, a powered-off device on the path,
   a private address the internet cannot route, a TTL that ran out in a
   routing loop, and a static route whose next hop no device has.
5. **The addressing a silent failure points to** — the origin's gateway
   (missing; off its subnet; an address nobody has; a router port with no
   cable; a host that does not route), the target (nobody has the address;
   powered off; uncabled), a **VLAN** mismatch between two ends that are wired
   into one switched network (`l2Reachable` with and without the VLAN,
   `getVlanForDevice`, and a router sub-interface's tag), and — for an
   off-subnet flow — the **target's** gateway, since the reply has to get back.
6. A **closed port** (the connect was answered with a RST).

`wrongRecordCause(from, name, resolvedIp)` covers a lookup that resolved, but
to the wrong address.

It reads the live network and changes nothing.

## Where it shows

`CheckResult.hint` (`scenarios.ts`): the evaluator probes while the network is
as the failed run left it — in `run()` for a flow that ran, `refusedFlow()` for
one its builder refused. An isolation check that fails because the flow got
through says `Nothing on <device> stops this flow yet.` The goal banner prints
it under the reasons as **Likely cause:** and `scenario check` as
`    likely cause: …`.

**Outside a scenario** the same probe follows a flow typed by hand — two small
wrappers keep the callers honest:

- **`runHint(from, target, kind, port, run)`** — a flow that ran and failed,
  read from the run's own log and post-mortem. A storm gets none (it is the
  whole story, and says so). `finishSimulation` (engine.ts) prints it as the
  last line in the origin's terminal after a failed animated `ping` / `nc` /
  `curl` / `nslookup` / `dhcp` — under the result and the post-mortem — as a
  line of kind `hint` (`.terminal-line.hint`; the `Likely cause:` label says
  what it is, the colour only sets it apart). The console's `run ping|connect|
  http|resolve|dhcp` prints it under the diagnosis, and `runTraceroute` sets
  `TracerouteResult.hint` from the last probe for a trace that never arrives
  (not for a short trace that merely ran out of hops).
- **`refusalHint(from, target, kind, port, refusal)`** — a flow its builder
  refused to start. Only a refusal that reports a **symptom** is probed
  (`Network is unreachable (no default gateway)`, `cannot resolve`, `unknown
  host`); one that already is the cause (`eth0 has no IPv4 address`, `invalid
  port`) gets nothing, since a hint under it would repeat it or guess past it.
  The host shell (`refuseFlow` in terminal/host.ts) and the console (`refused`
  in commands.ts) print it under the refusal.

`hintLine(cause)` is the one place the `Likely cause: …` wording lives.

## Tests

`tests/hints.test.ts`: each troubleshooting scenario's hint names the fault that
was planted (and never spells out the fix); the build-it scenarios name what is
still missing; the self-explaining failures get no hint; after its reference
solution every built-in scenario passes with no hint or reason left; and each
probe is exercised one fault at a time on a small routed network. Outside a
scenario: a failed animated `ping`, `nc`, `curl`, `nslookup` and `dhcp` in a
device terminal end with the hint (and a working ping with none); a refusal that
reports a symptom is explained while one that is already the cause, or names
its own (a shut cable), is left alone; and the console's `run`, `traceroute` and
refusals carry it.
