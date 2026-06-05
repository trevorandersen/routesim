import type {
  PortMode, ArpEntry, DhcpLease, MacTableEntry, Vlan, RouterInterface,
  RipConfig, StaticRoute, DeviceConfig, DeviceType, Device, Link
} from "./types";
import { normaliseMacAddress, isValidMac, isValidIpv4, clampPortCount, clampRouterPortCount, normaliseVlanId } from "./utils";

export function normaliseArpTable(entries: unknown): ArpEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries.map(entry => ({
    ipv4Address: String(entry.ipv4Address || entry.ip || "").trim(),
    macAddress: normaliseMacAddress(entry.macAddress || entry.mac || "")
  })).filter(entry => entry.ipv4Address || entry.macAddress);
}

export function normaliseDhcpLeases(entries: unknown): DhcpLease[] {
  if (!Array.isArray(entries)) return [];
  return entries.map(entry => ({
    macAddress: normaliseMacAddress(entry.macAddress || entry.mac || ""),
    ipv4Address: String(entry.ipv4Address || entry.ip || "").trim()
  })).filter(entry => entry.macAddress && entry.ipv4Address);
}

export function normaliseMacTable(entries: unknown): MacTableEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries.map(entry => {
    const vlan = entry.vlan == null ? "" : String(entry.vlan).trim();
    const macAddress = normaliseMacAddress(entry.macAddress || entry.mac || "");
    const port = String(entry.port || "").trim();
    const hasEntryData = Boolean(vlan || macAddress || port || entry.type);
    const type = hasEntryData ? String(entry.type || "DYNAMIC").trim().toUpperCase() : "";
    return { vlan, macAddress, type, port };
  }).filter(entry => entry.vlan || entry.macAddress || entry.type || entry.port);
}

export function normaliseVlans(entries: unknown): Vlan[] {
  const source = Array.isArray(entries) ? entries : [];
  const seen = new Set<number>();
  const vlans: Vlan[] = [{ id: 1, name: "default" }];
  source.forEach(entry => {
    const id = normaliseVlanId(typeof entry === "object" ? entry.id : entry);
    if (!id || seen.has(id) || id === 1) return;
    seen.add(id);
    vlans.push({ id, name: String(entry.name || `Vlan${id}`).trim() });
  });
  return vlans.sort((a, b) => a.id - b.id);
}

export function normalisePortVlans(portVlans: unknown): Record<string, number> {
  if (!portVlans || typeof portVlans !== "object") return {};
  return Object.fromEntries(Object.entries(portVlans)
    .map(([port, vlan]) => [String(port).trim(), normaliseVlanId(vlan)])
    .filter(([port, vlan]) => port && vlan && vlan !== 1)) as Record<string, number>;
}

export function normalisePortModes(portModes: unknown): Record<string, PortMode> {
  if (!portModes || typeof portModes !== "object") return {};
  const valid = new Set<string>(["access", "trunk"]);
  return Object.fromEntries(
    Object.entries(portModes)
      .map(([port, mode]) => [String(port).trim(), valid.has(String(mode)) ? String(mode) as PortMode : "access" as PortMode])
      .filter(([port]) => port)
  ) as Record<string, PortMode>;
}

export function normaliseTrunkAllowedVlans(allowed: unknown): Record<string, number[]> {
  if (!allowed || typeof allowed !== "object") return {};
  return Object.fromEntries(
    Object.entries(allowed)
      .map(([port, vlans]) => [
        String(port).trim(),
        (Array.isArray(vlans) ? vlans : []).map(Number).filter(v => v >= 1 && v <= 4094)
      ])
      .filter(([port, vlans]) => port && (vlans as number[]).length)
  );
}

export function normaliseRouterInterfaces(entries: unknown, routerId?: string): RouterInterface[] {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry, index) => ({
    peerId: String(entry.peerId || entry.peer || entry.linkedDeviceId || "").trim(),
    type: entry.type === "serial" ? "serial" : "ethernet",
    name: String(entry.name || "").trim(),
    ipv4Address: String(entry.ipv4Address || entry.ip || "").trim(),
    macAddress: entry.macAddress || generateRouterIfaceMac(routerId || "", index),
    arpTable: normaliseArpTable(entry.arpTable || []),
    dhcpLeases: normaliseDhcpLeases(entry.dhcpLeases || []),
    vlanTag: entry.vlanTag != null ? (normaliseVlanId(entry.vlanTag) || null) : null
  })).filter(entry => entry.peerId || entry.name || entry.ipv4Address || entry.arpTable.length);
}

