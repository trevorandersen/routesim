/**
 * Router terminal — modelled on FRRouting (vtysh): mode state machine
 * (exec/privileged/config/interface/rip), show commands, prefix abbreviation,
 * and context-sensitive `?` driven by the ROUTER_COMMANDS registry.
 */
import type { Device, TerminalSession, MutationResult } from "../types";
import { state, sync, pushUndo } from "../state";
import { isValidIpv4, parseIpv4Token, normaliseVlanId, prefixOf, clampPrefixLength, networkOf } from "../utils";
import { normaliseArpTable, normaliseDhcpLeases, normaliseStaticRoutes, normaliseRipConfig } from "../normalise";
import { routerInterfacesWithNames, routerInterfaceFor, routerInterfaceForName, routerInterfaceByName, applyHostname, linkedPortsFor } from "../devices";
import { buildRoutingTable, runRipConvergence } from "../engine";
import { terminalLine, terminalLineFor, closeSession } from "./core";
import { runIptablesCommand } from "./iptables";
import { runNftCommand } from "./nftables";

export function showRouterInterfaceBrief(router: Device): string {
  const interfaces = routerInterfacesWithNames(router);
  if (!interfaces.length) return "No interfaces configured.";
  return [
    ["Interface".padEnd(14), "IP-Address".padEnd(19), "Status".padEnd(22), "Protocol".padEnd(10), "VLAN".padEnd(6), "Connected to"].join(""),
    ...interfaces.map((iface: any) => {
      const vlanDisplay = iface.config.vlanTag != null ? String(iface.config.vlanTag) : "-";
      // A shut cable is "administratively down" with the line protocol down, as
      // on IOS — not "up/up" (review R41). The routing table already drops its
      // connected route, so the two views now agree.
      const shut = !!iface.link?.shutdown;
      const status = shut ? "administratively down" : (iface.peer ? "up" : "down");
      const protocol = (iface.peer && !shut) ? "up" : "down";
      return [
        iface.name.padEnd(14),
        (iface.config.ipv4Address ? `${iface.config.ipv4Address}/${prefixOf(iface.config)}` : "unassigned").padEnd(19),
        status.padEnd(22),
        protocol.padEnd(10),
        vlanDisplay.padEnd(6),
        iface.peer?.name || "-"
      ].join("");
    })
  ].join("\n");
}

// The routing table as it stands NOW. RIP's learned routes are derived state:
// stored on the router, but only true for the topology they were computed over.
// The show commands used to print them as stored — dead paths after an unlink,
// and no RIP routes at all until the first simulation had run — so every reader
// converges first (idempotent; the same call beginRun makes before a run), as
// `show spanning-tree` does for STP.
function currentRoutingTable(router: Device) {
  runRipConvergence();
  return buildRoutingTable(router);
}

export function showRouterRoute(router: Device): string {
  const table = currentRoutingTable(router);
  if (!table.length) return "Codes: C - connected, S - static, R - RIP\n\nNo routes configured.";
  return [
    "Codes: C - connected, S - static, R - RIP",
    "",
    ...table.map((route: any) => {
      if (route.type === "C") {
        return `C>* ${route.network} is directly connected, ${route.interface || "?"}`;
      }
      if (route.type === "S") {
        // An inactive static (unreachable next hop) is listed without the
        // selected marker, like FRR — it never forwards (review R18).
        return route.inactive
          ? `S   ${route.network} [1/0] via ${route.nextHop} inactive`
          : `S>* ${route.network} via ${route.nextHop}`;
      }
      // RIP
      return `R>* ${route.network} via ${route.nextHop} [${route.metric}]`;
    })
  ].join("\n");
}

export function showRouterArp(router: Device): string {
  const rows = routerInterfacesWithNames(router).flatMap((iface: any) =>
    normaliseArpTable(iface.config.arpTable || []).map((entry: any) => ({ ...entry, iface: iface.name }))
  );
  if (!rows.length) return "Address                  HWtype  HWaddress           Flags Mask            Iface";
  return [
    "Address                  HWtype  HWaddress           Flags Mask            Iface",
    ...rows.map((entry: any) => `${entry.ipv4Address.padEnd(24)}ether   ${entry.macAddress.padEnd(19)}C                     ${entry.iface}`)
  ].join("\n");
}

// `ip neigh flush all`: drop every interface's ARP entries (undoable).
export function flushRouterArp(router: Device): string {
  const ifaces = router.config?.interfaces ?? [];
  const count = ifaces.reduce((n, iface) => n + (iface.arpTable?.length ?? 0), 0);
  if (!count) return "ARP cache is already empty.";
  pushUndo();
  for (const iface of ifaces) iface.arpTable = [];
  sync().syncPanel();
  return `Flushed ${count} ARP ${count === 1 ? "entry" : "entries"}.`;
}

export function showRouterDhcpBindings(router: Device): string {
  const rows = routerInterfacesWithNames(router).flatMap((iface: any) =>
    normaliseDhcpLeases(iface.config.dhcpLeases || []).map((entry: any) => ({ ...entry, iface: iface.name }))
  );
  if (!rows.length) return "IP Address       Client MAC         Interface\n--- No active bindings ---";
  return [
    "IP Address       Client MAC         Interface",
    ...rows.map((entry: any) => `${entry.ipv4Address.padEnd(17)}${entry.macAddress.padEnd(19)}${entry.iface}`)
  ].join("\n");
}

export function showRouterRip(router: Device): string {
  runRipConvergence();   // learned routes are derived — never print them as stored
  const rip = normaliseRipConfig(router.config?.rip);
  if (!rip.enabled) return "RIP is not enabled on this router.";
  const lines = [
    "RIP Configuration:",
    `  Status: enabled`,
    `  Networks: ${rip.networks.length ? rip.networks.join(", ") : "(none)"}`,
    `  Passive interfaces: ${rip.passiveInterfaces.length ? rip.passiveInterfaces.join(", ") : "(none)"}`,
    `  Learned routes: ${rip.learnedRoutes.length}`
  ];
  return lines.join("\n");
}

// FRR `show ip rip` — the RIP route table (what RIP itself knows).
export function showRouterRipRoutes(router: Device): string {
  runRipConvergence();
  const rip = normaliseRipConfig(router.config?.rip);
  if (!rip.enabled) return "RIP is not enabled on this router.";
  const header = [
    "Codes: R - RIP, C - connected, S - Static",
    "Sub-codes: (n) - normal, (i) - interface",
    "",
    "     Network              Next Hop         Metric From",
  ];
  if (!rip.learnedRoutes.length) return header.join("\n");
  return [
    ...header,
    ...rip.learnedRoutes.map((r: any) =>
      `R(n) ${String(r.network).padEnd(21)}${String(r.nextHop).padEnd(17)}${String(r.metric).padEnd(7)}self`)
  ].join("\n");
}

