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
  addDevice, addLink, deleteSelection, clearNetwork, collapseLan, expandLan,
  getDevice, moveDevice, linkName,
} from "./devices";
import {
  startSimulation, stopSimulation, pauseSimulation, resumeSimulation, stepOnce,
  runSimulationHeadless, runTraceroute,
} from "./engine";
import { buildPingEvents, buildDhcpEvents, buildConnectEvents, buildResolveEvents, findPingTarget } from "./simulation";
import {
  setHostIp, setHostGateway, setHostDns, setRouterInterfaceIp, addSwitchVlan, removeSwitchVlan,
  setSwitchPortVlan, setSwitchPortMode, setSwitchTrunkNative, modifySwitchTrunkAllowed,
  runTerminalCommand, ensureSession,
} from "./terminal";
import { buildConfigPayload, applyConfig, loadTopology } from "./config";
import { normaliseConfig, normaliseStaticRoutes, ensureConfig } from "./normalise";
import { setTool, setTheme } from "./ui";
import { setZoom, fitNetwork } from "./canvas";
import { isValidMac, normaliseMacAddress, prefixOf, networkOf } from "./utils";
import { SCENARIOS, getScenario, loadScenario, checkScenario } from "./scenarios";

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
  return msg.startsWith("Invalid") ? err(msg) : ok(msg);
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

function cmdRun(args: string[]): CommandResult {
  const mode = (args[0] || "").toLowerCase();
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
  state.simulation.speed = ms;
  return ok(`Speed set to ${ms} ms/hop.`);
}

// ── Management ───────────────────────────────────────────────────────────────

