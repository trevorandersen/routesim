/**
 * Likely-cause hints — the *Failure is a lesson* principle, one step past
 * "Why?". The "Why?" data says what HAPPENED ("R1: No route to 192.168.2.10 —
 * dropping", "ARP for 192.168.1.254 got no reply"); this says what is most
 * likely WRONG ("No device has PC-A's default gateway address 192.168.1.254").
 *
 * It is a nearest-cause probe over a failed flow: a short, ordered list of
 * checks — the origin's own state, name resolution, what the run's log says
 * decisively, then the addressing a silent failure points to (gateway, target,
 * VLAN, the reply's way back). The first that fits is the hint.
 *
 * Two rules keep it honest:
 *   - Name the cause, not the answer. "PC-A's default gateway 192.168.1.254
 *     belongs to no device" — never "set it to 192.168.1.1".
 *   - Say nothing rather than repeat or guess. Where the failure already names
 *     its cause and remedy (an unauthenticated port, a failed MACsec link, a
 *     broadcast storm) there is no hint, and where no probe fits there is none.
 *
 * Reads the live network; changes nothing.
 */
import type { Device, SimLogEntry } from "./types";
import { state } from "./state";
import { linksFor, isPhysicalLink, routerInterfacesWithNames } from "./devices";
import { getVlanForDevice, l2Reachable, hostnameToIp } from "./simulation";
import { normaliseStaticRoutes } from "./normalise";
import { isValidIpv4, sameSubnet, prefixOf, networkOf } from "./utils";
import { isHost } from "./device-registry";

export interface FailedFlow {
  from: Device;
  target: string;                       // an IPv4 address, or a name to resolve
  kind: "ping" | "tcp" | "http" | "dns" | "dhcp";
  port?: number | null;
  refusal?: string | null;              // the builder's refusal, when no run happened
  log?: readonly SimLogEntry[];         // the failed run's log…
  diagnosis?: readonly string[];        // …and its post-mortem
  resolvedIp?: string | null;           // what a name resolved to, if it did
  refused?: boolean;                    // the TCP connect was answered with a RST
}

// Who holds an address: a host's NIC, or a router interface (cabled or not).
interface Owner { device: Device; ifaceName?: string; cabled: boolean; vlanTag?: number | null }

function ownerOf(ip: string): Owner | null {
  for (const device of state.devices) {
    if (device.type === "router") {
      for (const iface of routerInterfacesWithNames(device)) {
        if (iface.config.ipv4Address === ip) return { device, ifaceName: iface.name, cabled: !!iface.peer, vlanTag: iface.config.vlanTag ?? null };
      }
    } else if (device.config?.ipv4Address === ip) {
      return { device, cabled: linksFor(device.id).some(isPhysicalLink) };
    }
  }
  return null;
}

const subnetOf = (device: Device) => networkOf(device.config!.ipv4Address!, prefixOf(device.config));
const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
const onLink = (device: Device, ip: string) => !!device.config?.ipv4Address && sameSubnet(device.config.ipv4Address, ip, prefixOf(device.config));

// ── The origin itself ────────────────────────────────────────────────────────

function originCause(flow: FailedFlow): string | null {
  const { from } = flow;
  if (from.poweredOff) return `${from.name} is powered off.`;
  if (!linksFor(from.id).some(isPhysicalLink)) {
    return from.type === "laptop" ? `${from.name} is not associated with an access point.` : `${from.name} is not cabled to anything.`;
  }
  if (flow.kind !== "dhcp" && !from.config?.ipv4Address) return `${from.name} has no IP address.`;
  return null;
}

// ── DHCP: who could have answered? ───────────────────────────────────────────