// FRR `show ip route rip` — RIP entries as installed in the main routing table.
export function showRouterRouteRip(router: Device): string {
  const table = currentRoutingTable(router).filter((r: any) => r.type === "R");
  if (!table.length) return "Codes: C - connected, S - static, R - RIP\n\nNo RIP routes.";
  return [
    "Codes: C - connected, S - static, R - RIP",
    "",
    ...table.map((r: any) => `R>* ${r.network} via ${r.nextHop} [${r.metric}]`)
  ].join("\n");
}

export function showRouterRunningConfig(router: Device): string {
  const interfaces = routerInterfacesWithNames(router);
  const statics = normaliseStaticRoutes(router.config?.staticRoutes || []);
  return [
    "!",
    `hostname ${router.name}`,
    "!",
    ...interfaces.filter((iface: any) => iface.peer || iface.config.ipv4Address).flatMap((iface: any) => {
      const lines = [`interface ${iface.name}`];
      if (iface.config.vlanTag != null) lines.push(` encapsulation dot1q ${iface.config.vlanTag}`);
      lines.push(iface.config.ipv4Address ? ` ip address ${iface.config.ipv4Address}/${prefixOf(iface.config)}` : " no ip address");
      if (iface.config.natRole) lines.push(` ip nat ${iface.config.natRole}`);
      lines.push(" exit", "!");
      return lines;
    }),
    ...statics.map((r: any) => `ip route ${r.network} ${r.nextHop}`),
    ...(statics.length ? ["!"] : []),
    // Static port-forwards are configured in this same config mode; the
    // running-config used to omit them.
    ...(router.config?.portForwards || []).map((r: any) => `ip nat inside source static ${r.proto} ${r.insideIp} ${r.insidePort} ${r.outsideIp} ${r.outsidePort}`),
    ...((router.config?.portForwards || []).length ? ["!"] : []),
    ...(router.config?.rip?.enabled ? [
      "router rip",
      ...(router.config.rip.networks || []).map((n: string) => ` network ${n}`),
      ...(router.config.rip.passiveInterfaces || []).map((n: string) => ` passive-interface ${n}`),
      " exit",
      "!"
    ] : []),
    "end"
  ].join("\n");
}
export function setRouterInterfaceIp(router: Device, peerId: string, address: string, vlanTag?: number | null): string {
  const parsed = parseIpv4Token(address);
  if (!parsed) return `Invalid IPv4 address: ${address}`;
  pushUndo();
  const iface = routerInterfaceFor(router, peerId, vlanTag);
  iface.ipv4Address = parsed.address;
  if (parsed.prefixLength != null) iface.prefixLength = clampPrefixLength(parsed.prefixLength);
  sync().syncPanel();
  sync().render();
  return "";
}

// The same edit for a port with NO cable, keyed by its name (Ethernet3) — the
// entry the inspector's "not connected" rows edit. An empty address clears it.
// Returns an error string, or "" on success, like setRouterInterfaceIp.
export function setUncabledRouterInterfaceIp(router: Device, name: string, address: string): string {
  const parsed = address === "" ? null : parseIpv4Token(address);
  if (address !== "" && !parsed) return `Invalid IPv4 address: ${address}`;
  pushUndo();
  const iface = routerInterfaceForName(router, name);
  iface.ipv4Address = parsed ? parsed.address : "";
  if (parsed?.prefixLength != null) iface.prefixLength = clampPrefixLength(parsed.prefixLength);
  sync().syncPanel();
  sync().render();
  return "";
}

export function clearRouterInterfaceIp(router: Device, peerId: string, vlanTag?: number | null): void {
  pushUndo();
  const iface = routerInterfaceFor(router, peerId, vlanTag);
  iface.ipv4Address = "";
  sync().syncPanel();
  sync().render();
}
// ─── FRR command registry — drives abbreviation + context-sensitive `?` ───────
// FRR's vtysh lets you type any unambiguous prefix (`sh ip ro` → `show ip route`,
// `conf t` → `configure terminal`) and `?` lists the commands valid in the
// current mode. The registry below is the single source for both. Commands the
// existing handlers accept but that are missing here simply aren't abbreviated —
// they still work when typed in full (expansion returns null → pass through).
type RouterMode = "exec" | "privileged" | "config" | "interface" | "rip";
const ALL_ROUTER_MODES: RouterMode[] = ["exec", "privileged", "config", "interface", "rip"];
// `min`: the fewest characters of the FIRST keyword that may abbreviate it
// (default 1). `iptables` is a program, not a vtysh keyword, and it shares its
// first two letters with every `ip …` command: with no minimum, `ip add
// 10.0.0.1/24` typed in config mode (the commonest slip — forgetting
// `interface Ethernet1`) expanded to `iptables add …` and answered
// `iptables: unknown operation "add"` instead of "% Interface mode required."
interface RouterCmdSpec { tokens: string[]; args?: boolean; modes: RouterMode[]; min?: number }
const ROUTER_COMMANDS: RouterCmdSpec[] = [
  { tokens: ["enable"], modes: ["exec", "privileged"] },
  { tokens: ["configure", "terminal"], modes: ["privileged"] },
  { tokens: ["show", "ip", "interface", "brief"], modes: ALL_ROUTER_MODES },
  { tokens: ["show", "ip", "route"], modes: ALL_ROUTER_MODES },
  { tokens: ["show", "ip", "route", "rip"], modes: ALL_ROUTER_MODES },
  { tokens: ["show", "ip", "arp"], modes: ALL_ROUTER_MODES },
  { tokens: ["show", "ip", "dhcp", "binding"], modes: ALL_ROUTER_MODES },
  { tokens: ["show", "ip", "rip"], modes: ALL_ROUTER_MODES },
  { tokens: ["show", "ip", "rip", "status"], modes: ALL_ROUTER_MODES },
  { tokens: ["show", "running-config"], modes: ALL_ROUTER_MODES },
  { tokens: ["write", "memory"], modes: ["privileged"] },
  { tokens: ["clear", "ip", "rip", "database"], modes: ["privileged", "config", "rip"] },
  { tokens: ["do"], args: true, modes: ["config", "interface", "rip"] },
  { tokens: ["hostname"], args: true, modes: ["config"] },
  { tokens: ["interface"], args: true, modes: ["config"] },
  { tokens: ["ip", "address"], args: true, modes: ["interface"] },
  { tokens: ["no", "ip", "address"], modes: ["interface"] },
  { tokens: ["ip", "nat", "inside"], modes: ["interface"] },
  { tokens: ["ip", "nat", "outside"], modes: ["interface"] },
  { tokens: ["no", "ip", "nat", "inside"], modes: ["interface"] },
  { tokens: ["no", "ip", "nat", "outside"], modes: ["interface"] },
  { tokens: ["ip", "nat", "inside", "source", "static", "tcp"], args: true, modes: ["config"] },
  { tokens: ["no", "ip", "nat", "inside", "source", "static", "tcp"], args: true, modes: ["config"] },
  { tokens: ["show", "ip", "nat", "translations"], modes: ALL_ROUTER_MODES },
  { tokens: ["clear", "ip", "nat", "translation"], args: true, modes: ["privileged", "config"] },
  { tokens: ["iptables"], args: true, modes: ["privileged", "config"], min: 3 },
  { tokens: ["ip", "neigh", "flush", "all"], modes: ["privileged", "config"] },
  { tokens: ["encapsulation", "dot1q"], args: true, modes: ["interface"] },
  { tokens: ["no", "encapsulation", "dot1q"], modes: ["interface"] },
  { tokens: ["ip", "route"], args: true, modes: ["config"] },
  { tokens: ["no", "ip", "route"], args: true, modes: ["config"] },
  { tokens: ["router", "rip"], modes: ["config"] },
  { tokens: ["no", "router", "rip"], modes: ["config"] },
  { tokens: ["network"], args: true, modes: ["rip"] },
  { tokens: ["no", "network"], args: true, modes: ["rip"] },
  { tokens: ["passive-interface"], args: true, modes: ["rip"] },
  { tokens: ["no", "passive-interface"], args: true, modes: ["rip"] },
  { tokens: ["exit"], modes: ALL_ROUTER_MODES },
  { tokens: ["end"], modes: ["privileged", "config", "interface", "rip"] },
  { tokens: ["clear"], modes: ALL_ROUTER_MODES },
];

