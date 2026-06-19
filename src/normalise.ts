import type {
  PortMode, ArpEntry, DhcpLease, MacTableEntry, Vlan, RouterInterface,
  RipConfig, StaticRoute, DeviceConfig, DeviceType, Device, Link, FirewallRule, DnsRecord
} from "./types";
import { normaliseMacAddress, isValidMac, isValidIpv4, clampPortCount, clampRouterPortCount, clampPrefixLength, normaliseVlanId } from "./utils";
import { DEVICE_SPECS } from "./device-registry";

// Each element is coerced to an object before use: imported JSON may carry a
// null / primitive in a table array, and dereferencing it raw threw a TypeError
// that aborted the whole import (and poisoned the scenario registry).
function asObject(raw: unknown): any {
  return raw && typeof raw === "object" ? raw : {};
}

export function normaliseArpTable(entries: unknown): ArpEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries.map(raw => {
    const entry = asObject(raw);
    return {
      ipv4Address: String(entry.ipv4Address || entry.ip || "").trim(),
      macAddress: normaliseMacAddress(entry.macAddress || entry.mac || "")
    };
  }).filter(entry => entry.ipv4Address || entry.macAddress);
}

export function normaliseDhcpLeases(entries: unknown): DhcpLease[] {
  if (!Array.isArray(entries)) return [];
  return entries.map(raw => {
    const entry = asObject(raw);
    return {
      macAddress: normaliseMacAddress(entry.macAddress || entry.mac || ""),
      ipv4Address: String(entry.ipv4Address || entry.ip || "").trim()
    };
  }).filter(entry => entry.macAddress && entry.ipv4Address);
}

export function normaliseMacTable(entries: unknown): MacTableEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries.map(raw => {
    const entry = asObject(raw);
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
    const id = normaliseVlanId(entry && typeof entry === "object" ? entry.id : entry);
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
  return entries.map((raw, index) => {
    const entry = asObject(raw);
    return {
      peerId: String(entry.peerId || entry.peer || entry.linkedDeviceId || "").trim(),
      type: (entry.type === "serial" ? "serial" : "ethernet") as "serial" | "ethernet",
      name: String(entry.name || "").trim(),
      ipv4Address: String(entry.ipv4Address || entry.ip || "").trim(),
      ...(entry.prefixLength != null ? { prefixLength: clampPrefixLength(entry.prefixLength) } : {}),
      ...(entry.natRole === "inside" || entry.natRole === "outside" ? { natRole: entry.natRole } : {}),
      macAddress: entry.macAddress || generateRouterIfaceMac(routerId || "", index),
      arpTable: normaliseArpTable(entry.arpTable || []),
      dhcpLeases: normaliseDhcpLeases(entry.dhcpLeases || []),
      vlanTag: entry.vlanTag != null ? (normaliseVlanId(entry.vlanTag) || null) : null
    };
  }).filter(entry => entry.peerId || entry.name || entry.ipv4Address || entry.arpTable.length);
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

const FIREWALL_TARGETS = new Set(["accept", "drop", "reject"]);
const FIREWALL_PROTOCOLS = new Set(["icmp", "udp", "tcp", "all"]);

export function normaliseFirewallRules(raw: any): FirewallRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r: any) => {
    const target = String(r?.target || "").toLowerCase();
    if (!FIREWALL_TARGETS.has(target)) return null;
    const rule: FirewallRule = { chain: String(r?.chain || "forward").toLowerCase(), target: target as any };
    const proto = String(r?.protocol || "").toLowerCase();
    if (FIREWALL_PROTOCOLS.has(proto) && proto !== "all") rule.protocol = proto as any;
    if (r?.src) rule.src = String(r.src);
    if (r?.dst) rule.dst = String(r.dst);
    if (r?.icmpType) rule.icmpType = String(r.icmpType).toLowerCase();
    if (r?.dport != null && Number.isFinite(Number(r.dport))) rule.dport = Number(r.dport);
    return rule;
  }).filter(Boolean) as FirewallRule[];
}

// dnsmasq A-records (`address=/name/ip`): drop entries with no name or a bad IP.
export function normaliseDnsRecords(raw: unknown): DnsRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r: any) => ({
    name: String(r?.name || "").trim().toLowerCase(),
    ip: String(r?.ip || r?.address || "").trim(),
  })).filter(r => r.name && isValidIpv4(r.ip));
}

// Shared host endpoint fields (computers and servers): IP/prefix/gateway/MAC,
// ARP cache, the TCP listener list, and the resolver address.
function normaliseHostFields(device: any): DeviceConfig {
  const ipv4Address = String(device.config?.ipv4Address || device.ipv4Address || "").trim();
  const gatewayIpv4Address = String(device.config?.gatewayIpv4Address || device.gatewayIpv4Address || device.gateway || "").trim();
  const macAddress = normaliseMacAddress(device.config?.macAddress || device.macAddress || "");
  const dnsServerIp = String(device.config?.dnsServerIp || "").trim();
  const label = device.name || device.id || (device.type === "server" ? "Server" : "Computer");
  if (ipv4Address && !isValidIpv4(ipv4Address)) {
    throw new Error(`${label} has an invalid IPv4 address.`);
  }
  if (gatewayIpv4Address && !isValidIpv4(gatewayIpv4Address)) {
    throw new Error(`${label} has an invalid default gateway.`);
  }
  if (macAddress && !isValidMac(macAddress)) {
    throw new Error(`${label} has an invalid MAC address.`);
  }
  const openPorts = Array.isArray(device.config?.openPorts)
    ? device.config.openPorts.map(Number).filter((p: number) => Number.isInteger(p) && p >= 1 && p <= 65535)
    : null;
  // A bare configured IP with no recorded source is static (built-in topologies,
  // hand-authored JSON); dhcp/apipa only appear when explicitly set.
  const rawSource = device.config?.ipSource;
  const ipSource = ipv4Address
    ? (rawSource === "dhcp" || rawSource === "apipa" ? rawSource : "static")
    : undefined;
  return {
    ipv4Address,
    ...(device.config?.prefixLength != null ? { prefixLength: clampPrefixLength(device.config.prefixLength) } : {}),
    ...(ipSource ? { ipSource } : {}),
    gatewayIpv4Address,
    macAddress,
    arpTable: normaliseArpTable(device.config?.arpTable || device.arpTable || []),
    ...(openPorts ? { openPorts } : {}),
    ...(isValidIpv4(dnsServerIp) ? { dnsServerIp } : {}),
  };
}

