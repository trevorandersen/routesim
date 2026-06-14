import { state, pushUndo, sync, dropTerminalSessions } from "./state";
import { dom } from "./dom";
import { clampPortCount, clampRouterPortCount } from "./utils";
import {
  normaliseArpTable, normaliseMacTable, normaliseVlans, normalisePortVlans,
  normalisePortModes, normaliseTrunkAllowedVlans, normaliseDnsRecords, normaliseDhcpLeases,
  normaliseRouterInterfaces, normaliseFirewallRules, normaliseConfig
} from "./normalise";
import { connectedIds, clearNetwork, nextDeviceNumber } from "./devices";
import { DEVICE_TYPES } from "./device-registry";
import { render, fitNetwork } from "./canvas";
import { syncPanel } from "./inspector";
import { syncTerminal } from "./terminal";
import { setTool } from "./ui";
import { defaultConfig, vlanRoasConfig, routerMeshConfig } from "./state";

export function buildConfigPayload(): any {
  return {
    version: 1,
    devices: state.devices.map(({ id, type, name, x, y, config, hidden, poweredOff, collapsedBy }: any) => ({
      id,
      type,
      name,
      x: Math.round(x),
      y: Math.round(y),
      ...(hidden ? { hidden: true } : {}),
      ...(poweredOff ? { poweredOff: true } : {}),
      ...(collapsedBy ? { collapsedBy } : {}),
      ...(type === "computer" ? {
        config: hostConfigForPayload(config)
      } : {}),
      ...(type === "server" ? {
        config: {
          ...hostConfigForPayload(config),
          dnsmasqRunning: config?.dnsmasqRunning !== false,
          dnsRecords: normaliseDnsRecords(config?.dnsRecords || []),
          ...(config?.dhcpRangeStart && config?.dhcpRangeEnd
            ? { dhcpRangeStart: config.dhcpRangeStart, dhcpRangeEnd: config.dhcpRangeEnd } : {}),
          ...(config?.dhcpRouterIp ? { dhcpRouterIp: config.dhcpRouterIp } : {}),
          dhcpLeases: normaliseDhcpLeases(config?.dhcpLeases || [])
        }
      } : {}),
      ...(type === "switch" ? {
        config: {
          managed: Boolean(config?.managed),
          ethernetPorts: clampPortCount(config?.ethernetPorts ?? 8),
          macTable: normaliseMacTable(config?.macTable || []),
          ...(config?.managed ? {
            vlans: normaliseVlans(config?.vlans || []),
            portVlans: normalisePortVlans(config?.portVlans || {}),
            portModes: normalisePortModes(config?.portModes || {}),
            trunkAllowedVlans: normaliseTrunkAllowedVlans(config?.trunkAllowedVlans || {}),
            trunkNativeVlans: normalisePortVlans(config?.trunkNativeVlans || {})
          } : {})
        }
      } : {}),
      ...(type === "router" ? {
        config: {
          ethernetPorts: clampRouterPortCount(config?.ethernetPorts ?? 4),
          serialPorts: clampRouterPortCount(config?.serialPorts ?? 4),
          interfaces: routerInterfacesForPayload({ id, config }),
          ...(config?.staticRoutes?.length ? { staticRoutes: config.staticRoutes } : {}),
          ...(config?.rip?.enabled ? { rip: config.rip } : {}),
          ...(config?.rules?.length ? { rules: normaliseFirewallRules(config.rules) } : {}),
          ...(config?.policy && Object.keys(config.policy).length ? { policy: config.policy } : {}),
          ...(config?.natTranslations?.length ? { natTranslations: config.natTranslations } : {}),
        }
      } : {}),
      ...(type === "firewall" ? {
        config: {
          ethernetPorts: config?.ethernetPorts ?? 2,
          rules: normaliseFirewallRules(config?.rules || []),
          policy: { forward: config?.policy?.forward === "drop" ? "drop" : "accept" }
        }
      } : {}),
      ...(type === "lan" ? {
        config: {
          anchorId: config?.anchorId || "",
          members: Array.isArray(config?.members) ? config.members : [],
          absorbedLans: Array.isArray(config?.absorbedLans) ? config.absorbedLans : []
        }
      } : {})
    })),
    links: state.links.map(({ from, to, name, fromPort, toPort, hidden, collapsedBy, proxy }: any) => ({
      from,
      to,
      ...(name ? { name } : {}),
      ...(fromPort != null ? { fromPort } : {}),
      ...(toPort != null ? { toPort } : {}),
      ...(hidden ? { hidden: true } : {}),
      ...(collapsedBy ? { collapsedBy } : {}),
      ...(proxy ? { proxy: true } : {})
    }))
  };
}

// Shared host (computer/server) endpoint fields for the config payload.
function hostConfigForPayload(config: any): any {
  return {
    ipv4Address: config?.ipv4Address || "",
    ...(config?.prefixLength != null ? { prefixLength: config.prefixLength } : {}),
    gatewayIpv4Address: config?.gatewayIpv4Address || "",
    macAddress: config?.macAddress || "",
    arpTable: normaliseArpTable(config?.arpTable || []),
    ...(Array.isArray(config?.openPorts) ? { openPorts: config.openPorts } : {}),
    ...(config?.dnsServerIp ? { dnsServerIp: config.dnsServerIp } : {})
  };
}

export function routerInterfacesForPayload(device: any): any[] {
  const connectedPeerIds = new Set(connectedIds(device.id));
  return normaliseRouterInterfaces(device.config?.interfaces || [])
    .filter((entry: any) => !entry.peerId || connectedPeerIds.has(entry.peerId));
}

export function parseConfig(text: string): any {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Config file must be valid JSON text.");
  }

  return normaliseConfig(parsed);
}

export function applyConfig(config: any): void {
  pushUndo();
  applyConfigWithoutUndo(config);
}

export function applyConfigWithoutUndo(config: any): void {
  state.devices = config.devices;
  state.links = config.links;
  state.selectedId = config.devices[0]?.id || null;
  state.configuringId = null;
  // The old network's terminal sessions reference devices that no longer
  // exist — drop them all (closes the dock if it was showing a terminal).
  dropTerminalSessions();
  state.linkStartId = null;
  state.drag = null;
  state.panDrag = null;
  state.pointer = null;
  // Recompute auto-name counters from the loaded devices for every type — a
  // loaded FW-2 must make the next firewall FW-3, not a duplicate FW-1.
  for (const type of DEVICE_TYPES) state.nameCounters[type] = nextDeviceNumber(type);
  // Replacing the network drops any active scenario; loadScenario re-sets it after.
  state.activeScenarioId = null;
  setTool("select");
  fitNetwork();
  syncPanel();
  syncTerminal();
  sync().syncScenarioPanel();
  render();
}

export function loadTopology(name: string): void {
  try {
    if (name === "vlan-roas") {
      applyConfig(normaliseConfig(vlanRoasConfig));
      dom.modeLabel.textContent = "Loaded VLAN Router-on-a-Stick topology.";
    } else if (name === "router-mesh") {
      applyConfig(normaliseConfig(routerMeshConfig));
      dom.modeLabel.textContent = "Loaded 5-Router Partial Mesh topology.";
    } else {
      applyConfig(normaliseConfig(defaultConfig));
      dom.modeLabel.textContent = "Loaded Basic Network topology.";
    }
  } catch (error: any) {
    dom.modeLabel.textContent = error.message;
  }
}

export function loadDefaultConfig(): void {
  applyConfigWithoutUndo(normaliseConfig(defaultConfig));
  dom.modeLabel.textContent = "Loaded the Basic Network topology.";
}
