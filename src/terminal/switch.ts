/**
 * Managed-switch terminal — modelled on SONiC: flat, mode-less `config ...` /
 * `show ...` commands with VLAN-membership (tagged/untagged) semantics.
 * The mutators are shared with the inspector GUI and the console engine.
 */
import type { Device } from "../types";
import { state, sync, pushUndo } from "../state";
import { normaliseVlanId } from "../utils";
import { normaliseMacTable, normaliseVlans, normalisePortVlans, normalisePortModes, normaliseTrunkAllowedVlans, ensureConfig } from "../normalise";
import { switchInterfacesWithNames, switchIfaceByName, applyHostname } from "../devices";
import { runStpConvergence } from "../stp";
import { terminalLine } from "./core";

export function showSwitchInterfaces(device: Device): string {
  const interfaces = switchInterfacesWithNames(device);
  return [
    "Interface  Admin  Oper  Mode    VLAN  Connected to",
    ...interfaces.map((iface) => {
      const mode = iface.mode || "access";
      const vlanDisplay = mode === "trunk" ? `-` : String(iface.vlan);
      // A shut cable is admin-down with the line protocol down — not up/up
      // (review R41). Admin status was hardcoded "up".
      const shut = !!iface.link?.shutdown;
      return [
        iface.name.padEnd(11),
        (shut ? "down" : "up").padEnd(7),
        ((iface.peer && !shut) ? "up" : "down").padEnd(6),
        mode.padEnd(8),
        vlanDisplay.padEnd(6),
        iface.peer?.name || "-"
      ].join("");
    })
  ].join("\n");
}

export function showSwitchVlans(device: Device): string {
  const vlans = normaliseVlans(device.config?.vlans || []);
  const configured = vlans.length ? vlans : [{ id: 1, name: "default" }];
  const interfaces = switchInterfacesWithNames(device);
  const trunkAllowed = normaliseTrunkAllowedVlans(device.config?.trunkAllowedVlans || {});
  return [
    "VLAN ID  Name       Ports",
    ...configured.map((vlan) => {
      const accessPorts = interfaces.filter((iface) => iface.mode !== "trunk" && iface.vlan === vlan.id).map((iface) => iface.name);
      const trunkPorts = interfaces.filter((iface) => {
        if (iface.mode !== "trunk") return false;
        const allowed = trunkAllowed[iface.name];
        return !allowed || allowed.length === 0 || allowed.includes(vlan.id);
      }).map((iface) => `${iface.name}(T)`);
      const ports = [...accessPorts, ...trunkPorts].join(",") || "-";
      return `${String(vlan.id).padEnd(8)}${String(vlan.name || `Vlan${vlan.id}`).padEnd(11)}${ports}`;
    })
  ].join("\n");
}

export function showSwitchMacTable(device: Device): string {
  const entries = normaliseMacTable(device.config?.macTable || []);
  if (!entries.length) return "No.    Vlan  MacAddress         Port      Type";
  return [
    "No.    Vlan  MacAddress         Port      Type",
    ...entries.map((entry, index: number) => `${String(index + 1).padEnd(7)}${String(entry.vlan || "-").padEnd(6)}${entry.macAddress.padEnd(19)}${String(entry.port || "-").padEnd(10)}${entry.type || "DYNAMIC"}`)
  ].join("\n");
}