function dhcpCause(from: Device): string | null {
  const reachable = (other: Device) => other.id !== from.id && !other.poweredOff && l2Reachable(from.id, other.id, null);
  const servers = state.devices.filter(d => d.type === "server" && reachable(d));
  for (const server of servers) {
    const config = server.config || {};
    if (config.dnsmasqRunning === false) return `dnsmasq is stopped on ${server.name}, so it is not answering DHCP.`;
    if (!config.dhcpRangeStart || !config.dhcpRangeEnd) return `${server.name} has no dhcp-range configured, so it leases no addresses.`;
    if (!config.ipv4Address) return `${server.name} has no IP address of its own, so it cannot serve DHCP.`;
  }
  const routers = state.devices.filter(d => d.type === "router" && reachable(d));
  if (!servers.length && routers.length && !routers.some(r => routerInterfacesWithNames(r, true).some(i => i.config.ipv4Address && i.peer && l2Reachable(from.id, i.peer.id, null)))) {
    return `${routers[0].name}'s interface on ${from.name}'s segment has no address, so it cannot lease any.`;
  }
  if (!servers.length && !routers.length) return `No DHCP server is on ${from.name}'s segment.`;
  return null;
}

// ── Name resolution ──────────────────────────────────────────────────────────

// Returns a cause, or the address the name resolves to (so the caller can go
// on to ask whether THAT is reachable), or null when resolution is not the story.
function resolutionCause(flow: FailedFlow): { cause?: string; ip?: string } {
  const { from, target } = flow;
  const nameserver = from.config?.dnsServerIp;
  if (!nameserver) return { cause: `${from.name} has no nameserver configured, so it cannot look up ${target}.` };
  const server = ownerOf(nameserver);
  if (!server) return { cause: `${from.name}'s nameserver ${nameserver} is an address no device has.` };
  if (server.device.type !== "server") return { cause: `${from.name}'s nameserver ${nameserver} is ${server.device.name}, which runs no DNS service.` };
  if (server.device.config?.dnsmasqRunning === false) return { cause: `dnsmasq is stopped on ${server.device.name}, so it answers no DNS queries.` };
  const record = (server.device.config?.dnsRecords || []).find(r => r.name === target.toLowerCase());
  const answer = flow.resolvedIp ?? record?.ip ?? hostnameToIp(target);
  if (!answer) return { cause: `${server.device.name} has no record for ${target}.` };
  if (!ownerOf(answer)) {
    return { cause: `${target} resolves to ${answer}, an address no device has${record ? ` — ${server.device.name}'s record for it is wrong` : ""}.` };
  }
  return { ip: answer };
}

// What a DNS server's record says, for a lookup that resolved to the wrong address.
export function wrongRecordCause(from: Device, name: string, resolvedIp: string): string | null {
  const server = from.config?.dnsServerIp ? ownerOf(from.config.dnsServerIp) : null;
  if (!server) return null;
  const record = (server.device.config?.dnsRecords || []).find(r => r.name === name.toLowerCase());
  return record ? `${server.device.name}'s record for ${name} points at ${resolvedIp}.` : null;
}

// ── What the run's log says decisively ───────────────────────────────────────

function logCause(flow: FailedFlow, targetIp: string): string | null {
  const targetOwner = ownerOf(targetIp);
  for (const entry of flow.log || []) {
    if (entry.kind !== "sim-drop") continue;
    const text = entry.action;
    let m: RegExpMatchArray | null;
    if ((m = text.match(/^No route to (\S+) on the internet/))) {
      return isPrivate(m[1])
        ? `${m[1]} is a private address: the internet cannot route to it.`
        : `No router on the internet owns ${m[1]}.`;
    }
    if ((m = text.match(/^No route to (\S+)/))) {
      const network = targetOwner && !isHostOnLinkOnly(targetOwner) ? ` (${describeNetwork(m[1])})` : "";
      return `${entry.deviceName} has no route to ${m[1]}${network}.`;
    }
    if ((m = text.match(/^Firewall (DROP|REJECT) .*\(([A-Z]+)/))) {
      return `${entry.deviceName}'s ${m[2]} rules ${m[1] === "DROP" ? "drop" : "reject"} this flow.`;
    }
    if ((m = text.match(/^Cannot (?:reply to|answer) (\S+) — no route \(no default gateway\)/))) {
      return isPrivate(m[1]) && !isPrivate(targetIp)
        ? `${entry.deviceName} was sent the private address ${m[1]} and has no route back to it — no router on the way is translating (NAT) that address.`
        : `${entry.deviceName} has no default gateway, so its reply to ${ownerOf(m[1])?.device.name ?? m[1]} cannot leave its subnet.`;
    }
    if (/no service listens on this port of the router/.test(text)) {
      return `${entry.deviceName} itself has nothing on that port, and no port-forward sends it on to an inside server.`;
    }
    if (/no web service/.test(text)) return `${entry.deviceName}'s web service is off.`;
    if (/ is powered off — /.test(text)) return `${entry.deviceName} is powered off.`;
    if (/dnsmasq is not running/.test(text)) return `dnsmasq is stopped on ${entry.deviceName}.`;
    if (/runs no DNS service/.test(text)) return `${flow.from.name}'s nameserver is ${entry.deviceName}, which runs no DNS service.`;
    if (/TTL expired/.test(text) && entry.deviceName) {
      return `The packet circled until its TTL ran out at ${entry.deviceName} — two routers each send it back toward the other (a routing loop).`;
    }
  }
  // A router that ARPed for a static route's next hop and heard nothing.
  for (const line of flow.diagnosis || []) {
    const m = line.match(/^(.+?): ARP for (\S+) got no reply .*next hop/);
    const router = m && state.devices.find(d => d.name === m[1] && d.type === "router");
    if (!m || !router) continue;
    const route = normaliseStaticRoutes(router.config?.staticRoutes || []).find(r => r.nextHop === m[2]);
    if (route && !ownerOf(m[2])) return `${router.name}'s static route to ${route.network} points at next hop ${m[2]}, an address no device has.`;
  }
  return null;
}

const isHostOnLinkOnly = (owner: Owner) => !owner.device.config?.ipv4Address && owner.device.type !== "router";
function describeNetwork(ip: string): string {
  const owner = ownerOf(ip);
  if (owner && owner.device.type !== "router" && owner.device.config?.ipv4Address) return `${owner.device.name}'s network ${subnetOf(owner.device)}`;
  return "that network";
}

// ── The addressing a silent failure points to ────────────────────────────────

function gatewayCause(host: Device, toward: string, forReply = false): string | null {
  const gateway = host.config?.gatewayIpv4Address;
  const consequence = forReply ? `so its reply to ${toward} cannot leave its subnet` : `so it cannot send anything off its own subnet (${subnetOf(host)})`;
  if (!gateway) return `${host.name} has no default gateway, ${consequence}.`;
  if (!onLink(host, gateway)) return `${host.name}'s default gateway ${gateway} is not on its own subnet (${subnetOf(host)}) — a host can only use a gateway it can reach directly.`;
  const owner = ownerOf(gateway);
  if (!owner) return `No device has ${host.name}'s default gateway address ${gateway}${forReply ? `, ${consequence}` : ""}.`;
  if (!owner.cabled) return `${host.name}'s default gateway ${gateway} is ${owner.device.name}'s ${owner.ifaceName ?? "interface"}, which has no cable.`;
  if (owner.device.type !== "router" && !owner.device.config?.ipForward) return `${host.name}'s default gateway ${gateway} is ${owner.device.name}, which does not route.`;
  return vlanCause(host, owner, `its gateway ${gateway}`);
}

// Two ends that are wired into the same switched network but sit in different VLANs.
function vlanCause(host: Device, other: Owner, what: string): string | null {
  if (other.device.id === host.id || !l2Reachable(host.id, other.device.id, null)) return null;   // not a VLAN question
  const vlan = getVlanForDevice(host.id);
  if (other.device.type === "router") {
    if (other.vlanTag != null && other.vlanTag !== vlan) return `${host.name} is in VLAN ${vlan}, but ${what} is ${other.device.name}'s sub-interface for VLAN ${other.vlanTag}.`;
    return l2Reachable(host.id, other.device.id, other.vlanTag ?? vlan) ? null
      : `${host.name} is in VLAN ${vlan}, which does not reach ${other.device.name} — the switch port toward it does not carry that VLAN.`;
  }
  const theirs = getVlanForDevice(other.device.id);
  if (theirs !== vlan) return `${host.name} (VLAN ${vlan}) and ${other.device.name} (VLAN ${theirs}) are in different VLANs, so they cannot reach each other directly.`;
  return l2Reachable(host.id, other.device.id, vlan) ? null
    : `${host.name} and ${other.device.name} are both in VLAN ${vlan}, but no switch path between them carries it.`;
}

function addressingCause(flow: FailedFlow, targetIp: string): string | null {
  const { from } = flow;
  const target = ownerOf(targetIp);
  if (!onLink(from, targetIp)) {
    const viaGateway = gatewayCause(from, targetIp);
    if (viaGateway) return viaGateway;
  }
  if (!target) return `No device has the address ${targetIp}.`;
  if (target.device.poweredOff) return `${target.device.name} is powered off.`;
  if (!target.cabled) return target.ifaceName ? `${targetIp} is ${target.device.name}'s ${target.ifaceName}, which has no cable.` : `${target.device.name} is not cabled to anything.`;
  if (onLink(from, targetIp)) return vlanCause(from, target, target.device.name);
  // Off-subnet: the request may well arrive — can the reply get back?
  if (isHost(target.device.type) && from.config?.ipv4Address && !onLink(target.device, from.config.ipv4Address)) {
    return gatewayCause(target.device, from.name, true);
  }
  return null;
}

// ── The probe ────────────────────────────────────────────────────────────────

export function likelyCause(flow: FailedFlow): string | null {
  const origin = originCause(flow);
  if (origin) return origin;
  // A refusal that carries its own reason — "Network is unreachable (… never
  // authenticated …)" — has already named the cause, and usually the remedy.
  // (The terse ones — no link, no gateway — are left for the probes below to
  // state properly.)
  if (flow.refusal && /(?:unreachable|could be reached) \((?!no link\)|no default gateway\)|gateway not on source subnet\))[^)]+\)/.test(flow.refusal)) return null;
  if (flow.kind === "dhcp") return dhcpCause(flow.from);

  let targetIp = flow.target;
  if (!isValidIpv4(targetIp)) {
    const named = state.devices.find(d => d.name.toLowerCase() === targetIp.toLowerCase());
    if (named && !flow.from.config?.dnsServerIp && !named.config?.ipv4Address) return `${named.name} has no IP address.`;
    const resolved = resolutionCause(flow);
    if (resolved.cause) return resolved.cause;
    if (flow.kind === "dns") return null;         // it resolved; a wrong answer is the caller's to describe
    targetIp = resolved.ip!;
  }
  const decisive = logCause(flow, targetIp);
  if (decisive) return decisive;
  // A failure that already explains itself (a data gate, a storm) needs no guess on top.
  if ((flow.log || []).some(e => e.kind === "sim-drop" && /MACsec|802\.1X|spanning tree|administratively down|never authenticated|switching loop/.test(e.action))) return null;
  const addressing = addressingCause(flow, targetIp);
  if (addressing) return addressing;
  if (flow.refused && flow.port != null) return `Nothing listens on port ${flow.port} at ${ownerOf(targetIp)?.device.name ?? targetIp}.`;
  return null;
}

