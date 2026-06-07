import type { AppState } from "./types";
import { shiftToPositive } from "./normalise";

export type SyncCallbacks = {
  render: () => void;
  syncPanel: () => void;
  syncTerminal: () => void;
  resizeCanvas: () => void;
  syncScenarioPanel: () => void;
  syncCoordReadout: () => void;
};

let _cb: SyncCallbacks;

export function registerCallbacks(cb: SyncCallbacks) {
  _cb = cb;
}

export function sync(): SyncCallbacks {
  return _cb;
}

export const state: AppState = {
  tool: "select",
  devices: [],
  links: [],
  selectedId: null,
  selectedLinkId: null,
  configuringId: null,
  linkStartId: null,
  pointer: null,
  drag: null,
  panDrag: null,
  pan: { x: 0, y: 0 },
  scale: 1,
  theme: "dark",
  inspectorWidth: 320,
  inspectorResize: null,
  terminal: {
    open: false,
    deviceId: null,
    mode: "exec",
    interfacePeerId: null,
    interfaceVlanTag: null,
    lines: [],
    history: [],
    historyIndex: -1
  },
  console: {
    open: false,
    lines: [],
    history: [],
    historyIndex: -1
  },
  activeScenarioId: null,
  options: {
    showDeviceNames: true,
    showIpAddresses: true,
    showMacAddresses: true,
    displayOptionsOpen: false,
    networkPanelOpen: false
  },
  nextComputer: 1,
  nextSwitch: 1,
  nextRouter: 1,
  configStore: { version: 1, configs: {} },
  undoStack: [],
  isApplyingCompositeChange: false,
  simulation: {
    status: "idle",
    mode: "ping",
    events: [],
    log: [],
    transits: [],
    pendingArp: {},
    speed: 1000,
    autoPlay: true,
    stepIndex: 0,
    originDeviceId: null,
    pingTargetIp: null,
    pingSuccess: false,
    pingTtl: 64,
    dhcpSuccess: false,
    dhcpAssignedIp: null,
    dhcpAssignedGateway: null
  },
  portSelection: null
};

export const toolCopy: Record<string, [string, string]> = {
  select: ["Select and move devices", "Drag devices to arrange the network."],
  computer: ["Add computer", "Click the canvas to place a computer."],
  switch: ["Add switch", "Click the canvas to place a switch."],
  connect: ["Connect devices", "Click one device, then another device to connect them."],
  router: ["Add router", "Click the canvas to place a router."],
  configure: ["Configure device", "Click a device to edit its static configuration."]
};

export const colors = {
  selected: "#f0b429"
};

export const deviceIcons: Record<string, string[]> = {
  // MIT-licensed Tabler icon path data, adapted for canvas rendering.
  computer: [
    "M3 5a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-10",
    "M7 20h10",
    "M9 16v4",
    "M15 16v4"
  ],
  switch: [
    "M16 3l4 4l-4 4",
    "M10 7l10 0",
    "M8 13l-4 4l4 4",
    "M4 17l9 0"
  ],
  router: [
    "M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0",
    "M6 12h5",
    "M8 10l3 2l-3 2",
    "M18 12h-5",
    "M16 10l-3 2l3 2",
    "M12 10v-5",
    "M10 7l2 -2l2 2",
    "M12 14v5",
    "M10 17l2 2l2 -2"
  ],
  lan: [
    "M7 18a4.6 4.4 0 0 1 -1.2 -8.9a5.8 5.6 0 0 1 10.8 -1.9a4.7 4.5 0 0 1 1.4 8.8",
    "M8 18h9",
    "M10 15h4",
    "M12 13v5",
    "M8 20h8"
  ]
};