// SONiC `show runningconfiguration all`. Real SONiC emits JSON; we emit the
// equivalent `config …` commands that would recreate the state (consistent with
// the switch CLI grammar and easy to replay).
export function showSwitchRunningConfig(device: Device): string {
  const vlans = normaliseVlans(device.config?.vlans || []).filter((vlan) => vlan.id !== 1);
  const interfaces = switchInterfacesWithNames(device);
  const trunkAllowed = normaliseTrunkAllowedVlans(device.config?.trunkAllowedVlans || {});
  // Every line is a command this shell accepts, so the listing can be typed
  // back. The header used to read `hostname X`, which the SONiC shell rejects
  // (its form is `config hostname X`).
  const header = `config hostname ${device.name}`;
  const lines: string[] = [header];
  const stp = device.config?.stp;
  if (stp?.enabled === false) lines.push(`config spanning_tree disable`);
  if (stp?.priority != null && stp.priority !== 32768) lines.push(`config spanning_tree priority ${stp.priority}`);
  const mir = device.config?.mirror;
  if (mir?.dest) lines.push(`config mirror_session span add ${mir.name || "MON"} ${mir.dest}${mir.sources?.length ? " " + mir.sources.join(",") : ""}`);
  for (const vlan of vlans) lines.push(`config vlan add ${vlan.id}`);
  for (const iface of interfaces) {
    if (iface.mode === "trunk") {
      if (iface.nativeVlan && iface.nativeVlan !== 1) lines.push(`config vlan member add ${iface.nativeVlan} ${iface.name}`);
      const allowed = trunkAllowed[iface.name] || [];
      for (const vid of allowed) lines.push(`config vlan member add -t ${vid} ${iface.name}`);
      // A trunk with no explicit allow-list carries every VLAN — SONiC has no
      // "member add -t all", so the replayable form cannot express it. Say so
      // rather than emit nothing (which replayed as an access port).
      if (!allowed.length) lines.push(`# ${iface.name}: trunk carrying all VLANs (no SONiC command expresses this — add tagged members to pin it)`);
    } else if (iface.vlan && iface.vlan !== 1) {
      lines.push(`config vlan member add ${iface.vlan} ${iface.name}`);
    }
  }
  return lines.length > 1 ? lines.join("\n") : `${header}\n# (no VLAN configuration)`;
}

// SONiC `show spanning_tree` — the bridge/root ids and per-port role/state/cost.
export function showSwitchSpanningTree(device: Device): string {
  if (!device.config?.managed) return "Spanning tree runs only on a managed switch.";
  if (device.config.stp && device.config.stp.enabled === false) return "Spanning tree is administratively disabled on this bridge.";
  runStpConvergence();   // reflect the current topology (idempotent)
  const s = device.config?.stp;
  const isRoot = !!s?.bridgeId && s.bridgeId === s.rootId;
  const ports = s?.ports || {};
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  return [
    "Spanning tree (IEEE 802.1D)",
    `  Bridge ID  ${s?.bridgeId || "-"}`,
    `  Root ID    ${s?.rootId || "-"}${isRoot ? "  (this bridge is the root)" : `  root path cost ${s?.rootCost ?? "-"}`}`,
    "",
    "Interface   Role        State        Cost  Connected to",
    ...switchInterfacesWithNames(device).filter((i) => i.peer).map((i) => {
      const pi = ports[i.name];
      return [
        i.name.padEnd(12),
        cap(pi?.role || "designated").padEnd(12),
        cap(pi?.state || "forwarding").padEnd(13),
        "1".padEnd(6),
        i.peer?.name || "-",
      ].join("");
    }),
  ].join("\n");
}

// SONiC `show mirror_session` — the SPAN port-mirroring session, if any.
export function showSwitchMirror(device: Device): string {
  const m = device.config?.mirror;
  if (!m?.dest) return "No mirror sessions configured.";
  const src = m.sources && m.sources.length ? m.sources.join(",") : "all";
  return [
    "Name  Status  SRC Port  DST Port  Direction",
    `${(m.name || "MON").padEnd(6)}${"active".padEnd(8)}${src.padEnd(10)}${m.dest.padEnd(10)}rx`,
  ].join("\n");
}

// Configure (or clear) a SPAN session: mirror source ports (or all, when sources
// is empty) to a monitor destination port. Shared by the CLI + the console
// `mirror` command. Validates the ports against the switch's interface list.
export function setSwitchMirror(device: Device, change: { name?: string; dest: string; sources?: string[] } | null): string {
  ensureConfig(device);
  const cfg = device.config;
  if (change === null) {
    if (!cfg.mirror) return "No mirror session is configured.";   // nothing to remove: no undo point
    pushUndo(); delete cfg.mirror; sync().syncPanel(); sync().render(); return "Mirror session removed.";
  }
  const valid = (p: string) => !!switchIfaceByName(device, p);
  if (!valid(change.dest)) return `Unknown interface ${change.dest}.`;
  const sources = (change.sources || []).filter(Boolean);
  for (const s of sources) if (!valid(s)) return `Unknown interface ${s}.`;
  pushUndo();   // after validation — a rejected port must not leave a spurious entry / wipe redo
  cfg.mirror = { name: change.name || "MON", dest: switchIfaceByName(device, change.dest).name, ...(sources.length ? { sources: sources.map(s => switchIfaceByName(device, s).name) } : {}) };
  sync().syncPanel();
  sync().render();
  const srcLabel = sources.length ? sources.join(",") : "all ports";
  return `Mirroring ${srcLabel} to ${cfg.mirror.dest}.`;
}