// A router session's CLI mode points at configuration: `rip` mode at the
// router's RIP process, `interface` mode at one cabled (sub-)interface. That
// configuration can go away behind the shell's back — an undo or redo rewinds
// it, a cable is pulled, the sub-interface is removed elsewhere — and the mode
// would then dangle: `network …` dereferenced a RIP block that no longer
// existed (a TypeError that escaped the submit), and `ip address …` silently
// recreated the undone sub-interface. So the mode is checked against the live
// router wherever it is read (each command, each terminal render): a mode whose
// target is gone falls back to configuration mode, and the session says why.
export function reconcileRouterSession(session: TerminalSession, router: Device): void {
  if (session.mode === "rip") {
    if (router.config?.rip?.enabled) return;
    session.mode = "config";
    terminalLineFor(session, "muted", `% RIP is no longer enabled on ${router.name} — back in configuration mode (router rip to re-enter).`);
    return;
  }
  if (session.mode !== "interface") return;
  if (!session.interfacePeerId && session.interfaceName) {
    // Configuring a port that had no cable. It may have gained one, or gone.
    const base = session.interfaceName.toLowerCase();
    const now = routerInterfacesWithNames(router).find((i: any) => i.name.toLowerCase().split(".")[0] === base);
    if (now && !now.peer) return;                       // still there, still unplugged
    if (now) {
      // The port is the same port; it is keyed by its peer now that it has one.
      terminalLineFor(session, "muted", `% ${session.interfaceName} is now cabled to ${now.peer!.name} — configuring that interface.`);
      session.interfacePeerId = now.peerId;
      session.interfaceVlanTag = null;
      session.interfaceName = null;
      return;
    }
    const name = session.interfaceName;
    session.mode = "config";
    clearInterfaceTarget(session);
    terminalLineFor(session, "muted", `% ${name} no longer exists on ${router.name} — back in configuration mode.`);
    return;
  }
  const peerId = session.interfacePeerId;
  const tag = session.interfaceVlanTag;
  let gone: string | null = null;
  if (!peerId || !linkedPortsFor(router.id).some((port: any) => port?.peer?.id === peerId)) {
    gone = "The interface you were configuring is no longer cabled";
  } else if (tag != null && !(router.config?.interfaces || []).some((i: any) => i.peerId === peerId && i.vlanTag === tag)) {
    gone = `Sub-interface .${tag} no longer exists`;
  }
  if (!gone) return;
  session.mode = "config";
  clearInterfaceTarget(session);
  terminalLineFor(session, "muted", `% ${gone} — back in configuration mode.`);
}

// ── What the session's config-if commands act on ─────────────────────────────
// A cabled interface is keyed by its peer (+ VLAN tag for a sub-interface). A
// port with no cable has no peer, so the session holds its name instead and the
// commands edit the by-name entry the inspector's "not connected" rows use
// (`routerInterfaceForName`). The guards used to test `interfacePeerId` alone:
// an uncabled port's is "", so `interface Ethernet3` entered config-if and
// then every command answered "Interface mode required" (review R39).

function clearInterfaceTarget(session: TerminalSession): void {
  session.interfacePeerId = null;
  session.interfaceVlanTag = null;
  session.interfaceName = null;
}

function inInterfaceMode(): boolean {
  return state.terminal.mode === "interface" && !!(state.terminal.interfacePeerId || state.terminal.interfaceName);
}

// The name of the uncabled port being configured, or null on a cabled one.
function uncabledTarget(): string | null {
  return state.terminal.interfacePeerId ? null : state.terminal.interfaceName;
}

// The config entry the session's interface commands edit (created on demand).
function sessionInterfaceEntry(router: Device): any {
  const name = uncabledTarget();
  return name
    ? routerInterfaceForName(router, name)
    : routerInterfaceFor(router, state.terminal.interfacePeerId!, state.terminal.interfaceVlanTag);
}

// A port with no cable takes an address, but it is down: say what that means.
const notCabledNote = (name: string) => `% ${name} is not cabled — it stays down, with no connected route, until a cable is plugged in.`;

function routerMode(): RouterMode {
  const m = state.terminal.mode;
  return (m === "privileged" || m === "config" || m === "interface" || m === "rip") ? m : "exec";
}

