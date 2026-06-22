import type { PortOption, Device, Link, DeviceType, NamedRouterIface } from "./types";
import { state, sync, pushUndo, networkSnapshot, dropTerminalSessions } from "./state";
import { dom } from "./dom";
import { deviceSize, defaultDeviceConfig, ensureConfig, normaliseRouterInterfaces, normalisePortVlans, normalisePortModes } from "./normalise";
import { clampPortCount, clampApPortCount, clampRouterPortCount, escapeHtml, randomMac } from "./utils";
import { DEVICE_SPECS, freshNameCounters } from "./device-registry";

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
  // A new host (computer/laptop/server) gets a NIC MAC so it can communicate immediately.
  if (type === "computer" || type === "laptop" || type === "server") (device.config as any).macAddress = randomMac();
  state.devices.push(device as any);
  state.selectedId = device.id;
  sync().syncPanel();
  sync().render();
  return device;
}

// Tools that place a device on a canvas click. "managed-switch" is a UI variant
// of the switch tool (the Switch tool group), not a distinct device type.
export const PLACEMENT_TOOLS = new Set(["computer", "laptop", "server", "switch", "managed-switch", "router", "firewall", "hub", "access-point"]);

// Place the device for a placement tool, resolving UI variants to real types:
// "managed-switch" is a switch with management turned on.
export function placeToolDevice(tool: string, x: number, y: number): Device {
  if (tool === "managed-switch") {
    const device = addDevice("switch", x, y);
    device.config = device.config || {};
    (device.config as any).managed = true;
    sync().syncPanel();
    sync().render();
    return device;
  }
  return addDevice(tool as DeviceType, x, y);
}

