/**
 * Command engine — the text-command interface that can drive the whole app.
 *
 * Pure dispatcher: it parses a line, resolves device references, and calls the
 * existing action functions. It does NOT touch the console panel UI, so it is
 * reused by the panel (`console.ts`), the `window.routesim` API (`app.ts`), and
 * tests. See docs/scripting.md for the command reference.
 */
import type { Device, DeviceType } from "./types";
import { state, undo, redo, sync, pushUndo, THEMES } from "./state";
import { USER_ADDABLE_TYPES } from "./device-registry";
import { dom } from "./dom";
import {
  addDevice, addLink, linkBlockReason, deleteSelection, clearNetwork, collapseLan, expandLan,
  getDevice, moveDevice, linkName,
} from "./devices";
import {
  startSimulation, stopSimulation, pauseSimulation, resumeSimulation, stepOnce,
  runSimulationHeadless, runTraceroute,
} from "./engine";
import { buildPingEvents, buildDhcpEvents, buildConnectEvents, buildResolveEvents, buildAssociationEvents, buildDot1xEvents, associatedAp, findPingTarget } from "./simulation";
import {
  setHostIp, setHostGateway, setHostDns, setRouterInterfaceIp, addSwitchVlan, removeSwitchVlan,
  setSwitchPortVlan, setSwitchPortMode, setSwitchTrunkNative, modifySwitchTrunkAllowed,
  runTerminalCommand, ensureSession,
} from "./terminal";
import { buildConfigPayload, applyConfig, loadTopology } from "./config";
import { normaliseConfig, normaliseStaticRoutes, ensureConfig } from "./normalise";
import { setTool, setTheme } from "./ui";
import { setZoom, fitNetwork } from "./canvas";
import { isValidMac, normaliseMacAddress, prefixOf, networkOf, normaliseSsid, normaliseWifiPassword } from "./utils";
import { SCENARIOS, getScenario, loadScenario, checkScenario } from "./scenarios";
import { SPEED_MIN, SPEED_MAX } from "./settings-url";

export interface CommandResult {
  ok: boolean;
  output: string[];
  data?: unknown;
}

const ok = (...output: string[]): CommandResult => ({ ok: true, output });
const err = (...output: string[]): CommandResult => ({ ok: false, output });

// Switch/router mutators report failure with a magic-prefixed string ("Invalid
// VLAN ID: …", "Unknown interface …"). Surface those as a command error so
// scripts and window.routesim see ok===false rather than a silent success.
const mutatorResult = (msg: string): CommandResult =>
  (msg.startsWith("Invalid") || msg.startsWith("Unknown")) ? err(msg) : ok(msg);

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveDevice(ref: string): Device | string {
  if (!ref) return "Missing device reference.";
  const byId = getDevice(ref);
  if (byId) return byId;
  const lower = ref.toLowerCase();
  const matches = state.devices.filter(d => d.name.toLowerCase() === lower);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return `Ambiguous device "${ref}" (${matches.length} matches).`;
  return `No device named "${ref}".`;
}

function spawnPosition(): { x: number; y: number } {
  const n = state.devices.filter(d => d.type !== "lan").length;
  return { x: 120 + (n % 6) * 130, y: 120 + Math.floor(n / 6) * 120 };
}

function targetIpFor(ref: string): string {
  return findPingTarget(ref)?.config?.ipv4Address || ref;
}

// ── Command handlers ─────────────────────────────────────────────────────────

function cmdAdd(args: string[]): CommandResult {
  const type = (args[0] || "").toLowerCase();
  if (!USER_ADDABLE_TYPES.includes(type as DeviceType)) {
    return err(`add: type must be ${USER_ADDABLE_TYPES.join("|")}.`);
  }
  let name: string | undefined;
  let pos = spawnPosition();
  const atIdx = args.indexOf("at");
  if (atIdx >= 0) {
    pos = { x: Number(args[atIdx + 1]), y: Number(args[atIdx + 2]) };
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return err(`add: invalid "at <x> <y>".`);
    if (atIdx >= 2) name = args[1];
  } else if (args[1]) {
    name = args[1];
  }
  const device = addDevice(type as DeviceType, pos.x, pos.y, name);
  return ok(`Added ${type} ${device.name} at ${Math.round(device.x)},${Math.round(device.y)}.`);
}

function cmdRemove(args: string[]): CommandResult {
  const device = resolveDevice(args[0]);
  if (typeof device === "string") return err(device);
  state.selectedId = device.id;
  deleteSelection();
  return ok(`Removed ${device.name}.`);
}

function cmdLink(args: string[]): CommandResult {
  const a = resolveDevice(args[0]);
  if (typeof a === "string") return err(a);
  const b = resolveDevice(args[1]);
  if (typeof b === "string") return err(b);
  const fromPort = args[2] ? Number(args[2]) : undefined;
  const toPort = args[3] ? Number(args[3]) : undefined;
  const badPort = (p: number | undefined) => p !== undefined && !(Number.isInteger(p) && p >= 1);
  if (badPort(fromPort) || badPort(toPort)) return err("link: ports must be positive whole numbers.");
  const reason = linkBlockReason(a.id, b.id);
  if (reason) return err(reason);
  addLink(a.id, b.id, fromPort, toPort);
  return ok(`Linked ${a.name} ↔ ${b.name}.`);
}

function cmdUnlink(args: string[]): CommandResult {
  const a = resolveDevice(args[0]);
  if (typeof a === "string") return err(a);
  const b = resolveDevice(args[1]);
  if (typeof b === "string") return err(b);
  const before = state.links.length;
  state.links = state.links.filter(l =>
    !((l.from === a.id && l.to === b.id) || (l.from === b.id && l.to === a.id)));
  if (state.links.length === before) return err(`No link between ${a.name} and ${b.name}.`);
  sync().syncPanel();
  sync().render();
  return ok(`Unlinked ${a.name} ↔ ${b.name}.`);
}