function routerCmdMatches(tokens: string[], spec: RouterCmdSpec): boolean {
  const k = spec.tokens.length;
  if (spec.args ? tokens.length < k : tokens.length !== k) return false;
  if (spec.min && tokens[0].length < spec.min) return false;
  for (let i = 0; i < k; i++) {
    if (!spec.tokens[i].startsWith(tokens[i].toLowerCase())) return false;
  }
  return true;
}

// Expand an abbreviated command to canonical form. Returns the canonical string,
// "" if the prefix is ambiguous, or null if nothing matches (pass through).
function expandRouterCommand(command: string, mode: RouterMode): string | null {
  const tokens = command.trim().split(/\s+/);
  if (!tokens[0]) return null;
  const any = ROUTER_COMMANDS.filter(c => routerCmdMatches(tokens, c));
  let matches = any.filter(c => c.modes.includes(mode));
  // How many of a spec's keywords were typed in full (not abbreviated).
  const exactness = (spec: RouterCmdSpec) =>
    spec.tokens.filter((t, i) => tokens[i] && t === tokens[i].toLowerCase()).length;
  if (matches.length === 0) {
    if (any.length !== 1) return null; // unknown or cross-mode ambiguity → pass through
    matches = any;
  } else {
    // A command spelled out in full for ANOTHER mode beats a mere prefix match
    // in this one: `ip address …` typed in config mode is the interface command
    // in the wrong mode ("% Interface mode required"), not an abbreviation of
    // `iptables`. Pass it through for its own handler to answer.
    const bestHere = Math.max(...matches.map(exactness));
    if (any.some(c => !c.modes.includes(mode) && exactness(c) === c.tokens.length && exactness(c) > bestHere)) return null;
  }
  if (matches.length > 1) {
    // Prefer the candidates whose keywords match the typed tokens exactly —
    // "ip route" must beat "iptables" for the input "ip route ..." even though
    // "ip" is also a prefix of "iptables".
    const best = Math.max(...matches.map(exactness));
    matches = matches.filter(m => exactness(m) === best);
  }
  if (matches.length > 1) return "";
  const spec = matches[0];
  return [...spec.tokens, ...tokens.slice(spec.tokens.length)].join(" ");
}

// Context-sensitive `?`: list the commands in `mode` whose keywords prefix-match
// what's been typed so far.
function routerHelp(mode: RouterMode, typed: string): string {
  const prefix = typed.trim().split(/\s+/).filter(Boolean);
  const entries = ROUTER_COMMANDS.filter(c =>
    c.modes.includes(mode) &&
    prefix.every((t, i) => i < c.tokens.length && c.tokens[i].startsWith(t.toLowerCase()))
  );
  if (!entries.length) return "% No matching commands.";
  return entries.map(c => c.tokens.join(" ") + (c.args ? " <...>" : "")).join("\n");
}

// Cisco-style `show ip nat translations`.
export function showRouterNatTranslations(router: Device): string {
  const translations = router.config?.natTranslations || [];
  const marks = routerInterfacesWithNames(router)
    .filter((i: any) => i.config?.natRole)
    .map((i: any) => `${i.name}: ${i.config.natRole}`);
  const forwards = (router.config?.portForwards || []).map((r: any) =>
    `  ${r.proto} ${r.outsideIp}:${r.outsidePort} → ${r.insideIp}:${r.insidePort}`);
  const fwBlock = forwards.length ? ["Static port-forwards:", ...forwards, ""] : [];
  const header = [...(marks.length ? [`NAT interfaces — ${marks.join(", ")}`, ""] : []), ...fwBlock];
  if (!translations.length) return [...header, "Pro  Inside global        Inside local         Outside"].join("\n") + "\n(no dynamic translations)";
  return [
    ...header,
    "Pro  Inside global        Inside local         Outside",
    ...translations.map(t => {
      const ig = t.protocol === "tcp" ? `${t.outsideIp}:${t.outsidePort}` : `${t.outsideIp} (id ${t.outsidePort})`;
      const il = t.protocol === "tcp" ? `${t.insideIp}:${t.insidePort}` : `${t.insideIp} (id ${t.insidePort})`;
      return `${t.protocol.padEnd(5)}${ig.padEnd(26)}${il.padEnd(26)}${t.destIp}`;
    })
  ].join("\n");
}

// Static destination-NAT (port-forward), config mode:
// `[no] ip nat inside source static tcp <insideIp> <insidePort> <outsideIp> <outsidePort>`.
function routerStaticNatCommand(router: Device, lower: string): boolean {
  const m = lower.match(/^(no\s+)?ip\s+nat\s+inside\s+source\s+static\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)$/);
  if (!m) return false;
  if (routerMode() !== "config") { terminalLine("error", "% Configuration mode required (configure terminal)."); return true; }
  if (m[2] !== "tcp") { terminalLine("error", "% Only 'tcp' static NAT (port-forwarding) is supported."); return true; }
  const insideIp = m[3], insidePort = Number(m[4]), outsideIp = m[5], outsidePort = Number(m[6]);
  if (!isValidIpv4(insideIp) || !isValidIpv4(outsideIp)) { terminalLine("error", "% Invalid IPv4 address."); return true; }
  if (![insidePort, outsidePort].every(p => p >= 1 && p <= 65535)) { terminalLine("error", "% Port must be 1-65535."); return true; }
  if (!router.config) (router as any).config = {};
  const list = router.config.portForwards || (router.config.portForwards = []);
  const idx = list.findIndex((r: any) => r.outsideIp === outsideIp && r.outsidePort === outsidePort);
  if (m[1]) {
    if (idx < 0) { terminalLine("error", `% No port-forward for ${outsideIp}:${outsidePort}.`); return true; }
    pushUndo();
    list.splice(idx, 1);
    terminalLine("", `Removed port-forward ${outsideIp}:${outsidePort}.`);
  } else {
    pushUndo();
    const rule = { proto: "tcp" as const, insideIp, insidePort, outsideIp, outsidePort };
    if (idx >= 0) list[idx] = rule; else list.push(rule);
    terminalLine("", `Port-forward ${outsideIp}:${outsidePort} → ${insideIp}:${insidePort}.`);
  }
  sync().syncPanel();
  return true;
}

// Marks the selected interface `ip nat inside|outside` (or clears the mark).
function routerNatCommand(router: Device, lower: string): boolean {
  const natMatch = lower.match(/^(no\s+)?ip\s+nat\s+(inside|outside)$/);
  if (!natMatch) return false;
  if (!inInterfaceMode()) {
    terminalLine("error", "% Interface mode required.");
    return true;
  }
  pushUndo();
  const iface = sessionInterfaceEntry(router);
  if (natMatch[1]) {
    delete iface.natRole;
    terminalLine("", `Cleared NAT role on the interface.`);
  } else {
    iface.natRole = natMatch[2] as "inside" | "outside";
    terminalLine("", `Interface marked ip nat ${natMatch[2]}.`);
  }
  sync().syncPanel();
  return true;
}

