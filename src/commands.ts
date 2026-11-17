/**
 * Command engine — the text-command interface that can drive the whole app.
 *
 * Pure dispatcher: it parses a line, resolves device references, and calls the
 * existing action functions. It does NOT touch the console panel UI, so it is
 * reused by the panel (`console.ts`), the `window.routesim` API (`app.ts`), and
 * tests. See docs/scripting.md for the command reference.
 */
import type { Device, DeviceType } from "./types";
import { state, undo, redo, undoBlockReason, sync, pushUndo, pushUndoSnapshot, networkSnapshot, THEMES, linksChanged } from "./state";
import { USER_ADDABLE_TYPES, isHost, isDot1xSupplicant, defaultPortCount } from "./device-registry";
import { dom } from "./dom";
import {
  addDevice, addLink, deleteLink, deleteSelection, clearNetwork, collapseLan, expandLan,
  getDevice, moveDevice, linkName, deviceNameBlockReason, routerInterfacesWithNames, isPhysicalLink, linkedPortsFor, linkPortName, setLinkShutdown, setDevicePower, setSwitchManaged } from "./devices";
import {
  startSimulation, stopSimulation, pauseSimulation, resumeSimulation, stepOnce, animatedRunBlockReason, takePreemptionNote,
  runSimulationHeadless, runTraceroute, STORM_DIAGNOSIS, captureEntriesFor,
} from "./engine";
import { explainCapture, explanationText, storyEnd } from "./explain";
import type { SimResult } from "./engine";
import { refusalHint, runHint, hintLine } from "./hints";
import type { FailedFlow } from "./hints";
import { buildPingEvents, buildDhcpEvents, buildConnectEvents, buildResolveEvents, buildHttpEvents, parseHttpTarget, buildAssociationEvents, buildDot1xEvents, buildStpEvents, associatedAp, findPingTarget } from "./simulation";
import { buildScanEvents, buildSweepEvents, buildArpSpoofEvents, buildAttackEvents } from "./security/offensive/attacks";
import { DEFAULT_BRIDGE_PRIORITY } from "./stp";
import {
  setHostIp, setHostGateway, setHostDns, setRouterInterfaceIp, addSwitchVlan, removeSwitchVlan,
  setSwitchPortVlan, setSwitchPortMode, setSwitchTrunkNative, modifySwitchTrunkAllowed, setSwitchMirror, setSwitchStp, addIdsRule,
  runTerminalCommand, ensureSession, setListeningPorts, stpPriorityError, addStaticRoute,
} from "./terminal";
import { buildConfigPayload, applyConfig, loadTopology } from "./config";
import { normaliseConfig, ensureConfig } from "./normalise";
import { setTool, setTheme } from "./ui";
import { setZoom, fitNetwork } from "./canvas";
import { isValidMac, normaliseMacAddress, prefixOf, networkOf, normaliseSsid, normaliseWifiPassword, clampPortCount, clampRouterPortCount, clampApPortCount, mutationText, clampFirewallPortCount, defaultBridgeMac } from "./utils";
import { SCENARIOS, getScenario, loadScenario, checkScenario } from "./scenarios";
import { SCENARIO_GROUPS } from "./scenario-library";
import { SPEED_MIN, SPEED_MAX } from "./settings-url";
import { setSeedOverride, getSeedOverride, currentSimSeed } from "./prng";
import { parseSnortRule, snortRuleIssue } from "./snort";
import { tokenizeCommand, quoteArg } from "./tokenize";
import { ruleToIptables, ruleLangOf } from "./terminal/iptables";
import { ruleToNft } from "./terminal/nftables";
import { diagnoseState } from "./diagnostics";
import { DEFAULT_STRESS_SEED, DEFAULT_STRESS_STEPS, MAX_STRESS_STEPS, runStressTest } from "./stress";

export interface CommandResult {
  ok: boolean;
  output: string[];
  data?: unknown;
}

const ok = (...output: string[]): CommandResult => ({ ok: true, output });
const err = (...output: string[]): CommandResult => ({ ok: false, output });
// A flow its builder refused to start: the refusal, then the likely cause
// where the refusal reports a symptom rather than the cause (hints.ts).
function refused(from: Device, refusal: string, target: string, kind: FailedFlow["kind"], port: number | null = null): CommandResult {
  const cause = refusalHint(from, target, kind, port, refusal);
  return cause ? err(refusal, hintLine(cause)) : err(refusal);
}

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
  // The position is the TRAILING `at <x> <y>` — found from the end, so a device
  // may itself be named "at" (`add computer at at 10 20`); the first `at` used
  // to win and the name was read as the keyword.
  const atIdx = args.length - 3;
  if (atIdx >= 1 && args[atIdx].toLowerCase() === "at") {
    pos = { x: Number(args[atIdx + 1]), y: Number(args[atIdx + 2]) };
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return err(`add: invalid "at <x> <y>".`);
    if (atIdx >= 2) name = args[1];
  } else if (args.slice(1).some(a => a.toLowerCase() === "at") && args.length > 2) {
    return err(`add: invalid "at <x> <y>".`);   // an `at` that is not followed by exactly two numbers
  } else if (args[1]) {
    name = args[1];
  }
  // Names are the handle every later command uses, matched ignoring case — a
  // second `PC1` (or `pc1`) could never be referenced again (R38).
  const taken = name ? deviceNameBlockReason(name) : null;
  if (taken) return err(`add: ${taken}`);
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
  // `auto` (or `-`) leaves that end unpinned: `link R1 SW auto 4` pins only
  // SW's port. The script export writes it for an end nobody chose.
  const portArg = (text: string | undefined) => !text || /^(auto|-)$/i.test(text) ? undefined : Number(text);
  const fromPort = portArg(args[2]);
  const toPort = portArg(args[3]);
  const badPort = (p: number | undefined) => p !== undefined && !(Number.isInteger(p) && p >= 1);
  if (badPort(fromPort) || badPort(toPort)) return err("link: ports must be positive whole numbers (or auto).");
  // addLink validates, links and reports — refused (why), already linked, or
  // made, with a warning for each port it could not honour.
  const result = addLink(a.id, b.id, fromPort, toPort);
  return result.ok ? ok(mutationText(result)) : err(mutationText(result));
}

function cmdUnlink(args: string[]): CommandResult {
  const a = resolveDevice(args[0]);
  if (typeof a === "string") return err(a);
  const b = resolveDevice(args[1]);
  if (typeof b === "string") return err(b);
  const link = state.links.find(l =>
    (l.from === a.id && l.to === b.id) || (l.from === b.id && l.to === a.id));
  if (!link) return err(`No link between ${a.name} and ${b.name}.`);
  // Route through deleteLink so the removal is undoable and recomputes spanning
  // tree — a direct state.links filter left both stale (a redundant link removed
  // this way kept the survivor's port wrongly blocked until the next run).
  deleteLink(link.id);
  return ok(`Unlinked ${a.name} ↔ ${b.name}.`);
}

function cmdLinkSet(args: string[]): CommandResult {
  // linkset <a> <b> name|bandwidth|latency|loss <value>
  const a = resolveDevice(args[0]);
  if (typeof a === "string") return err(a);
  const b = resolveDevice(args[1]);
  if (typeof b === "string") return err(b);
  const link = state.links.find(l => isPhysicalLink(l) &&
    ((l.from === a.id && l.to === b.id) || (l.from === b.id && l.to === a.id)));
  if (!link) return err(`No link between ${a.name} and ${b.name}.`);
  const attr = (args[2] || "").toLowerCase();
  const value = args.slice(3).join(" "); // names may contain spaces
  // pushUndo per-branch, AFTER value validation — a rejected linkset must not
  // push a spurious snapshot (which would also wipe the redo stack).
  if (attr === "name") {
    pushUndo();
    if (value) link.name = value; else delete link.name;
    sync().syncPanel(); sync().render();
    return ok(value ? `Named link ${a.name} ↔ ${b.name} "${value}".` : `Cleared link name.`);
  }
  if (attr === "bandwidth" || attr === "latency" || attr === "loss") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return err(`linkset: ${attr} must be a non-negative number (0 clears it).`);
    const v = attr === "loss" ? Math.min(100, n) : n;
    pushUndo();
    if (v > 0) (link)[attr] = v; else delete (link)[attr];
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
  const link = state.links.find(l => isPhysicalLink(l) &&
    ((l.from === a.id && l.to === b.id) || (l.from === b.id && l.to === a.id)));
  if (!link) return err(`No link between ${a.name} and ${b.name}.`);
  const already = !!link.shutdown === down;
  setLinkShutdown(link, down);   // the mutator the inspector toggle and the canvas double-click use
  return ok(`Link ${a.name} ↔ ${b.name} is ${already ? "already" : "now"} ${down ? "administratively down (shut)" : "up (no shut)"}.`);
}
function cmdShut(args: string[]): CommandResult { return cmdLinkState(args, true); }
function cmdNoShut(args: string[]): CommandResult { return cmdLinkState(args, false); }