function cmdLinkSet(args: string[]): CommandResult {
  // linkset <a> <b> name|bandwidth|latency|loss <value>
  const a = resolveDevice(args[0]);
  if (typeof a === "string") return err(a);
  const b = resolveDevice(args[1]);
  if (typeof b === "string") return err(b);
  const link = state.links.find(l => !l.hidden &&
    ((l.from === a.id && l.to === b.id) || (l.from === b.id && l.to === a.id)));
  if (!link) return err(`No link between ${a.name} and ${b.name}.`);
  const attr = (args[2] || "").toLowerCase();
  const value = args.slice(3).join(" "); // names may contain spaces
  pushUndo();
  if (attr === "name") {
    if (value) link.name = value; else delete link.name;
    sync().syncPanel(); sync().render();
    return ok(value ? `Named link ${a.name} ↔ ${b.name} "${value}".` : `Cleared link name.`);
  }
  if (attr === "bandwidth" || attr === "latency" || attr === "loss") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return err(`linkset: ${attr} must be a non-negative number (0 clears it).`);
    const v = attr === "loss" ? Math.min(100, n) : n;
    if (v > 0) (link as any)[attr] = v; else delete (link as any)[attr];
    sync().syncPanel(); sync().render();
    return ok(`Set ${a.name} ↔ ${b.name} ${attr} to ${v}.`);
  }
  return err(`linkset: expected "name|bandwidth|latency|loss <value>".`);
}

function cmdLinkState(args: string[], down: boolean): CommandResult {
  const a = resolveDevice(args[0]);
  if (typeof a === "string") return err(a);
  const b = resolveDevice(args[1]);
  if (typeof b === "string") return err(b);
  const link = state.links.find(l => !l.hidden &&
    ((l.from === a.id && l.to === b.id) || (l.from === b.id && l.to === a.id)));
  if (!link) return err(`No link between ${a.name} and ${b.name}.`);
  pushUndo();
  if (down) link.shutdown = true; else delete link.shutdown;
  sync().syncPanel();
  sync().render();
  return ok(`Link ${a.name} ↔ ${b.name} is now ${down ? "administratively down (shut)" : "up (no shut)"}.`);
}
function cmdShut(args: string[]): CommandResult { return cmdLinkState(args, true); }
function cmdNoShut(args: string[]): CommandResult { return cmdLinkState(args, false); }