// Hosts (computer/server) model a single NIC (eth0), so they take at most one
// cable. Returns the offending device's name when fully cabled, else null.
// (Multi-NIC hosts are a future option — see ROADMAP.)
function hostNicTaken(deviceId: string): string | null {
  const device = getDevice(deviceId);
  if (!device || !["computer", "laptop", "server"].includes(device.type)) return null;
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

// The 802.1X authenticator port for a host↔managed-switch link, or null when the
// link isn't under port control. Cheap early-out (a switch with no portAuth map
// pays only a property read) so non-802.1X topologies don't hit the hot path.
export function dot1xLinkInfo(link: any): { sw: any; host: any; mode: string; port: string } | null {
  if (!link || link.wireless) return null;
  const a = getDevice(link.from), b = getDevice(link.to);
  const sw = a?.type === "switch" ? a : b?.type === "switch" ? b : null;
  if (!sw?.config?.portAuth) return null;
  const host = (a?.type === "switch" ? b : a);
  if (!host || !["computer", "laptop", "server"].includes(host.type)) return null;
  const ports = linkedPortsFor(sw.id);
  const idx = ports.findIndex((p: any) => p.peer?.id === host.id);
  if (idx < 0) return null;
  const port = `Ethernet${idx + 1}`;
  return { sw, host, mode: sw.config.portAuth[port] || "force-authorized", port };
}

// Whether an 802.1X-controlled port currently authorises the host. force-authorized
// (the default / no 802.1X) always passes; force-unauthorized never; "auto" passes
// only after a successful EAP exchange (stored on the link as dot1xAuthorized).
export function dot1xPortAuthorized(link: any): boolean {
  const info = dot1xLinkInfo(link);
  if (!info || info.mode === "force-authorized") return true;
  if (info.mode === "force-unauthorized") return false;
  return !!link.dot1xAuthorized;
}

// MACsec (802.1AE) state of a link, from each end's per-peer CAK. "secured" =
// both ends configured with a matching key; "failed" = a key mismatch, or a
// must-secure end facing a peer with no MACsec; "open" = no MACsec in play (or a
// should-secure end falling back to plaintext). Live — tracks key edits.
export function macsecState(link: any): "open" | "secured" | "failed" {
  const a = getDevice(link?.from), b = getDevice(link?.to);
  const aCfg = a?.config?.macsec?.[link?.to];
  const bCfg = b?.config?.macsec?.[link?.from];
  if (!aCfg && !bCfg) return "open";
  if (aCfg && bCfg) return aCfg.cak === bCfg.cak ? "secured" : "failed";
  const cfg = aCfg || bCfg;            // only one end wants MACsec
  return cfg!.mode === "must" ? "failed" : "open";
}

// The single data-path gate: false = this link drops DATA frames right now,
// whether because a WiFi association never authenticated, an 802.1X port is
// unauthorized, or a MACsec link could not be secured (must-secure). (Shutdown/
// hidden are checked separately at each site; auth/EAPOL control frames bypass
// this — see the engine transit step.)
export function linkAuthorizedForData(link: any): boolean {
  if (link?.wireless && !wifiLinkAuthenticated(link)) return false;
  if (!dot1xPortAuthorized(link)) return false;
  if (macsecState(link) === "failed") return false;
  return true;
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

export function addLink(fromId: string, toId: string, fromPort?: number, toPort?: number): void {
  if (fromId === toId) return;
  const exists = state.links.some(link =>
    (link.from === fromId && link.to === toId) || (link.from === toId && link.to === fromId)
  );
  if (!exists) {
    const reason = linkBlockReason(fromId, toId);
    if (reason) {
      state.linkStartId = null;
      dom.modeLabel.textContent = reason;
      sync().render();
      return;
    }
    const { wireless } = classifyLink(fromId, toId);
    pushUndo();
    const resolvedFromPort = resolvePort(fromId, fromPort);
    const resolvedToPort = resolvePort(toId, toPort);
    const link: any = {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      from: fromId,
      to: toId,
      fromPort: resolvedFromPort,
      toPort: resolvedToPort,
      ...(wireless ? { wireless: true } : {})
    };
    state.links.push(link);
    // A wireless association with a wrong password forms but can't authenticate —
    // flag it so the user knows why traffic won't pass (the join handshake will fail).
    if (wireless && !wifiLinkAuthenticated(link)) {
      const laptop = getDevice(fromId)?.type === "laptop" ? getDevice(fromId) : getDevice(toId);
      dom.modeLabel.textContent = `${laptop?.name} associated but not authenticated — wrong WiFi password.`;
    }
    // The cable just came up: unconfigured hosts on either end boot their
    // network config (DHCP, then APIPA) — wired to the engine in app.ts.
    if (_linkUp) _linkUp(fromId, toId);
  }
  state.linkStartId = null;
  sync().syncPanel();
  sync().render();
}

export function nextAvailablePort(deviceId: string): number {
  const device = getDevice(deviceId);
  if (!device) return 1;
  const occupied = new Set<number>();
  for (const link of state.links) {
    if (link.hidden) continue;
    if (link.from === deviceId && link.fromPort) occupied.add(link.fromPort);
    if (link.to === deviceId && link.toPort) occupied.add(link.toPort);
  }
  let port = 1;
  while (occupied.has(port)) port++;
  return port;
}

function portTaken(deviceId: string, port: number): boolean {
  return state.links.some(l => !l.hidden &&
    ((l.from === deviceId && l.fromPort === port) || (l.to === deviceId && l.toPort === port)));
}

// An explicit port request is honoured only when it's a positive integer that's
// free; otherwise fall back to the next available port. Prevents a NaN or an
// already-occupied console-supplied port from landing two links on the same
// slot (the second would overwrite the first in linkedPortsFor and orphan it).
function resolvePort(deviceId: string, requested: number | undefined): number {
  if (requested != null && Number.isInteger(requested) && requested >= 1 && !portTaken(deviceId, requested)) {
    return requested;
  }
  return nextAvailablePort(deviceId);
}

// Remove a link by id. Returns true if one was removed.
export function deleteLink(linkId: string): boolean {
  if (!state.links.some(l => l.id === linkId)) return false;
  pushUndo();
  state.links = state.links.filter(l => l.id !== linkId);
  if (state.selectedLinkId === linkId) state.selectedLinkId = null;
  sync().syncPanel();
  sync().render();
  return true;
}

// Flip a link's admin status (shut ⇄ up), select it, and re-sync. Returns the
// link (with its new state) or null if not found. Backs the canvas double-click
// gesture; the inspector toggle and `shut`/`noshut` console commands set it too.
export function toggleLinkShutdown(linkId: string): Link | null {
  const link = state.links.find(l => l.id === linkId);
  if (!link) return null;
  pushUndo();
  if (link.shutdown) delete link.shutdown; else link.shutdown = true;
  state.selectedLinkId = link.id;
  state.selectedId = null;
  state.configuringId = null;
  sync().syncPanel();
  sync().render();
  return link;
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
  state.devices = state.devices.filter(device => device.id !== id);
  state.links = state.links.filter(link => link.from !== id && link.to !== id);
  state.selectedId = null;
  state.configuringId = null;
  state.linkStartId = null;
  if (id) dropTerminalSessions([id]); // a deleted device's session tab goes with it
  sync().syncPanel();
  sync().syncTerminal();
  sync().render();
}

export function clearNetwork(): void {
  if (state.devices.length || state.links.length) pushUndo();
  state.devices = [];
  state.links = [];
  state.selectedId = null;
  state.configuringId = null;
  state.linkStartId = null;
  state.panDrag = null;
  dropTerminalSessions();
  state.nameCounters = freshNameCounters();
  sync().syncPanel();
  sync().syncTerminal();
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

export function linkedPortsFor(id: string): any[] {
  const entries = linksFor(id)
    .filter(link => !link.hidden)
    .map(link => {
      const isFrom = link.from === id;
      const portNum = isFrom ? link.fromPort : link.toPort;
      return {
        link,
        peer: getDevice(isFrom ? link.to : link.from),
        portNum: portNum || 0
      };
    })
    .filter(port => isVisibleDevice(port.peer));

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

export function collapseLan(anchor: any): void {
  if (!anchor || anchor.type !== "switch") return;
  const { members, absorbedLans } = collectLanMembers(anchor.id);
  if (members.length < 2) {
    dom.modeLabel.textContent = "Collapse LAN needs a switch with at least one attached LAN device.";
    return;
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
  sync().render();
  dom.modeLabel.textContent = `Collapsed ${members.length} devices into ${lan.name}.`;
}

export function expandLan(lan: any): void {
  if (!lan || lan.type !== "lan") return;
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
  sync().render();
  dom.modeLabel.textContent = `Expanded ${lan.name}.`;
}

export function routerInterfaceFor(router: any, peerId: string, vlanTag?: number | null): any {
  ensureConfig(router);
  router.config.interfaces = normaliseRouterInterfaces(router.config.interfaces || []);
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
    iface = { peerId, type, ipv4Address: "", vlanTag: vlanTag ?? null };
    router.config.interfaces.push(iface);
  }
  return iface;
}

// Find or create a config entry for an *unconnected* port, keyed by its
// interface name (Ethernet3, Serial2). Lets a user pre-assign an IP before a
// cable exists; normaliseRouterInterfaces keeps the entry alive because it has
// a name. If a cable later occupies that port, the by-peer entry takes over.
export function routerInterfaceForName(router: any, name: string): any {
  ensureConfig(router);
  router.config.interfaces = normaliseRouterInterfaces(router.config.interfaces || []);
  let iface = router.config.interfaces.find((entry: any) => entry.peerId === "" && entry.name === name);
  if (!iface) {
    iface = { peerId: "", name, type: /^serial/i.test(name) ? "serial" : "ethernet", ipv4Address: "", vlanTag: null };
    router.config.interfaces.push(iface);
  }
  return iface;
}

export function routerInterfacesWithNames(router: any): NamedRouterIface[] {
  const ethernetPorts = clampRouterPortCount(router.config?.ethernetPorts ?? 4);
  const serialPorts = clampRouterPortCount(router.config?.serialPorts ?? 4);
  const configured = normaliseRouterInterfaces(router.config?.interfaces || []);
  const linked = linkedPortsFor(router.id).map(port => {
    const type = port.peer.type === "router" ? "serial" : "ethernet";
    // Find ALL configured interfaces for this peer (supports sub-interfaces)
    const allConfigs = configured.filter((entry: any) => entry.peerId === port.peer.id);
    if (allConfigs.length === 0) {
      allConfigs.push({ peerId: port.peer.id, type, name: "", ipv4Address: "", macAddress: "", arpTable: [], dhcpLeases: [], vlanTag: null });
    }
    return { peer: port.peer, peerId: port.peer.id, type: allConfigs[0].type || type, configs: allConfigs };
  });
  let ethernetIndex = 0;
  let serialIndex = 0;
  const occupied: any[] = [];
  for (const entry of linked) {
    const index = entry.type === "serial" ? ++serialIndex : ++ethernetIndex;
    if ((entry.type === "serial" && index > serialPorts) || (entry.type !== "serial" && index > ethernetPorts)) {
      continue;
    }
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
          config
        });
      }
    } else {
      // Single interface, no sub-interfaces
      occupied.push({
        name: baseName,
        type: entry.type,
        peer: entry.peer,
        peerId: entry.peerId,
        config: entry.configs[0]
      });
    }
  }
  // Unconnected ports reuse any saved by-name config (so a pre-assigned IP
  // persists across renders), else a fresh placeholder.
  const emptyConfigFor = (name: string, type: string) =>
    configured.find((c: any) => c.peerId === "" && c.name === name)
      || { peerId: "", name, type, ipv4Address: "", vlanTag: null };
  const emptyEthernet = Array.from({ length: Math.max(0, ethernetPorts - ethernetIndex) }, (_, index) => {
    const name = `Ethernet${ethernetIndex + index + 1}`;
    return { name, type: "ethernet", peer: null, peerId: "", config: emptyConfigFor(name, "ethernet") };
  });
  const emptySerial = Array.from({ length: Math.max(0, serialPorts - serialIndex) }, (_, index) => {
    const name = `Serial${serialIndex + index + 1}`;
    return { name, type: "serial", peer: null, peerId: "", config: emptyConfigFor(name, "serial") };
  });
  return [...occupied, ...emptyEthernet, ...emptySerial];
}

