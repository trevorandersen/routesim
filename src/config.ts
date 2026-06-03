import { state, pushUndo } from "./state";
import { dom } from "./dom";
import { READONLY } from "./env";
import { clampPortCount, clampRouterPortCount } from "./utils";
import {
  normaliseArpTable, normaliseMacTable, normaliseVlans, normalisePortVlans,
  normalisePortModes, normaliseTrunkAllowedVlans,
  normaliseRouterInterfaces, normaliseConfig, normaliseConfigStore, normaliseConfigName
} from "./normalise";
import { connectedIds, clearNetwork, nextDeviceNumber } from "./devices";
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
        config: {
          ipv4Address: config?.ipv4Address || "",
          gatewayIpv4Address: config?.gatewayIpv4Address || "",
          macAddress: config?.macAddress || "",
          arpTable: normaliseArpTable(config?.arpTable || [])
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
    links: state.links.map(({ from, to, fromPort, toPort, hidden, collapsedBy, proxy }: any) => ({
      from,
      to,
      ...(fromPort != null ? { fromPort } : {}),
      ...(toPort != null ? { toPort } : {}),
      ...(hidden ? { hidden: true } : {}),
      ...(collapsedBy ? { collapsedBy } : {}),
      ...(proxy ? { proxy: true } : {})
    }))
  };
}

export function routerInterfacesForPayload(device: any): any[] {
  const connectedPeerIds = new Set(connectedIds(device.id));
  return normaliseRouterInterfaces(device.config?.interfaces || [])
    .filter((entry: any) => !entry.peerId || connectedPeerIds.has(entry.peerId));
}

export async function saveConfig(): Promise<void> {
  if (READONLY) {
    dom.hint.textContent = "Read-only build — saving to config.json is disabled.";
    return;
  }

  const name = normaliseConfigName(prompt("Save config name", suggestedConfigName()));
  if (!name) return;

  await refreshConfigStore();
  state.configStore.configs[name] = buildConfigPayload();
  const payload = JSON.stringify(normaliseConfigStore(state.configStore), null, 2);

  try {
    await persistConfigStore(payload);
    dom.hint.textContent = `Saved "${name}" to config.json.`;
  } catch (error: any) {
    if (error.name !== "AbortError") {
      downloadConfigStore(payload);
      dom.hint.textContent = `Saved "${name}". Downloaded config.json because direct file write was unavailable.`;
    }
  }
  syncPanel();
}

export async function loadConfig(): Promise<void> {
  await refreshConfigStore(true);
  const names = Object.keys(state.configStore.configs).sort((a, b) => a.localeCompare(b));
  if (!names.length) {
    dom.hint.textContent = "No configs found in config.json yet.";
    return;
  }

  const name = normaliseConfigName(prompt(`Load config:\n${names.join("\n")}`, names[0]));
  if (!name) return;

  const saved = state.configStore.configs[name];
  if (!saved) {
    dom.hint.textContent = `No config named "${name}" in config.json.`;
    return;
  }

  try {
    applyConfig(normaliseConfig(saved));
    dom.hint.textContent = `Loaded "${name}" from config.json.`;
  } catch (error: any) {
    dom.hint.textContent = error.message;
  }
}

export function suggestedConfigName(): string {
  const base = "network";
  if (!state.configStore.configs[base]) return base;
  let index = 2;
  while (state.configStore.configs[`${base}-${index}`]) index++;
  return `${base}-${index}`;
}

export async function refreshConfigStore(pickIfNeeded = false): Promise<void> {
  if (state.configFileHandle) {
    await readConfigStoreFromHandle();
    return;
  }

  try {
    const response = await fetch("./config.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Missing config.json");
    state.configStore = normaliseConfigStore(await response.json());
  } catch {
    if (pickIfNeeded && "showOpenFilePicker" in window) {
      const [fileHandle] = await (window as any).showOpenFilePicker({
        types: [{
          description: "RouteSim config store",
          accept: { "application/json": [".json"] }
        }]
      });
      state.configFileHandle = fileHandle;
      await readConfigStoreFromHandle();
      return;
    }
    state.configStore = normaliseConfigStore(state.configStore);
  }
}

export async function persistConfigStore(payload: string): Promise<void> {
  if ("showSaveFilePicker" in window) {
    if (!state.configFileHandle) {
      state.configFileHandle = await (window as any).showSaveFilePicker({
        suggestedName: "config.json",
        types: [{
          description: "RouteSim config store",
          accept: { "application/json": [".json"] }
        }]
      });
    }
    const writable = await state.configFileHandle.createWritable();
    await writable.write(payload);
    await writable.close();
    return;
  }

  downloadConfigStore(payload);
}

export async function readConfigStoreFromHandle(): Promise<void> {
  const file = await state.configFileHandle.getFile();
  state.configStore = normaliseConfigStore(JSON.parse(await file.text()));
}

export function downloadConfigStore(payload: string): void {
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "config.json";
  anchor.click();
  URL.revokeObjectURL(url);
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
  state.terminal.open = false;
  state.terminal.deviceId = null;
  state.terminal.mode = "exec";
  state.terminal.interfacePeerId = null;
  state.terminal.interfaceVlanTag = null;
  state.terminal.lines = [];
  state.linkStartId = null;
  state.drag = null;
  state.panDrag = null;
  state.pointer = null;
  state.nextComputer = nextDeviceNumber("computer");
  state.nextSwitch = nextDeviceNumber("switch");
  state.nextRouter = nextDeviceNumber("router");
  setTool("select");
  fitNetwork();
  syncPanel();
  syncTerminal();
  render();
}

export function loadTopology(name: string): void {
  try {
    if (name === "vlan-roas") {
      applyConfig(normaliseConfig(vlanRoasConfig));
      dom.hint.textContent = "Loaded VLAN Router-on-a-Stick topology.";
    } else if (name === "router-mesh") {
      applyConfig(normaliseConfig(routerMeshConfig));
      dom.hint.textContent = "Loaded 5-Router Partial Mesh topology.";
    } else {
      applyConfig(normaliseConfig(defaultConfig));
      dom.hint.textContent = "Loaded Basic Network topology.";
    }
  } catch (error: any) {
    dom.hint.textContent = error.message;
  }
}

export async function loadDefaultConfig(): Promise<void> {
  await refreshConfigStore();
  if (!state.configStore.configs.default) {
    state.configStore.configs.default = defaultConfig;
  }
  if (state.devices.length || state.links.length) {
    applyConfig(normaliseConfig(state.configStore.configs.default));
  } else {
    applyConfigWithoutUndo(normaliseConfig(state.configStore.configs.default));
  }
  dom.hint.textContent = "Loaded default topology from config.json.";
}
