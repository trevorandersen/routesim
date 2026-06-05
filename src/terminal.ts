import type { Device } from "./types";
import { state, sync, pushUndo } from "./state";
import { dom } from "./dom";
import { escapeHtml, isValidIpv4, ipv4Network24, normaliseMacAddress, isValidMac, parseIpv4Token, normaliseVlanId } from "./utils";
import { normaliseArpTable, normaliseMacTable, normaliseDhcpLeases, normaliseVlans, normalisePortVlans, normalisePortModes, normaliseTrunkAllowedVlans, normaliseRouterInterfaces, normaliseStaticRoutes, normaliseRipConfig, ensureConfig } from "./normalise";
import { getDevice, routerInterfacesWithNames, routerInterfaceFor, routerInterfaceByName, switchInterfacesWithNames, linkedPortsFor } from "./devices";
import { buildPingEvents, buildDhcpEvents } from "./simulation";
import { startSimulation, buildRoutingTable, runRipConvergence } from "./engine";

export function terminalLine(kind: string, text: string): void {
  state.terminal.lines.push({ kind, text });
  if (state.terminal.lines.length > 120) state.terminal.lines.splice(0, state.terminal.lines.length - 120);
}

export function terminalPromptText(device: Device): string {
  if (device.type === "computer") return `${device.name}$`;
  if (device.type === "switch") return `${device.name}#`;
  if (state.terminal.mode === "config") return `${device.name}(config)#`;
  if (state.terminal.mode === "interface") return `${device.name}(config-if)#`;
  if (state.terminal.mode === "rip") return `${device.name}(config-router)#`;
  if (state.terminal.mode === "privileged") return `${device.name}#`;
  return `${device.name}>`;
}

export function showHostIp(device: Device): string {
  const ipv4 = device.config?.ipv4Address || "unassigned";
  const mac = device.config?.macAddress || "unassigned";
  const inetLine = device.config?.ipv4Address ? `    inet ${ipv4}/24 scope global eth0` : "    inet unassigned";
  return [
    "1: eth0: <BROADCAST,MULTICAST,UP> mtu 1500",
    `    link/ether ${mac} brd ff:ff:ff:ff:ff:ff`,
    inetLine
  ].join("\n");
}

export function showHostRoute(device: Device): string {
  const gateway = device.config?.gatewayIpv4Address;
  return gateway ? `default via ${gateway} dev eth0` : "No default route configured.";
}

export function showHostArp(device: Device): string {
  const entries = normaliseArpTable(device.config?.arpTable || []);
  if (!entries.length) return "Address                  HWtype  HWaddress           Flags Mask            Iface";
  return [
    "Address                  HWtype  HWaddress           Flags Mask            Iface",
    ...entries.map((entry: any) => `${entry.ipv4Address.padEnd(24)}ether   ${entry.macAddress.padEnd(19)}C                     eth0`)
  ].join("\n");
}

export function setHostIp(device: Device, address: string): string {
  const parsed = parseIpv4Token(address);
  if (!parsed) return `Invalid IPv4 address: ${address}`;
  pushUndo();
  ensureConfig(device);
  device.config.ipv4Address = parsed.address;
  sync().syncPanel();
  sync().render();
  return `Assigned ${parsed.address}${parsed.prefixLength == null ? "" : `/${parsed.prefixLength}`} to eth0.`;
}

export function flushHostIp(device: Device): string {
  if (!device.config?.ipv4Address) return "No IPv4 address configured on eth0.";
  pushUndo();
  ensureConfig(device);
  device.config.ipv4Address = "";
  device.config.arpTable = [];
  sync().syncPanel();
  sync().render();
  return "Flushed IPv4 address and ARP table from eth0.";
}

export function setHostGateway(device: Device, address: string): string {
  const parsed = parseIpv4Token(address);
  if (!parsed) return `Invalid IPv4 address: ${address}`;
  pushUndo();
  ensureConfig(device);
  device.config.gatewayIpv4Address = parsed.address;
  sync().syncPanel();
  sync().render();
  return `Default gateway set to ${parsed.address}.`;
}