function cmdMove(args: string[]): CommandResult {
  const device = resolveDevice(args[0]);
  if (typeof device === "string") return err(device);
  const x = Number(args[1]); const y = Number(args[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return err(`move: invalid coordinates.`);
  moveDevice(device, x, y);
  return ok(`Moved ${device.name} to ${x},${y}.`);
}

function cmdRename(args: string[]): CommandResult {
  const device = resolveDevice(args[0]);
  if (typeof device === "string") return err(device);
  const name = args[1];
  if (!name) return err(`rename: missing new name.`);
  device.name = name;
  sync().syncPanel(); sync().syncTerminal(); sync().render();
  return ok(`Renamed to ${name}.`);
}

function cmdClear(): CommandResult { clearNetwork(); return ok("Cleared network."); }

function cmdCollapse(args: string[]): CommandResult {
  const device = resolveDevice(args[0]);
  if (typeof device === "string") return err(device);
  collapseLan(device);
  return ok(`Collapsed LAN at ${device.name}.`);
}

function cmdExpand(args: string[]): CommandResult {
  const device = resolveDevice(args[0]);
  if (typeof device === "string") return err(device);
  expandLan(device);
  return ok(`Expanded ${device.name}.`);
}

// ── Config verbs (call the exported mutators directly — no mode machine) ──────

function hostMutator(args: string[], fn: (d: Device, v: string) => string): CommandResult {
  const device = resolveDevice(args[0]);
  if (typeof device === "string") return err(device);
  const msg = fn(device, args[1]);
  return msg.startsWith("Invalid") ? err(msg) : ok(msg);
}

function cmdIp(args: string[]): CommandResult { return hostMutator(args, setHostIp); }
function cmdGateway(args: string[]): CommandResult { return hostMutator(args, setHostGateway); }
function cmdNameserver(args: string[]): CommandResult { return hostMutator(args, setHostDns); }

function cmdMac(args: string[]): CommandResult {
  const device = resolveDevice(args[0]);
  if (typeof device === "string") return err(device);
  const mac = normaliseMacAddress(args[1] || "");
  if (!isValidMac(mac)) return err(`Invalid MAC address: ${args[1]}`);
  ensureConfig(device);
  device.config.macAddress = mac;
  sync().render();
  return ok(`Set ${device.name} MAC to ${mac}.`);
}

// ssid <laptop|access-point> <name> [password] — set the WiFi network a laptop
// joins or an access point broadcasts. An omitted password means open (and
// clears any existing one), so the export round-trip is faithful.
function cmdSsid(args: string[]): CommandResult {
  const device = resolveDevice(args[0]);
  if (typeof device === "string") return err(device);
  if (device.type !== "laptop" && device.type !== "access-point") {
    return err(`${device.name} is not a WiFi device — set an SSID on a laptop or access point.`);
  }
  const ssid = normaliseSsid(args[1] || "");
  if (!ssid) return err("Usage: ssid <laptop|access-point> <name> [password]");
  ensureConfig(device);
  device.config.ssid = ssid;
  const password = normaliseWifiPassword(args[2] ?? "");
  device.config.wifiPassword = password;
  sync().render();
  const role = device.type === "access-point" ? "broadcasts" : "joins";
  return ok(`${device.name} ${role} SSID "${ssid}"${password ? " (password set)" : ""}.`);
}

function cmdInterface(args: string[]): CommandResult {
  // interface <router> <peerRef> ip <addr> [vlan <tag>]
  const router = resolveDevice(args[0]);
  if (typeof router === "string") return err(router);
  const peer = resolveDevice(args[1]);
  if (typeof peer === "string") return err(peer);
  const ipIdx = args.indexOf("ip");
  if (ipIdx < 0 || !args[ipIdx + 1]) return err(`interface: expected "ip <addr>".`);
  const vlanIdx = args.indexOf("vlan");
  let vlanTag: number | null = null;
  if (vlanIdx >= 0) {
    vlanTag = Number(args[vlanIdx + 1]);
    if (!(Number.isInteger(vlanTag) && vlanTag >= 1 && vlanTag <= 4094)) return err(`interface: vlan tag must be 1-4094.`);
  }
  const msg = setRouterInterfaceIp(router, peer.id, args[ipIdx + 1], vlanTag);
  if (msg.startsWith("Invalid")) return err(msg);
  // setRouterInterfaceIp returns "" on success — synthesise a confirmation so the
  // command doesn't print a blank line, matching every other config verb.
  return ok(msg || `Set ${router.name} interface to ${peer.name}: ${args[ipIdx + 1]}${vlanTag ? ` (VLAN ${vlanTag})` : ""}.`);
}

function cmdRoute(args: string[]): CommandResult {
  // route <router> <network/prefix> <nextHop>
  const router = resolveDevice(args[0]);
  if (typeof router === "string") return err(router);
  const network = args[1]; const nextHop = args[2];
  if (!network || !nextHop) return err(`route: expected "<network/prefix> <nextHop>".`);
  ensureConfig(router);
  const routes = router.config.staticRoutes || [];
  routes.push({ network, nextHop });
  router.config.staticRoutes = normaliseStaticRoutes(routes);
  sync().syncPanel(); sync().render();
  return ok(`Added static route ${network} via ${nextHop} on ${router.name}.`);
}

function cmdVlan(args: string[]): CommandResult {
  const sw = resolveDevice(args[0]);
  if (typeof sw === "string") return err(sw);
  const action = (args[1] || "").toLowerCase();
  const id = args[2];
  if (action === "add") return mutatorResult(addSwitchVlan(sw, id));
  if (["del", "delete", "remove"].includes(action)) return mutatorResult(removeSwitchVlan(sw, id));
  return err(`vlan: expected "add|del <id>".`);
}

function cmdPort(args: string[]): CommandResult {
  // port <sw> <EthN> vlan <id> | mode <access|trunk> | native <id> | allowed add|remove <id>
  const sw = resolveDevice(args[0]);
  if (typeof sw === "string") return err(sw);
  const port = args[1]; const sub = (args[2] || "").toLowerCase();
  if (sub === "vlan") return mutatorResult(setSwitchPortVlan(sw, port, args[3]));
  if (sub === "mode") {
    const mode = (args[3] || "").toLowerCase();
    if (mode !== "access" && mode !== "trunk") return err(`port mode: expected "access|trunk".`);
    return mutatorResult(setSwitchPortMode(sw, port, mode));
  }
  if (sub === "native") return mutatorResult(setSwitchTrunkNative(sw, port, args[3]));
  if (sub === "allowed") {
    const act = (args[3] || "").toLowerCase();
    if (act !== "add" && act !== "remove") return err(`port allowed: expected "add|remove <id>".`);
    return mutatorResult(modifySwitchTrunkAllowed(sw, port, args[4], act));
  }
  return err(`port: expected "vlan|mode|native|allowed ...".`);
}

function cmdCli(args: string[], rest: string): CommandResult {
  const device = resolveDevice(args[0]);
  if (typeof device === "string") return err(device);
  const line = rest.slice(args[0].length).trim();
  if (!line) return err(`cli: missing command.`);
  // Attach to (or silently create) the device's terminal session — its CLI
  // mode persists across cli calls, so multi-line vtysh scripts work.
  if (state.terminal.deviceId !== device.id) {
    state.terminal = ensureSession(device);
  }
  // Hold the session: an exec-level `exit` may close it mid-command, and the
  // output still lives on the closed session's buffer.
  const session = state.terminal;
  const before = session.lines.length;
  runTerminalCommand(line);
  sync().syncTerminal(); // keep the dock's terminal pane/prompt in step
  return ok(...session.lines.slice(before).map(l => l.text));
}

// ── Simulation ───────────────────────────────────────────────────────────────

function cmdPing(args: string[]): CommandResult {
  const src = resolveDevice(args[0]);
  if (typeof src === "string") return err(src);
  const dst = args[1];
  if (!dst) return err(`ping: missing target.`);
  const setup = buildPingEvents(src, dst);
  if (typeof setup === "string") return err(setup);
  startSimulation(setup, src.id, targetIpFor(dst), "ping");
  return ok(`Ping ${src.name} → ${dst} started.`);
}

function cmdConnect(args: string[]): CommandResult {
  const src = resolveDevice(args[0]);
  if (typeof src === "string") return err(src);
  const dst = args[1];
  const port = Number(args[2]);
  if (!dst || !args[2]) return err(`connect: expected "connect <src> <dst> <port>".`);
  const setup = buildConnectEvents(src, dst, port);
  if (typeof setup === "string") return err(setup);
  startSimulation(setup, src.id, targetIpFor(dst), "tcp", port);
  return ok(`TCP connect ${src.name} → ${dst}:${port} started.`);
}

function cmdDhcp(args: string[]): CommandResult {
  const host = resolveDevice(args[0]);
  if (typeof host === "string") return err(host);
  const setup = buildDhcpEvents(host);
  if (typeof setup === "string") return err(setup);
  startSimulation(setup, host.id, "", "dhcp");
  return ok(`DHCP on ${host.name} started.`);
}

function cmdAssociate(args: string[]): CommandResult {
  const laptop = resolveDevice(args[0]);
  if (typeof laptop === "string") return err(laptop);
  const setup = buildAssociationEvents(laptop);
  if (typeof setup === "string") return err(setup);
  const ssid = associatedAp(laptop)?.ap.config?.ssid || "";
  startSimulation(setup, laptop.id, ssid, "associate");
  return ok(`Associating ${laptop.name} to "${ssid}"...`);
}

// 802.1X: set a host's supplicant identity/password.
function cmdSupplicant(args: string[]): CommandResult {
  const host = resolveDevice(args[0]);
  if (typeof host === "string") return err(host);
  if (!["computer", "laptop", "server"].includes(host.type)) return err(`${host.name} is not a host.`);
  const identity = args[1], password = args[2];
  if (!identity || password == null) return err("Usage: supplicant <host> <identity> <password>");
  ensureConfig(host);
  host.config.dot1x = { identity, password };
  sync().syncPanel();
  return ok(`${host.name} 802.1X supplicant: identity "${identity}".`);
}

// 802.1X: set a switch port's authentication mode (the authenticator).
function cmdPortAuth(args: string[]): CommandResult {
  const sw = resolveDevice(args[0]);
  if (typeof sw === "string") return err(sw);
  if (sw.type !== "switch") return err(`${sw.name} is not a switch.`);
  const portMatch = (args[1] || "").trim().match(/^(?:ethernet|eth|e)?\s*(\d+)$/i);
  const port = portMatch ? `Ethernet${portMatch[1]}` : "";
  const mode = (args[2] || "").toLowerCase();
  if (!port) return err("Usage: portauth <switch> <EthN> <auto|force-authorized|force-unauthorized>");
  if (!["auto", "force-authorized", "force-unauthorized"].includes(mode)) return err("portauth mode: auto|force-authorized|force-unauthorized");
  ensureConfig(sw);
  sw.config.portAuth = sw.config.portAuth || {};
  sw.config.portAuth[port] = mode as any;
  sync().syncPanel();
  return ok(`${sw.name} ${port} 802.1X port-control: ${mode}.`);
}

// 802.1X: add/update a RADIUS user on a server (enables the RADIUS back end).
function cmdRadius(args: string[]): CommandResult {
  const server = resolveDevice(args[0]);
  if (typeof server === "string") return err(server);
  if (server.type !== "server") return err(`${server.name} is not a server.`);
  const identity = args[1], password = args[2];
  if (!identity || password == null) return err("Usage: radius <server> <identity> <password>");
  ensureConfig(server);
  const cfg: any = server.config;
  cfg.radius = cfg.radius || { users: [] };
  const existing = cfg.radius.users.find((u: any) => u.identity === identity);
  if (existing) existing.password = password; else cfg.radius.users.push({ identity, password });
  sync().syncPanel();
  return ok(`${server.name} RADIUS user "${identity}" set.`);
}

// Set a host's listening TCP ports (the simple "is this port open?" model nc/
// connect use). Comma- or space-separated; "none"/"off"/"clear" removes them.
function cmdPorts(args: string[]): CommandResult {
  const host = resolveDevice(args[0]);
  if (typeof host === "string") return err(host);
  if (!["computer", "laptop", "server"].includes(host.type)) return err(`${host.name} is not a host (only computers/laptops/servers listen on ports).`);
  const spec = args.slice(1).join(" ").trim();
  ensureConfig(host);
  const cfg: any = host.config;
  if (!spec || /^(none|off|clear)$/i.test(spec)) {
    delete cfg.openPorts;
    sync().syncPanel();
    return ok(`${host.name}: listening ports cleared.`);
  }
  const ports = spec.split(/[\s,]+/).filter(Boolean).map(Number);
  if (!ports.every(p => Number.isInteger(p) && p >= 1 && p <= 65535)) return err("ports: each port must be an integer 1–65535.");
  cfg.openPorts = [...new Set(ports)];
  sync().syncPanel();
  return ok(`${host.name} listening on ${cfg.openPorts.join(", ")}.`);
}

// MACsec: set (or clear, with "off") the pre-shared key for the link to a peer.
function cmdMacsec(args: string[]): CommandResult {
  const dev = resolveDevice(args[0]);
  if (typeof dev === "string") return err(dev);
  const peer = resolveDevice(args[1]);
  if (typeof peer === "string") return err(peer);
  const key = args[2];
  if (!key) return err("Usage: macsec <device> <peer> <key|dot1x> [must|should]  (key 'off' clears)");
  ensureConfig(dev);
  const cfg: any = dev.config;
  cfg.macsec = cfg.macsec || {};
  if (key.toLowerCase() === "off" || key.toLowerCase() === "none") {
    delete cfg.macsec[peer.id];
    sync().render();
    return ok(`MACsec cleared on ${dev.name} ↔ ${peer.name}.`);
  }
  const mode = (args[3] || "should").toLowerCase() === "must" ? "must" : "should";
  if (key.toLowerCase() === "dot1x" || key.toLowerCase() === "mka") {
    cfg.macsec[peer.id] = { derive: true, mode };
    sync().render();
    return ok(`${dev.name} ↔ ${peer.name}: MACsec keyed from 802.1X (${mode}-secure).`);
  }
  cfg.macsec[peer.id] = { cak: key, mode };
  sync().render();
  return ok(`${dev.name} ↔ ${peer.name}: MACsec key set (${mode}-secure).`);
}

function cmdDot1x(args: string[]): CommandResult {
  const host = resolveDevice(args[0]);
  if (typeof host === "string") return err(host);
  const setup = buildDot1xEvents(host);
  if (typeof setup === "string") return err(setup);
  startSimulation(setup, host.id, host.config?.dot1x?.identity || "", "dot1x");
  return ok(`802.1X authentication started for ${host.name}.`);
}

function cmdRun(args: string[]): CommandResult {
  const mode = (args[0] || "").toLowerCase();
  if (mode === "dot1x") {
    const host = resolveDevice(args[1]);
    if (typeof host === "string") return err(host);
    const setup = buildDot1xEvents(host);
    if (typeof setup === "string") return err(setup);
    const r = runSimulationHeadless(setup, host.id, "", "dot1x");
    return { ok: r.success, data: r,
      output: [r.success ? `dot1x: ${host.name} authenticated — port authorised (${r.steps} frames)` : `dot1x: authentication failed`] };
  }
  if (mode === "associate") {
    const laptop = resolveDevice(args[1]);
    if (typeof laptop === "string") return err(laptop);
    const setup = buildAssociationEvents(laptop);
    if (typeof setup === "string") return err(setup);
    const r = runSimulationHeadless(setup, laptop.id, "", "associate");
    return { ok: r.success, data: r,
      output: [r.success ? `associate: ${laptop.name} joined the WiFi (${r.steps} frames)` : "associate: handshake did not complete"] };
  }
  if (mode === "ping") {
    const src = resolveDevice(args[1]);
    if (typeof src === "string") return err(src);
    const dst = args[2];
    if (!dst) return err(`run ping: missing target.`);
    const setup = buildPingEvents(src, dst);
    if (typeof setup === "string") return err(setup);
    const r = runSimulationHeadless(setup, src.id, targetIpFor(dst), "ping");
    return { ok: r.success, data: r,
      output: [`ping ${dst}: ${r.success ? `reachable (ttl=${r.ttl})` : "unreachable"} — ${r.steps} steps`] };
  }
  if (mode === "connect" || mode === "tcp") {
    const src = resolveDevice(args[1]);
    if (typeof src === "string") return err(src);
    const dst = args[2];
    const port = Number(args[3]);
    if (!dst || !args[3]) return err(`run connect: expected "run connect <src> <dst> <port>".`);
    const setup = buildConnectEvents(src, dst, port);
    if (typeof setup === "string") return err(setup);
    const r = runSimulationHeadless(setup, src.id, targetIpFor(dst), "tcp", port);
    return { ok: r.success, data: r,
      output: [`connect ${dst}:${port}: ${r.success ? "open (handshake completed)" : r.refused ? "refused (RST)" : "timed out"} — ${r.steps} steps`] };
  }
  if (mode === "dhcp") {
    const host = resolveDevice(args[1]);
    if (typeof host === "string") return err(host);
    const setup = buildDhcpEvents(host);
    if (typeof setup === "string") return err(setup);
    const r = runSimulationHeadless(setup, host.id, "", "dhcp");
    return { ok: r.success, data: r,
      output: [r.success ? `dhcp: assigned ${r.assignedIp} (gw ${r.assignedGateway})` : "dhcp: no response"] };
  }
  if (mode === "resolve" || mode === "dns") {
    const src = resolveDevice(args[1]);
    if (typeof src === "string") return err(src);
    const name = args[2];
    if (!name) return err(`run resolve: expected "run resolve <src> <name>".`);
    const setup = buildResolveEvents(src, name, null, null);
    if (typeof setup === "string") return err(setup);
    const r = runSimulationHeadless(setup, src.id, name, "dns");
    return { ok: r.success, data: r,
      output: [`resolve ${name}: ${r.resolvedIp || "no answer"} — ${r.steps} steps`] };
  }
  return err(`run: expected "ping <src> <dst>", "connect <src> <dst> <port>", "resolve <src> <name>", or "dhcp <host>".`);
}

function cmdTraceroute(args: string[]): CommandResult {
  const src = resolveDevice(args[0]);
  if (typeof src === "string") return err(src);
  const dst = args[1];
  if (!dst) return err(`traceroute: expected "traceroute <src> <dst>".`);
  const result = runTraceroute(src, dst);
  if (typeof result === "string") return err(result);
  const lines = [`traceroute to ${result.targetIp}, 30 hops max`];
  for (const hop of result.hops) lines.push(` ${hop.ttl}  ${hop.ip || "* (no response)"}`);
  if (!result.reached) lines.push("(destination not reached within 30 hops)");
  return { ok: result.reached, data: result, output: lines };
}

function cmdPlay(): CommandResult { resumeSimulation(); return ok("Resumed."); }
function cmdPause(): CommandResult { pauseSimulation(); return ok("Paused."); }
function cmdStep(): CommandResult { stepOnce(); return ok(`Stepped (step ${state.simulation.stepIndex}).`); }
function cmdStop(): CommandResult { stopSimulation(); return ok("Stopped."); }
function cmdSpeed(args: string[]): CommandResult {
  const ms = Number(args[0]);
  if (!Number.isFinite(ms) || ms <= 0) return err(`speed: expected a positive number of ms.`);
  // Clamp to the same range the slider and the URL `speed` setting use.
  const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(ms)));
  state.simulation.speed = clamped;
  dom.simSpeed.value = String(clamped);
  return ok(`Speed set to ${clamped} ms/hop.`);
}

