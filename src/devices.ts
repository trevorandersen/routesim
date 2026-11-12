import type { PortOption, Device, Link, DeviceType, DeviceConfig, NamedRouterIface, MutationResult, LinkResult } from "./types";
import { state, sync, pushUndo, networkSnapshot, dropTerminalSessions, resetCaptureState, linksChanged } from "./state";
import { dom } from "./dom";
import { deviceSize, defaultDeviceConfig, ensureConfig, normaliseRouterInterfaces, normalisePortVlans, normalisePortModes } from "./normalise";
import { clampPortCount, clampApPortCount, clampRouterPortCount, escapeHtml, randomMac, isValidHostname, MAX_PHYSICAL_PORT, deriveMac, normaliseMacAddress, clampFirewallPortCount } from "./utils";
import { quoteArg } from "./tokenize";
import { DEVICE_SPECS, USER_ADDABLE_TYPES, freshNameCounters, hasSingleNic, isHost, isDot1xSupplicant, defaultPortCount } from "./device-registry";

// The hostname role lives in the device registry; re-exported for the inspector.
export { hasHostname } from "./device-registry";

// Set a CLI device's hostname, which IS its canvas name. Validates against the
// RFC-1123 label rule, pushes undo, and re-syncs the panel/terminal/canvas.
// Returns an error message on a bad name, or null on success — the realistic
// `hostname`/`hostnamectl`/`/etc/hostname` CLI paths and the console all share it.
export function applyHostname(device: Device, name: string): string | null {
  const next = String(name || "").trim();
  if (!isValidHostname(next))
    return `Invalid hostname '${name}': use letters, digits and hyphens (1–63 chars, no leading/trailing hyphen).`;
  pushUndo();
  device.name = next;
  sync().syncPanel();
  sync().syncTerminal();
  sync().render();
  return null;
}

export function addDevice(type: DeviceType, x: number, y: number, name?: string): Device {
  pushUndo();
  const device: Device = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    type,
    name: name || nextName(type),
    x,
    y,
    width: deviceSize(type).width,
    height: deviceSize(type).height,
    config: defaultDeviceConfig(type)
  };
  // A new host gets a NIC MAC so it can communicate immediately.
  if (isHost(type)) device.config.macAddress = randomMac();
  state.devices.push(device as any);
  state.selectedId = device.id;
  sync().syncPanel();
  sync().render();
  return device;
}

// Tools that place a device on a canvas click: every user-addable type, plus the
// UI variants placeToolDevice resolves to a real type + preset ("managed-switch",
// "border-router", the server role presets) — not distinct device types.
export const PLACEMENT_TOOLS = new Set<string>([...USER_ADDABLE_TYPES, "managed-switch", "border-router", "dns-server", "dhcp-server", "radius-server", "web-server"]);

// The Server tool group places a `server` pre-configured for a role. They are all
// the same `server` device type — so the inspector, frame processing, and
// serialisation are shared — and a preset only seeds the role's (empty) config
// plus a role-specific name prefix. The plain "server" tool keeps the type
// default (DNS + DHCP via dnsmasq). Mirrors the managed-switch variant.
interface ServerPreset { namePrefix: string; config: () => DeviceConfig }
export const SERVER_PRESETS: Record<string, ServerPreset> = {
  "dns-server": { namePrefix: "DNS", config: () => ({ dnsmasqRunning: true, dnsRecords: [] }) },
  "dhcp-server": { namePrefix: "DHCP", config: () => ({ dnsmasqRunning: true, dnsRecords: [] }) },
  "radius-server": { namePrefix: "RAD", config: () => ({ dnsmasqRunning: false, radius: { users: [] } }) },
  "web-server": { namePrefix: "WEB", config: () => ({ dnsmasqRunning: false, openPorts: [80], httpEnabled: true }) },
};

// Next free "<PREFIX>-<n>" name across all devices. Preset prefixes aren't in
// DEVICE_SPECS, so they can't use the per-type nameCounters.
function nextNameForPrefix(prefix: string): string {
  const p = `${prefix}-`;
  const highest = state.devices
    .filter(d => d.name.startsWith(p))
    .map(d => Number(d.name.slice(p.length)))
    .filter(Number.isFinite)
    .reduce((max, v) => Math.max(max, v), 0);
  return `${prefix}-${highest + 1}`;
}

// Place the device for a placement tool, resolving UI variants to real types:
// "managed-switch" is a switch with management on; the server presets seed a
// role's config onto a plain server.
export function placeToolDevice(tool: string, x: number, y: number): Device {
  if (tool === "managed-switch") {
    const device = addDevice("switch", x, y);
    device.config = device.config || {};
    (device.config as any).managed = true;
    sync().syncPanel();
    sync().render();
    return device;
  }
  // A border/edge router — a `router` with the role flag (the inside/outside NAT
  // marks and the firewall are then yours to add). The plain "router" tool stays
  // an internal/core router (no role). Mirrors the managed-switch variant.
  if (tool === "border-router") {
    const device = addDevice("router", x, y, nextNameForPrefix("Border"));
    device.config = device.config || {};
    (device.config as any).role = "border";
    sync().syncPanel();
    sync().render();
    return device;
  }
  // A server role preset (dns/dhcp/radius/web). The plain "server" tool isn't in
  // the table, so it falls through to the default addDevice below.
  const preset = SERVER_PRESETS[tool];
  if (preset) {
    const device = addDevice("server", x, y, nextNameForPrefix(preset.namePrefix));
    device.config = { ...device.config, ...preset.config() } as DeviceConfig;
    sync().syncPanel();
    sync().render();
    return device;
  }
  return addDevice(tool as DeviceType, x, y);
}

// Hosts and the IDS sensor model a single NIC (the registry's singleNic role), so
// they take at most one cable. Returns the offending device's name when fully
// cabled, else null. (Multi-NIC hosts are a future option — see ROADMAP.)
function hostNicTaken(deviceId: string): string | null {
  const device = getDevice(deviceId);
  if (!device || !hasSingleNic(device.type)) return null;
  // Count ANY link, including a hidden one: a host collapsed into a LAN still
  // holds its single cable, so it must not be linkable again (the console `link`
  // command resolves by name regardless of collapse state).
  const cabled = state.links.some(l => l.from === deviceId || l.to === deviceId);
  return cabled ? device.name : null;
}

// A laptop has a single wireless NIC and may ONLY associate to an access point;
// that association is a `wireless` link. Returns a rejection reason to show the
// user (or null) plus whether the pair forms a wireless association.
export function classifyLink(fromId: string, toId: string): { reject: string | null; wireless: boolean } {
  const a = getDevice(fromId), b = getDevice(toId);
  if (!a || !b) return { reject: null, wireless: false };
  const aLap = a.type === "laptop", bLap = b.type === "laptop";
  const aAp = a.type === "access-point", bAp = b.type === "access-point";
  if (aLap && bLap) return { reject: "A laptop associates to an access point, not directly to another laptop.", wireless: false };
  if (aLap && !bAp) return { reject: `${a.name} is wireless — associate it to an access point.`, wireless: false };
  if (bLap && !aAp) return { reject: `${b.name} is wireless — associate it to an access point.`, wireless: false };
  // A laptop ↔ access-point pair: a wireless join, gated on a matching SSID and
  // (if the AP is secured) password — the same checks a real client makes.
  if ((aLap && bAp) || (bLap && aAp)) {
    const laptop = aLap ? a : b;
    const ap = aAp ? a : b;
    return { reject: wifiJoinReason(laptop, ap), wireless: true };
  }
  return { reject: null, wireless: false };
}

// Why a laptop can't even attempt to join an access point (null = it can). The
// SSID must match — you can't associate to a network you aren't looking for. A
// *wrong password* does NOT block the link: the association forms but stays
// unauthenticated (data is blocked and the WPA2 handshake fails), exactly like a
// real client that associates then fails the 4-way key exchange.
function wifiJoinReason(laptop: any, ap: any): string | null {
  const apSsid = (ap.config?.ssid || "").trim();
  const lapSsid = (laptop.config?.ssid || "").trim();
  if (!apSsid) return `${ap.name} has no SSID set — give it a network name first.`;
  if (lapSsid !== apSsid) {
    return `${laptop.name} is set to join "${lapSsid || "(none)"}", but ${ap.name} broadcasts "${apSsid}".`;
  }
  return null;
}

