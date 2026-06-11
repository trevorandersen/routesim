# DNS & the server device — dnsmasq, name resolution, server-side DHCP

The **server** is a host (same L2/L3 endpoint behaviour as a computer: IP,
prefix, gateway, MAC, ARP cache, the TCP listener model) that also runs
**dnsmasq** — the lightweight open-source daemon that serves both DNS and
DHCP. That pairing is the whole point: one device, two services, configured
the way a real machine is.

## Configuring dnsmasq (server terminal)

The server terminal is a Linux shell (everything the PC terminal offers) plus
the dnsmasq idiom — append directives to the conf file, manage the daemon with
systemctl:

```
root@SRV-1:~# cat /etc/dnsmasq.conf
root@SRV-1:~# echo address=/web.corp/192.168.1.80 >> /etc/dnsmasq.conf
root@SRV-1:~# echo dhcp-range=192.168.1.100,192.168.1.200 >> /etc/dnsmasq.conf
root@SRV-1:~# echo dhcp-option=option:router,192.168.1.1 >> /etc/dnsmasq.conf
root@SRV-1:~# systemctl stop dnsmasq      (status / start / restart)
```

- `address=/name/ip` adds a DNS A-record; appending a line with an existing
  name **replaces** it (matching what editing the file achieves).
- `dhcp-range=start,end` is what turns DHCP **on** — exactly like the real
  daemon. No range, no DHCP.
- `dhcp-option=option:router,<ip>` sets the gateway handed to clients; the
  default is the server itself (dnsmasq's own default).
- `systemctl stop dnsmasq` stops **both** services — one daemon serves both.
- Simplification (documented deviation): conf lines take effect immediately;
  the real daemon must be restarted to re-read its config. Unknown names
  answer **NXDOMAIN** (the simulator has no upstream to forward to, as if
  `no-resolv` with no upstream servers).

The inspector mirrors all of this (records with add/remove, the range, the
router option, daemon state, live leases).

## Resolution on hosts

A host resolves names via its **/etc/resolv.conf** nameserver — set in the
terminal (`echo nameserver 192.168.1.53 > /etc/resolv.conf`), the inspector
("DNS nameserver"), the console (`nameserver PC-A 192.168.1.53`), or learned
from DHCP (option 6).

`ping web.corp`, `nc -z web.corp 80`, and `traceroute web.corp` all
**resolve first, then act**: the host sends a real UDP/53 query frame
(cyan dot) to its nameserver — ARP-ing the next hop, crossing switches,
routers, firewalls, and NAT like any other IPv4 packet — and only when the
answer arrives does it launch the ICMP/TCP flow toward the resolved address.
`nslookup <name>` runs the lookup alone. Pinging a **device name** (e.g.
`ping PC-B`) still works without DNS — that is the /etc/hosts-style
convenience — but a name that isn't a device requires a nameserver.

### The wire format (`DnsPayload`)

One question per query, one answer per response, carried in
`Ipv4Payload` with protocol 17:

```ts
{ type: "dns", op: "query" | "response", id, name, address: string | null }
```

`address: null` in a response = **NXDOMAIN** (red dot). The transaction `id`
also serves as the PAT flow identifier, so DNS works through a NAT router
(`protocol: "udp"` entries in `show ip nat translations`). Firewall rules
match it as UDP (`iptables … -p udp -j DROP` blocks resolution).

## Engine flow

- `buildResolveEvents(source, name, then, port)` (simulation.ts) validates the
  resolver config and emits the query (deferred behind ARP when needed). The
  returned setup carries `dns: { name, then, port }` — `then` is the follow-on
  flow (`"ping"`/`"tcp"`/`null`).
- `processAtServer` (engine.ts) answers queries addressed to the server when
  dnsmasq is running (with the same return-route guard as any host — a server
  that can't route back stays silent), then falls through to
  `processAtComputer` for everything else.
- When the origin receives the response, `buildFollowOnFrames` launches the
  resolved flow; `sim.dnsName`/`dnsResolvedIp`/`resolveThen` track the state,
  and `SimResult.resolvedIp` reports it (mode `"dns"` succeeds iff resolved).

## DHCP from the server

With a `dhcp-range`, the server answers Discover/Request on its segment:
addresses allocate sequentially from the range (skipping statics and existing
leases), and the ACK carries the subnet mask, the router option, and **the
server itself as nameserver (option 6)** — so a freshly-leased client can ping
by name with zero manual configuration (`server-dhcp` scenario).

Two servers on one segment behave correctly: the client takes the **first
offer** and its Request names that server; both router and server DHCP ignore
Requests addressed to someone else.

## Limits (v1)

- A-records only — no reverse lookups, CNAME, MX, or upstream forwarding.
- One nameserver per host (no resolver fallback list).
- ICMP errors don't carry the original DNS payload (same modelling limit as
  NAT + traceroute).

Tests: `tests/dns.test.ts` (resolution, resolve-then-act, NAT/firewall
interplay, server DHCP, round-trips); scenarios `dns-service`,
`troubleshoot-dns`, `server-dhcp` with reference solutions in
`tests/scenarios.test.ts`; benchmark `processAtServer — DNS, 50 records`
(p99 budget 100 µs).