// ── Management ───────────────────────────────────────────────────────────────

function cmdTopology(args: string[]): CommandResult {
  const name = (args[0] || "").toLowerCase();
  if (!["basic", "vlan-roas", "router-mesh", "wifi-vlan"].includes(name)) {
    return err(`topology: expected basic|vlan-roas|router-mesh|wifi-vlan.`);
  }
  loadTopology(name);
  return ok(`Loaded topology "${name}".`);
}

function cmdSave(args: string[]): CommandResult {
  const name = args[0];
  if (!name) return err(`save: missing name.`);
  state.configStore.configs[name] = buildConfigPayload();
  return ok(`Saved current topology as "${name}".`);
}

function cmdLoad(args: string[]): CommandResult {
  const name = args[0];
  const stored = state.configStore.configs[name];
  if (!stored) return err(`No saved config named "${name}".`);
  applyConfig(normaliseConfig(stored));
  return ok(`Loaded "${name}".`);
}

function cmdUndo(): CommandResult { undo(); return ok("Undone."); }
function cmdRedo(): CommandResult { redo(); return ok("Redone."); }

function cmdExport(): CommandResult {
  const script = exportTopologyScript();
  return { ok: true, output: script.split("\n"), data: script };
}

// ── Query ────────────────────────────────────────────────────────────────────