// Why a bridge priority is not valid, or null when it is: 802.1D priorities are
// multiples of 4096 from 0 to 61440. The one rule for the switch shell, the
// console's `stp` and the inspector field (which used to revert a bad value
// without a word).
export function stpPriorityError(value: unknown): string | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 61440 && n % 4096 === 0 ? null
    : `Bridge priority must be 0–61440 in steps of 4096 (got ${String(value).trim() || "nothing"}).`;
}

// Enable/disable spanning tree or set the bridge priority (shared by the CLI and
// the console `stp` command). Re-converges so blocked ports update live.
export function setSwitchStp(device: Device, change: { enabled?: boolean; priority?: number }): string {
  // A change that changes nothing takes no undo point (and so keeps the redo
  // branch) — `config spanning_tree disable` on a bridge already disabled used
  // to (review R88).
  const now = device.config?.stp;
  const enabledNow = now?.enabled !== false, priorityNow = now?.priority ?? 32768;
  if ((change.enabled == null || change.enabled === enabledNow) && (change.priority == null || change.priority === priorityNow)) {
    return change.priority != null ? `Bridge priority is already ${priorityNow}.` : `Spanning tree is already ${enabledNow ? "enabled" : "disabled"}.`;
  }
  pushUndo();
  ensureConfig(device);
  const cfg = device.config;
  cfg.stp = cfg.stp || { enabled: true };
  if (change.enabled != null) cfg.stp.enabled = change.enabled;
  if (change.priority != null) cfg.stp.priority = change.priority;
  sync().recomputeStp();
  sync().syncPanel();
  if (change.priority != null) return `Bridge priority set to ${change.priority}.`;
  return `Spanning tree ${change.enabled ? "enabled" : "disabled"}.`;
}

// Add a VLAN, optionally with a name (the console's `vlan SW add 10 Sales`, and
// what the script export writes for a named VLAN). Adding an existing id with a
// name renames it; without one it is left as it is.
export function addSwitchVlan(device: Device, vlanId: string, name = ""): string {
  const id = normaliseVlanId(vlanId);
  if (!id) return `Invalid VLAN ID: ${vlanId}`;
  const label = name.replace(/\s+/g, " ").trim().slice(0, 32);
  ensureConfig(device);
  const vlans = normaliseVlans(device.config.vlans || []);
  const existing = vlans.find((vlan) => vlan.id === id);
  // Nothing to add and nothing to rename: say so, with no undo point — it used
  // to answer "Added VLAN 10" and leave a dead undo entry (review R88).
  if (existing && (!label || existing.name === label)) return `VLAN ${id} already exists.`;
  pushUndo();
  if (existing) existing.name = label;
  else vlans.push({ id, name: label || (id === 1 ? "default" : `Vlan${id}`) });
  device.config.vlans = vlans.sort((a, b) => a.id - b.id);
  sync().syncPanel();
  return existing ? `Renamed VLAN ${id} to ${label}.` : `Added VLAN ${id}${label ? ` (${label})` : ""}.`;
}

export function removeSwitchVlan(device: Device, vlanId: string): string {
  const id = normaliseVlanId(vlanId);
  if (!id || id === 1) return `Invalid VLAN ID: ${vlanId}`;
  ensureConfig(device);
  // Removing a VLAN the switch does not have removed nothing, yet answered
  // "Removed VLAN 999" and took an undo point (review R88).
  if (!normaliseVlans(device.config.vlans || []).some((vlan) => vlan.id === id)) return `Unknown VLAN ${id} — nothing to remove.`;
  pushUndo();
  device.config.vlans = normaliseVlans(device.config.vlans || []).filter((vlan) => vlan.id !== id);
  const portVlans = normalisePortVlans(device.config.portVlans || {});
  Object.keys(portVlans).forEach(port => {
    if (portVlans[port] === id) delete portVlans[port];
  });
  device.config.portVlans = portVlans;
  // Trunk allow-lists and native VLANs referenced the deleted VLAN too — a
  // trunk kept "carrying" a VLAN that no longer existed.
  const trunkNative = normalisePortVlans(device.config.trunkNativeVlans || {});
  Object.keys(trunkNative).forEach(port => { if (trunkNative[port] === id) delete trunkNative[port]; });
  device.config.trunkNativeVlans = trunkNative;
  const trunkAllowed = normaliseTrunkAllowedVlans(device.config.trunkAllowedVlans || {});
  Object.keys(trunkAllowed).forEach(port => {
    trunkAllowed[port] = trunkAllowed[port].filter(v => v !== id);
    if (!trunkAllowed[port].length) delete trunkAllowed[port];
  });
  device.config.trunkAllowedVlans = trunkAllowed;
  sync().syncPanel();
  sync().render();
  return `Removed VLAN ${id}.`;
}

