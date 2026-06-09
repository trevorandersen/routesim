/**
 * Managed-switch terminal — modelled on SONiC: flat, mode-less `config ...` /
 * `show ...` commands with VLAN-membership (tagged/untagged) semantics.
 * The mutators are shared with the inspector GUI and the console engine.
 */
import type { Device } from "../types";
import { state, sync, pushUndo } from "../state";
import { normaliseVlanId } from "../utils";
import { normaliseMacTable, normaliseVlans, normalisePortVlans, normalisePortModes, normaliseTrunkAllowedVlans, ensureConfig } from "../normalise";
import { switchInterfacesWithNames, switchIfaceByName } from "../devices";
import { terminalLine } from "./core";

export function showSwitchInterfaces(device: Device): string {
  const interfaces = switchInterfacesWithNames(device);
  return [
    "Interface  Admin  Oper  Mode    VLAN  Connected to",
    ...interfaces.map((iface: any) => {
      const mode = iface.mode || "access";
      const vlanDisplay = mode === "trunk" ? `-` : String(iface.vlan);
      return [
        iface.name.padEnd(11),
        "up".padEnd(7),
        (iface.peer ? "up" : "down").padEnd(6),
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
    ...configured.map((vlan: any) => {
      const accessPorts = interfaces.filter((iface: any) => iface.mode !== "trunk" && iface.vlan === vlan.id).map((iface: any) => iface.name);
      const trunkPorts = interfaces.filter((iface: any) => {
        if (iface.mode !== "trunk") return false;
        const allowed = trunkAllowed[iface.name];
        return !allowed || allowed.length === 0 || allowed.includes(vlan.id);
      }).map((iface: any) => `${iface.name}(T)`);
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
    ...entries.map((entry: any, index: number) => `${String(index + 1).padEnd(7)}${String(entry.vlan || "-").padEnd(6)}${entry.macAddress.padEnd(19)}${String(entry.port || "-").padEnd(10)}${entry.type || "DYNAMIC"}`)
  ].join("\n");
}

// SONiC `show runningconfiguration all`. Real SONiC emits JSON; we emit the
// equivalent `config …` commands that would recreate the state (consistent with
// the switch CLI grammar and easy to replay).
export function showSwitchRunningConfig(device: Device): string {
  const vlans = normaliseVlans(device.config?.vlans || []).filter((vlan: any) => vlan.id !== 1);
  const interfaces = switchInterfacesWithNames(device);
  const trunkAllowed = normaliseTrunkAllowedVlans(device.config?.trunkAllowedVlans || {});
  const lines: string[] = [`hostname ${device.name}`];
  for (const vlan of vlans) lines.push(`config vlan add ${vlan.id}`);
  for (const iface of interfaces) {
    if (iface.mode === "trunk") {
      if (iface.nativeVlan && iface.nativeVlan !== 1) lines.push(`config vlan member add ${iface.nativeVlan} ${iface.name}`);
      for (const vid of trunkAllowed[iface.name] || []) lines.push(`config vlan member add -t ${vid} ${iface.name}`);
    } else if (iface.vlan && iface.vlan !== 1) {
      lines.push(`config vlan member add ${iface.vlan} ${iface.name}`);
    }
  }
  return lines.length > 1 ? lines.join("\n") : `hostname ${device.name}\n(no VLAN configuration)`;
}

export function addSwitchVlan(device: Device, vlanId: string): string {
  const id = normaliseVlanId(vlanId);
  if (!id) return `Invalid VLAN ID: ${vlanId}`;
  pushUndo();
  ensureConfig(device);
  const vlans = normaliseVlans(device.config.vlans || []);
  if (!vlans.some((vlan: any) => vlan.id === id)) vlans.push({ id, name: id === 1 ? "default" : `Vlan${id}` });
  device.config.vlans = vlans.sort((a: any, b: any) => a.id - b.id);
  sync().syncPanel();
  return `Added VLAN ${id}.`;
}

export function removeSwitchVlan(device: Device, vlanId: string): string {
  const id = normaliseVlanId(vlanId);
  if (!id || id === 1) return `Invalid VLAN ID: ${vlanId}`;
  pushUndo();
  ensureConfig(device);
  device.config.vlans = normaliseVlans(device.config.vlans || []).filter((vlan: any) => vlan.id !== id);
  const portVlans = normalisePortVlans(device.config.portVlans || {});
  Object.keys(portVlans).forEach(port => {
    if (portVlans[port] === id) delete portVlans[port];
  });
  device.config.portVlans = portVlans;
  sync().syncPanel();
  return `Removed VLAN ${id}.`;
}

export function setSwitchPortVlan(device: Device, portName: string, vlanId: string): string {
  const id = normaliseVlanId(vlanId);
  const iface = switchInterfacesWithNames(device).find((port: any) => port.name.toLowerCase() === String(portName || "").toLowerCase());
  if (!iface) return `Unknown interface ${portName}.`;
  if (!id) return `Invalid VLAN ID: ${vlanId}`;
  pushUndo();
  ensureConfig(device);
  const vlans = normaliseVlans(device.config.vlans || []);
  if (!vlans.some((vlan: any) => vlan.id === id)) vlans.push({ id, name: id === 1 ? "default" : `Vlan${id}` });
  const portVlans = normalisePortVlans(device.config.portVlans || {});
  if (id === 1) {
    delete portVlans[iface.name];
  } else {
    portVlans[iface.name] = id;
  }
  device.config.vlans = vlans.sort((a: any, b: any) => a.id - b.id);
  device.config.portVlans = portVlans;
  sync().syncPanel();
  return `Assigned ${iface.name} to VLAN ${id}.`;
}

export function setSwitchPortMode(device: Device, portName: string, mode: string): string {
  const iface = switchInterfacesWithNames(device).find((port: any) => port.name.toLowerCase() === String(portName || "").toLowerCase());
  if (!iface) return `Unknown interface ${portName}.`;
  pushUndo();
  ensureConfig(device);
  const portModes = normalisePortModes(device.config.portModes || {});
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
  const iface = switchInterfacesWithNames(device).find((port: any) => port.name.toLowerCase() === String(portName || "").toLowerCase());
  if (!iface) return `Unknown interface ${portName}.`;
  if (!id) return `Invalid VLAN ID: ${vlanId}`;
  pushUndo();
  ensureConfig(device);
  const trunkNativeVlans = normalisePortVlans(device.config.trunkNativeVlans || {});
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
  const iface = switchInterfacesWithNames(device).find((port: any) => port.name.toLowerCase() === String(portName || "").toLowerCase());
  if (!iface) return `Unknown interface ${portName}.`;
  if (!id) return `Invalid VLAN ID: ${vlanId}`;
  pushUndo();
  ensureConfig(device);
  const trunkAllowed = normaliseTrunkAllowedVlans(device.config.trunkAllowedVlans || {});
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
  return id === 1 || normaliseVlans(device.config?.vlans || []).some((v: any) => v.id === id);
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
  pushUndo();
  ensureConfig(device);
  const portModes = normalisePortModes(device.config.portModes || {});
  const portVlans = normalisePortVlans(device.config.portVlans || {});
  const trunkNative = normalisePortVlans(device.config.trunkNativeVlans || {});
  const trunkAllowed = normaliseTrunkAllowedVlans(device.config.trunkAllowedVlans || {});
  const name = iface.name;
  let changed = false;
  if (portModes[name] === "trunk") {
    if (trunkNative[name] === id) { delete trunkNative[name]; changed = true; }
    if (trunkAllowed[name]?.includes(id)) {
      trunkAllowed[name] = trunkAllowed[name].filter((v: number) => v !== id);
      changed = true;
    }
    if (!trunkAllowed[name] || trunkAllowed[name].length === 0) {
      // No tagged members left — collapse back to an access port.
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
  const addVlanMatch = command.match(/^config\s+vlan\s+add\s+(\d+)$/i);
  if (addVlanMatch) {
    const result = addSwitchVlan(device, addVlanMatch[1]);
    terminalLine(result.startsWith("Invalid") ? "error" : "", result);
    return;
  }
  const delVlanMatch = command.match(/^config\s+vlan\s+del\s+(\d+)$/i);
  if (delVlanMatch) {
    const result = removeSwitchVlan(device, delVlanMatch[1]);
    terminalLine(result.startsWith("Invalid") ? "error" : "", result);
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
  terminalLine("error", `% Unknown command: ${command}`);
}