function cmdList(args: string[]): CommandResult {
  if ((args[0] || "").toLowerCase() === "links") {
    if (!state.links.length) return ok("(no links)");
    return ok(...state.links.map(l => linkName(l)));
  }
  const devices = state.devices.filter(d => d.type !== "lan");
  if (!devices.length) return ok("(no devices)");
  return ok(...devices.map(d => `${d.name} (${d.type}) at ${Math.round(d.x)},${Math.round(d.y)}`));
}

function cmdShow(args: string[]): CommandResult {
  const device = resolveDevice(args[0]);
  if (typeof device === "string") return err(device);
  const c: any = device.config || {};
  const lines = [`${device.name} (${device.type})`];
  if (device.type === "computer" || device.type === "laptop" || device.type === "server") {
    lines.push(
      `  ip: ${c.ipv4Address ? `${c.ipv4Address}/${prefixOf(c)} (subnet ${networkOf(c.ipv4Address, prefixOf(c))})` : "(unset)"}`,
      `  gateway: ${c.gatewayIpv4Address || "(unset)"}`,
      `  mac: ${c.macAddress || "(unset)"}`
    );
    if (c.dnsServerIp) lines.push(`  nameserver: ${c.dnsServerIp}`);
    if (device.type === "laptop") lines.push(`  ssid: ${c.ssid || "(none)"}${c.wifiPassword ? " (secured)" : ""}`);
    if (device.type === "server") {
      lines.push(`  dnsmasq: ${c.dnsmasqRunning !== false ? "running" : "stopped"}`);
      for (const r of (c.dnsRecords || [])) lines.push(`  dns: ${r.name} → ${r.ip}`);
      if (c.dhcpRangeStart && c.dhcpRangeEnd) lines.push(`  dhcp-range: ${c.dhcpRangeStart} – ${c.dhcpRangeEnd}`);
      if (c.dhcpRouterIp) lines.push(`  dhcp router option: ${c.dhcpRouterIp}`);
    }
  } else if (device.type === "access-point") {
    lines.push(`  ssid: ${c.ssid || "(none)"}${c.wifiPassword ? " (secured)" : " (open)"}`, `  uplink ports: ${c.ethernetPorts ?? 1}`);
  } else if (device.type === "switch") {
    lines.push(`  managed: ${Boolean(c.managed)}`, `  ports: ${c.ethernetPorts ?? 8}`);
    if (c.managed && c.vlans?.length) lines.push(`  vlans: ${c.vlans.map((v: any) => v.id).join(", ")}`);
  } else if (device.type === "router") {
    for (const i of (c.interfaces || [])) lines.push(`  iface → ${getDevice(i.peerId)?.name || i.peerId}: ${i.ipv4Address ? `${i.ipv4Address}/${prefixOf(i)}` : "(unset)"}`);
    if (c.staticRoutes?.length) lines.push(`  routes: ${c.staticRoutes.map((r: any) => `${r.network}→${r.nextHop}`).join(", ")}`);
    if (c.rip?.enabled) lines.push(`  rip: enabled`);
  }
  return ok(...lines);
}