export function setSwitchPortVlan(device: Device, portName: string, vlanId: string): string {
  const id = normaliseVlanId(vlanId);
  const iface = switchInterfacesWithNames(device).find((port) => port.name.toLowerCase() === String(portName || "").toLowerCase());
  if (!iface) return `Unknown interface ${portName}.`;
  if (!id) return `Invalid VLAN ID: ${vlanId}`;
  ensureConfig(device);
  const vlans = normaliseVlans(device.config.vlans || []);
  const portVlans = normalisePortVlans(device.config.portVlans || {});
  if ((portVlans[iface.name] || 1) === id && (id === 1 || vlans.some((vlan) => vlan.id === id))) return `${iface.name} is already in VLAN ${id}.`;
  pushUndo();
  if (!vlans.some((vlan) => vlan.id === id)) vlans.push({ id, name: id === 1 ? "default" : `Vlan${id}` });
  if (id === 1) {
    delete portVlans[iface.name];
  } else {
    portVlans[iface.name] = id;
  }
  device.config.vlans = vlans.sort((a, b) => a.id - b.id);
  device.config.portVlans = portVlans;
  sync().syncPanel();
  return `Assigned ${iface.name} to VLAN ${id}.`;
}

export function setSwitchPortMode(device: Device, portName: string, mode: string): string {
  const iface = switchInterfacesWithNames(device).find((port) => port.name.toLowerCase() === String(portName || "").toLowerCase());
  if (!iface) return `Unknown interface ${portName}.`;
  ensureConfig(device);
  const portModes = normalisePortModes(device.config.portModes || {});
  if ((portModes[iface.name] || "access") === mode) return `${iface.name} is already in ${mode} mode.`;
  pushUndo();
  if (mode === "access") {
    delete portModes[iface.name];
  } else {
    portModes[iface.name] = mode as any;
  }
  device.config.portModes = portModes;
  sync().syncPanel();
  sync().render();
  return `Set ${iface.name} to ${mode} mode.`;
}

export function setSwitchTrunkNative(device: Device, portName: string, vlanId: string): string {
  const id = normaliseVlanId(vlanId);
  const iface = switchInterfacesWithNames(device).find((port) => port.name.toLowerCase() === String(portName || "").toLowerCase());
  if (!iface) return `Unknown interface ${portName}.`;
  if (!id) return `Invalid VLAN ID: ${vlanId}`;
  ensureConfig(device);
  const trunkNativeVlans = normalisePortVlans(device.config.trunkNativeVlans || {});
  if ((trunkNativeVlans[iface.name] || 1) === id) return `${iface.name} trunk native VLAN is already ${id}.`;
  pushUndo();
  if (id === 1) {
    delete trunkNativeVlans[iface.name];
  } else {
    trunkNativeVlans[iface.name] = id;
  }
  device.config.trunkNativeVlans = trunkNativeVlans;
  sync().syncPanel();
  return `Set ${iface.name} trunk native VLAN to ${id}.`;
}