function cmdMove(args: string[]): CommandResult {
  const device = resolveDevice(args[0]);
  if (typeof device === "string") return err(device);
  const x = Number(args[1]); const y = Number(args[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return err(`move: invalid coordinates.`);
  pushUndo();
  moveDevice(device, x, y);
  return ok(`Moved ${device.name} to ${x},${y}.`);
}

function cmdRename(args: string[]): CommandResult {
  const device = resolveDevice(args[0]);
  if (typeof device === "string") return err(device);
  const name = args[1];
  if (!name) return err(`rename: missing new name.`);
  // `rename` stays permissive (a meta tool — no hostname validation, unlike the
  // terminal's `hostname`), but it must still be undoable like every other edit,
  // and the name must stay unique or nothing could address the device again.
  const taken = deviceNameBlockReason(name, device);
  if (taken) return err(`rename: ${taken}`);
  pushUndo();
  device.name = name;
  sync().syncPanel(); sync().syncTerminal(); sync().render();
  return ok(`Renamed to ${name}.`);
}

function cmdClear(): CommandResult { return ok(clearedText(clearNetwork())); }
// What Clear says: the network is gone, and so is the scenario it belonged to.
export function clearedText(endedScenarioId: string | null): string {
  if (!endedScenarioId) return "Cleared network.";
  return `Cleared network — the scenario "${getScenario(endedScenarioId)?.name ?? endedScenarioId}" ended with it. Undo brings both back.`;
}

function cmdCollapse(args: string[]): CommandResult {
  const device = resolveDevice(args[0]);
  if (typeof device === "string") return err(device);
  // collapse <switch> [as <name>] — the name the LAN node gets (the script
  // export writes it when it is not the default, so a renamed LAN replays).
  if (args[1] != null && (args[1].toLowerCase() !== "as" || !args[2])) return err("Usage: collapse <switch> [as <name>]");
  const result = collapseLan(device, args[2]);
  return result.ok ? ok(mutationText(result)) : err(mutationText(result));
}

function cmdExpand(args: string[]): CommandResult {
  const device = resolveDevice(args[0]);
  if (typeof device === "string") return err(device);
  const result = expandLan(device);
  return result.ok ? ok(mutationText(result)) : err(mutationText(result));
}

// ── Config verbs (call the exported mutators directly — no mode machine) ──────
// Undo contract: a state-changing command must be undoable. Either delegate to a
// helper that already pushes undo (addLink/deleteLink/addDevice/deleteSelection/
// the switch mutators), or call pushUndo() here *after* validation and *before*
// the first mutation, so a rejected command leaves no spurious undo entry.

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
  pushUndo();
  ensureConfig(device);
  device.config.macAddress = mac;
  // A switch's MAC is the tie-break in its bridge id: the tree may change.
  if (device.type === "switch") sync().recomputeStp();
  sync().syncPanel();
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
  // `ssid LT ""` clears it — a laptop with no network configured is a real
  // state (the wifi-join scenario starts in it), and the script export has to
  // be able to say so. A missing argument is still a usage error.
  if (!ssid && args[1] !== "") return err("Usage: ssid <laptop|access-point> <name> [password]   (\"\" clears the name)");
  pushUndo();
  ensureConfig(device);
  device.config.ssid = ssid;
  const password = normaliseWifiPassword(args[2] ?? "");
  device.config.wifiPassword = password;
  sync().render();
  const role = device.type === "access-point" ? "broadcasts" : "joins";
  if (!ssid) return ok(`${device.name}: SSID cleared.`);
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
  // The same mutator as the router shell's `ip route`, so the console cannot
  // store a route the shell would refuse — or could never remove (R37).
  const router = resolveDevice(args[0]);
  if (typeof router === "string") return err(router);
  if (!args[1] || !args[2]) return err(`route: expected "<network/prefix> <nextHop>".`);
  const result = addStaticRoute(router, args[1], args[2]);
  if (!result.ok) return err(`route: ${result.error}`);
  return ok(mutationText(result));
}

function cmdVlan(args: string[]): CommandResult {
  const sw = resolveDevice(args[0]);
  if (typeof sw === "string") return err(sw);
  const action = (args[1] || "").toLowerCase();
  const id = args[2];
  if (action === "add") return mutatorResult(addSwitchVlan(sw, id, args.slice(3).join(" ")));   // optional name: vlan SW add 10 Sales
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

function cmdCli(args: string[], _rest: string, tail: (n: number) => string): CommandResult {
  const device = resolveDevice(args[0]);
  if (typeof device === "string") return err(device);
  const line = tail(1);   // raw source after the device token — a shell line, never re-split
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
  const result = runTerminalCommand(line);
  sync().syncTerminal(); // keep the dock's terminal pane/prompt in step
  // The shell's verdict is the command's verdict: `cli` used to return ok
  // whatever the device printed, so a script whose RIP, NAT, iptables or
  // dnsmasq lines were all rejected still imported "cleanly".
  return { ok: result.ok, output: session.lines.slice(before).map(l => l.text) };
}

// ── Simulation ───────────────────────────────────────────────────────────────

function cmdPing(args: string[]): CommandResult {
  const src = resolveDevice(args[0]);
  if (typeof src === "string") return err(src);
  const dst = args[1];
  if (!dst) return err(`ping: missing target.`);
  // An animated run can't start while another owns the simulator (engine
  // beginRun) — refused here, before building: building reseeds the run PRNG,
  // which would perturb the in-flight run. Same check in every animated verb.
  const busy = animatedRunBlockReason(); if (busy) return err(busy);
  const setup = buildPingEvents(src, dst);
  if (typeof setup === "string") return refused(src, setup, dst, "ping");
  startSimulation(setup, src.id, targetIpFor(dst), "ping");
  return ok(`Ping ${src.name} → ${dst} started.`);
}

function cmdConnect(args: string[]): CommandResult {
  const src = resolveDevice(args[0]);
  if (typeof src === "string") return err(src);
  const dst = args[1];
  const port = Number(args[2]);
  if (!dst || !args[2]) return err(`connect: expected "connect <src> <dst> <port>".`);
  const busy = animatedRunBlockReason(); if (busy) return err(busy);
  const setup = buildConnectEvents(src, dst, port);
  if (typeof setup === "string") return refused(src, setup, dst, "tcp", port);
  startSimulation(setup, src.id, targetIpFor(dst), "tcp", port);
  return ok(`TCP connect ${src.name} → ${dst}:${port} started.`);
}

function cmdHttp(args: string[]): CommandResult {
  const src = resolveDevice(args[0]);
  if (typeof src === "string") return err(src);
  if (!args[1]) return err(`http: expected "http <src> <host>[:port][/path] [path]".`);
  const { host, port, path } = parseHttpTarget(args[1], args[2] || "/");
  if (!host) return err(`http: no host specified.`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return err(`http: invalid port in "${args[1]}".`);
  const busy = animatedRunBlockReason(); if (busy) return err(busy);
  const setup = buildHttpEvents(src, host, port, path);
  if (typeof setup === "string") return refused(src, setup, host, "http", port);
  startSimulation(setup, src.id, targetIpFor(host), "http", port);
  return ok(`HTTP GET ${src.name} → http://${host}:${port}${path} started.`);
}

function cmdDhcp(args: string[]): CommandResult {
  const host = resolveDevice(args[0]);
  if (typeof host === "string") return err(host);
  const busy = animatedRunBlockReason(); if (busy) return err(busy);
  const setup = buildDhcpEvents(host);
  if (typeof setup === "string") return refused(host, setup, "", "dhcp");
  startSimulation(setup, host.id, "", "dhcp");
  return ok(`DHCP on ${host.name} started.`);
}

function cmdAssociate(args: string[]): CommandResult {
  const laptop = resolveDevice(args[0]);
  if (typeof laptop === "string") return err(laptop);
  const busy = animatedRunBlockReason(); if (busy) return err(busy);
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
  if (!isDot1xSupplicant(host.type)) return err(`${host.name} is not a host (802.1X supplicant).`);
  const identity = args[1], password = args[2];
  if (!identity || password == null) return err("Usage: supplicant <host> <identity> <password>");
  pushUndo();
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
  pushUndo();
  ensureConfig(sw);
  sw.config.portAuth = sw.config.portAuth || {};
  const previous = sw.config.portAuth[port] || "force-authorized";
  sw.config.portAuth[port] = mode as any;
  // A change of control mode ends the port's 802.1X session, as it does on a
  // real switch: an authorisation earned under the old mode must not open the
  // port under the new one (a later switch to `auto` used to pass data, and the
  // scenario check, with no exchange).
  const link = linkedPortsFor(sw.id)[Number(portMatch![1]) - 1]?.link;
  const cleared = previous !== mode && !!link?.dot1xAuthorized;
  if (cleared) delete link.dot1xAuthorized;
  sync().syncPanel();
  sync().render();
  return ok(`${sw.name} ${port} 802.1X port-control: ${mode}.${cleared ? " The port's 802.1X session was cleared — the host must authenticate again." : ""}`);
}

// 802.1X: add/update a RADIUS user on a server (enables the RADIUS back end).
function cmdRadius(args: string[]): CommandResult {
  const server = resolveDevice(args[0]);
  if (typeof server === "string") return err(server);
  if (server.type !== "server") return err(`${server.name} is not a server.`);
  const identity = args[1], password = args[2];
  if (!identity || password == null) return err("Usage: radius <server> <identity> <password>");
  pushUndo();
  ensureConfig(server);
  const cfg = server.config;
  cfg.radius = cfg.radius || { users: [] };
  const existing = cfg.radius.users.find((u) => u.identity === identity);
  if (existing) existing.password = password; else cfg.radius.users.push({ identity, password });
  sync().syncPanel();
  return ok(`${server.name} RADIUS user "${identity}" set.`);
}

// Set a host's listening TCP ports (the simple "is this port open?" model nc/
// connect use). Comma- or space-separated; "none"/"off"/"clear" removes them.
function cmdPorts(args: string[]): CommandResult {
  const host = resolveDevice(args[0]);
  if (typeof host === "string") return err(host);
  const spec = args.slice(1).join(" ").trim();
  // No list (or none/off/clear) = accept on any port. `closed` is the OTHER
  // empty state: an explicit empty list = listen on nothing (every SYN is RST) —
  // distinct, and the script export needs to say which one it means.
  const ports = !spec || /^(none|off|clear)$/i.test(spec) ? null
    : /^closed$/i.test(spec) ? []
    : spec.split(/[\s,]+/).filter(Boolean).map(Number);
  const result = setListeningPorts(host, ports);
  return result.ok ? ok(mutationText(result)) : err(mutationText(result));
}

// MACsec: set (or clear, with "off") the pre-shared key for the link to a peer.
function cmdMacsec(args: string[]): CommandResult {
  const dev = resolveDevice(args[0]);
  if (typeof dev === "string") return err(dev);
  const peer = resolveDevice(args[1]);
  if (typeof peer === "string") return err(peer);
  const key = args[2];
  if (!key) return err("Usage: macsec <device> <peer> <key|dot1x> [must|should]  (key 'off' clears)");
  pushUndo();
  ensureConfig(dev);
  const cfg = dev.config;
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
  const busy = animatedRunBlockReason(); if (busy) return err(busy);
  const setup = buildDot1xEvents(host);
  if (typeof setup === "string") return err(setup);
  startSimulation(setup, host.id, host.config?.dot1x?.identity || "", "dot1x");
  return ok(`802.1X authentication started for ${host.name}.`);
}

// Turn a switch's management plane on/off (VLANs, STP, port security need it).
// Mirrors the inspector toggle / the Managed-switch tool, and makes a managed
// switch reproducible from a script (JSON already round-trips `managed`).
function cmdManaged(args: string[]): CommandResult {
  const sw = resolveDevice(args[0]);
  if (typeof sw === "string") return err(sw);
  if (sw.type !== "switch") return err(`${sw.name} is not a switch.`);
  const on = !args[1] || /^(on|true|yes|enable)$/i.test(args[1]);
  return ok(mutationText(setSwitchManaged(sw, on)));
}

// Enable/disable a host's HTTP service: `web <server> on|off [title]`. With it
// on, the host answers an HTTP GET with 200 OK (and the given page title).
function cmdWeb(args: string[]): CommandResult {
  const dev = resolveDevice(args[0]);
  if (typeof dev === "string") return err(dev);
  if (dev.type !== "server") return err(`${dev.name} is not a server (the web service runs on a server).`);
  const mode = (args[1] || "").toLowerCase();
  if (mode !== "on" && mode !== "off") return err(`web: expected "web <host> on|off [title]".`);
  pushUndo();
  ensureConfig(dev);
  if (mode === "off") {
    dev.config!.httpEnabled = false;
    delete (dev.config).httpTitle;
    sync().syncPanel();
    return ok(`Web service disabled on ${dev.name}.`);
  }
  dev.config!.httpEnabled = true;
  const title = args.slice(2).join(" ").trim();
  if (title) dev.config!.httpTitle = title.slice(0, 200);
  sync().syncPanel();
  return ok(`Web service enabled on ${dev.name}${title ? ` ("${title}")` : ""}.`);
}

// Set a router's placement archetype: `role <router> border|internal`. A border
// router faces the outside (pair it with NAT + a firewall); internal is the
// plain default (interior forwarding).
function cmdRuleLang(args: string[]): CommandResult {
  const device = resolveDevice(args[0]);
  if (typeof device === "string") return err(device);
  if (device.type !== "firewall" && device.type !== "router") return err(`${device.name} has no netfilter ruleset.`);
  const lang = (args[1] || "").toLowerCase();
  if (lang !== "iptables" && lang !== "nftables") return err(`rulelang: expected "rulelang <device> iptables|nftables".`);
  pushUndo();
  ensureConfig(device);
  if (lang === "nftables") (device.config).ruleLang = "nftables";
  else delete (device.config).ruleLang; // iptables is the plain default
  sync().syncPanel();
  return ok(`${device.name} now speaks ${lang}.`);
}

function cmdRole(args: string[]): CommandResult {
  const router = resolveDevice(args[0]);
  if (typeof router === "string") return err(router);
  if (router.type !== "router") return err(`${router.name} is not a router.`);
  const role = (args[1] || "").toLowerCase();
  if (role !== "border" && role !== "internal") return err(`role: expected "role <router> border|internal".`);
  pushUndo();
  ensureConfig(router);
  if (role === "border") (router.config).role = "border";
  else delete (router.config).role; // internal is the plain default
  sync().syncPanel();
  sync().render();
  return ok(`${router.name} is now a ${role} router.`);
}

// SPAN port mirroring on a managed switch: `mirror <switch> <dst> [src...]`,
// or `mirror <switch> off` to remove. Copies traffic to a monitor port (IDS).
function cmdMirror(args: string[]): CommandResult {
  const sw = resolveDevice(args[0]);
  if (typeof sw === "string") return err(sw);
  if (sw.type !== "switch" || !sw.config?.managed) return err(`${sw.name} is not a managed switch (port mirroring runs on managed switches).`);
  const dst = args[1];
  if (!dst || /^(off|none|remove|clear)$/i.test(dst)) return mutatorResult(setSwitchMirror(sw, null));
  return mutatorResult(setSwitchMirror(sw, { dest: dst, sources: args.slice(2).filter(Boolean) }));
}

// Add a Snort rule to an IDS sensor (or `idsrule <ids> clear` to flush).
function cmdIdsRule(args: string[], _rest: string, tail: (n: number) => string): CommandResult {
  const ids = resolveDevice(args[0]);
  if (typeof ids === "string") return err(ids);
  if (ids.type !== "ids") return err(`${ids.name} is not an IDS sensor.`);
  const ruleText = tail(1);   // raw source after the sensor token — the rule text verbatim
  if (!ruleText) return err("Usage: idsrule <ids> <snort rule>  |  idsrule <ids> clear");
  if (/^(clear|flush)$/i.test(ruleText)) { pushUndo(); ensureConfig(ids); (ids.config).idsRules = []; sync().syncPanel(); return ok(`${ids.name}: rules cleared.`); }
  // Validate the rule BEFORE pushUndo — a bad rule must not push a spurious
  // snapshot (which would also wipe the redo stack).
  const ruleIssue = snortRuleIssue(ruleText);
  if (ruleIssue) return err(`ERROR: ${ruleIssue}`);
  if (!parseSnortRule(ruleText)) return err(`ERROR: bad rule (expected: alert proto src sport -> dst dport (msg:"..."; sid:N;))`);
  pushUndo();
  const result = addIdsRule(ids, ruleText);
  sync().syncPanel();
  return result.startsWith("ERROR") ? err(result) : ok(result);
}

// Launch a Kali PC's or Red Team actor's attacks. `attack <node>` runs all
// enabled attacks; `attack <node> scan|sweep|arp-spoof [target]` runs one. A
// scan/sweep target argument overrides (and remembers) the host's target.
function cmdAttack(args: string[]): CommandResult {
  const node = resolveDevice(args[0]);
  if (typeof node === "string") return err(node);
  if (node.type !== "attacker" && node.type !== "kali") return err(`${node.name} is not a Kali PC or Red Team host.`);
  const busy = animatedRunBlockReason(); if (busy) return err(busy);   // before the target is stored
  const kind = args[1] && /^(scan|sweep|arp-spoof)$/i.test(args[1]) ? args[1].toLowerCase() : undefined;
  const targetArg = (kind ? args.slice(2) : args.slice(1)).join(" ").trim();
  // A scan/sweep target argument overrides (and remembers) the configured
  // target; for arp-spoof the argument is the IP to impersonate, not a target.
  // Build (and validate) against the effective target WITHOUT persisting it —
  // a rejected attack must not leave an un-undoable config change (R82).
  const effectiveTarget = targetArg || node.config?.attackTarget || "";
  let setup;
  if (kind === "scan") setup = buildScanEvents(node, effectiveTarget);
  else if (kind === "sweep") setup = buildSweepEvents(node, effectiveTarget);
  else if (kind === "arp-spoof") setup = buildArpSpoofEvents(node, targetArg || undefined);
  else setup = buildAttackEvents(node);
  if (typeof setup === "string") return err(setup);
  // The target validated — now remember it, undoably, and only if it changed.
  if (targetArg && kind !== "arp-spoof" && node.config?.attackTarget !== targetArg) {
    pushUndo();
    ensureConfig(node);
    (node.config).attackTarget = targetArg;
  }
  startSimulation(setup, node.id, "", "attack");
  return ok(`${node.name}: ${kind || "attacks"} launched.`);
}

// Configure a Red Team host: its target, enabled attacks, or ARP-spoof IP.
function cmdRedteam(args: string[]): CommandResult {
  const node = resolveDevice(args[0]);
  if (typeof node === "string") return err(node);
  if (node.type !== "attacker") return err(`${node.name} is not a Red Team host.`);
  const sub = (args[1] || "").toLowerCase();
  if (!["target", "spoof", "attacks"].includes(sub)) {
    return err("Usage: redteam <node> target <ip> | attacks <scan,sweep,arp-spoof> | spoof <ip>");
  }
  ensureConfig(node);
  const cfg: any = node.config;
  // An unchanged value takes no undo point (review R88): the undo is pushed by
  // `set`, only when the new value differs from the stored one.
  const set = (key: string, value: unknown, msg: string) => {
    if (JSON.stringify(cfg[key] ?? null) !== JSON.stringify(value)) { pushUndo(); cfg[key] = value; sync().syncPanel(); }
    return ok(msg);
  };
  if (sub === "target") return set("attackTarget", args[2] || "", `${node.name}: target ${args[2] || "(none)"}.`);
  if (sub === "spoof") return set("spoofIp", args[2] || "", `${node.name}: ARP-spoof target ${args[2] || "(gateway)"}.`);
  if (sub === "attacks") {
    const list = (args[2] || "").split(",").map(s => s.trim()).filter(a => ["scan", "sweep", "arp-spoof"].includes(a));
    return set("attacks", list, `${node.name}: attacks [${list.join(", ")}].`);
  }
  return err("Usage: redteam <node> target <ip> | attacks <scan,sweep,arp-spoof> | spoof <ip>");
}

// Spanning tree: no args animates the BPDU exchange; `stp <switch> on|off` or
// `stp <switch> priority <n>` configures a managed switch.
function cmdStp(args: string[]): CommandResult {
  if (args.length === 0) {
    const busy = animatedRunBlockReason(); if (busy) return err(busy);
    const setup = buildStpEvents();
    if (typeof setup === "string") return err(setup);
    // The seeded events originate at a root bridge (fromDeviceId) — use it as the
    // run origin (where the result lands) rather than reconverging to find it.
    startSimulation(setup, setup.events[0]?.fromDeviceId || "", "", "stp");
    return ok("Spanning-tree BPDU exchange started.");
  }
  const sw = resolveDevice(args[0]);
  if (typeof sw === "string") return err(sw);
  if (sw.type !== "switch" || !sw.config?.managed) return err(`${sw.name} is not a managed switch (spanning tree runs on managed switches).`);
  const sub = (args[1] || "").toLowerCase();
  if (!["on", "enable", "off", "disable", "priority"].includes(sub)) {
    return err(`stp: expected "<switch> on|off" or "<switch> priority <n>".`);
  }
  if (sub === "priority") {
    const bad = stpPriorityError(args[2]);
    if (bad) return err(`stp priority: ${bad}`);
  }
  // The same mutator as the switch shell and the inspector (undo point,
  // reconvergence, panel) — and the same no-op rule: a value it already has
  // takes no undo point.
  const enable = sub === "on" || sub === "enable";
  const n = Number(args[2]);   // already validated by the up-front guard
  const result = setSwitchStp(sw, sub === "priority" ? { priority: n } : { enabled: enable });
  if (result.includes("already")) return ok(`${sw.name}: ${result.charAt(0).toLowerCase()}${result.slice(1)}`);
  return ok(sub === "priority" ? `${sw.name}: bridge priority ${n}.` : `${sw.name}: spanning tree ${enable ? "enabled" : "disabled"}.`);
}

// A `run` result line followed, when the run failed, by the engine's
// post-mortem (a broadcast storm, an ARP nobody answered) — so the console says
// WHY, not just "unreachable".
// Every console `run` is traced, so `why` can explain it afterwards.
const RUN_TRACE = { trace: true } as const;

// `flow` names the flow for the likely-cause probe (hints.ts) — given for the
// runs it knows how to read (ping / connect / http / resolve / dhcp).
function runOutput(r: SimResult, line: string, flow?: { from: Device; target: string; kind: FailedFlow["kind"]; port?: number | null }): CommandResult {
  if (r.success) return { ok: true, data: r, output: [line] };
  const cause = flow ? runHint(flow.from, flow.target, flow.kind, flow.port ?? null, r) : null;
  // A failed run points at its own explanation (the frames it did send).
  const why = r.trace?.length ? ["Type `why` to see how it got there."] : [];
  return { ok: false, data: r, output: [line, ...r.diagnosis, ...(cause ? [hintLine(cause)] : []), ...why] };
}

// Which ICMP error, if any, a failed ping got back (Linux ping's wording).
function pingErrorNote(r: SimResult): string {
  if (r.timeExceeded && r.responderIp) return ` (Time to live exceeded from ${r.responderIp})`;
  if (r.unreachableFrom) return ` (Destination Port Unreachable from ${r.unreachableFrom})`;
  return "";
}

function cmdRun(args: string[]): CommandResult {
  const mode = (args[0] || "").toLowerCase();
  // Names this run in the note left if it stops an animated run (engine beginRun).
  const purpose = `the console's \`run ${mode}\``;
  if (mode === "stp") {
    const setup = buildStpEvents();
    if (typeof setup === "string") return err(setup);
    const r = runSimulationHeadless(setup, setup.events[0]?.fromDeviceId || "", "", "stp", null, purpose, RUN_TRACE);
    const blocked = state.links.filter(l => l.stpBlocked).length;
    return { ok: r.success, data: r,
      output: [r.success ? `stp: spanning tree converged — ${blocked} port(s) blocking (${r.steps} BPDUs)` : "stp: broadcast storm — no spanning tree to break the loop"] };
  }
  if (mode === "dot1x") {
    const host = resolveDevice(args[1]);
    if (typeof host === "string") return err(host);
    const setup = buildDot1xEvents(host);
    if (typeof setup === "string") return err(setup);
    const r = runSimulationHeadless(setup, host.id, "", "dot1x", null, purpose, RUN_TRACE);
    return runOutput(r, r.success ? `dot1x: ${host.name} authenticated — port authorised (${r.steps} frames)` : `dot1x: authentication failed`);
  }
  if (mode === "associate") {
    const laptop = resolveDevice(args[1]);
    if (typeof laptop === "string") return err(laptop);
    const setup = buildAssociationEvents(laptop);
    if (typeof setup === "string") return err(setup);
    const r = runSimulationHeadless(setup, laptop.id, "", "associate", null, purpose, RUN_TRACE);
    return runOutput(r, r.success ? `associate: ${laptop.name} joined the WiFi (${r.steps} frames)` : "associate: handshake did not complete");
  }
  if (mode === "ping") {
    const src = resolveDevice(args[1]);
    if (typeof src === "string") return err(src);
    const dst = args[2];
    if (!dst) return err(`run ping: missing target.`);
    const setup = buildPingEvents(src, dst);
    if (typeof setup === "string") return refused(src, setup, dst, "ping");
    const r = runSimulationHeadless(setup, src.id, targetIpFor(dst), "ping", null, purpose, RUN_TRACE);
    return runOutput(r, `ping ${dst}: ${r.success ? `reachable (ttl=${r.ttl})` : `unreachable${pingErrorNote(r)}`} — ${r.steps} steps`, { from: src, target: dst, kind: "ping" });
  }
  if (mode === "connect" || mode === "tcp") {
    const src = resolveDevice(args[1]);
    if (typeof src === "string") return err(src);
    const dst = args[2];
    const port = Number(args[3]);
    if (!dst || !args[3]) return err(`run connect: expected "run connect <src> <dst> <port>".`);
    const setup = buildConnectEvents(src, dst, port);
    if (typeof setup === "string") return refused(src, setup, dst, "tcp", port);
    const r = runSimulationHeadless(setup, src.id, targetIpFor(dst), "tcp", port, purpose, RUN_TRACE);
    return runOutput(r, `connect ${dst}:${port}: ${r.success ? "open (handshake completed)" : r.refused ? "refused (RST)" : "timed out"} — ${r.steps} steps`, { from: src, target: dst, kind: "tcp", port });
  }
  if (mode === "http") {
    const src = resolveDevice(args[1]);
    if (typeof src === "string") return err(src);
    if (!args[2]) return err(`run http: expected "run http <src> <host>[:port][/path] [path]".`);
    const { host, port, path } = parseHttpTarget(args[2], args[3] || "/");
    if (!host) return err(`run http: no host specified.`);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return err(`run http: invalid port in "${args[2]}".`);
    const setup = buildHttpEvents(src, host, port, path);
    if (typeof setup === "string") return refused(src, setup, host, "http", port);
    const r = runSimulationHeadless(setup, src.id, targetIpFor(host), "http", port, purpose, RUN_TRACE);
    return runOutput(r, `http http://${host}:${port}${path}: ${r.httpStatus != null ? `${r.httpStatus}` : r.refused ? "refused" : "no response"} — ${r.steps} steps`, { from: src, target: host, kind: "http", port });
  }
  if (mode === "dhcp") {
    const host = resolveDevice(args[1]);
    if (typeof host === "string") return err(host);
    const setup = buildDhcpEvents(host);
    if (typeof setup === "string") return refused(host, setup, "", "dhcp");
    // The one `run` that changes saved configuration: a lease re-addresses the
    // host (and records a binding on the server). So it is an undo point, like
    // the animated `dhcp` — taken only when the run changed something, so a
    // run nobody answered leaves no dead entry and keeps the redo branch.
    const before = networkSnapshot();
    const r = runSimulationHeadless(setup, host.id, "", "dhcp", null, purpose, RUN_TRACE);
    if (!state.isApplyingCompositeChange && networkSnapshot() !== before) pushUndoSnapshot(before);
    return runOutput(r, r.success ? `dhcp: assigned ${r.assignedIp} (gw ${r.assignedGateway})` : "dhcp: no response", { from: host, target: "", kind: "dhcp" });
  }
  if (mode === "resolve" || mode === "dns") {
    const src = resolveDevice(args[1]);
    if (typeof src === "string") return err(src);
    const name = args[2];
    if (!name) return err(`run resolve: expected "run resolve <src> <name>".`);
    const setup = buildResolveEvents(src, name, null, null);
    if (typeof setup === "string") return refused(src, setup, name, "dns");
    const r = runSimulationHeadless(setup, src.id, name, "dns", null, purpose, RUN_TRACE);
    return runOutput(r, `resolve ${name}: ${r.resolvedIp || "no answer"} — ${r.steps} steps`, { from: src, target: name, kind: "dns" });
  }
  return err(`run: expected "ping <src> <dst>", "connect <src> <dst> <port>", "resolve <src> <name>", or "dhcp <host>".`);
}

function cmdTraceroute(args: string[]): CommandResult {
  const src = resolveDevice(args[0]);
  if (typeof src === "string") return err(src);
  const dst = args[1];
  if (!dst) return err(`traceroute: expected "traceroute <src> <dst>".`);
  const result = runTraceroute(src, dst);
  if (typeof result === "string") return refused(src, result, dst, "ping");
  const lines = [`traceroute to ${result.targetIp}, 30 hops max`];
  for (const hop of result.hops) lines.push(` ${hop.ttl}  ${hop.ip || "* (no response)"}`);
  if (result.storm) lines.push(STORM_DIAGNOSIS);
  else if (!result.reached) lines.push("(destination not reached within 30 hops)", ...(result.diagnosis ?? []));
  if (result.hint) lines.push(hintLine(result.hint));
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

// Pin (or clear) the simulation's random seed. By default each run reseeds from
// the wall clock, so identical topologies still produce varying traffic; pinning
// a seed makes ephemeral ports / DHCP ids / NAT translations reproducible, so a
// saved-capture Compare is a true before/after diff.
// why [<no>] — the causal chain behind a packet in the capture the Sim Log is
// showing: the frames that led to it, each with the reason its sender logged,
// then what its receiver did. No number explains the packet being inspected.
function cmdWhy(args: string[]): CommandResult {
  // The most recent run decides what there is to explain: a headless `run`
  // leaves a trace (cleared by whatever runs next); otherwise it is the capture
  // the Sim Log is showing.
  const trace = state.simulation.trace?.length ? state.simulation.trace : null;
  const entries = trace ?? captureEntriesFor(state.dock.captureView || "live");
  if (!entries.length) return err("why: nothing to explain yet — run something first (ping, connect, dhcp, or a headless `run …`), then `why <packet number>`.");
  const inspected = !trace && state.inspectedCapture && entries.includes(state.inspectedCapture) ? state.inspectedCapture : null;
  const range = `${entries[0].no}–${entries[entries.length - 1].no}`;
  if (!args[0] && !inspected && !trace) return err(`why: which packet? Give its number from the packet list (${range}), or click a row first.`);
  // With no number: the inspected packet, or — for a traced run — where it ended.
  const entry = args[0] ? entries.find(e => e.no === Number(args[0])) : (inspected ?? storyEnd(entries));
  if (!entry) return err(`why: no packet ${args[0]} in ${trace ? "the last run" : "this capture"} (it holds ${range}).`);
  const explanation = explainCapture(entry, entries, id => state.devices.find(d => d.id === id)?.name ?? "a removed device");
  return ok(trace ? `Why frame ${entry.no} of ${entries.length} in the last run?` : `Why packet ${entry.no}?`, ...explanationText(explanation));
}

function cmdSeed(args: string[]): CommandResult {
  const arg = (args[0] || "").trim().toLowerCase();
  if (!arg) {
    const pinned = getSeedOverride();
    return pinned != null
      ? ok(`Seed pinned to ${pinned} — every run reproduces the same traffic. "seed off" to unpin.`)
      : ok(`Seed follows the clock (each run varies). Last run used ${currentSimSeed()}; "seed ${currentSimSeed()}" reproduces it, or "seed <n>" pins a new one.`);
  }
  if (/^(off|clear|none|random|clock)$/.test(arg)) {
    setSeedOverride(null);
    return ok("Seed unpinned — each run reseeds from the clock.");
  }
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return err(`seed: expected a whole number 0–4294967295, or "off".`);
  setSeedOverride(n);
  return ok(`Seed pinned to ${n} — runs are now reproducible. "seed off" to unpin.`);
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

function cmdUndo(): CommandResult {
  const blocked = undoBlockReason();
  if (blocked) return err(blocked);
  undo(); return ok("Undone.");
}
function cmdRedo(): CommandResult {
  const blocked = undoBlockReason();
  if (blocked) return err(blocked);
  redo(); return ok("Redone.");
}

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
  const c = device.config || {};
  const lines = [`${device.name} (${device.type})`];
  if (isHost(device.type)) {
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
    lines.push(`  ssid: ${c.ssid || "(none)"}${c.wifiPassword ? " (secured)" : " (open)"}`, `  uplink ports: ${c.ethernetPorts ?? defaultPortCount("access-point")}`);
  } else if (device.type === "switch") {
    lines.push(`  managed: ${Boolean(c.managed)}`, `  ports: ${c.ethernetPorts ?? defaultPortCount("switch")}`);
    if (c.managed && c.vlans?.length) lines.push(`  vlans: ${c.vlans.map((v) => v.id).join(", ")}`);
  } else if (device.type === "router") {
    for (const i of (c.interfaces || [])) lines.push(`  iface → ${getDevice(i.peerId)?.name || i.peerId}: ${i.ipv4Address ? `${i.ipv4Address}/${prefixOf(i)}` : "(unset)"}`);
    if (c.staticRoutes?.length) lines.push(`  routes: ${c.staticRoutes.map((r) => `${r.network}→${r.nextHop}`).join(", ")}`);
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
    // Grouped by category (SCENARIO_GROUPS), matching the chooser; anything not
    // in a curated group is shown under "Other" so nothing is hidden.
    const byId = new Map(SCENARIOS.map(s => [s.id, s]));
    const placed = new Set<string>();
    const lines: string[] = [];
    for (const g of SCENARIO_GROUPS) {
      const items = g.ids.map(id => byId.get(id)).filter(Boolean) as typeof SCENARIOS;
      if (!items.length) continue;
      lines.push(`${g.label}:`);
      for (const s of items) { lines.push(`  ${s.id} — ${s.name}`); placed.add(s.id); }
    }
    const other = SCENARIOS.filter(s => !placed.has(s.id));
    if (other.length) { lines.push("Other:"); for (const s of other) lines.push(`  ${s.id} — ${s.name}`); }
    return ok(...lines);
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
      output: [...r.checks.flatMap(c => [`${c.passed ? "✓" : "✗"} ${c.label}`,
        ...(!c.passed && c.note ? [`    ${c.note}`] : []),
        ...(!c.passed ? (c.why || []).map(line => `    why: ${line}`) : []),
        ...(!c.passed && c.hint ? [`    likely cause: ${c.hint}`] : [])]),
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

// power <device> on|off — the canvas power state, which the script export
// previously had no way to reproduce.
function cmdPower(args: string[]): CommandResult {
  const dev = resolveDevice(args[0]);
  if (typeof dev === "string") return err(dev);
  const mode = (args[1] || "").toLowerCase();
  if (mode !== "on" && mode !== "off") return err("Usage: power <device> on|off");
  return ok(mutationText(setDevicePower(dev, mode === "on")));
}

// portcount <device> [serial] <n> — a device's physical port capacity. Each
// type keeps its own range (the same clamps the inspector applies).
function cmdPortCount(args: string[]): CommandResult {
  const dev = resolveDevice(args[0]);
  if (typeof dev === "string") return err(dev);
  const serial = (args[1] || "").toLowerCase() === "serial";
  const n = Number(serial ? args[2] : args[1]);
  if (!Number.isInteger(n)) return err("Usage: portcount <device> [serial] <n>");
  if (serial && dev.type !== "router") return err("portcount: only a router has serial ports.");
  const clamp: Record<string, (v: number) => number> = {
    switch: clampPortCount, hub: clampPortCount, internet: clampPortCount,
    router: clampRouterPortCount, "access-point": clampApPortCount,
    firewall: clampFirewallPortCount,
  };
  const fn = clamp[dev.type];
  if (!fn) return err(`portcount: ${dev.name} (${dev.type}) has no configurable port count.`);
  if (fn(n) !== n) return err(`portcount: ${n} is outside the ${dev.type}'s supported range.`);
  pushUndo();
  ensureConfig(dev);
  if (serial) (dev.config).serialPorts = n; else (dev.config).ethernetPorts = n;
  sync().syncPanel(); sync().render();
  return ok(`${dev.name}: ${serial ? "serial" : "ethernet"} ports = ${n}.`);
}

function cmdStress(args: string[]): CommandResult {
  const seedText = args[0];
  const stepsText = args[1];
  if (seedText && !/^\d+$/.test(seedText)) return err("stress: seed must be an unsigned whole number.");
  if (stepsText && !/^\d+$/.test(stepsText)) return err(`stress: steps must be a whole number from 1 to ${MAX_STRESS_STEPS}.`);
  if (args.length > 2) return err("stress: expected stress [seed] [steps].");

  const seed = seedText ? Number(seedText) : DEFAULT_STRESS_SEED;
  const steps = stepsText ? Number(stepsText) : DEFAULT_STRESS_STEPS;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    return err("stress: seed must be between 0 and 4294967295.");
  }
  if (!Number.isSafeInteger(steps) || steps < 1 || steps > MAX_STRESS_STEPS) {
    return err(`stress: steps must be a whole number from 1 to ${MAX_STRESS_STEPS}.`);
  }

  const report = runStressTest(seed, steps, runConsoleCommand, () => state, diagnoseState);
  if (report.ok) {
    return {
      ok: true,
      data: report,
      output: [`Stress passed: ${report.completedSteps} actions (seed ${report.seed}, ${report.rejectedCommands} expected rejections).`],
    };
  }
  return {
    ok: false,
    data: report,
    output: [
      `Stress failed after ${report.completedSteps}/${report.requestedSteps} actions (seed ${report.seed}).`,
      ...report.issues,
      `Replay with: stress ${report.seed} ${report.requestedSteps}`,
    ],
  };
}

// ── Registry ─────────────────────────────────────────────────────────────────

type Handler = (args: string[], rest: string, tail: (n: number) => string) => CommandResult;

const COMMANDS: Record<string, Handler> = {
  add: cmdAdd, remove: cmdRemove, delete: cmdRemove, link: cmdLink, unlink: cmdUnlink, linkset: cmdLinkSet,
  shut: cmdShut, noshut: cmdNoShut,
  move: cmdMove, rename: cmdRename, clear: cmdClear, collapse: cmdCollapse, expand: cmdExpand,
  ip: cmdIp, gateway: cmdGateway, nameserver: cmdNameserver, mac: cmdMac, ssid: cmdSsid, interface: cmdInterface, route: cmdRoute,
  supplicant: cmdSupplicant, portauth: cmdPortAuth, radius: cmdRadius, ports: cmdPorts, dot1x: cmdDot1x, macsec: cmdMacsec,
  vlan: cmdVlan, port: cmdPort, managed: cmdManaged, role: cmdRole, rulelang: cmdRuleLang, stp: cmdStp, mirror: cmdMirror, web: cmdWeb, idsrule: cmdIdsRule, attack: cmdAttack, redteam: cmdRedteam, cli: cmdCli,
  ping: cmdPing, dhcp: cmdDhcp, connect: cmdConnect, http: cmdHttp, associate: cmdAssociate, run: cmdRun, traceroute: cmdTraceroute, tracert: cmdTraceroute,
  play: cmdPlay, pause: cmdPause, step: cmdStep,
  stop: cmdStop, speed: cmdSpeed, seed: cmdSeed, why: cmdWhy,
  topology: cmdTopology, save: cmdSave, load: cmdLoad, undo: cmdUndo, redo: cmdRedo, export: cmdExport,
  list: cmdList, show: cmdShow, status: cmdStatus, log: cmdLog,
  select: cmdSelect, tool: cmdTool, theme: cmdTheme, zoom: cmdZoom, fit: cmdFit,
  scenario: cmdScenario,
  power: cmdPower, portcount: cmdPortCount,
  stress: cmdStress,
  help: cmdHelp,
};

const HELP: Record<string, string> = {
  add: "add <computer|laptop|server|switch|router|firewall|hub|access-point> [name] [at <x> <y>]",
  remove: "remove <device>", link: "link <a> <b> [portA portB] (a port number pins that end; auto leaves it to the next free port)", unlink: "unlink <a> <b>",
  linkset: "linkset <a> <b> name|bandwidth|latency|loss <value> (0 clears a number)",
  shut: "shut <a> <b> (administratively down the link)", noshut: "noshut <a> <b> (bring the link up)",
  move: "move <device> <x> <y>", rename: "rename <device> <name>", clear: "remove all devices",
  collapse: "collapse <switch> [as <name>] — into a LAN node", expand: "expand <lan>",
  ip: "ip <host> <addr/prefix>", gateway: "gateway <host> <ip>", nameserver: "nameserver <host> <ip>", mac: "mac <host|switch> <addr>",
  ssid: "ssid <laptop|access-point> <name> [password] (omit password = open; \"\" clears the name)",
  supplicant: "supplicant <host> <identity> <password> (set 802.1X credentials)",
  portauth: "portauth <switch> <EthN> <auto|force-authorized|force-unauthorized>",
  radius: "radius <server> <identity> <password> (add a RADIUS user, enables the back end)",
  ports: "ports <host> <port[,port…]> (set the host's listening TCP ports; 'none' clears)",
  dot1x: "dot1x <host> (animate the 802.1X EAP/RADIUS exchange)",
  macsec: "macsec <device> <peer> <key|dot1x> [must|should] (802.1AE link encryption; 'dot1x' derives keys from 802.1X, 'off' clears)",
  interface: "interface <router> <peer> ip <addr> [vlan <tag>]", route: "route <router> <net/prefix> <nextHop>",
  vlan: "vlan <switch> add <id> [name] | vlan <switch> del <id>", port: "port <switch> <EthN> vlan|mode|native|allowed ...",
  managed: "managed <switch> [on|off] (enable the switch's management plane: VLANs, STP, port security)",
  role: "role <router> border|internal (set the router's placement archetype — border faces the outside)",
  rulelang: "rulelang <firewall|router> iptables|nftables (which language its view / add-rule form / export speak; both shells always parse either)",
  stp: "stp (animate the BPDU exchange) | stp <switch> on|off | stp <switch> priority <n> (default on for managed switches)",
  mirror: "mirror <switch> <dst-port> [src-port…] | mirror <switch> off (SPAN: copy traffic to a monitor port for an IDS)",
  web: "web <server> on|off [title] (enable/disable the server's HTTP service)",
  idsrule: "idsrule <ids> <snort rule> | idsrule <ids> clear (manage a Snort IDS sensor's rules)",
  attack: "attack <redteam> [scan|sweep|arp-spoof] [target] (launch a Red Team host's simulated attacks)",
  redteam: "redteam <node> target <ip> | attacks <scan,sweep,arp-spoof> | spoof <ip> (configure a Red Team host)",
  cli: "cli <device> <raw CLI command>",
  ping: "ping <src> <dst> (animated)", dhcp: "dhcp <host> (animated)", connect: "connect <src> <dst> <port> (animated TCP handshake)",
  http: "http <src> <host>[:port][/path] [path] (animated HTTP GET over the TCP handshake)",
  associate: "associate <laptop> (animate the 802.11 join: probe/auth/assoc + WPA2 if secured)",
  run: "run ping <src> <dst> | run connect <src> <dst> <port> | run http <src> <host> | run resolve <src> <name> | run dhcp <host> | run associate <laptop> | run dot1x <host> | run stp (headless, returns result)",
  traceroute: "traceroute <src> <dst> (hop-by-hop via TTL)",
  play: "resume", pause: "pause", step: "advance one hop", stop: "stop", speed: "speed <ms-per-hop>",
  seed: "seed [<n>|off] — pin the run's random seed for reproducible ports/ids (default: clock)",
  why: "why [<packet no>] — explain a captured packet: the chain of frames that led to it, with each device's reason",
  topology: "topology basic|vlan-roas|router-mesh|wifi-vlan", save: "save <name>", load: "load <name>",
  undo: "undo", redo: "redo", export: "export topology as a reproducible script",
  list: "list [links]", show: "show <device>", status: "simulation status + last result", log: "hop-by-hop log",
  select: "select <device>", tool: "tool <name>", theme: "theme warm-light|dark|blueprint", zoom: "zoom <scale>", fit: "fit to view",
  scenario: "scenario list | load <id> | goal | check",
  power: "power <device> on|off", portcount: "portcount <device> [serial] <n> (physical port capacity)",
  stress: `stress [seed] [steps] — REPLACES your topology and mutates it randomly (dev tool; max ${MAX_STRESS_STEPS} steps, not undoable)`,
  help: "help [command]",
};

// ── Entry points ─────────────────────────────────────────────────────────────

export function runConsoleCommand(line: string): CommandResult {
  const trimmed = (line || "").trim();
  if (!trimmed || trimmed.startsWith("#")) return ok();
  const { args: tokens, ends, error } = tokenizeCommand(trimmed);
  if (error) return err(error);
  if (!tokens.length) return ok();
  const verb = tokens[0].toLowerCase();
  const handler = COMMANDS[verb];
  if (!handler) return err(`Unknown command: ${verb}. Try "help".`);
  // Raw source after token `n` — for handlers whose tail is free text (a shell
  // line, a Snort rule) that must reach them exactly as typed, unsplit.
  const tail = (n: number) => (n < ends.length ? trimmed.slice(ends[n]).trim() : "");
  try {
    takePreemptionNote();   // drop a note left by a run this command didn't start
    const result = handler(tokens.slice(1), tail(0), tail);
    // A headless verb (run, traceroute, scenario check) stops an animated run in
    // flight first (engine beginRun) — say so here too, not just in its terminal.
    const note = takePreemptionNote();
    if (note) result.output.unshift(note);
    return result;
  } catch (e) {
    return err(`Error: ${(e instanceof Error && e.message) || String(e)}`);
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
// The port a `link` line states for one end of a cable. Never a made-up number:
// the export used to write `1` for an end nobody pinned, which on replay took
// port 1 first and pushed the real pin elsewhere, so every later line naming a
// port (vlan, mirror, portauth, a NAT role) landed on the wrong cable.
//   - a pinned end states its pin;
//   - an unpinned end on a device with NO pinned cables is `auto` (null): its
//     cables replay in order onto the same ports;
//   - an unpinned end on a device that HAS a pinned cable states the port it
//     occupies now. Where that cable sits depends on the pins around it, and a
//     replay adds one cable at a time — a later pin can no longer displace an
//     earlier implicit cable (it is refused), so the layout is written out.
function exportedPort(payloadLink: any, deviceId: string): number | null {
  const pinned = payloadLink.from === deviceId ? payloadLink.fromPort : payloadLink.toPort;
  if (pinned != null) return pinned;
  const pinsHere = state.links.some(l => isPhysicalLink(l) &&
    ((l.from === deviceId && l.fromPort != null) || (l.to === deviceId && l.toPort != null)));
  if (!pinsHere) return null;
  const live = state.links.find(l => l.from === payloadLink.from && l.to === payloadLink.to);
  const name = live ? linkPortName(live, deviceId) : null;
  const n = name ? Number(name.replace(/\D+/g, "")) : 0;
  return n > 0 ? n : null;
}

// Give every device in an export payload a name no other device in it has
// (ignoring case), in payload order — deterministic, so the same network always
// exports the same script. Renames in place; returns a `#` comment per rename.
function uniqueExportNames(devices: { name: string }[]): string[] {
  const original = new Set(devices.map(d => d.name.toLowerCase()));
  const used = new Set<string>();
  const notes: string[] = [];
  for (const d of devices) {
    const lower = d.name.toLowerCase();
    if (!used.has(lower)) { used.add(lower); continue; }
    let n = 2;
    while (used.has(`${lower}-${n}`) || original.has(`${lower}-${n}`)) n++;
    const unique = `${d.name}-${n}`;
    notes.push(`# two devices were named ${quoteArg(d.name)} — this script calls the later one ${quoteArg(unique)}`);
    d.name = unique;
    used.add(unique.toLowerCase());
  }
  return notes;
}

export function exportTopologyScript(): string {
  const payload: any = buildConfigPayload();
  // The script addresses devices by name, so every name in it must be unique
  // (ignoring case, as `resolveDevice` matches). The commands refuse a
  // duplicate, but a JSON import or a collapse can still produce one — the
  // first holder keeps the name, each later one is written as `<name>-2`,
  // `-3`, … (the lowest suffix nothing else uses), and the script says so.
  const renamed = uniqueExportNames(payload.devices);
  // Names are quoted on the way out so a name containing a space still parses
  // back into exactly one token (`add computer "My PC" at 0 0`).
  const idToName = new Map<string, string>(payload.devices.map((d: any) => [d.id, quoteArg(d.name)]));
  const lines: string[] = ["clear", ...renamed];

  for (const d of payload.devices) {
    if (d.type === "lan") continue;
    lines.push(`add ${d.type} ${quoteArg(d.name)} at ${Math.round(d.x)} ${Math.round(d.y)}`);
  }
  // Non-default port capacities — previously unrepresentable, so a
  // saved-then-replayed topology silently came back with default port counts.
  // (Power state is written last: see the end of this function.)
  for (const d of payload.devices) {
    if (d.type === "lan") continue;
    const c = d.config || {};
    const defaultPorts = defaultPortCount(d.type);
    if (defaultPorts > 0 && c.ethernetPorts != null && c.ethernetPorts !== defaultPorts) lines.push(`portcount ${quoteArg(d.name)} ${c.ethernetPorts}`);
    if (d.type === "router" && c.serialPorts != null && c.serialPorts !== 4) lines.push(`portcount ${quoteArg(d.name)} serial ${c.serialPorts}`);
  }

  // Cables BEFORE per-device config: anything that names a port or interface
  // (`port SW Ethernet2 …`, `mirror … Ethernet3`, the router CLI's `interface
  // Ethernet1` for NAT roles) can only resolve once the link exists — emitted
  // after, `interface Ethernet1` opened an unbound config-if prompt and the
  // `ip nat` inside it was silently lost.
  for (const l of payload.links) {
    if (l.proxy) continue;   // a collapsed LAN's stand-in cable — `collapse` recreates it (below)
    const f = idToName.get(l.from); const t = idToName.get(l.to);
    if (!f || !t) continue;
    const fromPort = exportedPort(l, l.from), toPort = exportedPort(l, l.to);
    const ports = (fromPort != null || toPort != null) ? ` ${fromPort ?? "auto"} ${toPort ?? "auto"}` : "";
    lines.push(`link ${f} ${t}${ports}`);
    if (l.shutdown) lines.push(`shut ${f} ${t}`);
    if (l.name) lines.push(`linkset ${f} ${t} name ${quoteArg(l.name)}`);
    if (l.bandwidth) lines.push(`linkset ${f} ${t} bandwidth ${l.bandwidth}`);
    if (l.latency) lines.push(`linkset ${f} ${t} latency ${l.latency}`);
    if (l.loss) lines.push(`linkset ${f} ${t} loss ${l.loss}`);
  }

  for (const d of payload.devices) {
    const c = d.config || {};
    if (isHost(d.type)) {
      // Every host — PC, laptop, server, Kali PC, Red Team actor — shares the
      // host lines (address, supplicant, listening ports); the type-specific
      // ones (SSID, dnsmasq, the Red Team plan) are gated within.
      if (c.ipv4Address) lines.push(`ip ${quoteArg(d.name)} ${c.ipv4Address}/${prefixOf(c)}`);
      if (c.gatewayIpv4Address) lines.push(`gateway ${quoteArg(d.name)} ${c.gatewayIpv4Address}`);
      if (c.macAddress) lines.push(`mac ${quoteArg(d.name)} ${c.macAddress}`);
      if (c.dnsServerIp) lines.push(`nameserver ${quoteArg(d.name)} ${c.dnsServerIp}`);
      // Always stated for a laptop: a new one defaults to the shared SSID, so an
      // empty (unconfigured) one must be written out as "".
      if (d.type === "laptop") lines.push(`ssid ${quoteArg(d.name)} ${quoteArg(c.ssid || "")}${c.wifiPassword ? ` ${quoteArg(c.wifiPassword)}` : ""}`);
      // dnsmasq state replays through the server terminal (same as a human would type).
      for (const r of (c.dnsRecords || [])) lines.push(`cli ${quoteArg(d.name)} echo address=/${r.name}/${r.ip} >> /etc/dnsmasq.conf`);
      if (c.dhcpRangeStart && c.dhcpRangeEnd) lines.push(`cli ${quoteArg(d.name)} echo dhcp-range=${c.dhcpRangeStart},${c.dhcpRangeEnd} >> /etc/dnsmasq.conf`);
      if (c.dhcpRouterIp) lines.push(`cli ${quoteArg(d.name)} echo dhcp-option=option:router,${c.dhcpRouterIp} >> /etc/dnsmasq.conf`);
      if (d.type === "server" && c.dnsmasqRunning === false) lines.push(`cli ${quoteArg(d.name)} systemctl stop dnsmasq`);
      // The password is ALWAYS written, quoted — an empty one as "". Dropping it
      // left `supplicant PC alice`, which replays as a usage error, and the
      // credential was lost.
      if (c.dot1x?.identity) lines.push(`supplicant ${quoteArg(d.name)} ${quoteArg(c.dot1x.identity)} ${quoteArg(c.dot1x.password ?? "")}`);
      for (const u of (c.radius?.users || [])) lines.push(`radius ${quoteArg(d.name)} ${quoteArg(u.identity)} ${quoteArg(u.password ?? "")}`);
      if (Array.isArray(c.openPorts)) lines.push(c.openPorts.length ? `ports ${quoteArg(d.name)} ${c.openPorts.join(",")}` : `ports ${quoteArg(d.name)} closed`);
      if (c.httpEnabled) lines.push(`web ${quoteArg(d.name)} on${c.httpTitle ? ` ${quoteArg(c.httpTitle)}` : ""}`);
      // IP forwarding, replayed through the host shell as a person would set it.
      if (c.ipForward) lines.push(`cli ${quoteArg(d.name)} sysctl -w net.ipv4.ip_forward=1`);
      if (d.type === "attacker") {
        if (Array.isArray(c.attacks)) lines.push(`redteam ${quoteArg(d.name)} attacks ${c.attacks.join(",")}`);
        if (c.attackTarget) lines.push(`redteam ${quoteArg(d.name)} target ${c.attackTarget}`);
        if (c.spoofIp) lines.push(`redteam ${quoteArg(d.name)} spoof ${c.spoofIp}`);
      }
    } else if (d.type === "switch") {
      if (c.managed) {
        lines.push(`managed ${quoteArg(d.name)}`);   // a managed switch needs its management plane on before VLAN/STP config
        // The base MAC breaks spanning-tree ties. `add` derives it from the
        // name, so it is written only when it is something else (a renamed
        // switch, a `mac` edit, a saved network's id-derived one) — the replay
        // then elects the same root and blocks the same link.
        if (c.macAddress && c.macAddress !== defaultBridgeMac(d.name)) lines.push(`mac ${quoteArg(d.name)} ${c.macAddress}`);
        // A VLAN's name is written when it is not the default — `Sales` used to
        // come back as `Vlan10`.
        for (const v of (c.vlans || [])) {
          const defaultName = v.id === 1 ? "default" : `Vlan${v.id}`;
          const named = v.name && v.name !== defaultName ? ` ${quoteArg(v.name)}` : "";
          if (v.id !== 1 || named) lines.push(`vlan ${quoteArg(d.name)} add ${v.id}${named}`);
        }
        for (const [port, mode] of Object.entries(c.portModes || {})) lines.push(`port ${quoteArg(d.name)} ${port} mode ${mode}`);
        for (const [port, id] of Object.entries(c.portVlans || {})) lines.push(`port ${quoteArg(d.name)} ${port} vlan ${id}`);
        for (const [port, id] of Object.entries(c.trunkNativeVlans || {})) lines.push(`port ${quoteArg(d.name)} ${port} native ${id}`);
        for (const [port, ids] of Object.entries(c.trunkAllowedVlans || {})) {
          for (const id of (ids as number[])) lines.push(`port ${quoteArg(d.name)} ${port} allowed add ${id}`);
        }
      }
      for (const [port, mode] of Object.entries(c.portAuth || {})) lines.push(`portauth ${quoteArg(d.name)} ${port} ${mode}`);
      // STP is on by default for managed switches — only emit a deviation.
      if (c.managed && c.stp) {
        if (c.stp.enabled === false) lines.push(`stp ${quoteArg(d.name)} off`);
        if (c.stp.priority != null && c.stp.priority !== DEFAULT_BRIDGE_PRIORITY) lines.push(`stp ${quoteArg(d.name)} priority ${c.stp.priority}`);
      }
      // SPAN port mirroring (the IDS link's explicit ports — emitted below — keep the dest valid).
      if (c.managed && c.mirror?.dest) lines.push(`mirror ${quoteArg(d.name)} ${c.mirror.dest}${c.mirror.sources?.length ? " " + c.mirror.sources.join(" ") : ""}`);
    } else if (d.type === "ids") {
      // Reset the default rule set, then re-add the exact local.rules contents.
      lines.push(`idsrule ${quoteArg(d.name)} clear`);
      for (const rule of (c.idsRules || [])) lines.push(`idsrule ${quoteArg(d.name)} ${rule}`);
    } else if (d.type === "router") {
      if (c.role === "border") lines.push(`role ${quoteArg(d.name)} border`);
      for (const i of (c.interfaces || [])) {
        const peer = idToName.get(i.peerId);
        if (peer && i.ipv4Address) {
          lines.push(`interface ${quoteArg(d.name)} ${peer} ip ${i.ipv4Address}/${prefixOf(i)}${i.vlanTag != null ? ` vlan ${i.vlanTag}` : ""}`);
        }
      }
      for (const r of (c.staticRoutes || [])) lines.push(`route ${quoteArg(d.name)} ${r.network} ${r.nextHop}`);
      // Everything below replays through the router's own FRR / netfilter CLI —
      // the same commands a person would type — in one enable/configure/end
      // block: RIP, NAT interface roles, static port-forwards, then the filter
      // policy + rules (privileged mode, after `end`). Before this the export
      // dropped RIP, NAT roles, and the whole filter, so a replayed router
      // came back with none of them.
      const cli = (line: string) => `cli ${quoteArg(d.name)} ${line}`;
      const cfg: string[] = [];
      if (c.rip?.enabled) {
        cfg.push("router rip");
        for (const n of (c.rip.networks || [])) cfg.push(`network ${n}`);
        for (const p of (c.rip.passiveInterfaces || [])) cfg.push(`passive-interface ${p}`);
        cfg.push("exit");
      }
      const live = state.devices.find(x => x.id === d.id);
      const named = live ? routerInterfacesWithNames(live) : [];
      for (const i of (c.interfaces || [])) {
        if (!i.peerId) continue;   // an unplugged port's entry — written by name, below
        if (i.natRole !== "inside" && i.natRole !== "outside") continue;
        const entry = named.find((n) => n.peerId === i.peerId && (n.config?.vlanTag ?? null) === (i.vlanTag ?? null));
        if (!entry) continue;
        cfg.push(`interface ${entry.name}`, `ip nat ${i.natRole}`, "exit");
      }
      // A port with no cable keeps its configuration (set there before cabling,
      // or left when its cable was pulled). It has no peer to name, so it
      // replays through the shell by port name. Sub-interfaces parked on an
      // unplugged port cannot be typed back (the shell needs a cable to carry
      // a VLAN): say so rather than drop them silently — the JSON save keeps them.
      for (const i of (c.interfaces || [])) {
        if (i.peerId || !i.name) continue;
        if (i.vlanTag != null) {
          if (i.ipv4Address) lines.push(`# ${d.name} ${i.name}.${i.vlanTag} (unplugged) had ${i.ipv4Address}/${prefixOf(i)} — re-create the sub-interface once the port is cabled`);
          continue;
        }
        if (!i.ipv4Address && !i.natRole) continue;
        cfg.push(`interface ${i.name}`);
        if (i.ipv4Address) cfg.push(`ip address ${i.ipv4Address}/${prefixOf(i)}`);
        if (i.natRole === "inside" || i.natRole === "outside") cfg.push(`ip nat ${i.natRole}`);
        cfg.push("exit");
      }
      for (const r of (c.portForwards || [])) cfg.push(`ip nat inside source static tcp ${r.insideIp} ${r.insidePort} ${r.outsideIp} ${r.outsidePort}`);
      // netfilter replays in the device's chosen language (round-tripping the
      // `rulelang` toggle too) — both shells parse either, so the rules are the
      // same model whichever is emitted.
      const nft = ruleLangOf(d) === "nftables";
      const priv: string[] = [];
      if (nft) {
        for (const [chain, pol] of Object.entries(c.policy || {})) if (pol === "drop") priv.push(`nft add chain inet filter ${chain} { policy drop ; }`);
        for (const r of (c.rules || [])) priv.push(`nft add rule inet filter ${r.chain || "forward"} ${ruleToNft(r)}`);
      } else {
        for (const [chain, pol] of Object.entries(c.policy || {})) if (pol === "drop") priv.push(`iptables -P ${String(chain).toUpperCase()} DROP`);
        for (const r of (c.rules || [])) priv.push(ruleToIptables(r));
      }
      if (nft) lines.push(`rulelang ${quoteArg(d.name)} nftables`);
      if (cfg.length || priv.length) lines.push(cli("enable"));
      if (cfg.length) lines.push(cli("configure terminal"), ...cfg.map(cli), cli("end"));
      lines.push(...priv.map(cli));
    } else if (d.type === "firewall") {
      // The transparent filter had NO export branch — a DROP policy with an
      // allow-list replayed as an empty ACCEPT firewall. Same shape as the
      // router, minus the mode dance (the firewall shell is flat), and in the
      // device's chosen language (round-tripping the `rulelang` toggle).
      const nft = ruleLangOf(d) === "nftables";
      if (nft) lines.push(`rulelang ${quoteArg(d.name)} nftables`);
      if (nft) {
        if (c.policy?.forward === "drop") lines.push(`cli ${quoteArg(d.name)} nft add chain inet filter forward { policy drop ; }`);
        for (const r of (c.rules || [])) lines.push(`cli ${quoteArg(d.name)} nft add rule inet filter ${r.chain || "forward"} ${ruleToNft(r)}`);
      } else {
        if (c.policy?.forward === "drop") lines.push(`cli ${quoteArg(d.name)} iptables -P FORWARD DROP`);
        for (const r of (c.rules || [])) lines.push(`cli ${quoteArg(d.name)} ${ruleToIptables(r)}`);
      }
    } else if (d.type === "access-point") {
      lines.push(`ssid ${quoteArg(d.name)} ${quoteArg(c.ssid || "")}${c.wifiPassword ? ` ${quoteArg(c.wifiPassword)}` : ""}`);
    }
    // MACsec keys (any device, keyed by peer) — each end emits its own.
    for (const [peerId, m] of Object.entries((c.macsec || {}) as Record<string, any>)) {
      const peer = idToName.get(peerId);
      // The key is quoted: `my key must` used to replay as the key "my" in
      // should-secure mode — a silent downgrade from must-secure.
      if (peer) lines.push(`macsec ${quoteArg(d.name)} ${peer} ${m.derive ? "dot1x" : quoteArg(m.cak ?? "")} ${m.mode}`);
    }
  }

  // Collapsed LANs last, once everything inside them is built: collapse each
  // around its switch (inner LANs first — payload order is creation order),
  // then restore a name or position the learner gave the LAN node. The LAN
  // device and its proxy link are views, never `add`ed or `link`ed.
  for (const d of payload.devices) {
    if (d.type !== "lan") continue;
    const anchor = idToName.get(d.config?.anchorId);
    const anchorDevice = payload.devices.find((x: any) => x.id === d.config?.anchorId);
    if (!anchor || !anchorDevice) continue;
    // The node is named as it is collapsed. A separate `rename "<switch> LAN"`
    // could hit another device that already has that name.
    lines.push(d.name === `${anchorDevice.name} LAN` ? `collapse ${anchor}` : `collapse ${anchor} as ${quoteArg(d.name)}`);
    lines.push(`move ${quoteArg(d.name)} ${Math.round(d.x)} ${Math.round(d.y)}`);
  }

  // Power state goes last: a powered-off device refuses its shell, so every
  // `cli` line above must run while it is still on.
  for (const d of payload.devices) {
    if (d.type !== "lan" && d.poweredOff) lines.push(`power ${quoteArg(d.name)} off`);
  }

  return lines.join("\n");
}