export function showRouterInterfaceBrief(router: Device): string {
  const interfaces = routerInterfacesWithNames(router);
  if (!interfaces.length) return "No interfaces configured.";
  return [
    "Interface     IP-Address      Status  Protocol  VLAN  Connected to",
    ...interfaces.map((iface: any) => {
      const vlanDisplay = iface.config.vlanTag != null ? String(iface.config.vlanTag) : "-";
      return [
        iface.name.padEnd(14),
        (iface.config.ipv4Address || "unassigned").padEnd(16),
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

export function showRouterRipDatabase(router: Device): string {
  const rip = normaliseRipConfig(router.config?.rip);
  if (!rip.enabled) return "RIP is not enabled on this router.";
  if (!rip.learnedRoutes.length) return "RIP Database:\n  No learned routes.";
  return [
    "RIP Database:",
    ...rip.learnedRoutes.map((r: any) => `  ${r.network} via ${r.nextHop} metric ${r.metric}${r.interface ? ` (${r.interface})` : ""}`)
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
      lines.push(iface.config.ipv4Address ? ` ip address ${iface.config.ipv4Address}/24` : " no ip address");
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

export function showSwitchRunningConfig(device: Device): string {
  const vlans = normaliseVlans(device.config?.vlans || []);
  const interfaces = switchInterfacesWithNames(device);
  const trunkAllowed = normaliseTrunkAllowedVlans(device.config?.trunkAllowedVlans || {});
  const ifaceLines: string[] = [];
  for (const iface of interfaces) {
    const lines: string[] = [];
    if (iface.mode === "trunk") {
      lines.push(` switchport mode trunk`);
      if (iface.nativeVlan !== 1) lines.push(` switchport trunk native vlan ${iface.nativeVlan}`);
      const allowed = trunkAllowed[iface.name];
      if (allowed && allowed.length > 0) lines.push(` switchport trunk allowed vlan ${allowed.join(",")}`);
    } else if (iface.vlan !== 1) {
      lines.push(` switchport mode access`);
      lines.push(` switchport access vlan ${iface.vlan}`);
    }
    if (lines.length) {
      ifaceLines.push(`interface ${iface.name}\n${lines.join("\n")}\n!`);
    }
  }
  return [
    "!",
    `hostname ${device.name}`,
    "!",
    ...vlans.filter((vlan: any) => vlan.id !== 1).map((vlan: any) => `vlan ${vlan.id}\n name ${vlan.name || `Vlan${vlan.id}`}\n!`),
    ...ifaceLines,
    "end"
  ].join("\n");
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

export function setRouterInterfaceIp(router: Device, peerId: string, address: string, vlanTag?: number | null): string {
  const parsed = parseIpv4Token(address);
  if (!parsed) return `Invalid IPv4 address: ${address}`;
  pushUndo();
  const iface = routerInterfaceFor(router, peerId, vlanTag);
  iface.ipv4Address = parsed.address;
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

export function runRouterTerminalCommand(router: Device, command: string): void {
  const lower = command.toLowerCase();
  if (lower === "?" || lower === "help") {
    terminalLine("muted", [
      "enable",
      "show ip interface brief",
      "show ip route",
      "show ip arp",
      "show ip dhcp binding",
      "show ip rip",
      "show ip rip database",
      "show running-config",
      "configure terminal",
      "interface <EthernetN|SerialN|EthernetN.vlan>",
      "ip address <ipv4>/24",
      "no ip address",
      "ip route <network/prefix> <next-hop-ip>",
      "no ip route <network/prefix>",
      "router rip / no router rip",
      "  network <cidr>",
      "  no network <cidr>",
      "  passive-interface <name>",
      "  no passive-interface <name>",
      "encapsulation dot1q <vlan-id>",
      "no encapsulation dot1q",
      "exit",
      "end"
    ].join("\n"));
    return;
  }
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
      closeTerminal();
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
  if (lower === "show ip rip") {
    terminalLine("", showRouterRip(router));
    return true;
  }
  if (lower === "show ip rip database") {
    terminalLine("", showRouterRipDatabase(router));
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

// Handles interface-mode commands: `interface`, `ip address`, `no ip address`,
// `encapsulation dot1q`. Returns true if the command matched.
function routerInterfaceCommand(router: Device, command: string, lower: string): boolean {
  const interfaceMatch = command.match(/^interface\s+(\S+)$/i);
  if (interfaceMatch) {
    if (state.terminal.mode !== "config") {
      terminalLine("error", "% Enter configuration mode first.");
      return true;
    }
    const iface = routerInterfaceByName(router, interfaceMatch[1]);
    if (!iface) {
      terminalLine("error", `% Unknown interface ${interfaceMatch[1]}`);
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
    const parsed = parseIpv4Token(networkToken);
    if (!parsed) {
      terminalLine("error", `% Invalid network: ${networkToken}`);
      return true;
    }
    const network = parsed.prefixLength != null ? `${parsed.address}/${parsed.prefixLength}` : `${parsed.address}/24`;
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
    const parsed = parseIpv4Token(networkToken);
    if (!parsed) {
      terminalLine("error", `% Invalid network: ${networkToken}`);
      return true;
    }
    const network = parsed.prefixLength != null ? `${parsed.address}/${parsed.prefixLength}` : `${parsed.address}/24`;
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
    if (!parsedNetwork) {
      terminalLine("error", `% Invalid network: ${networkToken}`);
      return true;
    }
    const network = parsedNetwork.prefixLength != null
      ? `${parsedNetwork.address}/${parsedNetwork.prefixLength}`
      : parsedNetwork.address;
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

export function runSwitchTerminalCommand(device: Device, command: string): void {
  const lower = command.toLowerCase();
  if (!device.config?.managed) {
    terminalLine("error", "This switch is unmanaged.");
    return;
  }
  if (lower === "?" || lower === "help") {
    terminalLine("muted", [
      "show interfaces status",
      "show vlan brief",
      "show mac",
      "show running-config",
      "config vlan add <vlan-id>",
      "config vlan del <vlan-id>",
      "config interface vlan add <EthernetN> <vlan-id>",
      "config interface vlan remove <EthernetN>",
      "config interface mode <EthernetN> access|trunk",
      "config interface trunk native <EthernetN> <vlan-id>",
      "config interface trunk allowed <EthernetN> add <vlan-id>",
      "config interface trunk allowed <EthernetN> remove <vlan-id>",
      "clear"
    ].join("\n"));
    return;
  }
  if (lower === "clear") {
    state.terminal.lines = [];
    return;
  }
  if (lower === "show interfaces status" || lower === "show interface status") {
    terminalLine("", showSwitchInterfaces(device));
    return;
  }
  if (lower === "show vlan brief" || lower === "show vlan") {
    terminalLine("", showSwitchVlans(device));
    return;
  }
  if (lower === "show mac" || lower === "show mac address-table" || lower === "show mac-address-table") {
    terminalLine("", showSwitchMacTable(device));
    return;
  }
  if (lower === "show running-config" || lower === "show run") {
    terminalLine("", showSwitchRunningConfig(device));
    return;
  }
  const addVlanMatch = command.match(/^config\s+vlan\s+add\s+(\d+)$/i);
  if (addVlanMatch) {
    const result = addSwitchVlan(device, addVlanMatch[1]);
    terminalLine(result.startsWith("Invalid") ? "error" : "", result);
    return;
  }
  const delVlanMatch = command.match(/^config\s+vlan\s+(?:del|delete|remove)\s+(\d+)$/i);
  if (delVlanMatch) {
    const result = removeSwitchVlan(device, delVlanMatch[1]);
    terminalLine(result.startsWith("Invalid") ? "error" : "", result);
    return;
  }
  const portVlanMatch = command.match(/^config\s+interface\s+vlan\s+add\s+(\S+)\s+(\d+)$/i);
  if (portVlanMatch) {
    const result = setSwitchPortVlan(device, portVlanMatch[1], portVlanMatch[2]);
    terminalLine(result.startsWith("Invalid") || result.startsWith("Unknown") ? "error" : "", result);
    return;
  }
  const removePortVlanMatch = command.match(/^config\s+interface\s+vlan\s+(?:remove|del|delete)\s+(\S+)$/i);
  if (removePortVlanMatch) {
    const result = setSwitchPortVlan(device, removePortVlanMatch[1], "1");
    terminalLine(result.startsWith("Unknown") ? "error" : "", result);
    return;
  }
  // Port mode: config interface mode <EthernetN> access|trunk
  const portModeMatch = command.match(/^config\s+interface\s+mode\s+(\S+)\s+(access|trunk)$/i);
  if (portModeMatch) {
    const result = setSwitchPortMode(device, portModeMatch[1], portModeMatch[2].toLowerCase());
    terminalLine(result.startsWith("Unknown") ? "error" : "", result);
    return;
  }
  // Trunk native VLAN: config interface trunk native <EthernetN> <vlan-id>
  const trunkNativeMatch = command.match(/^config\s+interface\s+trunk\s+native\s+(\S+)\s+(\d+)$/i);
  if (trunkNativeMatch) {
    const result = setSwitchTrunkNative(device, trunkNativeMatch[1], trunkNativeMatch[2]);
    terminalLine(result.startsWith("Unknown") || result.startsWith("Invalid") ? "error" : "", result);
    return;
  }
  // Trunk allowed VLAN add: config interface trunk allowed <EthernetN> add <vlan-id>
  const trunkAllowedAddMatch = command.match(/^config\s+interface\s+trunk\s+allowed\s+(\S+)\s+add\s+(\d+)$/i);
  if (trunkAllowedAddMatch) {
    const result = modifySwitchTrunkAllowed(device, trunkAllowedAddMatch[1], trunkAllowedAddMatch[2], "add");
    terminalLine(result.startsWith("Unknown") || result.startsWith("Invalid") ? "error" : "", result);
    return;
  }
  // Trunk allowed VLAN remove: config interface trunk allowed <EthernetN> remove <vlan-id>
  const trunkAllowedRemoveMatch = command.match(/^config\s+interface\s+trunk\s+allowed\s+(\S+)\s+(?:remove|del|delete)\s+(\d+)$/i);
  if (trunkAllowedRemoveMatch) {
    const result = modifySwitchTrunkAllowed(device, trunkAllowedRemoveMatch[1], trunkAllowedRemoveMatch[2], "remove");
    terminalLine(result.startsWith("Unknown") || result.startsWith("Invalid") ? "error" : "", result);
    return;
  }
  terminalLine("error", `% Unknown command: ${command}`);
}

export function runTerminalCommand(rawCommand: string): void {
  const host = getDevice(state.terminal.deviceId);
  const command = rawCommand.trim();
  if (!host || !["computer", "router", "switch"].includes(host.type)) {
    terminalLine("error", "No device is attached to this terminal.");
    return;
  }
  if (!command) return;

  terminalLine("command", `${terminalPromptText(host)} ${command}`);
  if (host.type === "router") {
    runRouterTerminalCommand(host, command);
    return;
  }
  if (host.type === "switch") {
    runSwitchTerminalCommand(host, command);
    return;
  }
  const lower = command.toLowerCase();
  if (lower === "clear") {
    state.terminal.lines = [];
    return;
  }
  if (lower === "help") {
    terminalLine("muted", [
      "Commands:",
      "  ip addr show",
      "  ip addr add <ipv4>/24 dev eth0",
      "  ip addr flush dev eth0",
      "  ip route show",
      "  ip route add default via <ipv4> dev eth0",
      "  arp -n",
      "  ping <pc-name|ipv4>",
      "  dhcp",
      "  clear"
    ].join("\n"));
    return;
  }
  if (lower === "ip" || lower === "ip addr" || lower === "ip address" || lower === "ip addr show" || lower === "ip address show" || lower === "ip addr show dev eth0" || lower === "ip address show dev eth0" || lower === "ip a") {
    terminalLine("", showHostIp(host));
    return;
  }

  if (lower === "ip route" || lower === "ip route show" || lower === "ip route show default" || lower === "ip r" || lower === "route" || lower === "route -n") {
    terminalLine("", showHostRoute(host));
    return;
  }

  if (lower === "arp" || lower === "arp -a" || lower === "arp -n" || lower === "ip neigh" || lower === "ip neigh show" || lower === "ip neighbour" || lower === "ip neighbour show") {
    terminalLine("", showHostArp(host));
    return;
  }

  const ipFlushMatch = command.match(/^ip\s+(?:addr|address)\s+flush\s+dev\s+eth0$/i);
  if (ipFlushMatch) {
    terminalLine("", flushHostIp(host));
    return;
  }

  const ipSetMatch = command.match(/^ip\s+(?:addr|address)\s+add\s+(\S+)\s+dev\s+eth0$/i) || command.match(/^ip\s+(?:addr|address)\s+(?:set|add)\s+(\S+)$/i) || command.match(/^set\s+ip\s+(\S+)$/i);
  if (ipSetMatch) {
    const result = setHostIp(host, ipSetMatch[1]);
    terminalLine(result.startsWith("Invalid") ? "error" : "", result);
    return;
  }

  const gatewayMatch = command.match(/^ip\s+route\s+(?:add|replace|change|set)\s+default\s+via\s+(\S+)(?:\s+dev\s+eth0)?$/i) || command.match(/^set\s+gateway\s+(\S+)$/i);
  if (gatewayMatch) {
    const result = setHostGateway(host, gatewayMatch[1]);
    terminalLine(result.startsWith("Invalid") ? "error" : "", result);
    return;
  }

  if (lower === "dhcp" || lower === "dhclient") {
    const result = buildDhcpEvents(host);
    if (typeof result === "string") {
      terminalLine("error", result);
    } else {
      startSimulation(result, host.id, "", "dhcp");
      dom.terminalInput.disabled = true;
    }
    return;
  }

  const pingMatch = command.match(/^ping(?:\s+-c\s+\d+)?\s+(.+)$/i);
  if (pingMatch) {
    const targetText = pingMatch[1].trim();
    const result = buildPingEvents(host, targetText);
    if (typeof result === "string") {
      // Validation error or instant result (self-ping)
      terminalLine(result.startsWith("ping:") ? "error" : "", result);
    } else {
      const targetIp = resolvePingTargetIp(targetText);
      startSimulation(result, host.id, targetIp);
      dom.terminalInput.disabled = true;
    }
    return;
  }

  terminalLine("error", `${command}: command not found`);
}

function resolvePingTargetIp(targetText: string): string {
  // If it's already an IP, return it
  if (isValidIpv4(targetText)) return targetText;
  // Otherwise find the target device by name
  const target = state.devices.find(d =>
    d.type === "computer" && d.name.toLowerCase() === targetText.toLowerCase()
  );
  return target?.config?.ipv4Address || targetText;
}

export function openTerminalFor(device: Device | undefined): void {
  if (!device || !["computer", "router", "switch"].includes(device.type)) {
    state.terminal.open = true;
    state.terminal.deviceId = null;
    state.terminal.mode = "exec";
    state.terminal.interfacePeerId = null;
    state.terminal.interfaceVlanTag = null;
    state.terminal.lines = [{ kind: "error", text: "Select a PC, router, or managed switch to open its terminal." }];
  } else if (device.poweredOff) {
    state.terminal.open = true;
    state.terminal.deviceId = null;
    state.terminal.mode = "exec";
    state.terminal.interfacePeerId = null;
    state.terminal.interfaceVlanTag = null;
    state.terminal.lines = [{ kind: "error", text: `${device.name} is powered off.` }];
  } else if (device.type === "switch" && !device.config?.managed) {
    state.terminal.open = true;
    state.terminal.deviceId = null;
    state.terminal.mode = "exec";
    state.terminal.interfacePeerId = null;
    state.terminal.interfaceVlanTag = null;
    state.terminal.lines = [{ kind: "error", text: "This switch is unmanaged. Enable managed mode to use a switch terminal." }];
  } else {
    state.selectedId = device.id;
    state.terminal.open = true;
    state.terminal.deviceId = device.id;
    state.terminal.mode = "exec";
    state.terminal.interfacePeerId = null;
    state.terminal.interfaceVlanTag = null;
    state.terminal.lines = [
      { kind: "muted", text: `Connected to ${device.name}. Type "${device.type === "computer" ? "help" : "?"}" for commands.` }
    ];
  }
  sync().syncPanel();
  syncTerminal();
  if (!dom.terminalInput.disabled) dom.terminalInput.focus();
}

export function closeTerminal(): void {
  state.terminal.open = false;
  syncTerminal();
}

export function syncTerminal(): void {
  const host = getDevice(state.terminal.deviceId);
  if (!host || !["computer", "router", "switch"].includes(host.type)) {
    state.terminal.deviceId = null;
    state.terminal.mode = "exec";
    state.terminal.interfacePeerId = null;
    state.terminal.interfaceVlanTag = null;
    if (state.terminal.open) {
      state.terminal.lines = [{ kind: "error", text: "Select a PC, router, or managed switch before opening the terminal." }];
    }
  }
  const activeHost = getDevice(state.terminal.deviceId);
  document.body.classList.toggle("terminal-closed", !state.terminal.open);
  dom.terminalOpenButton.setAttribute("aria-expanded", String(state.terminal.open));
  dom.terminalTitle.textContent = activeHost ? `${activeHost.name} terminal` : "Device terminal";
  dom.terminalPrompt.textContent = activeHost ? terminalPromptText(activeHost) : "device$";
  dom.terminalInput.disabled = !activeHost;
  dom.terminalInput.placeholder = activeHost ? (activeHost.type === "router" ? "?" : "help") : "Select a device";
  dom.terminalOutput.innerHTML = state.terminal.lines.map(line => (
    `<p class="terminal-line ${escapeHtml(line.kind || "")}">${escapeHtml(line.text)}</p>`
  )).join("");
  dom.terminalOutput.scrollTop = dom.terminalOutput.scrollHeight;
  requestAnimationFrame(() => sync().resizeCanvas());
}

export function submitTerminalCommand(event: Event): void {
  event.preventDefault();
  const command = dom.terminalInput.value;
  dom.terminalInput.value = "";
  if (command.trim()) {
    const h = state.terminal.history;
    if (h.length === 0 || h[h.length - 1] !== command) {
      h.push(command);
      if (h.length > 100) h.shift();
    }
  }
  state.terminal.historyIndex = -1;
  runTerminalCommand(command);
  syncTerminal();
}

export function handleTerminalKeydown(event: KeyboardEvent): void {
  const h = state.terminal.history;
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (h.length === 0) return;
    if (state.terminal.historyIndex === -1) {
      state.terminal.historyIndex = h.length - 1;
    } else if (state.terminal.historyIndex > 0) {
      state.terminal.historyIndex--;
    }
    dom.terminalInput.value = h[state.terminal.historyIndex];
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    if (state.terminal.historyIndex === -1) return;
    if (state.terminal.historyIndex < h.length - 1) {
      state.terminal.historyIndex++;
      dom.terminalInput.value = h[state.terminal.historyIndex];
    } else {
      state.terminal.historyIndex = -1;
      dom.terminalInput.value = "";
    }
  }
}
