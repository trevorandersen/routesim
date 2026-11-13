import { state, pushUndo, sync, dropTerminalSessions, resetCaptureState, flushLearnedMacs } from "./state";
import { dom } from "./dom";
import type { SerialisedTopology, Device, Link } from "./types";

type NormalisedConfig = { devices: Device[]; links: Link[] };
import { clampPortCount, clampApPortCount, clampRouterPortCount, normaliseSsid, normaliseWifiPassword, bridgeMacOf } from "./utils";
import { DEFAULT_SSID } from "./device-registry";
import {
  normaliseArpTable, normaliseMacTable, normaliseVlans, normalisePortVlans,
  normalisePortModes, normaliseTrunkAllowedVlans, normaliseDnsRecords, normaliseDhcpLeases,
  normaliseRouterInterfaces, normaliseFirewallRules, normaliseConfig, normaliseStpConfig, normaliseIdsRules, normaliseMirror, normalisePortForwards
} from "./normalise";
import { connectedIds, clearNetwork, nextDeviceNumber, physicalPeerIds } from "./devices";
import { runStpConvergence } from "./stp";
import { DEVICE_TYPES, defaultPortCount } from "./device-registry";
import { render, fitNetwork } from "./canvas";
import { syncPanel } from "./inspector";
import { syncTerminal } from "./terminal";
import { stopSimulation } from "./engine";
import { setTool } from "./ui";
import { defaultConfig, vlanRoasConfig, routerMeshConfig, wifiVlanConfig } from "./state";