export function modifySwitchTrunkAllowed(device: Device, portName: string, vlanId: string, action: "add" | "remove"): string {
  const id = normaliseVlanId(vlanId);
  const iface = switchInterfacesWithNames(device).find((port) => port.name.toLowerCase() === String(portName || "").toLowerCase());
  if (!iface) return `Unknown interface ${portName}.`;
  if (!id) return `Invalid VLAN ID: ${vlanId}`;
  ensureConfig(device);
  const trunkAllowed = normaliseTrunkAllowedVlans(device.config.trunkAllowedVlans || {});
  const listed = !!trunkAllowed[iface.name]?.includes(id);
  if (action === "add" && listed) return `VLAN ${id} is already on ${iface.name}'s trunk allowed list.`;
  if (action === "remove" && !listed) return `VLAN ${id} is not on ${iface.name}'s trunk allowed list.`;
  pushUndo();
  if (!trunkAllowed[iface.name]) trunkAllowed[iface.name] = [];
  if (action === "add") {
    if (!trunkAllowed[iface.name].includes(id)) trunkAllowed[iface.name].push(id);
    trunkAllowed[iface.name].sort((a, b) => a - b);
  } else {
    trunkAllowed[iface.name] = trunkAllowed[iface.name].filter(v => v !== id);
    if (trunkAllowed[iface.name].length === 0) delete trunkAllowed[iface.name];
  }
  device.config.trunkAllowedVlans = trunkAllowed;
  sync().syncPanel();
  return action === "add" ? `Added VLAN ${id} to ${iface.name} trunk allowed list.` : `Removed VLAN ${id} from ${iface.name} trunk allowed list.`;
}
function switchVlanExists(device: Device, id: number): boolean {
  return id === 1 || normaliseVlans(device.config?.vlans || []).some((v) => v.id === id);
}

// SONiC `config vlan member add [-t] <vid> <port>`. Untagged membership is the
// port's single access/native VLAN; a tagged member makes the port a trunk that
// carries the VLAN. One undo snapshot per command (atomic).
function sonicVlanMemberAdd(device: Device, vlanId: string, portName: string, tagged: boolean): string {
  const iface = switchIfaceByName(device, portName);
  if (!iface) return `Unknown interface ${portName}.`;
  const id = normaliseVlanId(vlanId);
  if (!id) return `Invalid VLAN ID: ${vlanId}`;
  if (!switchVlanExists(device, id)) return `Error: Vlan${id} doesn't exist`;
  pushUndo();
  ensureConfig(device);
  const portModes = normalisePortModes(device.config.portModes || {});
  const portVlans = normalisePortVlans(device.config.portVlans || {});
  const trunkNative = normalisePortVlans(device.config.trunkNativeVlans || {});
  const trunkAllowed = normaliseTrunkAllowedVlans(device.config.trunkAllowedVlans || {});
  const name = iface.name;
  if (tagged) {
    if (portModes[name] !== "trunk") {
      // Becoming a trunk: keep the current untagged (access) VLAN as the native.
      const access = portVlans[name];
      if (access && access !== 1) trunkNative[name] = access;
      delete portVlans[name];
      portModes[name] = "trunk";
    }
    if (!trunkAllowed[name]) trunkAllowed[name] = [];
    if (!trunkAllowed[name].includes(id)) trunkAllowed[name].push(id);
    trunkAllowed[name].sort((a, b) => a - b);
  } else if (portModes[name] === "trunk") {
    if (id === 1) delete trunkNative[name]; else trunkNative[name] = id;
  } else {
    if (id === 1) delete portVlans[name]; else portVlans[name] = id;
  }
  device.config.portModes = portModes;
  device.config.portVlans = portVlans;
  device.config.trunkNativeVlans = trunkNative;
  device.config.trunkAllowedVlans = trunkAllowed;
  sync().syncPanel();
  sync().render();
  return tagged
    ? `Added ${name} as a tagged member of VLAN ${id}.`
    : `Added ${name} as an untagged member of VLAN ${id}.`;
}

