/**
 * Router terminal — modelled on FRRouting (vtysh): mode state machine
 * (exec/privileged/config/interface/rip), show commands, prefix abbreviation,
 * and context-sensitive `?` driven by the ROUTER_COMMANDS registry.
 */
import type { Device } from "../types";
import { state, sync, pushUndo } from "../state";
import { isValidIpv4, parseIpv4Token, normaliseVlanId, prefixOf, clampPrefixLength, networkOf } from "../utils";
import { normaliseArpTable, normaliseDhcpLeases, normaliseStaticRoutes, normaliseRipConfig } from "../normalise";
import { routerInterfacesWithNames, routerInterfaceFor, routerInterfaceByName, applyHostname } from "../devices";
import { buildRoutingTable, runRipConvergence } from "../engine";
import { terminalLine, closeSession } from "./core";
import { runIptablesCommand } from "./iptables";

export function showRouterInterfaceBrief(router: Device): string {
  const interfaces = routerInterfacesWithNames(router);
  if (!interfaces.length) return "No interfaces configured.";
  return [
    "Interface     IP-Address         Status  Protocol  VLAN  Connected to",
    ...interfaces.map((iface: any) => {
      const vlanDisplay = iface.config.vlanTag != null ? String(iface.config.vlanTag) : "-";
      return [
        iface.name.padEnd(14),
        (iface.config.ipv4Address ? `${iface.config.ipv4Address}/${prefixOf(iface.config)}` : "unassigned").padEnd(19),
        (iface.peer ? "up" : "down").padEnd(8),
        (iface.peer ? "up" : "down").padEnd(10),
        vlanDisplay.padEnd(6),
        iface.peer?.name || "-"
      ].join("");
    })
  ].join("\n");
}