function cmdStatus(): CommandResult {
  const sim = state.simulation;
  const lines = [`simulation: ${sim.status}`];
  if (sim.mode === "dhcp") lines.push(`dhcp: ${sim.dhcpSuccess ? `assigned ${sim.dhcpAssignedIp}` : "no result"}`);
  else lines.push(`ping: ${sim.pingSuccess ? `success (ttl=${sim.pingTtl})` : "no result"}`);
  lines.push(`devices: ${state.devices.length}, links: ${state.links.length}`);
  return ok(...lines);
}

function cmdLog(): CommandResult {
  const log = state.simulation.log;
  if (!log.length) return ok("(no simulation log)");
  return ok(...log.map(e => `[${e.step}] ${e.deviceName}: ${e.summary || e.action}`));
}

// ── View ─────────────────────────────────────────────────────────────────────

function cmdSelect(args: string[]): CommandResult {
  const device = resolveDevice(args[0]);
  if (typeof device === "string") return err(device);
  state.selectedId = device.id;
  state.selectedLinkId = null;
  sync().syncPanel(); sync().render();
  return ok(`Selected ${device.name}.`);
}

function cmdTool(args: string[]): CommandResult {
  const tool = (args[0] || "").toLowerCase();
  const tools = ["select", ...USER_ADDABLE_TYPES, "connect", "configure"];
  if (!tools.includes(tool)) {
    return err(`tool: expected ${tools.join("|")}.`);
  }
  setTool(tool);
  return ok(`Tool: ${tool}.`);
}

function cmdTheme(args: string[]): CommandResult {
  const raw = (args[0] || "").toLowerCase();
  const theme = raw === "light" ? "warm-light" : raw; // back-compat alias
  if (!THEMES.some(t => t.id === theme)) {
    return err(`theme: expected ${THEMES.map(t => t.id).join("|")}.`);
  }
  setTheme(theme);
  return ok(`Theme: ${theme}.`);
}

function cmdZoom(args: string[]): CommandResult {
  const scale = Number(args[0]);
  if (!Number.isFinite(scale)) return err(`zoom: expected a scale number.`);
  const rect = dom.canvas.getBoundingClientRect();
  setZoom(scale, { x: rect.width / 2, y: rect.height / 2 });
  return ok(`Zoom: ${Math.round(state.scale * 100)}%.`);
}

function cmdFit(): CommandResult { fitNetwork(); return ok("Fit to view."); }

// ── Scenarios ────────────────────────────────────────────────────────────────

function cmdScenario(args: string[]): CommandResult {
  const sub = (args[0] || "").toLowerCase();
  if (sub === "list") {
    return ok(...SCENARIOS.map(s => `${s.id} — ${s.name}`));
  }
  if (sub === "load") {
    return loadScenario(args[1]) ? ok(`Loaded scenario "${args[1]}".`) : err(`No scenario "${args[1]}".`);
  }
  const active = getScenario(state.activeScenarioId);
  if (sub === "goal") {
    if (!active) return err("No active scenario. Try `scenario load <id>`.");
    return ok(active.objective, ...active.checks.map(c => `  - ${c.label}`));
  }
  if (sub === "check") {
    if (!active) return err("No active scenario. Try `scenario load <id>`.");
    const r = checkScenario(active);
    return {
      ok: r.passed,
      data: r,
      output: [...r.checks.map(c => `${c.passed ? "✓" : "✗"} ${c.label}`),
        r.passed ? "Scenario complete!" : "Not yet — keep going."],
    };
  }
  return err("scenario: expected list|load <id>|goal|check.");
}