// Whether a wireless association is authenticated — open network, or the
// laptop's password matches the AP's. Computed live (no stored state), so it
// tracks password edits. A wired link is always "authenticated".
export function wifiLinkAuthenticated(link: any): boolean {
  if (!link?.wireless) return true;
  const a = getDevice(link.from), b = getDevice(link.to);
  const ap = a?.type === "access-point" ? a : b?.type === "access-point" ? b : null;
  const laptop = a?.type === "laptop" ? a : b?.type === "laptop" ? b : null;
  if (!ap || !laptop) return true;
  const apPassword = ap.config?.wifiPassword || "";
  return !apPassword || (laptop.config?.wifiPassword || "") === apPassword;
}

export type Dot1xPortMode = "auto" | "force-authorized" | "force-unauthorized";
export interface Dot1xPortInfo { sw: Device; peer: Device; mode: Dot1xPortMode; port: string }

// One end of a wired link as an 802.1X authenticator: `sw`'s port facing `peer`,
// or null when `sw` isn't a switch with port control. Port control is a
// property of the SWITCH PORT, whatever is plugged into it — a Kali box, a hub
// (and everything behind it), an access point or a router faces the same gate
// a PC does; one that can't (or doesn't) run a supplicant simply never
// authenticates. Cheap early-out (a switch with no portAuth map pays only a
// property read) so non-802.1X topologies don't hit the hot path.
function dot1xPortEnd(link: Link, sw: Device | undefined, peer: Device | undefined): Dot1xPortInfo | null {
  if (sw?.type !== "switch" || !sw.config?.portAuth || !peer) return null;
  const idx = linkedPortsFor(sw.id).findIndex((p: any) => p?.link?.id === link.id);   // linkedPortsFor can be sparse (null gaps)
  if (idx < 0) return null;
  const port = `Ethernet${idx + 1}`;
  return { sw, peer, mode: sw.config.portAuth[port] || "force-authorized", port };
}

// The 802.1X authenticator port on a wired link, or null when neither end is a
// switch port under port control. (A switch↔switch link reports the `from`
// end first; dot1xPortAuthorized checks both.)
export function dot1xLinkInfo(link: Link | null | undefined): Dot1xPortInfo | null {
  if (!link || link.wireless) return null;
  const a = getDevice(link.from), b = getDevice(link.to);
  return dot1xPortEnd(link, a, b) ?? dot1xPortEnd(link, b, a);
}

// The 802.1X port on `sw` that faces `peerId` — the authenticator's own view of
// the cable an EAPOL frame arrived on. Null when `sw` has no port control.
export function dot1xPortFacing(sw: Device | undefined, peerId: string | null | undefined): Dot1xPortInfo | null {
  if (!sw || !peerId) return null;
  const peer = getDevice(peerId);
  for (const link of linksFor(sw.id)) {
    if (link.wireless || (link.from !== peerId && link.to !== peerId)) continue;
    const end = dot1xPortEnd(link, sw, peer);
    if (end) return end;
  }
  return null;
}

// Whether one authenticator end lets data through. force-authorized (the
// default / no 802.1X) always passes; force-unauthorized never; "auto" passes
// only after a successful EAP exchange (stored on the link as dot1xAuthorized).
function dot1xEndAuthorized(link: Link, info: Dot1xPortInfo | null): boolean {
  if (!info || info.mode === "force-authorized") return true;
  if (info.mode === "force-unauthorized") return false;
  return !!link.dot1xAuthorized;
}

// The 802.1X-controlled end of this link that currently holds it closed, or
// null when every controlled port authorises it (both ends of a switch↔switch
// link may be under port control).
function dot1xBlockingEnd(link: Link | null | undefined): Dot1xPortInfo | null {
  if (!link || link.wireless) return null;
  const a = getDevice(link.from), b = getDevice(link.to);
  const aEnd = dot1xPortEnd(link, a, b);
  if (!dot1xEndAuthorized(link, aEnd)) return aEnd;
  const bEnd = dot1xPortEnd(link, b, a);
  return dot1xEndAuthorized(link, bEnd) ? null : bEnd;
}

// Whether every 802.1X-controlled port on this link currently authorises it.
export function dot1xPortAuthorized(link: Link | null | undefined): boolean {
  return dot1xBlockingEnd(link) === null;
}

// MACsec (802.1AE) state of a link, from each end's per-peer config. "secured" =
// both ends agree on a key; "failed" = a key/method mismatch, or a must-secure
// end facing a peer with no (or incompatible) MACsec; "open" = no MACsec in play
// (or a should-secure end falling back to plaintext). Two keying methods: a
// static pre-shared `cak` (both must match), or `derive` — keys bootstrapped
// from a successful 802.1X exchange on this link (MKA), so the link secures only
// once `link.dot1xAuthorized` is set. Live — tracks key edits and authentication.
export function macsecState(link: any): "open" | "secured" | "failed" {
  const a = getDevice(link?.from), b = getDevice(link?.to);
  const aCfg = a?.config?.macsec?.[link?.to];
  const bCfg = b?.config?.macsec?.[link?.from];
  if (!aCfg && !bCfg) return "open";
  if (aCfg && bCfg) {
    const mustEither = aCfg.mode === "must" || bCfg.mode === "must";
    if (aCfg.derive && bCfg.derive)       // 802.1X-derived keys: secured once the port has authenticated
      return link.dot1xAuthorized ? "secured" : (mustEither ? "failed" : "open");
    if (aCfg.derive || bCfg.derive)        // one end derives, the other a static PSK — incompatible
      return mustEither ? "failed" : "open";
    return aCfg.cak === bCfg.cak ? "secured" : "failed";   // matching pre-shared CAK
  }
  const cfg = aCfg || bCfg;            // only one end wants MACsec
  return cfg!.mode === "must" ? "failed" : "open";
}

// Why a link's MACsec is "failed", mirroring macsecState's branches — called
// only once macsecState has said so.
function macsecFailureDetail(link: Link): string {
  const a = getDevice(link.from), b = getDevice(link.to);
  const aCfg = a?.config?.macsec?.[link.to];
  const bCfg = b?.config?.macsec?.[link.from];
  if (aCfg && bCfg) {
    if (aCfg.derive && bCfg.derive) return "it keys from 802.1X and the port has not authenticated yet";
    if (aCfg.derive || bCfg.derive) return "one end derives its key from 802.1X, the other uses a static key";
    return "the two ends' pre-shared keys do not match";
  }
  const [strict, bare] = aCfg ? [a, b] : [b, a];
  return `${strict?.name ?? "one end"} requires MACsec but ${bare?.name ?? "its peer"} has none configured`;
}

// The console command a supplicant needs next: an identity first (`dot1x`
// refuses a host without one), then the exchange itself. The name is quoted the
// way the command line needs it, so a hostname with a space stays runnable.
function dot1xNextStep(peer: Device): string {
  const name = quoteArg(peer.name);
  return peer.config?.dot1x?.identity
    ? `run dot1x ${name} first`
    : `give it an identity with supplicant ${name} <identity> <password>, then run dot1x ${name}`;
}