export function runRouterTerminalCommand(router: Device, rawCommand: string): void {
  reconcileRouterSession(state.terminal, router);   // never dispatch on a mode whose target is gone
  const mode = routerMode();
  const trimmed = rawCommand.trim();
  // Context-sensitive `?` (bare or trailing) and `help`.
  if (trimmed === "?" || /\?\s*$/.test(trimmed)) {
    terminalLine("muted", routerHelp(mode, trimmed.replace(/\?\s*$/, "")));
    return;
  }
  if (trimmed.toLowerCase() === "help") {
    terminalLine("muted", routerHelp(mode, ""));
    return;
  }
  // Abbreviation: expand an unambiguous prefix to its canonical command.
  const expanded = expandRouterCommand(trimmed, mode);
  if (expanded === "") {
    terminalLine("error", `% Ambiguous command: ${trimmed}`);
    return;
  }
  const command = expanded || trimmed;
  const lower = command.toLowerCase();
  // `do <command>` runs a show command from any config sub-mode (FRR/IOS staple).
  const doMatch = command.match(/^do\s+(.+)$/i);
  if (doMatch) {
    const inner = (expandRouterCommand(doMatch[1].trim(), "exec") || doMatch[1].trim()).toLowerCase();
    if (!routerShowCommand(router, inner)) {
      terminalLine("error", `% Unknown command: ${doMatch[1]}`);
    }
    return;
  }
  // netfilter lives in the router's shell: INPUT + FORWARD chains. Both the
  // iptables and nft front doors drive the one ruleset (netfilter is always
  // present on a Linux router, an empty ruleset is a pass-through).
  {
    const nf = command.trim().toLowerCase();
    if (nf.startsWith("iptables") || nf.startsWith("nft")) {
      if (mode !== "privileged" && mode !== "config") {   // what the registry (and `?`) advertise
        const tool = nf.startsWith("nft") ? "nft" : "iptables";
        terminalLine("error", mode === "exec" ? "% Privileged mode required. Enter enable first." : `% Leave the sub-mode first (exit) — ${tool} runs in privileged or config mode.`);
        return;
      }
      if (nf.startsWith("nft")) runNftCommand(router, command, ["input", "forward"]);
      else runIptablesCommand(router, command, ["input", "forward"]);
      return;
    }
  }
  // The neighbour (ARP) cache lives in the router's Linux kernel too: `ip neigh
  // flush all` clears every interface's entries, so each next hop ARPs afresh —
  // the remedy for a stale entry, since the simulator never ages ARP out.
  if (/^ip\s+(?:neigh|neighbour|neighbor)\s+flush\s+all$/i.test(command.trim())) {
    if (mode !== "privileged" && mode !== "config") {
      terminalLine("error", mode === "exec" ? "% Privileged mode required. Enter enable first." : "% Leave the sub-mode first (exit) — ip neigh flush runs in privileged or config mode.");
      return;
    }
    terminalLine("", flushRouterArp(router));
    return;
  }
  // `hostname <name>` (config mode) renames the router — its prompt, canvas
  // label and resolvable name are all the hostname (FRR/IOS global command).
  const hostnameMatch = command.match(/^hostname\s+(\S+)$/i);
  if (hostnameMatch) {
    if (mode !== "config") { terminalLine("error", "% Configuration mode required (configure terminal)."); return; }
    const error = applyHostname(router, hostnameMatch[1]);
    if (error) terminalLine("error", `% ${error}`);
    return;
  }
  if (routerStaticNatCommand(router, lower)) return;
  if (routerNatCommand(router, lower)) return;
  if (routerSessionCommand(lower)) return;
  if (routerShowCommand(router, lower)) return;
  if (routerInterfaceCommand(router, command, lower)) return;
  if (routerRipCommand(router, command, lower)) return;
  if (routerStaticRouteCommand(router, command)) return;
  terminalLine("error", `% Unknown command: ${command}`);
}

// Handles session/mode control: `clear`, `exit`, `end`, `enable`,
// `configure terminal`. Returns true if the command matched.
function routerSessionCommand(lower: string): boolean {
  if (lower === "clear") {
    state.terminal.lines = [];
    return true;
  }
  if (lower === "exit") {
    if (state.terminal.mode === "interface") {
      state.terminal.mode = "config";
      clearInterfaceTarget(state.terminal);
    } else if (state.terminal.mode === "rip") {
      state.terminal.mode = "config";
    } else if (state.terminal.mode === "config") {
      state.terminal.mode = "privileged";
    } else if (state.terminal.mode === "privileged") {
      state.terminal.mode = "exec";
    } else {
      // `exit` at exec level logs out: close this session's tab.
      closeSession(state.terminal.deviceId);
    }
    return true;
  }
  if (lower === "end") {
    state.terminal.mode = "privileged";
    clearInterfaceTarget(state.terminal);
    return true;
  }
  if (lower === "enable") {
    // `enable` raises user-exec to privileged; it isn't a config-mode command
    // (use `end`/`exit` to leave config first), matching IOS/FRR.
    if (state.terminal.mode !== "exec" && state.terminal.mode !== "privileged") {
      terminalLine("error", "% Invalid input — leave configuration mode first (end).");
      return true;
    }
    state.terminal.mode = "privileged";
    clearInterfaceTarget(state.terminal);
    return true;
  }
  if (lower === "configure terminal" || lower === "conf t") {
    if (state.terminal.mode === "exec") {
      terminalLine("error", "% Privileged mode required. Enter enable first.");
    } else {
      state.terminal.mode = "config";
      clearInterfaceTarget(state.terminal);
    }
    return true;
  }
  return false;
}