export function buildConfigPayload(): SerialisedTopology {
  return {
    version: 1,
    devices: state.devices.map(({ id, type, name, x, y, config, hidden, poweredOff, collapsedBy }: any) => withMacsec(type, config, {
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
      ...(type === "laptop" ? {
        config: { ...hostConfigForPayload(config), ...wifiConfigForPayload(config) }
      } : {}),
      ...(type === "access-point" ? {
        config: {
          managed: false,
          ethernetPorts: clampApPortCount(config?.ethernetPorts ?? defaultPortCount(type)),
          macTable: normaliseMacTable(config?.macTable || []),
          ...wifiConfigForPayload(config),
        }
      } : {}),
      ...(type === "server" ? {
        config: {
          ...hostConfigForPayload(config),
          dnsmasqRunning: config?.dnsmasqRunning !== false,
          dnsRecords: normaliseDnsRecords(config?.dnsRecords || []),
          ...(config?.dhcpRangeStart && config?.dhcpRangeEnd
            ? { dhcpRangeStart: config.dhcpRangeStart, dhcpRangeEnd: config.dhcpRangeEnd } : {}),
          ...(config?.dhcpRouterIp ? { dhcpRouterIp: config.dhcpRouterIp } : {}),
          dhcpLeases: normaliseDhcpLeases(config?.dhcpLeases || []),
          ...(config?.radius ? { radius: { users: (config.radius.users || []).map((u: any) => ({ identity: u.identity, password: u.password || "" })) } } : {}),
          ...(config?.httpEnabled ? { httpEnabled: true } : {}),
          ...(config?.httpTitle ? { httpTitle: config.httpTitle } : {}),
        }
      } : {}),
      ...(type === "switch" ? {
        config: {
          managed: Boolean(config?.managed),
          ethernetPorts: clampPortCount(config?.ethernetPorts ?? defaultPortCount(type)),
          // A managed switch's base MAC decides spanning-tree ties, so it is
          // written out (the one it presents — bridgeMacOf) and a reload or a
          // script replay elects the same root.
          ...(config?.managed ? { macAddress: bridgeMacOf({ id, config }) } : {}),
          macTable: normaliseMacTable(config?.macTable || []),
          ...(config?.managed ? {
            vlans: normaliseVlans(config?.vlans || []),
            portVlans: normalisePortVlans(config?.portVlans || {}),
            portModes: normalisePortModes(config?.portModes || {}),
            trunkAllowedVlans: normaliseTrunkAllowedVlans(config?.trunkAllowedVlans || {}),
            trunkNativeVlans: normalisePortVlans(config?.trunkNativeVlans || {})
          } : {}),
          ...(config?.portAuth && Object.keys(config.portAuth).length ? { portAuth: { ...config.portAuth } } : {}),
          // STP is on by default for managed switches — only persist a deviation
          // (disabled, or a non-default bridge priority). Derived roles never persist.
          ...(config?.managed && config?.stp && (config.stp.enabled === false || (typeof config.stp.priority === "number" && config.stp.priority !== 32768))
            ? { stp: normaliseStpConfig(config.stp) } : {}),
          ...((config?.managed && normaliseMirror(config?.mirror)) ? { mirror: normaliseMirror(config?.mirror) } : {})
        }
      } : {}),
      ...(type === "router" ? {
        config: {
          ethernetPorts: clampRouterPortCount(config?.ethernetPorts ?? defaultPortCount(type)),
          serialPorts: clampRouterPortCount(config?.serialPorts ?? 4),
          ...(config?.role === "border" || config?.role === "internal" ? { role: config.role } : {}),
          interfaces: routerInterfacesForPayload({ id, config }),
          ...(config?.staticRoutes?.length ? { staticRoutes: config.staticRoutes } : {}),
          // RIP: only the configuration round-trips — learnedRoutes are derived
          // state, cleared and recomputed at each convergence (like STP's ports).
          ...(config?.rip?.enabled ? { rip: { enabled: true, networks: config.rip.networks || [], passiveInterfaces: config.rip.passiveInterfaces || [] } } : {}),
          ...(config?.rules?.length ? { rules: normaliseFirewallRules(config.rules) } : {}),
          ...(config?.policy && Object.keys(config.policy).length ? { policy: config.policy } : {}),
          ...(config?.ruleLang === "nftables" ? { ruleLang: "nftables" } : {}),
          ...(config?.natTranslations?.length ? { natTranslations: ((config?.natTranslations || []).map(({ lastStep, ...e }: any) => e)) } : {}),
          ...((pf => pf.length ? { portForwards: pf } : {})(normalisePortForwards(config?.portForwards)))
        }
      } : {}),
      ...(type === "firewall" ? {
        config: {
          ethernetPorts: config?.ethernetPorts ?? defaultPortCount(type),
          rules: normaliseFirewallRules(config?.rules || []),
          policy: { forward: config?.policy?.forward === "drop" ? "drop" : "accept" },
          ...(config?.ruleLang === "nftables" ? { ruleLang: "nftables" } : {})
        }
      } : {}),
      ...(type === "ids" ? {
        // A passive Snort sensor — persist only its rule set (raw Snort lines);
        // the alert log is runtime, not config.
        config: { idsRules: normaliseIdsRules(config?.idsRules || []) }
      } : {}),
      ...(type === "attacker" ? {
        config: {
          ...hostConfigForPayload(config),
          ...(config?.attackTarget ? { attackTarget: config.attackTarget } : {}),
          ...(config?.spoofIp ? { spoofIp: config.spoofIp } : {}),
          attacks: Array.isArray(config?.attacks) ? config.attacks.filter((a: any) => ["scan", "sweep", "arp-spoof"].includes(a)) : ["scan"],
        }
      } : {}),
      ...(type === "kali" ? {
        // A Kali PC serialises exactly like a host — its attacks are issued by hand.
        config: hostConfigForPayload(config)
      } : {}),
      ...(type === "hub" ? {
        config: { ethernetPorts: clampPortCount(config?.ethernetPorts ?? defaultPortCount(type)) }
      } : {}),
      ...(type === "internet" ? {
        config: { ethernetPorts: clampPortCount(config?.ethernetPorts ?? defaultPortCount(type)) }
      } : {}),
      ...(type === "lan" ? {
        config: {
          anchorId: config?.anchorId || "",
          members: Array.isArray(config?.members) ? config.members : [],
          absorbedLans: Array.isArray(config?.absorbedLans) ? config.absorbedLans : []
        }
      } : {})
    })),
    links: state.links.map(({ from, to, name, wireless, shutdown, bandwidth, latency, loss, fromPort, toPort, hidden, collapsedBy, proxy }: any) => ({
      from,
      to,
      ...(name ? { name } : {}),
      ...(wireless ? { wireless: true } : {}),
      ...(shutdown ? { shutdown: true } : {}),
      ...(bandwidth > 0 ? { bandwidth } : {}),
      ...(latency > 0 ? { latency } : {}),
      ...(loss > 0 ? { loss } : {}),
      ...(fromPort != null ? { fromPort } : {}),
      ...(toPort != null ? { toPort } : {}),
      ...(hidden ? { hidden: true } : {}),
      ...(collapsedBy ? { collapsedBy } : {}),
      ...(proxy ? { proxy: true } : {})
    }))
  };
}

// WiFi association fields (laptop + access point) for the config payload: the
// SSID always serialises (default-filled), the password only when set.
function wifiConfigForPayload(config: any): any {
  const wifiPassword = normaliseWifiPassword(config?.wifiPassword);
  return {
    ssid: normaliseSsid(config?.ssid ?? DEFAULT_SSID),
    ...(wifiPassword ? { wifiPassword } : {})
  };
}