// Why this link drops DATA frames right now, in the learner's words — or null
// when it carries data. The single data-path gate, behind all three chokepoints
// (l2Reachable / findFirstHop / the engine transit step), so a drop names its
// real cause instead of "no link": an administratively down cable, a
// spanning-tree alternate port (cut to break a loop), a WiFi association that
// never authenticated, an unauthorized 802.1X port, or a MACsec link that could
// not be secured. Auth/EAPOL/BPDU control frames bypass it (the transit step's
// `ctrl` set). The common open link returns null without building a string.
export function linkDataBlockReason(link: Link | null | undefined): string | null {
  if (!link) return null;
  if (link.shutdown) return `${linkName(link)} is administratively down, so it carries no traffic`;
  if (link.stpBlocked) return `${linkName(link)} is blocked by spanning tree — an alternate port, cut to break a switching loop`;
  if (link.wireless && !wifiLinkAuthenticated(link))
    return `${linkName(link)} never authenticated — the laptop's WiFi password does not match the access point's`;
  const port = dot1xBlockingEnd(link);
  if (port) {
    return port.mode === "force-unauthorized"
      ? `${port.sw.name} ${port.port} is 802.1X force-unauthorized, so it never carries data`
      : isDot1xSupplicant(port.peer.type)
        ? `${port.sw.name} ${port.port} is under 802.1X control and ${port.peer.name} has not authenticated — ${dot1xNextStep(port.peer)}`
        : `${port.sw.name} ${port.port} is under 802.1X control and ${port.peer.name} cannot authenticate (it is not an 802.1X supplicant)`;
  }
  if (macsecState(link) === "failed") return `${linkName(link)} failed MACsec — ${macsecFailureDetail(link)}`;
  return null;
}

// Boolean form of the gate: true = this link carries data right now.
export function linkAuthorizedForData(link: Link | null | undefined): boolean {
  return linkDataBlockReason(link) === null;
}

// Why a link from→to can't be created (null = allowed). Shared by addLink and
// the `link` console command so both reject — and explain — the same cases.
export function linkBlockReason(fromId: string, toId: string): string | null {
  if (fromId === toId) return "Cannot link a device to itself.";
  const exists = state.links.some(link =>
    (link.from === fromId && link.to === toId) || (link.from === toId && link.to === fromId));
  if (exists) return null; // re-linking is an idempotent no-op, not an error
  const { reject } = classifyLink(fromId, toId);
  if (reject) return reject;
  const taken = hostNicTaken(fromId) || hostNicTaken(toId);
  if (taken) return `${taken} has a single NIC and is already connected.`;
  return null;
}

// Cable two devices. Returns what happened instead of writing it to the status
// line: refused (and why), already linked, or made — with a warning for each
// requested port that could not be honoured (which, why, and where the cable
// went) and for a WiFi association that formed but cannot authenticate. Every
// front door (the Connect tool, the port picker, the `link` command, scripts,
// the API) shows the same result.
export function addLink(fromId: string, toId: string, fromPort?: number, toPort?: number): LinkResult {
  const from = getDevice(fromId), to = getDevice(toId);
  if (fromId === toId) return { ok: false, error: "Cannot link a device to itself.", warnings: [], created: false };
  if (!from || !to) return { ok: false, error: "No such device.", warnings: [], created: false };
  const existing = state.links.find(link =>
    (link.from === fromId && link.to === toId) || (link.from === toId && link.to === fromId)
  );
  if (existing) {
    // Re-linking is an idempotent no-op — but say so, and say when ports were
    // asked for that the existing cable does not sit on (they are not applied).
    state.linkStartId = null;
    linksChanged([]);
    sync().syncPanel();
    const warnings: string[] = [];
    const differs = (deviceId: string, requested: number | undefined) => {
      if (requested == null) return false;
      const name = linkPortName(existing, deviceId);
      return !name || Number(name.replace(/\D+/g, "") || 1) !== requested;
    };
    if (differs(fromId, fromPort) || differs(toId, toPort)) {
      const at = (device: Device) => `${device.name} ${linkPortName(existing, device.id) ?? "?"}`;
      warnings.push(`The requested ports were not applied: the cable stays on ${at(from)} ↔ ${at(to)} (unlink it first to move it).`);
    }
    return { ok: true, message: `${from.name} ↔ ${to.name} are already linked.`, warnings, link: existing, created: false };
  }
  const reason = linkBlockReason(fromId, toId);
  if (reason) {
    state.linkStartId = null;
    sync().render();
    return { ok: false, error: reason, warnings: [], created: false };
  }
  const { wireless } = classifyLink(fromId, toId);
  pushUndo();
  // Persist a port number only when the caller CHOSE it and it can be
  // honoured (the picker or `link A B 4 1`) — portBlockReason is the one
  // answer to "is this port free?". An auto-assigned cable stays implicit —
  // it fills the lowest free slot and names densely per media (Ethernet1,
  // Serial1, …) — whereas a chosen port is pinned to its number in every
  // view. Storing the auto slot made every cable "explicit" in one shared
  // numbering space, so a router's first serial cable came out as Serial2.
  const refusedFrom = fromPort != null ? portBlockReason(fromId, toId, fromPort) : null;
  const refusedTo = toPort != null ? portBlockReason(toId, fromId, toPort) : null;
  const link: any = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    from: fromId,
    to: toId,
    ...(fromPort != null && !refusedFrom ? { fromPort } : {}),
    ...(toPort != null && !refusedTo ? { toPort } : {}),
    ...(wireless ? { wireless: true } : {})
  };
  state.links.push(link);
  const warnings: string[] = [];
  const landed = (device: Device) => `${device.name} ${linkPortName(link, device.id) ?? "the next free port"}`;
  if (refusedFrom) warnings.push(`${refusedFrom}, so the cable went to ${landed(from)} instead.`);
  if (refusedTo) warnings.push(`${refusedTo}, so the cable went to ${landed(to)} instead.`);
  // A wireless association with a wrong password forms but can't authenticate —
  // say so, so the learner knows why traffic won't pass (the join handshake will fail).
  if (wireless && !wifiLinkAuthenticated(link)) {
    const laptop = from.type === "laptop" ? from : to;
    warnings.push(`${laptop.name} associated but not authenticated — wrong WiFi password.`);
  }
  // The cable just came up: unconfigured hosts on either end boot their
  // network config (DHCP, then APIPA) — wired to the engine in app.ts.
  if (_linkUp) _linkUp(fromId, toId);
  state.linkStartId = null;
  // A new cable renumbers implicit ports (flush the learnt MACs on its L2
  // domain) and can open or close a loop — recompute the spanning tree so any
  // newly blocked/unblocked port shows live (also re-renders).
  linksChanged([fromId, toId]);
  sync().syncPanel();
  return { ok: true, message: `Linked ${from.name} ↔ ${to.name}.`, warnings, link, created: true };
}

// ─── Port occupancy ───────────────────────────────────────────────────────────
//
// ONE answer to "which numbered ports of this device are in use?", shared by
// addLink, the `link` command, the port picker and (through linkPortName) the
// script export. It counts EVERY physical cable — pinned or implicit — exactly
// as the naming functions number them, and it is media-aware: a router numbers
// its Ethernet and serial ports separately, so Ethernet3 and Serial3 are two
// different ports.
//
// Three checks used to disagree. portTaken/nextAvailablePort counted only
// pinned cables, so `link SW1 PC2 1` landed on the port an implicit cable
// already held, shifted that host along and handed its VLAN to the newcomer
// (review R28). They also kept one number space per device, so with Ethernet3
// pinned the picker still offered Serial3 and choosing it produced Serial1
// (R29). And the script export invented a port for an unpinned end (R32).

export type PortMedia = "ethernet" | "serial";

// The kind of port a cable from `deviceId` to `peerId` uses at the `deviceId`
// end: serial between two routers, Ethernet otherwise — the same rule
// routerInterfacesWithNames names by. Only a router has two kinds.
export function portMediaFor(deviceId: string, peerId: string): PortMedia {
  return getDevice(deviceId)?.type === "router" && getDevice(peerId)?.type === "router" ? "serial" : "ethernet";
}

// How many ports of this kind the device has.
function portCapacity(device: Device, media: PortMedia): number {
  if (device.type === "router") {
    return media === "serial"
      ? clampRouterPortCount(device.config?.serialPorts ?? 4)
      : clampRouterPortCount(device.config?.ethernetPorts ?? defaultPortCount("router"));
  }
  if (media === "serial") return 0;
  if (hasSingleNic(device.type)) return 1;
  return defaultPortCount(device.type) > 0 ? wiredPortCapacity(device) : MAX_PHYSICAL_PORT;
}