// Handles read-only `show ...` commands plus `clear ip rip database` and
// `write memory`. Returns true if the command matched.
function routerShowCommand(router: Device, lower: string): boolean {
  if (lower === "show ip interface brief" || lower === "show interface brief") {
    terminalLine("", showRouterInterfaceBrief(router));
    return true;
  }
  if (lower === "show ip route" || lower === "show route") {
    terminalLine("", showRouterRoute(router));
    return true;
  }
  if (lower === "show ip arp" || lower === "show arp") {
    terminalLine("", showRouterArp(router));
    return true;
  }
  if (lower === "show ip dhcp binding" || lower === "show ip dhcp pool") {
    terminalLine("", showRouterDhcpBindings(router));
    return true;
  }
  if (lower === "show ip route rip") {
    terminalLine("", showRouterRouteRip(router));
    return true;
  }
  if (lower === "show ip rip status") {
    terminalLine("", showRouterRip(router));
    return true;
  }
  if (lower === "show ip rip") {
    terminalLine("", showRouterRipRoutes(router));
    return true;
  }
  if (lower === "show ip nat translations") {
    terminalLine("", showRouterNatTranslations(router));
    return true;
  }
  if (lower === "clear ip nat translation *" || lower === "clear ip nat translation") {
    pushUndo();
    if (router.config) router.config.natTranslations = [];
    sync().syncPanel();
    terminalLine("", "Cleared all NAT translations.");
    return true;
  }
  if (lower === "show running-config" || lower === "show run") {
    terminalLine("", showRouterRunningConfig(router));
    return true;
  }
  if (lower === "clear ip rip database") {
    if (!router.config?.rip?.enabled) {
      terminalLine("error", "% RIP is not enabled on this router.");
      return true;
    }
    // Learned routes are derived state, outside the undo history: no undo point.
    // As on a real router, the neighbours' next updates bring them back — here
    // that is the next convergence (a show command, or the next run).
    router.config.rip.learnedRoutes = [];
    sync().syncPanel();
    terminalLine("", "RIP learned routes cleared — they are relearned from the neighbours' next updates.");
    return true;
  }
  if (lower === "write memory" || lower === "copy running-config startup-config") {
    terminalLine("", "Building configuration...\n[OK]");
    return true;
  }
  return false;
}

// Resolve a name the listing does not carry: `EthernetN` as the BASE of an
// interface whose sub-interfaces are what the view lists, or `EthernetN.V` as a
// sub-interface that does not exist yet (created here — IOS/FRR create a
// sub-interface by naming it). Returns the selection, or null.
function routerBaseOrNewSubInterface(router: Device, name: string): { peerId: string; vlanTag: number | null } | null {
  const m = name.match(/^(.+?)\.(\d+)$/);
  const baseName = (m ? m[1] : name).toLowerCase();
  const entry = routerInterfacesWithNames(router).find((i: any) => i.peer && i.name.toLowerCase().split(".")[0] === baseName);
  if (!entry) return null;
  if (!m) return { peerId: entry.peerId, vlanTag: null };
  const vlan = normaliseVlanId(m[2]);
  if (!vlan) return null;
  pushUndo();
  routerInterfaceFor(router, entry.peerId, vlan);   // creates the tagged entry, fully formed
  sync().syncPanel();
  sync().render();
  return { peerId: entry.peerId, vlanTag: vlan };
}

// Handles interface-mode commands: `interface`, `ip address`, `no ip address`,
// `encapsulation dot1q`. Returns true if the command matched.
function routerInterfaceCommand(router: Device, command: string, lower: string): boolean {
  const interfaceMatch = command.match(/^interface\s+(\S+)$/i);
  if (interfaceMatch) {
    // FRR/IOS let you retarget the active interface directly from interface mode,
    // not only from config mode.
    if (state.terminal.mode !== "config" && state.terminal.mode !== "interface") {
      terminalLine("error", "% Enter configuration mode first.");
      return true;
    }
    const iface = routerInterfaceByName(router, interfaceMatch[1]);
    if (!iface) {
      // Not a listed name. Two cases IOS/FRR handle that the listing alone
      // cannot: `Ethernet1` is the BASE of an interface that already has
      // sub-interfaces (the view lists only those), and `Ethernet1.20` is a
      // sub-interface that does not exist yet — naming it creates it.
      const sub = interfaceMatch[1].match(/^(.+?)\.\d+$/);
      const uncabledBase = sub ? routerInterfaceByName(router, sub[1]) : null;
      if (uncabledBase && !uncabledBase.peer) {
        // A sub-interface is keyed by the cable that carries its VLAN.
        terminalLine("error", `% ${uncabledBase.name} is not cabled — a sub-interface needs a cable to carry its VLAN. Connect the port first.`);
        return true;
      }
      const sel = routerBaseOrNewSubInterface(router, interfaceMatch[1]);
      if (!sel) {
        terminalLine("error", `% Unknown interface ${interfaceMatch[1]}`);
        return true;
      }
      state.terminal.mode = "interface";
      clearInterfaceTarget(state.terminal);
      state.terminal.interfacePeerId = sel.peerId;
      state.terminal.interfaceVlanTag = sel.vlanTag;
      return true;
    }
    state.terminal.mode = "interface";
    clearInterfaceTarget(state.terminal);
    if (iface.peer) {
      state.terminal.interfacePeerId = iface.peerId;
      state.terminal.interfaceVlanTag = iface.config?.vlanTag ?? null;
    } else {
      state.terminal.interfaceName = iface.name;     // no cable, so no peer to key by — hold the port's name
    }
    return true;
  }
  const ipAddressMatch = command.match(/^ip\s+address\s+(\S+)$/i);
  if (ipAddressMatch) {
    if (!inInterfaceMode()) {
      terminalLine("error", "% Interface mode required.");
      return true;
    }
    const uncabled = uncabledTarget();
    const result = uncabled
      ? setUncabledRouterInterfaceIp(router, uncabled, ipAddressMatch[1])
      : setRouterInterfaceIp(router, state.terminal.interfacePeerId!, ipAddressMatch[1], state.terminal.interfaceVlanTag);
    if (result) terminalLine("error", result);
    else if (uncabled) terminalLine("muted", notCabledNote(uncabled));
    return true;
  }
  if (lower === "no ip address") {
    if (!inInterfaceMode()) {
      terminalLine("error", "% Interface mode required.");
      return true;
    }
    const uncabled = uncabledTarget();
    if (uncabled) setUncabledRouterInterfaceIp(router, uncabled, "");
    else clearRouterInterfaceIp(router, state.terminal.interfacePeerId!, state.terminal.interfaceVlanTag);
    return true;
  }
  const encapMatch = command.match(/^encapsulation\s+dot1q\s+(\d+)$/i);
  if (encapMatch) {
    if (!inInterfaceMode()) {
      terminalLine("error", "% Interface mode required.");
      return true;
    }
    if (uncabledTarget()) {
      terminalLine("error", `% ${uncabledTarget()} is not cabled — a sub-interface needs a cable to carry its VLAN. Connect the port first.`);
      return true;
    }
    const vlanId = normaliseVlanId(encapMatch[1]);
    if (!vlanId) {
      terminalLine("error", `% Invalid VLAN ID: ${encapMatch[1]}`);
      return true;
    }
    const peerId = state.terminal.interfacePeerId!;
    const current = state.terminal.interfaceVlanTag;
    const holder = (router.config?.interfaces || []).some((i: any) => i.peerId === peerId && i.vlanTag === vlanId);
    if (current != null && current !== vlanId && holder) {
      // Retagging this sub-interface onto a VLAN a sibling already carries
      // would leave two entries with one name: the second could never be
      // selected again and a later `ip address` overwrote the first. IOS
      // refuses it; so does the sibling `no encapsulation` path below.
      const base = routerInterfacesWithNames(router).find((i: any) => i.peerId === peerId)?.name.split(".")[0] || "this port";
      terminalLine("error", `% VLAN ${vlanId} is already carried by sub-interface ${base}.${vlanId} — a VLAN belongs to one sub-interface per port. Configure that one (interface ${base}.${vlanId}) or pick another VLAN.`);
      return true;
    }
    if (current === vlanId) {
      terminalLine("", `Encapsulation is already 802.1Q VLAN ${vlanId}.`);   // nothing to change, no undo point
      return true;
    }
    pushUndo();
    if (current == null) {
      // On the BASE interface, `encapsulation dot1q N` creates (or selects) the
      // .N sub-interface and moves the session onto it — the base keeps its own
      // untagged identity. It used to retag the base itself, after which no
      // second sub-interface could ever be made (router-on-a-stick was a dead end).
      routerInterfaceFor(router, state.terminal.interfacePeerId!, vlanId);
      state.terminal.interfaceVlanTag = vlanId;
      sync().syncPanel();
      sync().render();
      terminalLine("", `Encapsulation 802.1Q VLAN ${vlanId} — now configuring sub-interface .${vlanId}.`);
      return true;
    }
    // On a sub-interface: change the VLAN it carries (its name follows the tag).
    const iface = routerInterfaceFor(router, state.terminal.interfacePeerId!, state.terminal.interfaceVlanTag);
    iface.vlanTag = vlanId;
    state.terminal.interfaceVlanTag = vlanId;
    sync().syncPanel();
    sync().render();
    terminalLine("", `Encapsulation set to 802.1Q VLAN ${vlanId}.`);
    return true;
  }
  if (lower === "no encapsulation dot1q" || lower === "no encapsulation") {
    if (!inInterfaceMode()) {
      terminalLine("error", "% Interface mode required.");
      return true;
    }
    if (state.terminal.interfaceVlanTag == null) {
      terminalLine("error", "% The base interface carries no encapsulation.");
      return true;
    }
    // Un-tagging a sub-interface would merge it into the base; refuse when a
    // base entry already exists rather than leaving two untagged entries.
    if ((router.config?.interfaces || []).some((i: any) => i.peerId === state.terminal.interfacePeerId && i.vlanTag == null)) {
      terminalLine("error", "% The base interface already exists — remove the sub-interface's address instead (no ip address).");
      return true;
    }
    pushUndo();
    const iface = routerInterfaceFor(router, state.terminal.interfacePeerId!, state.terminal.interfaceVlanTag);
    iface.vlanTag = null;
    state.terminal.interfaceVlanTag = null;
    sync().syncPanel();
    sync().render();
    terminalLine("", "Encapsulation removed.");
    return true;
  }
  return false;
}