export const defaultConfig = {
  version: 1,
  devices: [
    { id: "pc-a1", type: "computer", name: "PC-A1", x: -560, y: -250, config: { ipv4Address: "192.168.10.11", gatewayIpv4Address: "192.168.10.1", macAddress: "02:00:00:00:10:11" } },
    { id: "pc-a2", type: "computer", name: "PC-A2", x: -560, y: -130, config: { ipv4Address: "192.168.10.12", gatewayIpv4Address: "192.168.10.1", macAddress: "02:00:00:00:10:12" } },
    { id: "sw-a", type: "switch", name: "Access-SW-A", x: -360, y: -190, config: { managed: false, ethernetPorts: 8 } },
    { id: "pc-b1", type: "computer", name: "PC-B1", x: -560, y: 90, config: { ipv4Address: "192.168.10.21", gatewayIpv4Address: "192.168.10.1", macAddress: "02:00:00:00:10:21" } },
    { id: "pc-b2", type: "computer", name: "PC-B2", x: -560, y: 210, config: { ipv4Address: "192.168.10.22", gatewayIpv4Address: "192.168.10.1", macAddress: "02:00:00:00:10:22" } },
    { id: "sw-b", type: "switch", name: "Access-SW-B", x: -360, y: 150, config: { managed: false, ethernetPorts: 8 } },
    { id: "sw-core", type: "switch", name: "Core-SW", x: -80, y: -20, config: { managed: false, ethernetPorts: 8 } },
    { id: "router", type: "router", name: "Router", x: 210, y: -20, config: { interfaces: [
      { peerId: "sw-core", type: "ethernet", ipv4Address: "192.168.10.1" },
      { peerId: "sw-c", type: "ethernet", ipv4Address: "192.168.30.1" }
    ] } },
    { id: "pc-c1", type: "computer", name: "PC-C1", x: 540, y: -80, config: { ipv4Address: "192.168.30.11", gatewayIpv4Address: "192.168.30.1", macAddress: "02:00:00:00:30:11" } },
    { id: "pc-c2", type: "computer", name: "PC-C2", x: 540, y: 80, config: { ipv4Address: "192.168.30.12", gatewayIpv4Address: "192.168.30.1", macAddress: "02:00:00:00:30:12" } },
    { id: "sw-c", type: "switch", name: "Access-SW-C", x: 360, y: 0, config: { managed: false, ethernetPorts: 8 } }
  ],
  links: [
    { from: "pc-a1", to: "sw-a" },
    { from: "pc-a2", to: "sw-a" },
    { from: "pc-b1", to: "sw-b" },
    { from: "pc-b2", to: "sw-b" },
    { from: "sw-a", to: "sw-core" },
    { from: "sw-b", to: "sw-core" },
    { from: "sw-core", to: "router" },
    { from: "pc-c1", to: "sw-c" },
    { from: "pc-c2", to: "sw-c" },
    { from: "sw-c", to: "router" }
  ]
};