function portLabel(device: Device, media: PortMedia, port: number): string {
  if (hasSingleNic(device.type)) return "eth0";
  return `${media === "serial" ? "Serial" : "Ethernet"}${port}`;
}

// The ports of one kind in use on a device, as port number → the peer cabled
// there. Read from the same views that NAME the ports (routerInterfacesWithNames
// for a router, linkedPortsFor's slots otherwise), so "occupied" can never
// disagree with what the inspector and terminal show.
export function occupiedPorts(deviceId: string, media: PortMedia = "ethernet"): Map<number, Device | null> {
  const taken = new Map<number, Device | null>();
  const device = getDevice(deviceId);
  if (!device) return taken;
  if (device.type === "router") {
    for (const iface of routerInterfacesWithNames(device, true)) {
      if (iface.type !== media) continue;
      const n = Number(iface.name.replace(/\..*$/, "").replace(/\D+/g, ""));
      if (n) taken.set(n, iface.peer ?? null);
    }
    return taken;
  }
  if (media !== "ethernet") return taken;
  const ports = linkedPortsFor(deviceId);
  if (hasSingleNic(device.type)) {
    const only = ports.find((port: any) => port);
    if (only) taken.set(1, only.peer ?? null);
    return taken;
  }
  // A wireless association is not a wired port (as in switchInterfacesWithNames).
  ports.filter((port: any) => !port?.link?.wireless).forEach((port: any, index: number) => {
    if (port) taken.set(index + 1, port.peer ?? null);
  });
  return taken;
}

// Why a cable from `deviceId` to `peerId` cannot take `port` at the `deviceId`
// end — or null when the port exists and is free. The reason is written for the
// learner: the `link` command prints it when a requested port is not honoured.
export function portBlockReason(deviceId: string, peerId: string, port: number): string | null {
  const device = getDevice(deviceId);
  if (!device) return "No such device.";
  const media = portMediaFor(deviceId, peerId);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PHYSICAL_PORT) return `${device.name} has no port ${port}`;
  const capacity = portCapacity(device, media);
  if (port > capacity) {
    if (hasSingleNic(device.type)) return `${device.name} has a single NIC (eth0), so it has no port ${port}`;
    const kind = device.type === "router" ? (media === "serial" ? "serial " : "Ethernet ") : "";
    return `${device.name} has ${capacity} ${kind}port${capacity === 1 ? "" : "s"}, so there is no ${portLabel(device, media, port)}`;
  }
  const taken = occupiedPorts(deviceId, media);
  if (taken.has(port)) {
    const peer = taken.get(port);
    return `${device.name} ${portLabel(device, media, port)} is already cabled${peer ? ` to ${peer.name}` : ""}`;
  }
  return null;
}

// The name of the port a cable occupies at one of its ends — "Ethernet3",
// "Serial1", "eth0" — as the inspector and terminal show it. Null for a
// wireless association, or a cable past the device's capacity.
export function linkPortName(link: Link, deviceId: string): string | null {
  const device = getDevice(deviceId);
  if (!device || link.wireless) return null;
  if (device.type === "router") {
    const iface = routerInterfacesWithNames(device, true).find((i: any) => i.link?.id === link.id);
    return iface ? iface.name.replace(/\..*$/, "") : null;
  }
  if (hasSingleNic(device.type)) return "eth0";
  const index = linkedPortsFor(deviceId).filter((port: any) => !port?.link?.wireless).findIndex((port: any) => port?.link?.id === link.id);
  return index >= 0 ? `Ethernet${index + 1}` : null;
}

// Remove a link by id. Returns true if one was removed.
export function deleteLink(linkId: string): boolean {
  const gone = state.links.find(l => l.id === linkId);
  if (!gone) return false;
  pushUndo();
  state.links = state.links.filter(l => l.id !== linkId);
  forgetArpEntries(new Set([...orphanedIfaceMacs(gone.from, gone.to), ...orphanedIfaceMacs(gone.to, gone.from)]));
  if (state.selectedLinkId === linkId) state.selectedLinkId = null;
  sync().syncPanel();
  // Later implicit ports renumber (flush the learnt MACs), and removing a
  // redundant link can unblock the surviving one.
  linksChanged([gone.from, gone.to]);
  return true;
}

// ─── Shared state mutators: admin status, power, switch management ────────────
// Each of these had two or three hand-written copies — the canvas gesture, the
// inspector control, the console command — that disagreed about what to
// recompute afterwards: the inspector's Managed toggle and both power buttons
// skipped the spanning tree, so stale "blocked" dashes, root badges and port
// roles stayed on screen until the next run (review R46). Every front door now
// calls the one mutator, which recomputes BEFORE the panel re-renders.

// Take a cable out of service (shut) or put it back (no shut).
export function setLinkShutdown(link: Link, down: boolean): MutationResult {
  const name = linkName(link);
  if (!!link.shutdown === down) return { ok: true, message: `${name} is already ${down ? "administratively down (shut)" : "up"}.`, warnings: [] };
  pushUndo();
  if (down) link.shutdown = true; else delete link.shutdown;
  // A shut port's learnt MACs are gone (it carries nothing), and a shut
  // redundant link lets the spanning tree re-open the other — flush, recompute
  // and redraw first, so the panel shows the tree as it now stands.
  linksChanged([link.from, link.to]);
  sync().syncPanel();
  return { ok: true, message: `${name} is now ${down ? "administratively down (shut)" : "up (no shut)"}.`, warnings: [] };
}

// Flip a link's admin status (shut ⇄ up) and select it. Returns the link (with
// its new state) or null if not found. Backs the canvas double-click gesture.
export function toggleLinkShutdown(linkId: string): Link | null {
  const link = state.links.find(l => l.id === linkId);
  if (!link) return null;
  setLinkShutdown(link, !link.shutdown);   // takes the undo point first, so undo also restores the selection
  state.selectedLinkId = link.id;
  state.selectedId = null;
  state.configuringId = null;
  sync().syncPanel();
  sync().render();
  return link;
}

// Power a device on or off. A powered-off switch leaves the spanning tree (and
// a powered-on one rejoins it), so the tree is recomputed — which also redraws.
// Power state only: an unconfigured host stays "unassigned" until the
// simulation is started (Play boots it via animated DHCP).
export function setDevicePower(device: Device, on: boolean): MutationResult {
  if (!device.poweredOff === on) return { ok: true, message: `${device.name} is already powered ${on ? "on" : "off"}.`, warnings: [] };
  pushUndo();
  device.poweredOff = !on;
  sync().recomputeStp();
  sync().syncPanel();
  sync().syncTerminal();
  return { ok: true, message: `${device.name} powered ${on ? "on" : "off"}.`, warnings: [] };
}

// Turn a switch's management plane on or off (VLANs, STP, port security need
// it). Only a managed switch runs spanning tree, so the tree is recomputed.
export function setSwitchManaged(device: Device, managed: boolean): MutationResult {
  if (device.type !== "switch") return { ok: false, error: `${device.name} is not a switch.`, warnings: [] };
  if (!!device.config?.managed === managed) return { ok: true, message: `${device.name} is already ${managed ? "managed" : "unmanaged"}.`, warnings: [] };
  pushUndo();
  ensureConfig(device);
  device.config.managed = managed;
  sync().recomputeStp();
  sync().syncPanel();
  sync().syncTerminal();   // an unmanaged switch has no CLI
  return { ok: true, message: `${device.name} is now ${managed ? "managed" : "unmanaged"}.`, warnings: [] };
}