// ── Outside a scenario ───────────────────────────────────────────────────────

// How a hint reads wherever it is printed as a line of its own (a device
// terminal, the console): the label carries the meaning, not the colour.
export const hintLine = (cause: string) => `Likely cause: ${cause}`;

// A refusal that reports a SYMPTOM — unreachable, cannot resolve — is worth a
// probe. One that already is the cause ("eth0 has no IPv4 address", "invalid
// port") is not: a hint under it would only repeat it, or guess past it.
const SYMPTOM = /unreachable|cannot resolve|unknown host|no route to nameserver|could be reached/i;

// The hint for a flow its builder refused to start, as typed in a device
// terminal or the console. Null when there is nothing to add.
export function refusalHint(from: Device, target: string, kind: FailedFlow["kind"], port: number | null, refusal: string): string | null {
  if (!SYMPTOM.test(refusal)) return null;
  return likelyCause({ from, target, kind, port, refusal });
}

// The hint for a flow that ran and failed, from the run's own evidence.
export interface FailedRun { log?: readonly SimLogEntry[]; diagnosis?: readonly string[]; resolvedIp?: string | null; refused?: boolean; storm?: boolean }
export function runHint(from: Device, target: string, kind: FailedFlow["kind"], port: number | null, run: FailedRun): string | null {
  if (run.storm) return null;                       // the storm is the whole story, and says so
  if (!target && kind !== "dhcp") return null;
  return likelyCause({ from, target, kind, port, log: run.log, diagnosis: run.diagnosis, resolvedIp: run.resolvedIp, refused: run.refused });
}