// SONiC `config vlan member del <vid> <port>`. Removing the last tagged member
// collapses the port back to an access port.
function sonicVlanMemberDel(device: Device, vlanId: string, portName: string): string {
  const iface = switchIfaceByName(device, portName);
  if (!iface) return `Unknown interface ${portName}.`;
  const id = normaliseVlanId(vlanId);
  if (!id) return `Invalid VLAN ID: ${vlanId}`;
  ensureConfig(device);
  const portModes = normalisePortModes(device.config.portModes || {});
  const portVlans = normalisePortVlans(device.config.portVlans || {});
  const trunkNative = normalisePortVlans(device.config.trunkNativeVlans || {});
  const trunkAllowed = normaliseTrunkAllowedVlans(device.config.trunkAllowedVlans || {});
  const name = iface.name;
  // Decide membership BEFORE the undo push: deleting a non-member is a no-op
  // and must not leave a spurious entry (or wipe the redo stack).
  const isMember = portModes[name] === "trunk"
    ? (trunkNative[name] === id || !!trunkAllowed[name]?.includes(id))
    : (portVlans[name] || 1) === id;
  if (!isMember) return `VLAN ${id} is not a member of ${name}.`;
  pushUndo();
  let changed = false;
  if (portModes[name] === "trunk") {
    if (trunkNative[name] === id) { delete trunkNative[name]; changed = true; }
    if (trunkAllowed[name]?.includes(id)) {
      trunkAllowed[name] = trunkAllowed[name].filter((v: number) => v !== id);
      changed = true;
    }
    if (changed && (!trunkAllowed[name] || trunkAllowed[name].length === 0)) {
      // This delete removed a member and none remain — collapse back to an
      // access port. Gated on `changed` so deleting a *non-member* VLAN from a
      // native-only trunk no longer silently demotes the port (it now correctly
      // returns "not a member" and leaves the trunk untouched).
      delete trunkAllowed[name];
      delete portModes[name];
      const native = trunkNative[name];
      delete trunkNative[name];
      if (native && native !== 1) portVlans[name] = native;
    }
  } else if ((portVlans[name] || 1) === id) {
    delete portVlans[name];
    changed = true;
  }
  device.config.portModes = portModes;
  device.config.portVlans = portVlans;
  device.config.trunkNativeVlans = trunkNative;
  device.config.trunkAllowedVlans = trunkAllowed;
  sync().syncPanel();
  sync().render();
  return changed ? `Removed ${name} from VLAN ${id}.` : `VLAN ${id} is not a member of ${name}.`;
}