export function routerInterfaceByName(router: any, name: string): any {
  const lower = String(name || "").trim().toLowerCase();
  return routerInterfacesWithNames(router).find(iface => iface.name.toLowerCase() === lower);
}

export function switchInterfacesWithNames(device: any): any[] {
  const portCount = device.type === "access-point"
    ? clampApPortCount(device.config?.ethernetPorts ?? 1)
    : clampPortCount(device.config?.ethernetPorts ?? 8);
  // A wireless association (laptop ↔ access point) is not an ethernet port, so
  // it never occupies a wired-port slot in the inspector / port picker. The
  // engine still floods over every link (it uses linkedPortsFor directly).
  const ports = linkedPortsFor(device.id).filter((p: any) => !p.link?.wireless);
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

// ─── Port selection modal ─────────────────────────────────────────────────────

function buildPortList(deviceId: string): PortOption[] {
  const device = getDevice(deviceId);
  if (!device) return [];

  if (device.type === "computer" || device.type === "laptop" || device.type === "server") {
    // Hosts have a single port — auto-select it
    const linked = linkedPortsFor(deviceId);
    const occupied = linked.length > 0;
    return [{
      name: "eth0",
      port: 1,
      available: !occupied,
      connectedTo: occupied ? (linked[0]?.peer?.name || null) : null
    }];
  }

  if (device.type === "switch" || device.type === "hub" || device.type === "access-point") {
    // A hub / access point enumerates ports the same way (just an ethernetPorts count).
    const ifaces = switchInterfacesWithNames(device);
    return ifaces.map((iface: any) => ({
      name: iface.name,
      port: iface.portNumber,
      available: !iface.peer,
      connectedTo: iface.peer?.name || null
    }));
  }

  if (device.type === "router") {
    const ifaces = routerInterfacesWithNames(device);
    return ifaces
      .filter((iface: any) => !iface.name.includes(".")) // skip sub-interfaces
      .map((iface: any, index: number) => ({
        name: iface.name,
        port: index + 1,
        available: !iface.peer,
        connectedTo: iface.peer?.name || null
      }));
  }

  return [];
}

export function openPortSelectionModal(fromId: string, toId: string): void {
  const fromDevice = getDevice(fromId);
  const toDevice = getDevice(toId);
  if (!fromDevice || !toDevice) return;

  // A wireless association (laptop ↔ AP) auto-links with no port picker; an
  // invalid laptop pairing is rejected here (addLink surfaces the reason).
  const { reject, wireless } = classifyLink(fromId, toId);
  if (reject || wireless) { addLink(fromId, toId); return; }

  const showFromPicker = !["computer", "laptop", "server"].includes(fromDevice.type);
  const showToPicker = !["computer", "laptop", "server"].includes(toDevice.type);

  // If both are single-port hosts, skip modal entirely
  if (!showFromPicker && !showToPicker) {
    addLink(fromId, toId, 1, 1);
    return;
  }

  const fromPorts = buildPortList(fromId);
  const toPorts = buildPortList(toId);

  state.portSelection = {
    fromId,
    toId,
    fromPorts,
    toPorts,
    selectedFrom: showFromPicker ? null : 1,
    selectedTo: showToPicker ? null : 1,
    showFromPicker,
    showToPicker
  };

  // Auto-select first available port for non-picker side
  if (!showFromPicker) {
    state.portSelection.selectedFrom = 1;
  }
  if (!showToPicker) {
    state.portSelection.selectedTo = 1;
  }

  syncPortSelectionModal();
  dom.portSelectionOverlay.classList.add("open");
}

export function syncPortSelectionModal(): void {
  const ps = state.portSelection;
  if (!ps) return;

  const fromDevice = getDevice(ps.fromId);
  const toDevice = getDevice(ps.toId);
  if (!fromDevice || !toDevice) return;

  const columns: string[] = [];

  if (ps.showFromPicker) {
    columns.push(renderPortColumn(fromDevice.name, ps.fromPorts, ps.selectedFrom, "from"));
  }
  if (ps.showToPicker) {
    columns.push(renderPortColumn(toDevice.name, ps.toPorts, ps.selectedTo, "to"));
  }

  const singleColumn = !ps.showFromPicker || !ps.showToPicker;
  dom.portSelectionBody.className = `port-selection-body${singleColumn ? " single-column" : ""}`;
  dom.portSelectionBody.innerHTML = columns.join("");

  // Wire click handlers
  dom.portSelectionBody.querySelectorAll(".port-option:not(.occupied)").forEach(btn => {
    btn.addEventListener("click", () => {
      const side = (btn as HTMLElement).dataset.side;
      const port = Number((btn as HTMLElement).dataset.port);
      if (side === "from") {
        state.portSelection!.selectedFrom = port;
      } else {
        state.portSelection!.selectedTo = port;
      }
      syncPortSelectionModal();
    });
  });

  // Update confirm button state
  const canConfirm = ps.selectedFrom != null && ps.selectedTo != null;
  dom.portSelectionConfirm.disabled = !canConfirm;
}

function renderPortColumn(deviceName: string, ports: PortOption[], selected: number | null, side: string): string {
  return `<div class="port-column">
    <div class="port-column-header">${escapeHtml(deviceName)}</div>
    ${ports.map(p => {
      const classes = ["port-option"];
      if (!p.available) classes.push("occupied");
      if (p.port === selected) classes.push("selected");
      const status = p.connectedTo ? `Connected to ${escapeHtml(p.connectedTo)}` : "Available";
      return `<button class="${classes.join(" ")}" data-side="${side}" data-port="${p.port}">
        <span class="port-name">${escapeHtml(p.name)}</span>
        <span class="port-status">${status}</span>
      </button>`;
    }).join("")}
  </div>`;
}

export function confirmPortSelection(): void {
  const ps = state.portSelection;
  if (!ps || ps.selectedFrom == null || ps.selectedTo == null) return;
  addLink(ps.fromId, ps.toId, ps.selectedFrom, ps.selectedTo);
  cancelPortSelection();
}

export function cancelPortSelection(): void {
  state.portSelection = null;
  dom.portSelectionOverlay.classList.remove("open");
  state.linkStartId = null;
  sync().render();
}

let _setTool: ((tool: string) => void) | null = null;
let _setNetworkPanel: ((open: boolean) => void) | null = null;
let _linkUp: ((aId: string, bId: string) => void) | null = null;
let _openTerminal: ((device: Device) => void) | null = null;

export function registerDeviceCallbacks(cbs: {
  setTool: (tool: string) => void;
  setNetworkPanel: (open: boolean) => void;
  linkUp?: (aId: string, bId: string) => void;   // fires when a new cable comes up (first-boot autoconf)
  openTerminal?: (device: Device) => void;        // configuring a CLI device opens its terminal
}) {
  _setTool = cbs.setTool;
  _setNetworkPanel = cbs.setNetworkPanel;
  _linkUp = cbs.linkUp ?? null;
  _openTerminal = cbs.openTerminal ?? null;
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