function cmdTopology(args: string[]): CommandResult {
  const name = (args[0] || "").toLowerCase();
  if (!["basic", "vlan-roas", "router-mesh"].includes(name)) {
    return err(`topology: expected basic|vlan-roas|router-mesh.`);
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
  if (device.type === "computer" || device.type === "server") {
    lines.push(
      `  ip: ${c.ipv4Address ? `${c.ipv4Address}/${prefixOf(c)} (subnet ${networkOf(c.ipv4Address, prefixOf(c))})` : "(unset)"}`,
      `  gateway: ${c.gatewayIpv4Address || "(unset)"}`,
      `  mac: ${c.macAddress || "(unset)"}`
    );
    if (c.dnsServerIp) lines.push(`  nameserver: ${c.dnsServerIp}`);
    if (device.type === "server") {
      lines.push(`  dnsmasq: ${c.dnsmasqRunning !== false ? "running" : "stopped"}`);
      for (const r of (c.dnsRecords || [])) lines.push(`  dns: ${r.name} → ${r.ip}`);
      if (c.dhcpRangeStart && c.dhcpRangeEnd) lines.push(`  dhcp-range: ${c.dhcpRangeStart} – ${c.dhcpRangeEnd}`);
      if (c.dhcpRouterIp) lines.push(`  dhcp router option: ${c.dhcpRouterIp}`);
    }
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
  add: cmdAdd, remove: cmdRemove, delete: cmdRemove, link: cmdLink, unlink: cmdUnlink,
  shut: cmdShut, noshut: cmdNoShut,
  move: cmdMove, rename: cmdRename, clear: cmdClear, collapse: cmdCollapse, expand: cmdExpand,
  ip: cmdIp, gateway: cmdGateway, nameserver: cmdNameserver, mac: cmdMac, interface: cmdInterface, route: cmdRoute,
  vlan: cmdVlan, port: cmdPort, cli: cmdCli,
  ping: cmdPing, dhcp: cmdDhcp, connect: cmdConnect, run: cmdRun, traceroute: cmdTraceroute, tracert: cmdTraceroute,
  play: cmdPlay, pause: cmdPause, step: cmdStep,
  stop: cmdStop, speed: cmdSpeed,
  topology: cmdTopology, save: cmdSave, load: cmdLoad, undo: cmdUndo, redo: cmdRedo, export: cmdExport,
  list: cmdList, show: cmdShow, status: cmdStatus, log: cmdLog,
  select: cmdSelect, tool: cmdTool, theme: cmdTheme, zoom: cmdZoom, fit: cmdFit,
  scenario: cmdScenario,
  help: cmdHelp,
};

const HELP: Record<string, string> = {
  add: "add <computer|server|switch|router|firewall|hub> [name] [at <x> <y>]",
  remove: "remove <device>", link: "link <a> <b> [portA portB]", unlink: "unlink <a> <b>",
  shut: "shut <a> <b> (administratively down the link)", noshut: "noshut <a> <b> (bring the link up)",
  move: "move <device> <x> <y>", rename: "rename <device> <name>", clear: "remove all devices",
  collapse: "collapse <switch> into a LAN", expand: "expand <lan>",
  ip: "ip <host> <addr/prefix>", gateway: "gateway <host> <ip>", nameserver: "nameserver <host> <ip>", mac: "mac <host> <addr>",
  interface: "interface <router> <peer> ip <addr> [vlan <tag>]", route: "route <router> <net/prefix> <nextHop>",
  vlan: "vlan <switch> add|del <id>", port: "port <switch> <EthN> vlan|mode|native|allowed ...",
  cli: "cli <device> <raw CLI command>",
  ping: "ping <src> <dst> (animated)", dhcp: "dhcp <host> (animated)", connect: "connect <src> <dst> <port> (animated TCP handshake)",
  run: "run ping <src> <dst> | run connect <src> <dst> <port> | run resolve <src> <name> | run dhcp <host> (headless, returns result)",
  traceroute: "traceroute <src> <dst> (hop-by-hop via TTL)",
  play: "resume", pause: "pause", step: "advance one hop", stop: "stop", speed: "speed <ms-per-hop>",
  topology: "topology basic|vlan-roas|router-mesh", save: "save <name>", load: "load <name>",
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
 * output through runConsoleScript() recreates the topology (round-trip).
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
    if (d.type === "computer" || d.type === "server") {
      if (c.ipv4Address) lines.push(`ip ${d.name} ${c.ipv4Address}/${prefixOf(c)}`);
      if (c.gatewayIpv4Address) lines.push(`gateway ${d.name} ${c.gatewayIpv4Address}`);
      if (c.macAddress) lines.push(`mac ${d.name} ${c.macAddress}`);
      if (c.dnsServerIp) lines.push(`nameserver ${d.name} ${c.dnsServerIp}`);
      // dnsmasq state replays through the server terminal (same as a human would type).
      for (const r of (c.dnsRecords || [])) lines.push(`cli ${d.name} echo address=/${r.name}/${r.ip} >> /etc/dnsmasq.conf`);
      if (c.dhcpRangeStart && c.dhcpRangeEnd) lines.push(`cli ${d.name} echo dhcp-range=${c.dhcpRangeStart},${c.dhcpRangeEnd} >> /etc/dnsmasq.conf`);
      if (c.dhcpRouterIp) lines.push(`cli ${d.name} echo dhcp-option=option:router,${c.dhcpRouterIp} >> /etc/dnsmasq.conf`);
      if (d.type === "server" && c.dnsmasqRunning === false) lines.push(`cli ${d.name} systemctl stop dnsmasq`);
    } else if (d.type === "switch" && c.managed) {
      for (const v of (c.vlans || [])) if (v.id !== 1) lines.push(`vlan ${d.name} add ${v.id}`);
      for (const [port, mode] of Object.entries(c.portModes || {})) lines.push(`port ${d.name} ${port} mode ${mode}`);
      for (const [port, id] of Object.entries(c.portVlans || {})) lines.push(`port ${d.name} ${port} vlan ${id}`);
      for (const [port, id] of Object.entries(c.trunkNativeVlans || {})) lines.push(`port ${d.name} ${port} native ${id}`);
      for (const [port, ids] of Object.entries(c.trunkAllowedVlans || {})) {
        for (const id of (ids as number[])) lines.push(`port ${d.name} ${port} allowed add ${id}`);
      }
    } else if (d.type === "router") {
      for (const i of (c.interfaces || [])) {
        const peer = idToName.get(i.peerId);
        if (peer && i.ipv4Address) {
          lines.push(`interface ${d.name} ${peer} ip ${i.ipv4Address}/${prefixOf(i)}${i.vlanTag != null ? ` vlan ${i.vlanTag}` : ""}`);
        }
      }
      for (const r of (c.staticRoutes || [])) lines.push(`route ${d.name} ${r.network} ${r.nextHop}`);
    }
  }

  for (const l of payload.links) {
    const f = idToName.get(l.from); const t = idToName.get(l.to);
    if (!f || !t) continue;
    const ports = (l.fromPort != null || l.toPort != null) ? ` ${l.fromPort ?? 1} ${l.toPort ?? 1}` : "";
    lines.push(`link ${f} ${t}${ports}`);
    if (l.shutdown) lines.push(`shut ${f} ${t}`);
  }

  return lines.join("\n");
}