export function deleteSelection(): void {
  // A selected link deletes first (devices and links are mutually exclusive).
  if (!state.selectedId && state.selectedLinkId) {
    deleteLink(state.selectedLinkId);
    return;
  }
  if (!state.selectedId) return;
  const selected = getDevice(state.selectedId);
  if (selected?.type === "lan") {
    expandLan(selected);
    return;
  }
  pushUndo();
  const id = state.selectedId;
  // Its neighbours lose a cable each — their learnt MACs are invalidated below.
  const neighbours = state.links.filter(link => link.from === id || link.to === id).map(link => link.from === id ? link.to : link.from);
  state.links = state.links.filter(link => link.from !== id && link.to !== id);
  if (selected) {
    // The device's own MACs leave the wire, and so does each neighbouring
    // router interface that was cabled to it.
    const gone = new Set(macsOwnedBy(selected));
    for (const peer of neighbours) for (const mac of orphanedIfaceMacs(peer, selected.id)) gone.add(mac);
    forgetArpEntries(gone, selected.id);
  }
  state.devices = state.devices.filter(device => device.id !== id);
  state.selectedId = null;
  state.configuringId = null;
  state.linkStartId = null;
  if (id) dropTerminalSessions([id]); // a deleted device's session tab goes with it
  sync().syncPanel();
  sync().syncTerminal();
  linksChanged(neighbours);   // renumbered ports; removing a switch/link can change which ports block
}

// Every MAC address `device` answers to on the wire: its NIC, each router
// interface, and the derived MAC a device without a configured one presents
// (the internet cloud's gateway MAC, a switch's bridge MAC).
export function macsOwnedBy(device: Device): string[] {
  const macs = [deriveMac(device.id)];
  if (device.config?.macAddress) macs.push(normaliseMacAddress(device.config.macAddress));
  for (const iface of device.config?.interfaces ?? []) if (iface.macAddress) macs.push(normaliseMacAddress(iface.macAddress));
  return macs;
}

// The MACs a device presents on a cable right now: none when it has no cable;
// otherwise its NIC (or derived) MAC, and for a router only the interfaces
// whose peer it is still cabled to. A router interface left behind when its
// cable is moved keeps its MAC in the config, but nothing answers to it on the
// wire — re-cabling the port creates a fresh interface with a new MAC.
export function liveMacsOf(device: Device): string[] {
  const links = linksFor(device.id);
  if (!links.length) return [];
  const peers = new Set(links.map(link => link.from === device.id ? link.to : link.from));
  const macs = [deriveMac(device.id)];
  if (device.config?.macAddress) macs.push(normaliseMacAddress(device.config.macAddress));
  for (const iface of device.config?.interfaces ?? []) {
    if (iface.macAddress && peers.has(iface.peerId)) macs.push(normaliseMacAddress(iface.macAddress));
  }
  return macs;
}

// The MACs of `routerId`'s interfaces facing `peerId` once no cable joins the
// two any more (call after the link is removed). Empty for a non-router, or
// while another cable to the same peer survives.
function orphanedIfaceMacs(routerId: string, peerId: string): string[] {
  const router = getDevice(routerId);
  const ifaces = router?.config?.interfaces;
  if (!ifaces?.length) return [];
  if (state.links.some(l => (l.from === routerId && l.to === peerId) || (l.to === routerId && l.from === peerId))) return [];
  return ifaces.filter(iface => iface.peerId === peerId && iface.macAddress).map(iface => normaliseMacAddress(iface.macAddress));
}

// MACs that just left the wire — a deleted device's, or a router interface's
// whose cable was removed (with the device, or on its own) — take every ARP
// entry pointing at them (a host's cache, each router interface's) with them.
// This is the simulator's stand-in for ARP ageing — the simulation has no clock
// to age entries out — and without it the device that now holds the address
// (a replacement device, or the router's re-cabled port with its new MAC) is
// never reached: the stale entry addresses the frames to a MAC no router takes
// up. Undoable with the delete (the snapshot holds the tables).
function forgetArpEntries(gone: Set<string>, skipId?: string): void {
  if (!gone.size) return;
  const keep = (entry: { macAddress: string }) => !gone.has(normaliseMacAddress(entry.macAddress));
  for (const device of state.devices) {
    if (device.id === skipId || !device.config) continue;
    if (device.config.arpTable?.length) device.config.arpTable = device.config.arpTable.filter(keep);
    for (const iface of device.config.interfaces ?? []) if (iface.arpTable?.length) iface.arpTable = iface.arpTable.filter(keep);
  }
}

export function clearNetwork(): void {
  // Tear down any active run BEFORE the topology it references disappears —
  // the same stop-before-replace order applyConfigWithoutUndo follows. Without
  // it the animation loop kept running against deleted devices (status stuck
  // on "running", a transit pointing at a missing link).
  _stopSimulation?.();
  if (state.devices.length || state.links.length) pushUndo();
  state.devices = [];
  state.links = [];
  state.selectedId = null;
  state.selectedLinkId = null;
  state.configuringId = null;
  state.linkStartId = null;
  state.panDrag = null;
  dropTerminalSessions();
  // The captures referenced the now-deleted devices/links — drop the archive
  // and refresh the sim-log pane so its capture bar/list don't dangle.
  resetCaptureState();
  state.nameCounters = freshNameCounters();
  sync().syncPanel();
  sync().syncTerminal();
  sync().syncSimLog();
  sync().render();
}

export function moveDevice(device: Device, x: number, y: number): void {
  device.x = x;
  device.y = y;
  sync().render();
}

export function findDeviceAt(point: { x: number; y: number }): Device | null {
  for (let i = state.devices.length - 1; i >= 0; i--) {
    const device = state.devices[i];
    if (device.hidden) continue;
    if (
      point.x >= device.x - device.width / 2 &&
      point.x <= device.x + device.width / 2 &&
      point.y >= device.y - device.height / 2 &&
      point.y <= device.y + device.height / 2
    ) {
      return device;
    }
  }
  return null;
}

export function findLinkAt(point: { x: number; y: number }): Link | null {
  const threshold = 14;
  for (const link of state.links) {
    if (link.hidden) continue;
    const from = getDevice(link.from);
    const to = getDevice(link.to);
    if (!from || !to || from.hidden || to.hidden) continue;
    const dist = pointToSegmentDistance(point.x, point.y, from.x, from.y, to.x, to.y);
    if (dist <= threshold) return link;
  }
  return null;
}

function pointToSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// --- O(1) lookup indexes, lazily rebuilt when state.devices/state.links change.
// Staleness is detected by array identity + length: every add/remove either
// reassigns the array (filter/=) or pushes (length change), and device ids /
// link endpoints are stable. In-place field changes (config, hidden, port) are
// seen through the cached object references, so they need no invalidation —
// which is why the adjacency keeps ALL links and callers filter `hidden`.
//
// INVARIANT: never replace an element in place (e.g. splice one out and push a
// different one) — same ref + same length would silently serve a stale index.
// Mutators must either reassign the array or only push/pop.
let _deviceIndex = new Map<string, Device>();
let _deviceRef: Device[] | null = null;
let _deviceLen = -1;

function deviceIndex(): Map<string, Device> {
  if (_deviceRef !== state.devices || _deviceLen !== state.devices.length) {
    _deviceIndex = new Map(state.devices.map(device => [device.id, device]));
    _deviceRef = state.devices;
    _deviceLen = state.devices.length;
  }
  return _deviceIndex;
}

let _linkAdjacency = new Map<string, Link[]>();
let _linkRef: Link[] | null = null;
let _linkLen = -1;

export function linksFor(id: string): Link[] {
  if (_linkRef !== state.links || _linkLen !== state.links.length) {
    const adjacency = new Map<string, Link[]>();
    const add = (key: string, link: Link) => {
      const list = adjacency.get(key);
      if (list) list.push(link); else adjacency.set(key, [link]);
    };
    for (const link of state.links) {
      add(link.from, link);
      add(link.to, link);
    }
    _linkAdjacency = adjacency;
    _linkRef = state.links;
    _linkLen = state.links.length;
  }
  return _linkAdjacency.get(id) ?? [];
}

export function getDevice(id: string | null): Device | undefined {
  return id == null ? undefined : deviceIndex().get(id);
}

let _linkByIdIndex = new Map<string, Link>();
let _linkByIdRef: Link[] | null = null;
let _linkByIdLen = -1;