// ── Meta ─────────────────────────────────────────────────────────────────────

function cmdHelp(args: string[]): CommandResult {
  if (args[0] && HELP[args[0].toLowerCase()]) return ok(`${args[0]} — ${HELP[args[0].toLowerCase()]}`);
  return ok("Commands:", ...Object.keys(COMMANDS).sort().map(v => `  ${v} — ${HELP[v] || ""}`));
}

// ── Registry ─────────────────────────────────────────────────────────────────

type Handler = (args: string[], rest: string) => CommandResult;

const COMMANDS: Record<string, Handler> = {
  add: cmdAdd, remove: cmdRemove, delete: cmdRemove, link: cmdLink, unlink: cmdUnlink, linkset: cmdLinkSet,
  shut: cmdShut, noshut: cmdNoShut,
  move: cmdMove, rename: cmdRename, clear: cmdClear, collapse: cmdCollapse, expand: cmdExpand,
  ip: cmdIp, gateway: cmdGateway, nameserver: cmdNameserver, mac: cmdMac, ssid: cmdSsid, interface: cmdInterface, route: cmdRoute,
  supplicant: cmdSupplicant, portauth: cmdPortAuth, radius: cmdRadius, ports: cmdPorts, dot1x: cmdDot1x, macsec: cmdMacsec,
  vlan: cmdVlan, port: cmdPort, cli: cmdCli,
  ping: cmdPing, dhcp: cmdDhcp, connect: cmdConnect, associate: cmdAssociate, run: cmdRun, traceroute: cmdTraceroute, tracert: cmdTraceroute,
  play: cmdPlay, pause: cmdPause, step: cmdStep,
  stop: cmdStop, speed: cmdSpeed,
  topology: cmdTopology, save: cmdSave, load: cmdLoad, undo: cmdUndo, redo: cmdRedo, export: cmdExport,
  list: cmdList, show: cmdShow, status: cmdStatus, log: cmdLog,
  select: cmdSelect, tool: cmdTool, theme: cmdTheme, zoom: cmdZoom, fit: cmdFit,
  scenario: cmdScenario,
  help: cmdHelp,
};

const HELP: Record<string, string> = {
  add: "add <computer|laptop|server|switch|router|firewall|hub|access-point> [name] [at <x> <y>]",
  remove: "remove <device>", link: "link <a> <b> [portA portB]", unlink: "unlink <a> <b>",
  linkset: "linkset <a> <b> name|bandwidth|latency|loss <value> (0 clears a number)",
  shut: "shut <a> <b> (administratively down the link)", noshut: "noshut <a> <b> (bring the link up)",
  move: "move <device> <x> <y>", rename: "rename <device> <name>", clear: "remove all devices",
  collapse: "collapse <switch> into a LAN", expand: "expand <lan>",
  ip: "ip <host> <addr/prefix>", gateway: "gateway <host> <ip>", nameserver: "nameserver <host> <ip>", mac: "mac <host> <addr>",
  ssid: "ssid <laptop|access-point> <name> [password] (omit password = open)",
  supplicant: "supplicant <host> <identity> <password> (set 802.1X credentials)",
  portauth: "portauth <switch> <EthN> <auto|force-authorized|force-unauthorized>",
  radius: "radius <server> <identity> <password> (add a RADIUS user, enables the back end)",
  ports: "ports <host> <port[,port…]> (set the host's listening TCP ports; 'none' clears)",
  dot1x: "dot1x <host> (animate the 802.1X EAP/RADIUS exchange)",
  macsec: "macsec <device> <peer> <key|dot1x> [must|should] (802.1AE link encryption; 'dot1x' derives keys from 802.1X, 'off' clears)",
  interface: "interface <router> <peer> ip <addr> [vlan <tag>]", route: "route <router> <net/prefix> <nextHop>",
  vlan: "vlan <switch> add|del <id>", port: "port <switch> <EthN> vlan|mode|native|allowed ...",
  cli: "cli <device> <raw CLI command>",
  ping: "ping <src> <dst> (animated)", dhcp: "dhcp <host> (animated)", connect: "connect <src> <dst> <port> (animated TCP handshake)",
  associate: "associate <laptop> (animate the 802.11 join: probe/auth/assoc + WPA2 if secured)",
  run: "run ping <src> <dst> | run connect <src> <dst> <port> | run resolve <src> <name> | run dhcp <host> | run associate <laptop> (headless, returns result)",
  traceroute: "traceroute <src> <dst> (hop-by-hop via TTL)",
  play: "resume", pause: "pause", step: "advance one hop", stop: "stop", speed: "speed <ms-per-hop>",
  topology: "topology basic|vlan-roas|router-mesh|wifi-vlan", save: "save <name>", load: "load <name>",
  undo: "undo", redo: "redo", export: "export topology as a reproducible script",
  list: "list [links]", show: "show <device>", status: "simulation status + last result", log: "hop-by-hop log",
  select: "select <device>", tool: "tool <name>", theme: "theme warm-light|dark|blueprint", zoom: "zoom <scale>", fit: "fit to view",
  scenario: "scenario list | load <id> | goal | check",
  help: "help [command]",
};

// ── Entry points ─────────────────────────────────────────────────────────────

export function runConsoleCommand(line: string): CommandResult {
  const trimmed = (line || "").trim();
  if (!trimmed || trimmed.startsWith("#")) return ok();
  const tokens = trimmed.split(/\s+/);
  const verb = tokens[0].toLowerCase();
  const handler = COMMANDS[verb];
  if (!handler) return err(`Unknown command: ${verb}. Try "help".`);
  const rest = trimmed.slice(tokens[0].length).trim();
  try {
    return handler(tokens.slice(1), rest);
  } catch (e: any) {
    return err(`Error: ${e?.message || String(e)}`);
  }
}