// MACsec keys belong to a cable's end, whatever the device: `macsec` and
// normaliseConfig accept every type, so the payload writes them for every type
// too — once, here, rather than in each type's branch. They used to be spread
// only for hosts, switches, routers and firewalls, so a key set on an access
// point, hub, IDS sensor or internet cloud vanished on save, and a must-secure
// link came back `failed` after a reload (review R30). A LAN node is a view,
// not a cable end.
function withMacsec<T extends { config?: any }>(type: string, config: any, entry: T): T {
  const keys = type === "lan" ? {} : macsecPayload(config);
  return keys.macsec ? { ...entry, config: { ...keys, ...(entry.config || {}) } } : entry;
}

// MACsec per-peer keys for the config payload (any device type).
function macsecPayload(config: any): any {
  const m = config?.macsec;
  if (!m || !Object.keys(m).length) return {};
  const out: any = {};
  for (const [peer, v] of Object.entries(m as Record<string, any>)) {
    const mode = v?.mode === "must" ? "must" : "should";
    if (v?.derive) out[peer] = { derive: true, mode };
    else if (v?.cak) out[peer] = { cak: v.cak, mode };
  }
  return Object.keys(out).length ? { macsec: out } : {};
}

// Shared host (computer/server) endpoint fields for the config payload.
function hostConfigForPayload(config: any): any {
  return {
    ipv4Address: config?.ipv4Address || "",
    ...(config?.prefixLength != null ? { prefixLength: config.prefixLength } : {}),
    ...(config?.ipSource ? { ipSource: config.ipSource } : {}),
    gatewayIpv4Address: config?.gatewayIpv4Address || "",
    macAddress: config?.macAddress || "",
    arpTable: normaliseArpTable(config?.arpTable || []),
    ...(Array.isArray(config?.openPorts) ? { openPorts: config.openPorts } : {}),
    ...(config?.dnsServerIp ? { dnsServerIp: config.dnsServerIp } : {}),
    ...(config?.dot1x?.identity ? { dot1x: { identity: config.dot1x.identity, password: config.dot1x.password || "" } } : {}),
    ...(config?.ipForward ? { ipForward: true } : {})
  };
}

export function routerInterfacesForPayload(device: any): any[] {
  // Structural connectivity, not visible connectivity: a collapsed LAN hides
  // its physical links, and filtering on the drawn set silently dropped the
  // router's whole interface (address, NAT role, tables) from the save.
  const connectedPeerIds = new Set(physicalPeerIds(device.id));
  return normaliseRouterInterfaces(device.config?.interfaces || [], device.id)
    .filter((entry: any) => !entry.peerId || connectedPeerIds.has(entry.peerId));
}

export function parseConfig(text: string): NormalisedConfig {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Config file must be valid JSON text.");
  }

  return normaliseConfig(parsed);
}

export function applyConfig(config: NormalisedConfig): void {
  pushUndo();
  applyConfigWithoutUndo(config);
}

export function applyConfigWithoutUndo(config: NormalisedConfig): void {
  // A replacement topology invalidates every queued frame and simulation
  // reference. Stop the animation loop before swapping its devices and links.
  stopSimulation();
  const sim = state.simulation;
  sim.headless = false;
  sim.originDeviceId = null;
  sim.pingTargetIp = null;
  sim.dnsName = null;
  sim.dnsResolvedIp = null;
  sim.resolveThen = null;
  state.devices = config.devices;
  state.links = config.links;
  state.selectedId = config.devices[0]?.id || null;
  state.selectedLinkId = null;
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
  // The old network's archived captures reference devices/links that no longer
  // exist — drop them and reset the packet-list capture view.
  resetCaptureState();
  // Replacing the network drops any active scenario; loadScenario re-sets it after.
  state.activeScenarioId = null;
  setTool("select");
  fitNetwork();
  // A loaded file's MAC tables were learnt over whatever cabling it was saved
  // with — never trust them (the linksChanged invalidation, all bridges). Then
  // converge the spanning tree so a loaded topology shows its blocked ports /
  // root bridge immediately (without waiting for the first simulation).
  flushLearnedMacs();
  runStpConvergence();
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
    } else if (name === "wifi-vlan") {
      applyConfig(normaliseConfig(wifiVlanConfig));
      dom.modeLabel.textContent = "Loaded WiFi Staff/Guest VLAN topology.";
    } else {
      applyConfig(normaliseConfig(defaultConfig));
      dom.modeLabel.textContent = "Loaded Basic Network topology.";
    }
    // Topologies default to instant name resolution (a convenience hosts file);
    // scenarios flip it off for realistic DNS. Set AFTER applyConfig has taken
    // its undo snapshot, so undoing the load brings the previous mode back with
    // the previous network (the snapshot records it).
    state.options.instantDns = true;
    sync().syncOptionControls();
  } catch (error: any) {
    dom.modeLabel.textContent = error.message;
  }
}

export function loadDefaultConfig(): void {
  applyConfigWithoutUndo(normaliseConfig(defaultConfig));
  dom.modeLabel.textContent = "Loaded the Basic Network topology.";
}