export function runSwitchTerminalCommand(device: Device, command: string): void {
  const lower = command.toLowerCase();
  if (!device.config?.managed) {
    terminalLine("error", "This switch is unmanaged.");
    return;
  }
  if (lower === "?" || lower === "help") {
    terminalLine("muted", [
      "show vlan brief",
      "show mac",
      "show interfaces status",
      "show runningconfiguration all",
      "config vlan add <vlan-id>",
      "config vlan del <vlan-id>",
      "config vlan member add <vlan-id> <EthernetN>      (untagged / access)",
      "config vlan member add -t <vlan-id> <EthernetN>   (tagged / trunk)",
      "config vlan member del <vlan-id> <EthernetN>",
      "show spanning_tree",
      "config spanning_tree enable | disable",
      "config spanning_tree priority <0-61440>",
      "show mirror_session",
      "config mirror_session span add <name> <dst-port> [src-port]   (SPAN to a monitor port)",
      "config mirror_session remove <name>",
      "config hostname <name>",
      "clear"
    ].join("\n"));
    return;
  }
  if (lower === "clear") {
    state.terminal.lines = [];
    return;
  }
  if (lower === "show vlan brief" || lower === "show vlan") {
    terminalLine("", showSwitchVlans(device));
    return;
  }
  if (lower === "show mac" || lower === "show mac address-table") {
    terminalLine("", showSwitchMacTable(device));
    return;
  }
  if (lower === "show interfaces status" || lower === "show interface status") {
    terminalLine("", showSwitchInterfaces(device));
    return;
  }
  if (lower === "show runningconfiguration all" || lower === "show runningconfiguration") {
    terminalLine("", showSwitchRunningConfig(device));
    return;
  }
  if (lower === "show spanning_tree" || lower === "show spanning-tree" || lower === "show stp") {
    terminalLine("", showSwitchSpanningTree(device));
    return;
  }
  if (lower === "show mirror_session" || lower === "show mirror") {
    terminalLine("", showSwitchMirror(device));
    return;
  }
  // SONiC `config mirror_session span add <name> <dst> [src] [direction]`. Only
  // rx (ingress) SPAN is simulated, so a tx/both direction is warned about and
  // ignored rather than silently applied as rx (R96). The source group's
  // negative lookahead keeps a bare direction token (`… <dst> rx`) out of it.
  const mirrorAddMatch = command.match(/^(?:sudo\s+)?config\s+mirror_session\s+span\s+add\s+(\S+)\s+(\S+)(?:\s+(?!(?:rx|tx|both)\b)(\S+))?(?:\s+(rx|tx|both))?(?:\s+\S+)*$/i);
  if (mirrorAddMatch) {
    const dir = (mirrorAddMatch[4] || "rx").toLowerCase();
    const result = setSwitchMirror(device, { name: mirrorAddMatch[1], dest: mirrorAddMatch[2], sources: mirrorAddMatch[3] ? mirrorAddMatch[3].split(",") : [] });
    if (/^Unknown/.test(result)) { terminalLine("error", result); return; }
    if (dir !== "rx") { terminalLine("muted", `${result} Note: only rx (ingress) SPAN is simulated — the ${dir} direction is ignored, so traffic sent out ${mirrorAddMatch[3] || "the source ports"} is not mirrored.`); return; }
    terminalLine("", result);
    return;
  }
  const mirrorRemoveMatch = command.match(/^(?:sudo\s+)?config\s+mirror_session\s+remove\s+\S+$/i);
  if (mirrorRemoveMatch) {
    terminalLine("", setSwitchMirror(device, null));
    return;
  }
  const stpEnableMatch = command.match(/^(?:sudo\s+)?config\s+spanning_tree\s+(enable|disable)(?:\s+pvst)?$/i);
  if (stpEnableMatch) {
    terminalLine("", setSwitchStp(device, { enabled: stpEnableMatch[1].toLowerCase() === "enable" }));
    return;
  }
  const stpPriorityMatch = command.match(/^(?:sudo\s+)?config\s+spanning_tree\s+priority\s+(\d+)$/i);
  if (stpPriorityMatch) {
    const n = Number(stpPriorityMatch[1]);
    const bad = stpPriorityError(n);
    if (bad) { terminalLine("error", `% ${bad}`); return; }
    terminalLine("", setSwitchStp(device, { priority: n }));
    return;
  }
  const addVlanMatch = command.match(/^config\s+vlan\s+add\s+(\d+)$/i);
  if (addVlanMatch) {
    const result = addSwitchVlan(device, addVlanMatch[1]);
    // As SONiC does, an existing VLAN is an error here (the console's `vlan …
    // add` stays idempotent, so a replayed script is not rejected).
    if (result.endsWith("already exists.")) terminalLine("error", `Error: Vlan${Number(addVlanMatch[1])} already exists`);
    else terminalLine(result.startsWith("Invalid") ? "error" : "", result);
    return;
  }
  const delVlanMatch = command.match(/^config\s+vlan\s+del\s+(\d+)$/i);
  if (delVlanMatch) {
    const result = removeSwitchVlan(device, delVlanMatch[1]);
    if (result.startsWith("Unknown")) terminalLine("error", `Error: Vlan${Number(delVlanMatch[1])} doesn't exist`);
    else terminalLine(result.startsWith("Invalid") ? "error" : "", result);
    return;
  }
  const memberAddMatch = command.match(/^config\s+vlan\s+member\s+add\s+(-t\s+)?(\d+)\s+(\S+)$/i);
  if (memberAddMatch) {
    const result = sonicVlanMemberAdd(device, memberAddMatch[2], memberAddMatch[3], !!memberAddMatch[1]);
    terminalLine(/^(Unknown|Invalid|Error)/.test(result) ? "error" : "", result);
    return;
  }
  const memberDelMatch = command.match(/^config\s+vlan\s+member\s+del\s+(\d+)\s+(\S+)$/i);
  if (memberDelMatch) {
    const result = sonicVlanMemberDel(device, memberDelMatch[1], memberDelMatch[2]);
    terminalLine(/^(Unknown|Invalid|Error)/.test(result) ? "error" : "", result);
    return;
  }
  // SONiC `config hostname <name>` renames the switch — its prompt, canvas label
  // and resolvable name are the hostname. (`sudo` prefix tolerated.)
  if (lower === "hostname") { terminalLine("", device.name); return; }
  const hostnameMatch = command.match(/^(?:sudo\s+)?config\s+hostname\s+(\S+)$/i);
  if (hostnameMatch) {
    const error = applyHostname(device, hostnameMatch[1]);
    if (error) terminalLine("error", error);
    return;
  }
  terminalLine("error", `% Unknown command: ${command}`);
}