export function showRouterRoute(router: Device): string {
  const table = buildRoutingTable(router);
  if (!table.length) return "Codes: C - connected, S - static, R - RIP\n\nNo routes configured.";
  return [
    "Codes: C - connected, S - static, R - RIP",
    "",
    ...table.map((route: any) => {
      if (route.type === "C") {
        return `C>* ${route.network} is directly connected, ${route.interface || "?"}`;
      }
      if (route.type === "S") {
        return `S>* ${route.network} via ${route.nextHop}`;
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
  const table = buildRoutingTable(router).filter((r: any) => r.type === "R");
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
interface RouterCmdSpec { tokens: string[]; args?: boolean; modes: RouterMode[] }
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
  { tokens: ["iptables"], args: true, modes: ["privileged", "config"] },
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

function routerMode(): RouterMode {
  const m = state.terminal.mode;
  return (m === "privileged" || m === "config" || m === "interface" || m === "rip") ? m : "exec";
}

function routerCmdMatches(tokens: string[], spec: RouterCmdSpec): boolean {
  const k = spec.tokens.length;
  if (spec.args ? tokens.length < k : tokens.length !== k) return false;
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
  let matches = ROUTER_COMMANDS.filter(c => c.modes.includes(mode) && routerCmdMatches(tokens, c));
  if (matches.length === 0) {
    const any = ROUTER_COMMANDS.filter(c => routerCmdMatches(tokens, c));
    if (any.length !== 1) return null; // unknown or cross-mode ambiguity → pass through
    matches = any;
  }
  if (matches.length > 1) {
    // Prefer the candidates whose keywords match the typed tokens exactly —
    // "ip route" must beat "iptables" for the input "ip route ..." even though
    // "ip" is also a prefix of "iptables".
    const exactness = (spec: RouterCmdSpec) =>
      spec.tokens.filter((t, i) => tokens[i] && t === tokens[i].toLowerCase()).length;
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
  pushUndo();
  if (!router.config) (router as any).config = {};
  const list = router.config.portForwards || (router.config.portForwards = []);
  const idx = list.findIndex((r: any) => r.outsideIp === outsideIp && r.outsidePort === outsidePort);
  if (m[1]) {
    if (idx >= 0) list.splice(idx, 1);
    terminalLine("", `Removed port-forward ${outsideIp}:${outsidePort}.`);
  } else {
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
  if (state.terminal.mode !== "interface" || !state.terminal.interfacePeerId) {
    terminalLine("error", "% Interface mode required.");
    return true;
  }
  pushUndo();
  const iface = routerInterfaceFor(router, state.terminal.interfacePeerId, state.terminal.interfaceVlanTag);
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
  // netfilter lives in the router's shell: INPUT + FORWARD chains.
  if (command.trim().toLowerCase().startsWith("iptables")) {
    if (mode === "exec") {
      terminalLine("error", "% Privileged mode required. Enter enable first.");
      return;
    }
    runIptablesCommand(router, command, ["input", "forward"]);
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
      state.terminal.interfacePeerId = null;
      state.terminal.interfaceVlanTag = null;
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
    state.terminal.interfacePeerId = null;
    state.terminal.interfaceVlanTag = null;
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
    state.terminal.interfacePeerId = null;
    state.terminal.interfaceVlanTag = null;
    return true;
  }
  if (lower === "configure terminal" || lower === "conf t") {
    if (state.terminal.mode === "exec") {
      terminalLine("error", "% Privileged mode required. Enter enable first.");
    } else {
      state.terminal.mode = "config";
      state.terminal.interfacePeerId = null;
      state.terminal.interfaceVlanTag = null;
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
    pushUndo();
    router.config.rip.learnedRoutes = [];
    sync().syncPanel();
    terminalLine("", "RIP learned routes cleared.");
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
      const sel = routerBaseOrNewSubInterface(router, interfaceMatch[1]);
      if (!sel) {
        terminalLine("error", `% Unknown interface ${interfaceMatch[1]}`);
        return true;
      }
      state.terminal.mode = "interface";
      state.terminal.interfacePeerId = sel.peerId;
      state.terminal.interfaceVlanTag = sel.vlanTag;
      return true;
    }
    state.terminal.mode = "interface";
    state.terminal.interfacePeerId = iface.peerId;
    state.terminal.interfaceVlanTag = iface.config?.vlanTag ?? null;
    return true;
  }
  const ipAddressMatch = command.match(/^ip\s+address\s+(\S+)$/i);
  if (ipAddressMatch) {
    if (state.terminal.mode !== "interface" || !state.terminal.interfacePeerId) {
      terminalLine("error", "% Interface mode required.");
      return true;
    }
    const result = setRouterInterfaceIp(router, state.terminal.interfacePeerId, ipAddressMatch[1], state.terminal.interfaceVlanTag);
    if (result) terminalLine("error", result);
    return true;
  }
  if (lower === "no ip address") {
    if (state.terminal.mode !== "interface" || !state.terminal.interfacePeerId) {
      terminalLine("error", "% Interface mode required.");
      return true;
    }
    clearRouterInterfaceIp(router, state.terminal.interfacePeerId, state.terminal.interfaceVlanTag);
    return true;
  }
  const encapMatch = command.match(/^encapsulation\s+dot1q\s+(\d+)$/i);
  if (encapMatch) {
    if (state.terminal.mode !== "interface" || !state.terminal.interfacePeerId) {
      terminalLine("error", "% Interface mode required.");
      return true;
    }
    const vlanId = normaliseVlanId(encapMatch[1]);
    if (!vlanId) {
      terminalLine("error", `% Invalid VLAN ID: ${encapMatch[1]}`);
      return true;
    }
    pushUndo();
    if (state.terminal.interfaceVlanTag == null) {
      // On the BASE interface, `encapsulation dot1q N` creates (or selects) the
      // .N sub-interface and moves the session onto it — the base keeps its own
      // untagged identity. It used to retag the base itself, after which no
      // second sub-interface could ever be made (router-on-a-stick was a dead end).
      routerInterfaceFor(router, state.terminal.interfacePeerId, vlanId);
      state.terminal.interfaceVlanTag = vlanId;
      sync().syncPanel();
      sync().render();
      terminalLine("", `Encapsulation 802.1Q VLAN ${vlanId} — now configuring sub-interface .${vlanId}.`);
      return true;
    }
    // On a sub-interface: change the VLAN it carries (its name follows the tag).
    const iface = routerInterfaceFor(router, state.terminal.interfacePeerId, state.terminal.interfaceVlanTag);
    iface.vlanTag = vlanId;
    state.terminal.interfaceVlanTag = vlanId;
    sync().syncPanel();
    sync().render();
    terminalLine("", `Encapsulation set to 802.1Q VLAN ${vlanId}.`);
    return true;
  }
  if (lower === "no encapsulation dot1q" || lower === "no encapsulation") {
    if (state.terminal.mode !== "interface" || !state.terminal.interfacePeerId) {
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
    const iface = routerInterfaceFor(router, state.terminal.interfacePeerId, state.terminal.interfaceVlanTag);
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
    const ifaceName = passiveMatch[1];
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

// Handles `ip route` / `no ip route`. Returns true if the command matched.
function routerStaticRouteCommand(router: Device, command: string): boolean {
  const ipRouteMatch = command.match(/^ip\s+route\s+(\S+)\s+(\S+)$/i);
  if (ipRouteMatch) {
    if (state.terminal.mode !== "config") {
      terminalLine("error", "% Configuration mode required.");
      return true;
    }
    const networkToken = ipRouteMatch[1];
    const nextHop = ipRouteMatch[2];
    const parsedNetwork = parseIpv4Token(networkToken);
    if (!parsedNetwork || parsedNetwork.prefixLength == null) {
      terminalLine("error", `% Invalid network: ${networkToken}. Use CIDR notation (e.g. 10.0.0.0/24).`);
      return true;
    }
    if (!isValidIpv4(nextHop)) {
      terminalLine("error", `% Invalid next-hop address: ${nextHop}`);
      return true;
    }
    const network = `${parsedNetwork.address}/${parsedNetwork.prefixLength}`;
    pushUndo();
    router.config = router.config || {};
    const statics = normaliseStaticRoutes(router.config.staticRoutes || []);
    if (!statics.some((r: any) => r.network === network && r.nextHop === nextHop)) {
      statics.push({ network, nextHop });
    }
    router.config.staticRoutes = statics;
    sync().syncPanel();
    terminalLine("", `Static route added: ${network} via ${nextHop}`);
    return true;
  }
  const noIpRouteMatch = command.match(/^no\s+ip\s+route\s+(\S+)(?:\s+(\S+))?$/i);
  if (noIpRouteMatch) {
    if (state.terminal.mode !== "config") {
      terminalLine("error", "% Configuration mode required.");
      return true;
    }
    const networkToken = noIpRouteMatch[1];
    const nextHop = noIpRouteMatch[2] || null;
    const parsedNetwork = parseIpv4Token(networkToken);
    // Stored routes always carry a prefix (the add path requires CIDR), so the
    // removal must too — otherwise a bare `no ip route 10.0.0.0` never matches.
    if (!parsedNetwork || parsedNetwork.prefixLength == null) {
      terminalLine("error", `% Invalid network: ${networkToken}. Use CIDR notation (e.g. 10.0.0.0/24).`);
      return true;
    }
    const network = `${parsedNetwork.address}/${parsedNetwork.prefixLength}`;
    pushUndo();
    router.config = router.config || {};
    const statics = normaliseStaticRoutes(router.config.staticRoutes || []);
    const before = statics.length;
    router.config.staticRoutes = statics.filter((r: any) => {
      if (nextHop) return !(r.network === network && r.nextHop === nextHop);
      return r.network !== network;
    });
    const removed = before - router.config.staticRoutes.length;
    sync().syncPanel();
    if (removed > 0) {
      terminalLine("", `Removed ${removed} static route(s) for ${network}.`);
    } else {
      terminalLine("error", `% No matching static route found for ${network}.`);
    }
    return true;
  }
  return false;
}