// Handles `router rip` / `no router rip` and the RIP sub-mode commands
// (network, passive-interface). Returns true if the command matched.
function routerRipCommand(router: Device, command: string, lower: string): boolean {
  if (lower === "router rip") {
    if (state.terminal.mode !== "config") {
      terminalLine("error", "% Configuration mode required.");
      return true;
    }
    pushUndo();
    router.config = router.config || {};
    if (!router.config.rip) router.config.rip = normaliseRipConfig(null);
    router.config.rip.enabled = true;
    state.terminal.mode = "rip";
    sync().syncPanel();
    return true;
  }
  if (lower === "no router rip") {
    if (state.terminal.mode !== "config") {
      terminalLine("error", "% Configuration mode required.");
      return true;
    }
    pushUndo();
    router.config = router.config || {};
    router.config.rip = normaliseRipConfig(null);
    sync().syncPanel();
    terminalLine("", "RIP routing disabled. Learned routes cleared.");
    return true;
  }
  const networkMatch = command.match(/^network\s+(\S+)$/i);
  if (networkMatch) {
    if (state.terminal.mode !== "rip") {
      terminalLine("error", "% Enter router rip mode first.");
      return true;
    }
    const networkToken = networkMatch[1];
    let network: string;
    const parsed = parseIpv4Token(networkToken);
    if (parsed) {
      // Store the masked network (192.168.1.5/24 -> 192.168.1.0/24), matching the
      // `network <ifname>` branch below and FRR's running-config display.
      network = networkOf(parsed.address, parsed.prefixLength ?? 24);
    } else {
      // FRR `network <ifname>` — enable RIP on the interface's connected network.
      const iface = routerInterfaceByName(router, networkToken);
      if (!iface) {
        terminalLine("error", `% Invalid network or interface: ${networkToken}`);
        return true;
      }
      if (!iface.config?.ipv4Address) {
        terminalLine("error", `% Interface ${iface.name} has no IP address.`);
        return true;
      }
      const ip = iface.config.ipv4Address;
      network = networkOf(ip, prefixOf(iface.config));
    }
    pushUndo();
    if (!router.config.rip!.networks.includes(network)) {
      router.config.rip!.networks.push(network);
    }
    sync().syncPanel();
    terminalLine("", `Added network ${network} to RIP.`);
    return true;
  }
  const noNetworkMatch = command.match(/^no\s+network\s+(\S+)$/i);
  if (noNetworkMatch) {
    if (state.terminal.mode !== "rip") {
      terminalLine("error", "% Enter router rip mode first.");
      return true;
    }
    const networkToken = noNetworkMatch[1];
    // Symmetric with `network`: the same masking (192.168.1.5/24 → 192.168.1.0/24)
    // and the same `<ifname>` form. Comparing the unmasked token meant
    // `no network 192.168.1.5/24` could never remove what `network 192.168.1.5/24`
    // had stored.
    const parsed = parseIpv4Token(networkToken);
    let network: string;
    if (parsed) {
      network = networkOf(parsed.address, parsed.prefixLength ?? 24);
    } else {
      const iface = routerInterfaceByName(router, networkToken);
      if (!iface || !iface.config?.ipv4Address) {
        terminalLine("error", `% Invalid network or interface: ${networkToken}`);
        return true;
      }
      network = networkOf(iface.config.ipv4Address, prefixOf(iface.config));
    }
    if (!router.config.rip!.networks.includes(network)) {
      terminalLine("error", `% ${network} is not a RIP network on this router.`);
      return true;
    }
    pushUndo();
    router.config.rip!.networks = router.config.rip!.networks.filter((n: string) => n !== network);
    sync().syncPanel();
    terminalLine("", `Removed network ${network} from RIP.`);
    return true;
  }
  const passiveMatch = command.match(/^passive-interface\s+(\S+)$/i);
  if (passiveMatch) {
    if (state.terminal.mode !== "rip") {
      terminalLine("error", "% Enter router rip mode first.");
      return true;
    }
    const target = routerInterfaceByName(router, passiveMatch[1]);
    if (!target) { terminalLine("error", `% Unknown interface ${passiveMatch[1]}`); return true; }
    const ifaceName = target.name;   // canonical spelling, so the send loop's name check matches
    pushUndo();
    if (!router.config.rip!.passiveInterfaces.includes(ifaceName)) {
      router.config.rip!.passiveInterfaces.push(ifaceName);
    }
    sync().syncPanel();
    terminalLine("", `Set ${ifaceName} as passive (no RIP updates sent/received).`);
    return true;
  }
  const noPassiveMatch = command.match(/^no\s+passive-interface\s+(\S+)$/i);
  if (noPassiveMatch) {
    if (state.terminal.mode !== "rip") {
      terminalLine("error", "% Enter router rip mode first.");
      return true;
    }
    const ifaceName = noPassiveMatch[1];
    pushUndo();
    router.config.rip!.passiveInterfaces = router.config.rip!.passiveInterfaces.filter((n: string) => n !== ifaceName);
    sync().syncPanel();
    terminalLine("", `Removed ${ifaceName} from passive interfaces.`);
    return true;
  }
  return false;
}