// O(1) link-by-id lookup, lazily rebuilt on the same (ref, length) signal as the
// adjacency index. Replaces per-frame `state.links.find(l => l.id === …)` scans.
export function linkById(id: string): Link | undefined {
  if (_linkByIdRef !== state.links || _linkByIdLen !== state.links.length) {
    _linkByIdIndex = new Map(state.links.map(l => [l.id, l]));
    _linkByIdRef = state.links;
    _linkByIdLen = state.links.length;
  }
  return _linkByIdIndex.get(id);
}

// A link's display name: the user-given name, or the endpoint combo (which
// follows device renames automatically). Used by the link inspector and the
// packet list's Link column.
export function linkName(link: Link): string {
  if (link.name) return link.name;
  return `${getDevice(link.from)?.name ?? link.from} ↔ ${getDevice(link.to)?.name ?? link.to}`;
}

export function isVisibleDevice(device: Device | undefined | null): device is Device {
  return !!device && !device.hidden;
}

export function connectedIds(id: string): string[] {
  return linksFor(id)
    .filter(link => !link.hidden)
    .map(link => link.from === id ? link.to : link.from);
}

// Whether a link is a real cable: every link except a collapsed LAN's proxy
// links (LAN cloud ↔ router, drawn in place of the hidden cables). Collapse is
// presentation — `hidden` says "not drawn", never "unplugged" — so everything
// that simulates, routes, numbers ports or checks cabling asks this rather than
// `!link.hidden`. Drawing and hit-testing still filter `hidden` (review R4).
export function isPhysicalLink(link: Link): boolean {
  return !link.proxy;
}

// Peers over PHYSICAL cables — including those a collapsed LAN has hidden, and
// excluding the LAN's proxy links. Collapse is presentation; persistence must
// ask "is this cable real?", not "is it drawn?" — otherwise saving while a LAN
// is collapsed dropped every router interface facing it.
export function physicalPeerIds(id: string): string[] {
  return linksFor(id)
    .filter(isPhysicalLink)
    .map(link => link.from === id ? link.to : link.from);
}

// A device's ports over its PHYSICAL cables (isPhysicalLink): what the engine
// forwards over, what interfaces and switch ports are named from, and what STP
// and 802.1X key on. Collapsing a LAN must not unplug the router's cable to it
// — that dropped the interface's address and connected route, renumbered the
// ports, and failed a ping across it with a false "No route" (review R4).
export function linkedPortsFor(id: string): any[] {
  const entries = linksFor(id)
    .filter(isPhysicalLink)
    .map(link => {
      const isFrom = link.from === id;
      const raw = isFrom ? link.fromPort : link.toPort;
      // Defensive bound (normalise + portBlockReason already enforce it): an
      // out-of-range port is treated as implicit rather than grown to.
      const portNum = Number.isInteger(raw) && (raw as number) >= 1 && (raw as number) <= MAX_PHYSICAL_PORT ? (raw as number) : 0;
      return {
        link,
        peer: getDevice(isFrom ? link.to : link.from),
        portNum
      };
    })
    .filter(port => !!port.peer);

  // If any entry has an explicit port number, place entries at those indices
  const hasExplicit = entries.some(e => e.portNum > 0);
  if (!hasExplicit) {
    return entries.map(({ link, peer }) => ({ link, peer }));
  }

  // Place explicit-port entries at the right index, fill others in order
  const result: any[] = [];
  const explicit = entries.filter(e => e.portNum > 0).sort((a, b) => a.portNum - b.portNum);
  const implicit = entries.filter(e => e.portNum === 0);

  for (const entry of explicit) {
    const idx = entry.portNum - 1; // 0-based
    // Two cables can carry the same number: a router's Ethernet3 and Serial3
    // are different ports (it names per media, not by slot). The later one
    // takes a free slot rather than overwriting — and orphaning — the first.
    if (result[idx]) { implicit.push(entry); continue; }
    while (result.length <= idx) result.push(null);
    result[idx] = { link: entry.link, peer: entry.peer };
  }

  // Fill implicit entries into empty slots
  let slot = 0;
  for (const entry of implicit) {
    while (slot < result.length && result[slot] !== null) slot++;
    if (slot < result.length) {
      result[slot] = { link: entry.link, peer: entry.peer };
    } else {
      result.push({ link: entry.link, peer: entry.peer });
    }
    slot++;
  }

  return result;
}

export function nextName(type: string): string {
  const spec = DEVICE_SPECS[type as DeviceType];
  return `${spec.namePrefix}-${state.nameCounters[type as DeviceType]++}`;
}

export function nextDeviceNumber(type: string): number {
  const prefix = `${DEVICE_SPECS[type as DeviceType].namePrefix}-`;
  const highest = state.devices
    .filter(device => device.type === type && device.name.startsWith(prefix))
    .map(device => Number(device.name.slice(prefix.length)))
    .filter(Number.isFinite)
    .reduce((max, value) => Math.max(max, value), 0);
  return highest + 1;
}

export function collectLanMembers(anchorId: string): { members: string[]; absorbedLans: string[] } {
  const members = new Set<string>();
  const absorbedLans = new Set<string>();
  const queue = [anchorId];
  while (queue.length) {
    const id = queue.shift()!;
    if (members.has(id)) continue;
    const device = getDevice(id);
    if (!device || device.hidden || device.type === "router") continue;
    if (device.type === "lan") {
      absorbedLans.add(device.id);
      (device.config?.members || []).forEach((memberId: string) => queue.push(memberId));
      continue;
    }
    members.add(id);
    state.links.forEach(link => {
      if (link.hidden || (link.from !== id && link.to !== id)) return;
      const nextId = link.from === id ? link.to : link.from;
      const next = getDevice(nextId);
      if (next && !next.hidden && next.type !== "router") queue.push(nextId);
    });
  }
  return {
    members: [...members],
    absorbedLans: [...absorbedLans]
  };
}