export function normaliseRipConfig(rip: any): RipConfig {
  if (!rip || typeof rip !== "object") return { enabled: false, networks: [], passiveInterfaces: [], learnedRoutes: [] };
  return {
    enabled: Boolean(rip.enabled),
    networks: Array.isArray(rip.networks) ? rip.networks.map((n: any) => String(n).trim()).filter(Boolean) : [],
    passiveInterfaces: Array.isArray(rip.passiveInterfaces) ? rip.passiveInterfaces.map((n: any) => String(n).trim()).filter(Boolean) : [],
    learnedRoutes: Array.isArray(rip.learnedRoutes) ? rip.learnedRoutes.map((r: any) => ({
      network: String(r.network || "").trim(),
      nextHop: String(r.nextHop || "").trim(),
      interface: r.interface ? String(r.interface).trim() : undefined,
      metric: Number(r.metric) || 2
    })).filter((r: any) => r.network && r.nextHop) : []
  };
}

export function normaliseStaticRoutes(routes: unknown): StaticRoute[] {
  if (!Array.isArray(routes)) return [];
  return routes
    .filter(r => r && r.network && r.nextHop)
    .map(r => ({
      network: String(r.network).trim(),
      nextHop: String(r.nextHop).trim(),
    }));
}

function generateRouterIfaceMac(routerId: string, ifaceIndex: number): string {
  // Deterministic MAC from router ID hash + interface index
  let hash = 0;
  for (let i = 0; i < routerId.length; i++) {
    hash = ((hash << 5) - hash + routerId.charCodeAt(i)) | 0;
  }
  const rr = ((hash >>> 0) % 256).toString(16).padStart(2, "0");
  const ii = ((ifaceIndex + 1) % 256).toString(16).padStart(2, "0");
  return `02:${rr}:00:00:${ii}:01`;
}

export function normaliseDeviceConfig(device: any): DeviceConfig {
  if (device.type === "switch") {
    const ethernetPorts = clampPortCount(device.config?.ethernetPorts ?? device.ethernetPorts ?? 8);
    const managed = Boolean(device.config?.managed ?? device.managed ?? false);
    return {
      managed,
      ethernetPorts,
      macTable: normaliseMacTable(device.config?.macTable || device.macTable || []),
      ...(managed ? {
        vlans: normaliseVlans(device.config?.vlans || device.vlans || []),
        portVlans: normalisePortVlans(device.config?.portVlans || device.portVlans || {}),
        portModes: normalisePortModes(device.config?.portModes || device.portModes || {}),
        trunkAllowedVlans: normaliseTrunkAllowedVlans(device.config?.trunkAllowedVlans || {}),
        trunkNativeVlans: normalisePortVlans(device.config?.trunkNativeVlans || {})
      } : {})
    };
  }
  if (device.type === "router") {
    const ethernetPorts = clampRouterPortCount(device.config?.ethernetPorts ?? device.ethernetPorts ?? 4);
    const serialPorts = clampRouterPortCount(device.config?.serialPorts ?? device.serialPorts ?? 4);
    const interfaces = normaliseRouterInterfaces(device.config?.interfaces || device.interfaces || [], device.id);
    const invalidInterface = interfaces.find(entry => entry.ipv4Address && !isValidIpv4(entry.ipv4Address));
    if (invalidInterface) {
      throw new Error(`${device.name || device.id || "Router"} has an invalid interface IPv4 address.`);
    }
    const ripConfig = normaliseRipConfig(device.config?.rip);
    return {
      ethernetPorts,
      serialPorts,
      interfaces,
      staticRoutes: normaliseStaticRoutes(device.config?.staticRoutes || []),
      ...(ripConfig.enabled ? { rip: ripConfig } : {})
    };
  }
  if (device.type === "lan") {
    return {
      anchorId: String(device.config?.anchorId || device.anchorId || ""),
      members: Array.isArray(device.config?.members || device.members)
        ? (device.config?.members || device.members).map((id: any) => String(id))
        : [],
      absorbedLans: Array.isArray(device.config?.absorbedLans || device.absorbedLans)
        ? (device.config?.absorbedLans || device.absorbedLans).map((id: any) => String(id))
        : []
    };
  }
  if (device.type !== "computer") return {};
  const ipv4Address = String(device.config?.ipv4Address || device.ipv4Address || "").trim();
  const gatewayIpv4Address = String(device.config?.gatewayIpv4Address || device.gatewayIpv4Address || device.gateway || "").trim();
  const macAddress = normaliseMacAddress(device.config?.macAddress || device.macAddress || "");
  if (ipv4Address && !isValidIpv4(ipv4Address)) {
    throw new Error(`${device.name || device.id || "Computer"} has an invalid IPv4 address.`);
  }
  if (gatewayIpv4Address && !isValidIpv4(gatewayIpv4Address)) {
    throw new Error(`${device.name || device.id || "Computer"} has an invalid default gateway.`);
  }
  if (macAddress && !isValidMac(macAddress)) {
    throw new Error(`${device.name || device.id || "Computer"} has an invalid MAC address.`);
  }
  return {
    ipv4Address,
    gatewayIpv4Address,
    macAddress,
    arpTable: normaliseArpTable(device.config?.arpTable || device.arpTable || [])
  };
}