// ── Static-route mutators — one validation for every front door ──────────────
// The router shell's `ip route` validated; the console's `route` verb did not:
// it stored `garbage nonsense`, a prefix-less `192.168.2.0` that `no ip route`
// could never match, and the same route again and again (review R37). Both now
// go through these two, so they refuse the same input and store the same form.

// The stored form of a static route's destination: CIDR required, host bits
// masked off (`10.0.0.5/24` → `10.0.0.0/24`, as FRR stores it) so the same
// prefix is one route however it was typed. Null when the text is not that.
function canonicalRouteNetwork(text: string): string | null {
  const parsed = parseIpv4Token(text);
  if (!parsed || parsed.prefixLength == null) return null;
  return networkOf(parsed.address, parsed.prefixLength);
}

const BAD_ROUTE_NETWORK = (text: string) => `Invalid network: ${text || "(none)"}. Use CIDR notation (e.g. 10.0.0.0/24).`;

// Add a static route. Refuses a non-CIDR network or an invalid next hop; a
// route already present is a no-op that says so (and takes no undo point).
export function addStaticRoute(router: Device, networkText: string, nextHopText: string): MutationResult {
  if (router.type !== "router") return { ok: false, error: `${router.name} is not a router — only a router has static routes.`, warnings: [] };
  const networkToken = String(networkText ?? "").trim();
  const nextHop = String(nextHopText ?? "").trim();
  const network = canonicalRouteNetwork(networkToken);
  if (!network) return { ok: false, error: BAD_ROUTE_NETWORK(networkToken), warnings: [] };
  if (!isValidIpv4(nextHop)) return { ok: false, error: `Invalid next-hop address: ${nextHop || "(none)"}`, warnings: [] };
  const statics = normaliseStaticRoutes(router.config?.staticRoutes || []);
  if (statics.some(r => r.network === network && r.nextHop === nextHop)) {
    return { ok: true, message: `Static route ${network} via ${nextHop} is already configured on ${router.name}.`, warnings: [] };
  }
  pushUndo();
  router.config = router.config || {};
  statics.push({ network, nextHop });
  router.config.staticRoutes = statics;
  sync().syncPanel();
  sync().render();
  return { ok: true, message: `Static route added: ${network} via ${nextHop}`, warnings: [] };
}

// Remove the static route(s) for a network — every next hop, or just the one
// named. Matching nothing is a refusal (and takes no undo point).
export function removeStaticRoute(router: Device, networkText: string, nextHopText?: string | null): MutationResult {
  if (router.type !== "router") return { ok: false, error: `${router.name} is not a router — only a router has static routes.`, warnings: [] };
  const networkToken = String(networkText ?? "").trim();
  const nextHop = String(nextHopText ?? "").trim() || null;
  const network = canonicalRouteNetwork(networkToken);
  if (!network) return { ok: false, error: BAD_ROUTE_NETWORK(networkToken), warnings: [] };
  const statics = normaliseStaticRoutes(router.config?.staticRoutes || []);
  const kept = statics.filter(r => nextHop ? !(r.network === network && r.nextHop === nextHop) : r.network !== network);
  const removed = statics.length - kept.length;
  if (!removed) return { ok: false, error: `No matching static route found for ${network}.`, warnings: [] };
  pushUndo();
  router.config = router.config || {};
  router.config.staticRoutes = kept;
  sync().syncPanel();
  sync().render();
  return { ok: true, message: `Removed ${removed} static route(s) for ${network}.`, warnings: [] };
}

// Handles `ip route` / `no ip route`. Returns true if the command matched.
function routerStaticRouteCommand(router: Device, command: string): boolean {
  const ipRouteMatch = command.match(/^ip\s+route\s+(\S+)\s+(\S+)$/i);
  const noIpRouteMatch = ipRouteMatch ? null : command.match(/^no\s+ip\s+route\s+(\S+)(?:\s+(\S+))?$/i);
  if (!ipRouteMatch && !noIpRouteMatch) return false;
  if (state.terminal.mode !== "config") {
    terminalLine("error", "% Configuration mode required.");
    return true;
  }
  const result = ipRouteMatch
    ? addStaticRoute(router, ipRouteMatch[1], ipRouteMatch[2])
    : removeStaticRoute(router, noIpRouteMatch![1], noIpRouteMatch![2]);
  if (result.ok) terminalLine("", result.message || "");
  else terminalLine("error", `% ${result.error}`);
  return true;
}