// Collapse the LAN around a switch into one LAN node. Returns why it did not
// (a non-switch, a switch with nothing attached, one already inside a collapsed
// LAN) — the `collapse` command used to report success for all of those.
export function collapseLan(anchor: any): MutationResult {
  if (!anchor) return { ok: false, error: "No such device.", warnings: [] };
  if (anchor.type !== "switch") return { ok: false, error: `${anchor.name} is not a switch — a LAN is collapsed around its switch.`, warnings: [] };
  if (anchor.hidden) return { ok: false, error: `${anchor.name} is already inside a collapsed LAN.`, warnings: [] };
  const { members, absorbedLans } = collectLanMembers(anchor.id);
  if (members.length < 2) {
    return { ok: false, error: `Collapse LAN needs a switch with at least one attached LAN device — ${anchor.name} has none.`, warnings: [] };
  }
  pushUndo();
  const memberSet = new Set(members);
  const absorbedLanSet = new Set(absorbedLans);
  const memberDevices = state.devices.filter(device => memberSet.has(device.id));
  const bounds = memberDevices.reduce((acc, device) => ({
    minX: Math.min(acc.minX, device.x - device.width / 2),
    minY: Math.min(acc.minY, device.y - device.height / 2),
    maxX: Math.max(acc.maxX, device.x + device.width / 2),
    maxY: Math.max(acc.maxY, device.y + device.height / 2)
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  const lanId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  const lan = {
    id: lanId,
    type: "lan",
    name: `${anchor.name} LAN`,
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    width: deviceSize("lan").width,
    height: deviceSize("lan").height,
    config: { anchorId: anchor.id, members, absorbedLans }
  };
  const boundaryIds = new Set<string>();
  state.links.forEach(link => {
    if (absorbedLanSet.has(link.from) || absorbedLanSet.has(link.to)) {
      (link as any).visibleBeforeParentCollapse = !link.hidden;
      link.hidden = true;
      link.collapsedBy = lanId;
      return;
    }
    const fromMember = memberSet.has(link.from);
    const toMember = memberSet.has(link.to);
    if (!fromMember && !toMember) return;
    link.hidden = true;
    link.collapsedBy = lanId;
    const outsideId = fromMember ? link.to : link.from;
    const outside = getDevice(outsideId);
    if (outside && outside.type === "router" && !outside.hidden) boundaryIds.add(outside.id);
  });
  memberDevices.forEach(device => {
    device.hidden = true;
    device.collapsedBy = lanId;
  });
  state.devices.forEach(device => {
    if (absorbedLanSet.has(device.id)) {
      device.hidden = true;
      device.collapsedBy = lanId;
    }
  });
  boundaryIds.forEach(routerId => {
    state.links.push({
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      from: lanId,
      to: routerId,
      proxy: true,
      collapsedBy: lanId
    } as any);
  });
  state.devices.push(lan as any);
  state.selectedId = lanId;
  state.configuringId = null;
  state.linkStartId = null;
  sync().syncPanel();
  // Collapse is presentation: the member cables are hidden, not unplugged, so
  // no port renumbers and nothing learnt from the cabling goes stale — there is
  // nothing to flush or reconverge, only the canvas to redraw.
  sync().render();
  return { ok: true, message: `Collapsed ${members.length} devices into ${lan.name}.`, warnings: [] };
}

// Expand a collapsed LAN back into its devices. Returns why it did not (the
// target is not a collapsed LAN).
export function expandLan(lan: any): MutationResult {
  if (!lan) return { ok: false, error: "No such device.", warnings: [] };
  if (lan.type !== "lan") return { ok: false, error: `${lan.name} is not a collapsed LAN — there is nothing to expand.`, warnings: [] };
  pushUndo();
  const lanId = lan.id;
  const absorbedLanSet = new Set(lan.config?.absorbedLans || []);
  state.devices.forEach(device => {
    if (device.collapsedBy === lanId) {
      device.hidden = false;
      delete device.collapsedBy;
    }
  });
  state.links = state.links.filter(link => !link.proxy || link.collapsedBy !== lanId);
  state.links.forEach(link => {
    if (link.collapsedBy === lanId) {
      if (absorbedLanSet.has(link.from) || absorbedLanSet.has(link.to)) {
        link.hidden = !(link as any).visibleBeforeParentCollapse;
      } else {
        link.hidden = false;
      }
      delete (link as any).visibleBeforeParentCollapse;
      delete link.collapsedBy;
    }
  });
  state.devices = state.devices.filter(device => device.id !== lanId);
  state.selectedId = lan.config?.anchorId || null;
  state.configuringId = null;
  state.linkStartId = null;
  sync().syncPanel();
  sync().render();   // presentation only, like collapse — the cabling never changed
  return { ok: true, message: `Expanded ${lan.name}.`, warnings: [] };
}

export function routerInterfaceFor(router: any, peerId: string, vlanTag?: number | null): any {
  ensureConfig(router);
  router.config.interfaces = normaliseRouterInterfaces(router.config.interfaces || [], router.id);
  let iface: any;
  if (vlanTag != null) {
    // Find sub-interface with matching peerId AND vlanTag
    iface = router.config.interfaces.find((entry: any) => entry.peerId === peerId && entry.vlanTag === vlanTag);
  } else {
    // Find interface with peerId and no vlanTag (or first match if no sub-interfaces)
    iface = router.config.interfaces.find((entry: any) => entry.peerId === peerId && entry.vlanTag == null)
      || router.config.interfaces.find((entry: any) => entry.peerId === peerId);
  }
  if (!iface) {
    const peer = getDevice(peerId);
    const type = peer?.type === "router" ? "serial" : "ethernet";
    // Push, then re-normalise, so the new entry is fully formed from birth
    // (deterministic MAC, arpTable, …) — a bare entry would otherwise leak an
    // undefined MAC into ARP replies until something re-normalised this router.
    router.config.interfaces.push({ peerId, type, ipv4Address: "", vlanTag: vlanTag ?? null });
    router.config.interfaces = normaliseRouterInterfaces(router.config.interfaces, router.id);
    iface = (vlanTag != null
      ? router.config.interfaces.find((entry: any) => entry.peerId === peerId && entry.vlanTag === vlanTag)
      : router.config.interfaces.find((entry: any) => entry.peerId === peerId && entry.vlanTag == null))
      || router.config.interfaces.find((entry: any) => entry.peerId === peerId);
  }
  return iface;
}

// Find or create a config entry for an *unconnected* port, keyed by its
// interface name (Ethernet3, Serial2). Lets a user pre-assign an IP before a
// cable exists; normaliseRouterInterfaces keeps the entry alive because it has
// a name. If a cable later occupies that port, the by-peer entry takes over.
export function routerInterfaceForName(router: any, name: string): any {
  ensureConfig(router);
  router.config.interfaces = normaliseRouterInterfaces(router.config.interfaces || [], router.id);
  let iface = router.config.interfaces.find((entry: any) => entry.peerId === "" && entry.name === name);
  if (!iface) {
    // Push, then re-normalise — same as routerInterfaceFor, so the by-name
    // entry carries a deterministic MAC and empty tables from birth.
    router.config.interfaces.push({ peerId: "", name, type: /^serial/i.test(name) ? "serial" : "ethernet", ipv4Address: "", vlanTag: null });
    router.config.interfaces = normaliseRouterInterfaces(router.config.interfaces, router.id);
    iface = router.config.interfaces.find((entry: any) => entry.peerId === "" && entry.name === name);
  }
  return iface;
}

// `cabledOnly` stops after the cabled interfaces, skipping the enumeration of
// free ports: the routing table and RIP only ever read interfaces with a peer,
// and they run per routed frame / per convergence, so they don't pay to build
// (and garbage-collect) a placeholder for every unused port.
export function routerInterfacesWithNames(router: any, cabledOnly = false): NamedRouterIface[] {
  const ethernetPorts = clampRouterPortCount(router.config?.ethernetPorts ?? defaultPortCount("router"));
  const serialPorts = clampRouterPortCount(router.config?.serialPorts ?? 4);
  const configured = normaliseRouterInterfaces(router.config?.interfaces || [], router.id);
  const linked = linkedPortsFor(router.id).filter((port: any) => port).map(port => {   // drop null gaps from sparse port arrays
    const type = port.peer.type === "router" ? "serial" : "ethernet";
    // Find ALL configured interfaces for this peer (supports sub-interfaces)
    const allConfigs = configured.filter((entry: any) => entry.peerId === port.peer.id);
    if (allConfigs.length === 0) {
      allConfigs.push({ peerId: port.peer.id, type, name: "", ipv4Address: "", macAddress: "", arpTable: [], dhcpLeases: [], vlanTag: null });
    }
    const raw = port.link.from === router.id ? port.link.fromPort : port.link.toPort;
    const explicitPort = Number.isInteger(raw) && raw > 0 ? raw : 0;
    return { peer: port.peer, peerId: port.peer.id, type: allConfigs[0].type || type, configs: allConfigs, link: port.link, explicitPort, index: 0 };
  });
  // Naming honours an explicitly chosen port: the picker said "port 4", so
  // this IS Ethernet4 — in the inspector, the terminal, and the picker alike.
  // Implicit cables take the lowest unused number of their media, so the common
  // all-implicit case still names densely (Ethernet1, Ethernet2, …) exactly as
  // before. Previously every link was renumbered by array position, so a sole
  // cable on port 4 became "Ethernet1" and the name moved whenever an earlier
  // cable was added or removed.
  const usedByMedia: Record<string, Set<number>> = { ethernet: new Set(), serial: new Set() };
  const capacityOf = (t: string) => (t === "serial" ? serialPorts : ethernetPorts);
  const mediaOf = (t: string) => (t === "serial" ? "serial" : "ethernet");
  for (const entry of linked) {
    const n = entry.explicitPort;
    if (n && n <= capacityOf(entry.type) && !usedByMedia[mediaOf(entry.type)].has(n)) { usedByMedia[mediaOf(entry.type)].add(n); entry.index = n; }
  }
  for (const entry of linked) {
    if (entry.index) continue;
    const used = usedByMedia[mediaOf(entry.type)];
    let n = 1;
    while (used.has(n)) n++;
    if (n > capacityOf(entry.type)) continue;   // over capacity — not shown (unchanged)
    used.add(n); entry.index = n;
  }
  const occupied: any[] = [];
  for (const entry of linked) {
    const index = entry.index;
    if (!index) continue;
    const baseName = entry.type === "serial" ? `Serial${index}` : `Ethernet${index}`;
    const hasSubInterfaces = entry.configs.some((c: any) => c.vlanTag != null);
    if (hasSubInterfaces) {
      // Show sub-interfaces (Ethernet1.10, Ethernet1.20, etc.)
      for (const config of entry.configs) {
        if (config.vlanTag == null) continue;
        occupied.push({
          name: `${baseName}.${config.vlanTag}`,
          type: entry.type,
          peer: entry.peer ?? null,
          peerId: entry.peerId,
          config,
          link: entry.link
        });
      }
    } else {
      // Single interface, no sub-interfaces
      occupied.push({
        name: baseName,
        type: entry.type,
        peer: entry.peer,
        peerId: entry.peerId,
        config: entry.configs[0],
        link: entry.link
      });
    }
  }
  if (cabledOnly) return occupied;
  // Unconnected ports reuse any saved by-name config (so a pre-assigned IP
  // persists across renders), else a fresh placeholder.
  const emptyConfigFor = (name: string, type: string) =>
    configured.find((c: any) => c.peerId === "" && c.name === name)
      || { peerId: "", name, type, ipv4Address: "", vlanTag: null };
  // Free ports are every unused number up to capacity (so a gap left by an
  // explicit pick is offered as free, not hidden).
  const emptyEthernet: any[] = [];
  for (let n = 1; n <= ethernetPorts; n++) if (!usedByMedia.ethernet.has(n)) { const name = `Ethernet${n}`; emptyEthernet.push({ name, type: "ethernet", peer: null, peerId: "", config: emptyConfigFor(name, "ethernet") }); }
  const emptySerial: any[] = [];
  for (let n = 1; n <= serialPorts; n++) if (!usedByMedia.serial.has(n)) { const name = `Serial${n}`; emptySerial.push({ name, type: "serial", peer: null, peerId: "", config: emptyConfigFor(name, "serial") }); }
  return [...occupied, ...emptyEthernet, ...emptySerial];
}

export function routerInterfaceByName(router: any, name: string): any {
  const lower = String(name || "").trim().toLowerCase();
  return routerInterfacesWithNames(router).find(iface => iface.name.toLowerCase() === lower);
}

// A device's wired-port capacity by type — the same clamps the inspector and
// normaliser apply, so the picker and the port view agree.
export function wiredPortCapacity(device: any): number {
  const n = device.config?.ethernetPorts;
  switch (device.type) {
    case "access-point": return clampApPortCount(n ?? 1);
    case "firewall":     return clampFirewallPortCount(n ?? 2);
    case "hub":          return clampPortCount(n ?? 4);
    case "internet":     return clampPortCount(n ?? 8);
    default:             return clampPortCount(n ?? 8);
  }
}

export function switchInterfacesWithNames(device: any): any[] {
  const portCount = wiredPortCapacity(device);
  // A wireless association (laptop ↔ access point) is not an ethernet port, so
  // it never occupies a wired-port slot in the inspector / port picker. The
  // engine still floods over every link (it uses linkedPortsFor directly).
  const ports = linkedPortsFor(device.id).filter((p: any) => !p?.link?.wireless);   // keep null gaps (index alignment), drop wireless
  const portVlans = normalisePortVlans(device.config?.portVlans || {});
  const portModes = normalisePortModes(device.config?.portModes || {});
  const trunkNativeVlans = normalisePortVlans(device.config?.trunkNativeVlans || {});
  return Array.from({ length: portCount }, (_, index) => {
    const name = `Ethernet${index + 1}`;
    return {
      name,
      portNumber: index + 1,
      peer: ports[index]?.peer || null,
      vlan: portVlans[name] || 1,
      mode: portModes[name] || "access",
      nativeVlan: trunkNativeVlans[name] || 1
    };
  });
}

// Case-insensitive switch port lookup by name (e.g. "ethernet3" → Ethernet3).
export function switchIfaceByName(device: any, portName: string): any {
  const lower = String(portName || "").toLowerCase();
  return switchInterfacesWithNames(device).find((p: any) => p.name.toLowerCase() === lower);
}

// ─── Port list (the data behind the port picker — the dialog is port-picker.ts) ──

// `peerId` (the other end of the cable being made) narrows a router's list to
// the kind of port that cable will use — serial to another router, Ethernet to
// anything else. Offering both let the learner pick "Serial2" for a switch and
// get Ethernet2.
export function buildPortList(deviceId: string, peerId?: string): PortOption[] {
  const device = getDevice(deviceId);
  if (!device) return [];

  if (hasSingleNic(device.type)) {
    // Hosts (and the single-NIC IDS sensor) have one port — auto-select it
    const linked = linkedPortsFor(deviceId);
    const occupied = linked.length > 0;
    return [{
      name: "eth0",
      port: 1,
      available: !occupied,
      connectedTo: occupied ? (linked[0]?.peer?.name || null) : null
    }];
  }

  if (device.type !== "router" && defaultPortCount(device.type) > 0) {
    // Every type with an ethernetPorts count (switch, hub, access point, firewall,
    // internet cloud) enumerates ports the same way — the firewall and cloud used
    // to fall through to an empty list, leaving the picker with a blank column and
    // no way to confirm. Routers name ports per media type, below.
    const ifaces = switchInterfacesWithNames(device);
    return ifaces.map((iface: any) => ({
      name: iface.name,
      port: iface.portNumber,
      available: !iface.peer,
      connectedTo: iface.peer?.name || null
    }));
  }

  if (device.type === "router") {
    const media = peerId ? portMediaFor(deviceId, peerId) : null;
    const ifaces = routerInterfacesWithNames(device);
    return ifaces
      .filter((iface: any) => !iface.name.includes(".")) // skip sub-interfaces
      .filter((iface: any) => !media || iface.type === media)
      .map((iface: any) => ({
        name: iface.name,
        // The number the NAME carries is what becomes the link's fromPort/toPort,
        // and naming honours it back — so "Ethernet4" picked here is Ethernet4
        // in the inspector and terminal too (it used to be the row's position).
        port: Number(iface.name.replace(/\D+/g, "")) || 1,
        available: !iface.peer,
        connectedTo: iface.peer?.name || null
      }));
  }

  return [];
}

let _setTool: ((tool: string) => void) | null = null;
let _setNetworkPanel: ((open: boolean) => void) | null = null;
let _linkUp: ((aId: string, bId: string) => void) | null = null;
let _openTerminal: ((device: Device) => void) | null = null;
let _stopSimulation: (() => void) | null = null;

export function registerDeviceCallbacks(cbs: {
  setTool: (tool: string) => void;
  setNetworkPanel: (open: boolean) => void;
  linkUp?: (aId: string, bId: string) => void;   // fires when a new cable comes up (first-boot autoconf)
  openTerminal?: (device: Device) => void;        // configuring a CLI device opens its terminal
  stopSimulation?: () => void;                    // clearNetwork tears down an active run first (engine-owned; bridged to avoid the devices→engine cycle)
}) {
  _setTool = cbs.setTool;
  _setNetworkPanel = cbs.setNetworkPanel;
  _linkUp = cbs.linkUp ?? null;
  _openTerminal = cbs.openTerminal ?? null;
  _stopSimulation = cbs.stopSimulation ?? null;
}

export function configureDevice(device: Device): void {
  if (!device) return;
  state.selectedId = device.id;
  state.configuringId = device.id;
  state.drag = null;
  state.panDrag = null;
  state.linkStartId = null;
  // Opening a device's config reverts to the select tool — configuring is a
  // one-shot action, not a sticky mode, so you land back in select afterwards.
  if (_setTool) _setTool("select");
  if (_setNetworkPanel) _setNetworkPanel(true);
  // Configuring a CLI device also brings up its terminal (no-op for devices
  // without a usable one — unmanaged switches, powered-off, LANs).
  if (_openTerminal) _openTerminal(device);
  dom.modeLabel.textContent = `Configuring ${device.name}.`;
  sync().syncPanel();
  sync().render();
}