export function normaliseDeviceConfig(device: any): DeviceConfig {
  if (device.type === "hub") {
    // A hub is a dumb layer-1 repeater — just a port count, no tables.
    return { ethernetPorts: clampPortCount(device.config?.ethernetPorts ?? device.ethernetPorts ?? 4) };
  }
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
    const rules = normaliseFirewallRules(device.config?.rules || []);
    const rawPolicy = device.config?.policy || {};
    const policy: Record<string, "accept" | "drop"> = {};
    for (const chain of ["input", "forward"]) {
      if (rawPolicy[chain] === "drop") policy[chain] = "drop";
    }
    return {
      ethernetPorts,
      serialPorts,
      interfaces,
      staticRoutes: normaliseStaticRoutes(device.config?.staticRoutes || []),
      ...(ripConfig.enabled ? { rip: ripConfig } : {}),
      ...(rules.length ? { rules } : {}),
      ...(Object.keys(policy).length ? { policy } : {}),
      ...(Array.isArray(device.config?.natTranslations) && device.config.natTranslations.length
        ? { natTranslations: device.config.natTranslations } : {})
    };
  }
  if (device.type === "firewall") {
    const ethernetPorts = clampPortCount(device.config?.ethernetPorts ?? device.ethernetPorts ?? 2);
    const rawPolicy = device.config?.policy || {};
    return {
      ethernetPorts,
      rules: normaliseFirewallRules(device.config?.rules || device.rules || []),
      policy: { forward: rawPolicy.forward === "drop" ? "drop" : "accept" }
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
  if (device.type === "server") {
    const dhcpRangeStart = String(device.config?.dhcpRangeStart || "").trim();
    const dhcpRangeEnd = String(device.config?.dhcpRangeEnd || "").trim();
    const dhcpRouterIp = String(device.config?.dhcpRouterIp || "").trim();
    const rangeValid = isValidIpv4(dhcpRangeStart) && isValidIpv4(dhcpRangeEnd);
    return {
      ...normaliseHostFields(device),
      dnsmasqRunning: device.config?.dnsmasqRunning !== false,
      dnsRecords: normaliseDnsRecords(device.config?.dnsRecords),
      ...(rangeValid ? { dhcpRangeStart, dhcpRangeEnd } : {}),
      ...(isValidIpv4(dhcpRouterIp) ? { dhcpRouterIp } : {}),
      dhcpLeases: normaliseDhcpLeases(device.config?.dhcpLeases || []),
    };
  }
  if (device.type !== "computer") return {};
  return normaliseHostFields(device);
}

export function normaliseConfig(parsed: any): { devices: Device[]; links: Link[] } {
  if (!parsed || !Array.isArray(parsed.devices) || !Array.isArray(parsed.links)) {
    throw new Error("Config needs devices and links arrays.");
  }

  const seenIds = new Set<string>();
  const devices = parsed.devices.map((device: any, index: number) => {
    if (!device || !["computer", "server", "switch", "router", "firewall", "lan"].includes(device.type)) {
      throw new Error(`Device ${index + 1} needs type computer, server, switch, router, firewall, or lan.`);
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
      ...(link.name ? { name: String(link.name).trim() } : {}),
      ...(link.shutdown ? { shutdown: true } : {}),
      ...(Number(link.bandwidth) > 0 ? { bandwidth: Number(link.bandwidth) } : {}),
      ...(Number(link.latency) > 0 ? { latency: Number(link.latency) } : {}),
      ...(Number(link.loss) > 0 ? { loss: Math.min(100, Number(link.loss)) } : {}),
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

// Ensures a device has a config object, creating the type-appropriate default
// if absent. Replaces the repeated `device.config = device.config || ...` guard.
export function ensureConfig(device: Device): DeviceConfig {
  if (!device.config) device.config = defaultDeviceConfig(device.type);
  return device.config;
}

export function defaultDeviceConfig(type: DeviceType): DeviceConfig {
  return DEVICE_SPECS[type]?.defaultConfig() ?? {};
}

// Translates a topology in place so every device sits at a positive coordinate
// (top-left anchored at `margin`), preserving the relative layout. Returns the
// same config object. Keeps the built-in topologies/scenarios positive.
export function shiftToPositive(config: any, margin = 80): any {
  const devices = config?.devices || [];
  if (!devices.length) return config;
  const dx = margin - Math.min(...devices.map((d: any) => d.x));
  const dy = margin - Math.min(...devices.map((d: any) => d.y));
  for (const d of devices) { d.x += dx; d.y += dy; }
  return config;
}

export function deviceSize(type: string): { width: number; height: number } {
  const spec = DEVICE_SPECS[type as DeviceType];
  return spec ? { width: spec.width, height: spec.height } : { width: 104, height: 58 };
}

export function defaultNameForType(type: string, fallbackNumber: number): string {
  const spec = DEVICE_SPECS[type as DeviceType];
  return `${spec?.namePrefix ?? "DEV"}-${fallbackNumber}`;
}