export function normaliseConfig(parsed: any): { devices: Device[]; links: Link[] } {
  if (!parsed || !Array.isArray(parsed.devices) || !Array.isArray(parsed.links)) {
    throw new Error("Config needs devices and links arrays.");
  }

  const seenIds = new Set<string>();
  const devices = parsed.devices.map((device: any, index: number) => {
    if (!device || !["computer", "switch", "router", "lan"].includes(device.type)) {
      throw new Error(`Device ${index + 1} needs type computer, switch, router, or lan.`);
    }

    const id = String(device.id || `device-${index + 1}`);
    if (seenIds.has(id)) throw new Error(`Duplicate device id: ${id}`);
    seenIds.add(id);

    const x = Number(device.x);
    const y = Number(device.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Device ${device.name || id} needs numeric x and y.`);
    }

    return {
      id,
      type: device.type,
      name: String(device.name || defaultNameForType(device.type, index + 1)),
      x,
      y,
      width: deviceSize(device.type).width,
      height: deviceSize(device.type).height,
      hidden: Boolean(device.hidden),
      ...(device.poweredOff ? { poweredOff: true } : {}),
      ...(device.collapsedBy ? { collapsedBy: String(device.collapsedBy) } : {}),
      config: normaliseDeviceConfig(device)
    };
  });

  const links: Link[] = [];
  const seenLinks = new Set<string>();
  parsed.links.forEach((link: any, index: number) => {
    if (!link || !seenIds.has(String(link.from)) || !seenIds.has(String(link.to))) {
      throw new Error(`Link ${index + 1} references a missing device.`);
    }
    const from = String(link.from);
    const to = String(link.to);
    if (from === to) return;
    const key = [from, to].sort().join("::");
    if (seenLinks.has(key)) return;
    seenLinks.add(key);
    links.push({
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      from,
      to,
      ...(link.fromPort != null ? { fromPort: Number(link.fromPort) } : {}),
      ...(link.toPort != null ? { toPort: Number(link.toPort) } : {}),
      hidden: Boolean(link.hidden),
      ...(link.collapsedBy ? { collapsedBy: String(link.collapsedBy) } : {}),
      ...(link.proxy ? { proxy: true } : {})
    });
  });

  return { devices, links };
}

export function normaliseConfigStore(store: any): any {
  return {
    version: 1,
    configs: store && store.configs && typeof store.configs === "object" ? store.configs : {}
  };
}

export function normaliseConfigName(value: unknown): string {
  return String(value || "").trim().replace(/[<>:"/\\|?*]/g, "-");
}

export function defaultDeviceConfig(type: DeviceType): DeviceConfig {
  if (type === "computer") return { ipv4Address: "", gatewayIpv4Address: "", macAddress: "", arpTable: [] };
  if (type === "switch") return { managed: false, ethernetPorts: 8, macTable: [], vlans: [], portVlans: {}, portModes: {}, trunkAllowedVlans: {}, trunkNativeVlans: {} };
  if (type === "router") return { ethernetPorts: 4, serialPorts: 4, interfaces: [] };
  if (type === "lan") return { members: [] };
  return {};
}

export function deviceSize(type: string): { width: number; height: number } {
  if (type === "computer") return { width: 92, height: 68 };
  if (type === "router") return { width: 92, height: 70 };
  if (type === "lan") return { width: 112, height: 72 };
  return { width: 104, height: 58 };
}

export function defaultNameForType(type: string, fallbackNumber: number): string {
  if (type === "router") return `RTR-${fallbackNumber}`;
  return type === "computer" ? `PC-${fallbackNumber}` : `SW-${fallbackNumber}`;
}