export const vlanRoasConfig = {
  version: 1,
  devices: [
    // Router with sub-interfaces for VLANs 10, 20, 30
    { id: "rtr", type: "router", name: "Router", x: 300, y: 0, config: {
      ethernetPorts: 4, serialPorts: 2,
      interfaces: [
        { peerId: "sw-core", type: "ethernet", ipv4Address: "192.168.10.1", vlanTag: 10 },
        { peerId: "sw-core", type: "ethernet", ipv4Address: "192.168.20.1", vlanTag: 20 },
        { peerId: "sw-core", type: "ethernet", ipv4Address: "192.168.30.1", vlanTag: 30 }
      ]
    }},
    // Core switch — all trunks
    { id: "sw-core", type: "switch", name: "Core-SW", x: 40, y: 0, config: {
      managed: true, ethernetPorts: 8,
      vlans: [{ id: 1, name: "default" }, { id: 10, name: "Sales" }, { id: 20, name: "Engineering" }, { id: 30, name: "Servers" }],
      portVlans: {},
      portModes: { Ethernet1: "trunk", Ethernet2: "trunk", Ethernet3: "trunk", Ethernet4: "trunk" },
      trunkNativeVlans: {},
      trunkAllowedVlans: {}
    }},
    // Edge switch A — VLAN 10
    { id: "sw-a", type: "switch", name: "Edge-SW-A", x: -250, y: -200, config: {
      managed: true, ethernetPorts: 8,
      vlans: [{ id: 1, name: "default" }, { id: 10, name: "Sales" }, { id: 20, name: "Engineering" }, { id: 30, name: "Servers" }],
      portVlans: { Ethernet2: 10, Ethernet3: 10 },
      portModes: { Ethernet1: "trunk" },
      trunkNativeVlans: {},
      trunkAllowedVlans: {}
    }},
    // Edge switch B — VLAN 20
    { id: "sw-b", type: "switch", name: "Edge-SW-B", x: -250, y: 0, config: {
      managed: true, ethernetPorts: 8,
      vlans: [{ id: 1, name: "default" }, { id: 10, name: "Sales" }, { id: 20, name: "Engineering" }, { id: 30, name: "Servers" }],
      portVlans: { Ethernet2: 20, Ethernet3: 20 },
      portModes: { Ethernet1: "trunk" },
      trunkNativeVlans: {},
      trunkAllowedVlans: {}
    }},
    // Edge switch C — VLAN 30 + trunk to unmanaged switch D
    { id: "sw-c", type: "switch", name: "Edge-SW-C", x: -250, y: 200, config: {
      managed: true, ethernetPorts: 8,
      vlans: [{ id: 1, name: "default" }, { id: 10, name: "Sales" }, { id: 20, name: "Engineering" }, { id: 30, name: "Servers" }],
      portVlans: { Ethernet2: 30, Ethernet3: 30 },
      portModes: { Ethernet1: "trunk", Ethernet4: "trunk" },
      trunkNativeVlans: {},
      trunkAllowedVlans: {}
    }},
    // Edge switch D — unmanaged (passes through VLAN 30 traffic transparently)
    { id: "sw-d", type: "switch", name: "Edge-SW-D", x: -520, y: 280, config: {
      managed: false, ethernetPorts: 8
    }},
    // PCs — VLAN 10 (Sales)
    { id: "pc-a1", type: "computer", name: "PC-A1", x: -520, y: -260, config: { ipv4Address: "192.168.10.11", gatewayIpv4Address: "192.168.10.1", macAddress: "02:00:0A:00:01:01" }},
    { id: "pc-a2", type: "computer", name: "PC-A2", x: -520, y: -160, config: { ipv4Address: "192.168.10.12", gatewayIpv4Address: "192.168.10.1", macAddress: "02:00:0A:00:01:02" }},
    // PCs — VLAN 20 (Engineering)
    { id: "pc-b1", type: "computer", name: "PC-B1", x: -520, y: -60, config: { ipv4Address: "192.168.20.11", gatewayIpv4Address: "192.168.20.1", macAddress: "02:00:14:00:01:01" }},
    { id: "pc-b2", type: "computer", name: "PC-B2", x: -520, y: 40, config: { ipv4Address: "192.168.20.12", gatewayIpv4Address: "192.168.20.1", macAddress: "02:00:14:00:01:02" }},
    // PCs — VLAN 30 (Servers) on Edge-SW-C
    { id: "pc-c1", type: "computer", name: "PC-C1", x: -520, y: 130, config: { ipv4Address: "192.168.30.11", gatewayIpv4Address: "192.168.30.1", macAddress: "02:00:1E:00:01:01" }},
    { id: "pc-c2", type: "computer", name: "PC-C2", x: -520, y: 210, config: { ipv4Address: "192.168.30.12", gatewayIpv4Address: "192.168.30.1", macAddress: "02:00:1E:00:01:02" }},
    // PCs — VLAN 30 (Servers) on Edge-SW-D (unmanaged)
    { id: "pc-d1", type: "computer", name: "PC-D1", x: -760, y: 200, config: { ipv4Address: "192.168.30.21", gatewayIpv4Address: "192.168.30.1", macAddress: "02:00:1E:00:02:01" }},
    { id: "pc-d2", type: "computer", name: "PC-D2", x: -760, y: 290, config: { ipv4Address: "192.168.30.22", gatewayIpv4Address: "192.168.30.1", macAddress: "02:00:1E:00:02:02" }},
    { id: "pc-d3", type: "computer", name: "PC-D3", x: -760, y: 380, config: { ipv4Address: "192.168.30.23", gatewayIpv4Address: "192.168.30.1", macAddress: "02:00:1E:00:02:03" }}
  ],
  links: [
    // Core-SW to Router (trunk)
    { from: "sw-core", to: "rtr" },
    // Core-SW to edge switches (trunk)
    { from: "sw-core", to: "sw-a" },
    { from: "sw-core", to: "sw-b" },
    { from: "sw-core", to: "sw-c" },
    // Edge-SW-A to PCs (access VLAN 10)
    { from: "sw-a", to: "pc-a1" },
    { from: "sw-a", to: "pc-a2" },
    // Edge-SW-B to PCs (access VLAN 20)
    { from: "sw-b", to: "pc-b1" },
    { from: "sw-b", to: "pc-b2" },
    // Edge-SW-C to PCs (access VLAN 30)
    { from: "sw-c", to: "pc-c1" },
    { from: "sw-c", to: "pc-c2" },
    // Edge-SW-C to Edge-SW-D (trunk carrying VLAN 30)
    { from: "sw-c", to: "sw-d" },
    // Edge-SW-D to PCs (unmanaged, transparently carries VLAN 30)
    { from: "sw-d", to: "pc-d1" },
    { from: "sw-d", to: "pc-d2" },
    { from: "sw-d", to: "pc-d3" }
  ]
};