export function runConsoleScript(text: string): CommandResult[] {
  return (text || "")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#"))
    .map(runConsoleCommand);
}

/**
 * Serialises the current topology to a reproducible command script. Running the
 * output through runConsoleScript() recreates the topology (round-trip): devices
 * + positions, host/router/switch config, links (ports, admin status, and
 * name/bandwidth/latency/loss via `linkset`).
 */
export function exportTopologyScript(): string {
  const payload: any = buildConfigPayload();
  const idToName = new Map<string, string>(payload.devices.map((d: any) => [d.id, d.name]));
  const lines: string[] = ["clear"];

  for (const d of payload.devices) {
    if (d.type === "lan") continue;
    lines.push(`add ${d.type} ${d.name} at ${Math.round(d.x)} ${Math.round(d.y)}`);
  }

  for (const d of payload.devices) {
    const c = d.config || {};
    if (d.type === "computer" || d.type === "laptop" || d.type === "server") {
      if (c.ipv4Address) lines.push(`ip ${d.name} ${c.ipv4Address}/${prefixOf(c)}`);
      if (c.gatewayIpv4Address) lines.push(`gateway ${d.name} ${c.gatewayIpv4Address}`);
      if (c.macAddress) lines.push(`mac ${d.name} ${c.macAddress}`);
      if (c.dnsServerIp) lines.push(`nameserver ${d.name} ${c.dnsServerIp}`);
      if (d.type === "laptop" && c.ssid) lines.push(`ssid ${d.name} ${c.ssid}${c.wifiPassword ? ` ${c.wifiPassword}` : ""}`);
      // dnsmasq state replays through the server terminal (same as a human would type).
      for (const r of (c.dnsRecords || [])) lines.push(`cli ${d.name} echo address=/${r.name}/${r.ip} >> /etc/dnsmasq.conf`);
      if (c.dhcpRangeStart && c.dhcpRangeEnd) lines.push(`cli ${d.name} echo dhcp-range=${c.dhcpRangeStart},${c.dhcpRangeEnd} >> /etc/dnsmasq.conf`);
      if (c.dhcpRouterIp) lines.push(`cli ${d.name} echo dhcp-option=option:router,${c.dhcpRouterIp} >> /etc/dnsmasq.conf`);
      if (d.type === "server" && c.dnsmasqRunning === false) lines.push(`cli ${d.name} systemctl stop dnsmasq`);
      if (c.dot1x?.identity) lines.push(`supplicant ${d.name} ${c.dot1x.identity} ${c.dot1x.password || ""}`.trimEnd());
      for (const u of (c.radius?.users || [])) lines.push(`radius ${d.name} ${u.identity} ${u.password || ""}`.trimEnd());
      if (Array.isArray(c.openPorts) && c.openPorts.length) lines.push(`ports ${d.name} ${c.openPorts.join(",")}`);
    } else if (d.type === "switch") {
      if (c.managed) {
        for (const v of (c.vlans || [])) if (v.id !== 1) lines.push(`vlan ${d.name} add ${v.id}`);
        for (const [port, mode] of Object.entries(c.portModes || {})) lines.push(`port ${d.name} ${port} mode ${mode}`);
        for (const [port, id] of Object.entries(c.portVlans || {})) lines.push(`port ${d.name} ${port} vlan ${id}`);
        for (const [port, id] of Object.entries(c.trunkNativeVlans || {})) lines.push(`port ${d.name} ${port} native ${id}`);
        for (const [port, ids] of Object.entries(c.trunkAllowedVlans || {})) {
          for (const id of (ids as number[])) lines.push(`port ${d.name} ${port} allowed add ${id}`);
        }
      }
      for (const [port, mode] of Object.entries(c.portAuth || {})) lines.push(`portauth ${d.name} ${port} ${mode}`);
    } else if (d.type === "router") {
      for (const i of (c.interfaces || [])) {
        const peer = idToName.get(i.peerId);
        if (peer && i.ipv4Address) {
          lines.push(`interface ${d.name} ${peer} ip ${i.ipv4Address}/${prefixOf(i)}${i.vlanTag != null ? ` vlan ${i.vlanTag}` : ""}`);
        }
      }
      for (const r of (c.staticRoutes || [])) lines.push(`route ${d.name} ${r.network} ${r.nextHop}`);
    } else if (d.type === "access-point" && c.ssid) {
      lines.push(`ssid ${d.name} ${c.ssid}${c.wifiPassword ? ` ${c.wifiPassword}` : ""}`);
    }
    // MACsec keys (any device, keyed by peer) — each end emits its own.
    for (const [peerId, m] of Object.entries((c.macsec || {}) as Record<string, any>)) {
      const peer = idToName.get(peerId);
      if (peer) lines.push(`macsec ${d.name} ${peer} ${m.derive ? "dot1x" : m.cak} ${m.mode}`);
    }
  }

  for (const l of payload.links) {
    const f = idToName.get(l.from); const t = idToName.get(l.to);
    if (!f || !t) continue;
    const ports = (l.fromPort != null || l.toPort != null) ? ` ${l.fromPort ?? 1} ${l.toPort ?? 1}` : "";
    lines.push(`link ${f} ${t}${ports}`);
    if (l.shutdown) lines.push(`shut ${f} ${t}`);
    if (l.name) lines.push(`linkset ${f} ${t} name ${l.name}`);
    if (l.bandwidth) lines.push(`linkset ${f} ${t} bandwidth ${l.bandwidth}`);
    if (l.latency) lines.push(`linkset ${f} ${t} latency ${l.latency}`);
    if (l.loss) lines.push(`linkset ${f} ${t} loss ${l.loss}`);
  }

  return lines.join("\n");
}