export const routerMeshConfig = {
  version: 1,
  devices: [
    // ── Routers ──────────────────────────────────────────────────────
    // R1 — central hub, LAN on 192.168.1.0/24
    { id: "r1", type: "router", name: "R1", x: -80, y: -60, config: {
      ethernetPorts: 4, serialPorts: 4,
      interfaces: [
        { peerId: "sw1", type: "ethernet", ipv4Address: "192.168.1.1", macAddress: "02:a1:00:00:01:01" },
        { peerId: "r2",  type: "serial",   ipv4Address: "10.0.12.1",   macAddress: "02:a1:00:00:02:01" },
        { peerId: "r3",  type: "serial",   ipv4Address: "10.0.13.1",   macAddress: "02:a1:00:00:03:01" },
        { peerId: "r4",  type: "serial",   ipv4Address: "10.0.14.1",   macAddress: "02:a1:00:00:04:01" }
      ],
      staticRoutes: [
        { network: "192.168.2.0/24", nextHop: "10.0.12.2" },
        { network: "192.168.4.0/24", nextHop: "10.0.14.2" },
        { network: "10.0.25.0/24",   nextHop: "10.0.12.2" },
        { network: "10.0.34.0/24",   nextHop: "10.0.13.2" },
        { network: "10.0.45.0/24",   nextHop: "10.0.14.2" }
      ]
    }},
    // R2 — east, LAN on 192.168.2.0/24
    { id: "r2", type: "router", name: "R2", x: 380, y: -60, config: {
      ethernetPorts: 4, serialPorts: 4,
      interfaces: [
        { peerId: "sw2", type: "ethernet", ipv4Address: "192.168.2.1", macAddress: "02:a2:00:00:01:01" },
        { peerId: "r1",  type: "serial",   ipv4Address: "10.0.12.2",   macAddress: "02:a2:00:00:02:01" },
        { peerId: "r5",  type: "serial",   ipv4Address: "10.0.25.2",   macAddress: "02:a2:00:00:03:01" }
      ],
      staticRoutes: [
        { network: "192.168.1.0/24", nextHop: "10.0.12.1" },
        { network: "192.168.4.0/24", nextHop: "10.0.25.5" },
        { network: "10.0.13.0/24",   nextHop: "10.0.12.1" },
        { network: "10.0.14.0/24",   nextHop: "10.0.12.1" },
        { network: "10.0.34.0/24",   nextHop: "10.0.12.1" },
        { network: "10.0.45.0/24",   nextHop: "10.0.25.5" }
      ]
    }},
    // R3 — southwest, transit-only
    { id: "r3", type: "router", name: "R3", x: -300, y: 180, config: {
      ethernetPorts: 4, serialPorts: 4,
      interfaces: [
        { peerId: "r1", type: "serial", ipv4Address: "10.0.13.2", macAddress: "02:a3:00:00:01:01" },
        { peerId: "r4", type: "serial", ipv4Address: "10.0.34.3", macAddress: "02:a3:00:00:02:01" }
      ],
      staticRoutes: [
        { network: "192.168.1.0/24", nextHop: "10.0.13.1" },
        { network: "192.168.2.0/24", nextHop: "10.0.13.1" },
        { network: "192.168.4.0/24", nextHop: "10.0.34.4" },
        { network: "10.0.12.0/24",   nextHop: "10.0.13.1" },
        { network: "10.0.14.0/24",   nextHop: "10.0.13.1" },
        { network: "10.0.25.0/24",   nextHop: "10.0.13.1" },
        { network: "10.0.45.0/24",   nextHop: "10.0.34.4" }
      ]
    }},
    // R4 — south, LAN on 192.168.4.0/24
    { id: "r4", type: "router", name: "R4", x: 80, y: 280, config: {
      ethernetPorts: 4, serialPorts: 4,
      interfaces: [
        { peerId: "sw4", type: "ethernet", ipv4Address: "192.168.4.1", macAddress: "02:a4:00:00:01:01" },
        { peerId: "r1",  type: "serial",   ipv4Address: "10.0.14.2",   macAddress: "02:a4:00:00:02:01" },
        { peerId: "r3",  type: "serial",   ipv4Address: "10.0.34.4",   macAddress: "02:a4:00:00:03:01" },
        { peerId: "r5",  type: "serial",   ipv4Address: "10.0.45.4",   macAddress: "02:a4:00:00:04:01" }
      ],
      staticRoutes: [
        { network: "192.168.1.0/24", nextHop: "10.0.14.1" },
        { network: "192.168.2.0/24", nextHop: "10.0.45.5" },
        { network: "10.0.12.0/24",   nextHop: "10.0.14.1" },
        { network: "10.0.13.0/24",   nextHop: "10.0.34.3" },
        { network: "10.0.25.0/24",   nextHop: "10.0.45.5" }
      ]
    }},
    // R5 — southeast, transit-only
    { id: "r5", type: "router", name: "R5", x: 380, y: 200, config: {
      ethernetPorts: 4, serialPorts: 4,
      interfaces: [
        { peerId: "r2", type: "serial", ipv4Address: "10.0.25.5", macAddress: "02:a5:00:00:01:01" },
        { peerId: "r4", type: "serial", ipv4Address: "10.0.45.5", macAddress: "02:a5:00:00:02:01" }
      ],
      staticRoutes: [
        { network: "192.168.1.0/24", nextHop: "10.0.25.2" },
        { network: "192.168.2.0/24", nextHop: "10.0.25.2" },
        { network: "192.168.4.0/24", nextHop: "10.0.45.4" },
        { network: "10.0.12.0/24",   nextHop: "10.0.25.2" },
        { network: "10.0.13.0/24",   nextHop: "10.0.25.2" },
        { network: "10.0.14.0/24",   nextHop: "10.0.45.4" },
        { network: "10.0.34.0/24",   nextHop: "10.0.45.4" }
      ]
    }},
    // ── Switches ─────────────────────────────────────────────────────
    { id: "sw1", type: "switch", name: "SW1", x: -320, y: -60, config: { managed: false, ethernetPorts: 8 } },
    { id: "sw2", type: "switch", name: "SW2", x: 600, y: -60, config: { managed: false, ethernetPorts: 8 } },
    { id: "sw4", type: "switch", name: "SW4", x: 80, y: 460, config: { managed: false, ethernetPorts: 8 } },
    // ── PCs — Subnet 192.168.1.0/24 (R1/SW1) ────────────────────────
    { id: "pc-a1", type: "computer", name: "PC-A1", x: -520, y: -120, config: { ipv4Address: "192.168.1.11", gatewayIpv4Address: "192.168.1.1", macAddress: "02:00:01:00:01:11" } },
    { id: "pc-a2", type: "computer", name: "PC-A2", x: -520, y: -10, config:  { ipv4Address: "192.168.1.12", gatewayIpv4Address: "192.168.1.1", macAddress: "02:00:01:00:01:12" } },
    // ── PCs — Subnet 192.168.2.0/24 (R2/SW2) ────────────────────────
    { id: "pc-b1", type: "computer", name: "PC-B1", x: 800, y: -120, config: { ipv4Address: "192.168.2.11", gatewayIpv4Address: "192.168.2.1", macAddress: "02:00:02:00:01:11" } },
    { id: "pc-b2", type: "computer", name: "PC-B2", x: 800, y: -10, config:  { ipv4Address: "192.168.2.12", gatewayIpv4Address: "192.168.2.1", macAddress: "02:00:02:00:01:12" } },
    // ── PCs — Subnet 192.168.4.0/24 (R4/SW4) ────────────────────────
    { id: "pc-d1", type: "computer", name: "PC-D1", x: -100, y: 530, config: { ipv4Address: "192.168.4.11", gatewayIpv4Address: "192.168.4.1", macAddress: "02:00:04:00:01:11" } },
    { id: "pc-d2", type: "computer", name: "PC-D2", x: 260, y: 530, config:  { ipv4Address: "192.168.4.12", gatewayIpv4Address: "192.168.4.1", macAddress: "02:00:04:00:01:12" } }
  ],
  links: [
    // LAN connections
    { from: "sw1", to: "r1" },
    { from: "sw2", to: "r2" },
    { from: "sw4", to: "r4" },
    { from: "pc-a1", to: "sw1" },
    { from: "pc-a2", to: "sw1" },
    { from: "pc-b1", to: "sw2" },
    { from: "pc-b2", to: "sw2" },
    { from: "pc-d1", to: "sw4" },
    { from: "pc-d2", to: "sw4" },
    // Serial links between routers (partial mesh)
    { from: "r1", to: "r2" },
    { from: "r1", to: "r3" },
    { from: "r1", to: "r4" },
    { from: "r3", to: "r4" },
    { from: "r2", to: "r5" },
    { from: "r4", to: "r5" }
  ]
};

// Keep all built-in topologies in positive coordinate space.
[defaultConfig, vlanRoasConfig, routerMeshConfig].forEach(c => shiftToPositive(c));

// --- Undo system ---

export function networkSnapshot(): string {
  return JSON.stringify({
    devices: state.devices,
    links: state.links.map(l => {
      const { frameHistory, ...rest } = l;
      return rest;
    }),
    selectedId: state.selectedId,
    configuringId: state.configuringId,
    nextComputer: state.nextComputer,
    nextSwitch: state.nextSwitch,
    nextRouter: state.nextRouter
  });
}

export function pushUndo(): void {
  if (state.isApplyingCompositeChange) return;
  pushUndoSnapshot(networkSnapshot());
}

export function pushUndoSnapshot(snapshot: string): void {
  if (state.undoStack[state.undoStack.length - 1] !== snapshot) {
    state.undoStack.push(snapshot);
    if (state.undoStack.length > 80) state.undoStack.shift();
  }
  syncUndoButton();
}

export function syncUndoButton(): void {
  (document.getElementById("undoButton") as HTMLButtonElement).disabled = state.undoStack.length === 0;
}

export function restoreSnapshot(snapshot: string): void {
  const restored = JSON.parse(snapshot);
  state.devices = restored.devices;
  state.links = restored.links;
  state.selectedId = restored.selectedId;
  state.configuringId = restored.configuringId;
  state.nextComputer = restored.nextComputer;
  state.nextSwitch = restored.nextSwitch;
  state.nextRouter = restored.nextRouter || 1;
  state.linkStartId = null;
  state.selectedLinkId = null;
  state.drag = null;
  state.panDrag = null;
  sync().syncPanel();
  sync().render();
}

export function undo(): void {
  // Cancel active simulation before undoing
  if (state.simulation.status !== "idle" && state.simulation.status !== "done") {
    state.simulation.status = "idle";
    state.simulation.events = [];
    state.simulation.log = [];
    state.simulation.transits = [];
    state.simulation.pendingArp = {};
    const termInput = document.getElementById("terminalInput") as HTMLInputElement | null;
    if (termInput) termInput.disabled = false;
    const logPanel = document.getElementById("simLogPanel");
    if (logPanel) logPanel.classList.remove("active");
  }
  const snapshot = state.undoStack.pop();
  if (!snapshot) return;
  restoreSnapshot(snapshot);
  syncUndoButton();
}

export function captureUndoOnFocus(input: HTMLInputElement): void {
  input.addEventListener("focus", () => {
    if (!(input as any).dataset.undoSnapshot) (input as any).dataset.undoSnapshot = networkSnapshot();
  });
  input.addEventListener("blur", () => {
    const snapshot = (input as any).dataset.undoSnapshot;
    delete (input as any).dataset.undoSnapshot;
    if (snapshot && snapshot !== networkSnapshot()) {
      pushUndoSnapshot(snapshot);
    }
  });
}
