import type { AppState, Device, TerminalSession } from "./types";
import { shiftToPositive } from "./normalise";
import { freshNameCounters } from "./device-registry";

export type SyncCallbacks = {
  render: () => void;
  syncPanel: () => void;
  syncTerminal: () => void;
  resizeCanvas: () => void;
  syncScenarioPanel: () => void;
  syncCoordReadout: () => void;
  syncOptionControls: () => void;
  recomputeStp: () => void;   // recompute the spanning tree for live canvas/inspector display (also runs at sim start); link changes reach it through linksChanged()
  syncSimLog: () => void;     // rebuild the sim-log dock pane (packet list / event log)
  // The engine's own run teardown (stops the animation loop, boot queue, transport
  // pill, queues, conntrack). Bridged because state.ts cannot import engine.ts;
  // every path that replaces the topology under a live run calls this first.
  stopSimulation?: () => void;
};

// Available colour themes. The id is written to `<html data-theme>` and matched
// by a CSS block in styles.css; the first entry is the default (applied at boot).
export interface ThemeOption { id: string; label: string }
export const THEMES: ThemeOption[] = [
  { id: "warm-light", label: "Warm Light" },
  { id: "dark", label: "Dark" },
  { id: "blueprint", label: "Blueprint" },
];
export const DEFAULT_THEME = THEMES[0].id;

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
  theme: DEFAULT_THEME,
  inspectorWidth: 320,
  inspectorResize: null,
  terminal: {
    deviceId: null,
    mode: "exec",
    interfacePeerId: null,
    interfaceVlanTag: null,
    lines: [],
    history: [],
    historyIndex: -1
  },
  terminalSessions: [],
  dock: {
    open: false,
    activeTab: "terminal",
    height: 280,
    logView: "packets",
    logFilter: { protocols: [], device: "", expr: "" },
    captureView: "live",
    compareBaseId: ""
  },
  console: {
    lines: [],
    history: [],
    historyIndex: -1
  },
  activeScenarioId: null,
  options: {
    showDeviceNames: true,
    showIpAddresses: true,
    showMacAddresses: true,
    networkPanelOpen: false,
    autoDhcp: false,
    apipaFallback: false,
    silentArp: false,
    silentDhcp: false,
    silentDns: false,
    silentWifi: false,
    silentStp: false,
    instantDns: true
  },
  nameCounters: freshNameCounters(),
  configStore: { version: 1, configs: {} },
  undoStack: [],
  redoStack: [],
  inspectedFrame: null,
  inspectedCapture: null,
  savedCaptures: [],
  isApplyingCompositeChange: false,
  simulation: {
    status: "idle",
    mode: "ping",
    events: [],
    log: [],
    capture: [],
    transits: [],
    pendingArp: {},
    speed: 1000,
    autoPlay: true,
    stepIndex: 0,
    originDeviceId: null,
    pingTargetIp: null,
    pingSuccess: false,
    pingTtl: 64,
    pingResponderIp: null,
    pingTimeExceeded: false,
    pingUnreachableFrom: null,
    tcpSuccess: false,
    tcpRefused: false,
    tcpTargetPort: null,
    httpPath: "/",
    httpSuccess: false,
    httpStatus: null,
    httpStatusText: null,
    httpServerTitle: null,
    headless: false,
    dnsName: null,
    dnsResolvedIp: null,
    resolveThen: null,
    dhcpOfferTaken: false,
    dhcpSuccess: false,
    dhcpAssignedIp: null,
    dhcpAssignedGateway: null,
    wifiAssociated: false,
    dot1xAuthorized: false,
    stormDetected: false,
    diagnosis: [],
    arpDrops: {},
    scanOpen: [],
    scanClosed: [],
    sweepLive: [],
    conntrack: {},
    dnatSessions: {}
  },
  portSelection: null
};

// A blank terminal session. `deviceId: null` is the detached placeholder shown
// when no device terminal is attached (or an open attempt failed).
export function freshTerminalSession(deviceId: string | null = null): TerminalSession {
  return {
    deviceId,
    mode: "exec",
    interfacePeerId: null,
    interfaceVlanTag: null,
    lines: [],
    history: [],
    historyIndex: -1,
  };
}

// Drop terminal sessions (all of them, or those for the given device ids) and
// repair the active pointer/dock. Lives here so devices.ts and config.ts can
// clean up without importing the terminal layer.
export function dropTerminalSessions(deviceIds: string[] | null = null): void {
  const doomed = deviceIds === null
    ? new Set(state.terminalSessions.map(s => s.deviceId))
    : new Set(deviceIds);
  state.terminalSessions = state.terminalSessions.filter(s => !doomed.has(s.deviceId));
  if (doomed.has(state.terminal.deviceId)) {
    state.terminal = state.terminalSessions[state.terminalSessions.length - 1] ?? freshTerminalSession();
    if (state.terminalSessions.length === 0 && state.dock.activeTab === "terminal") {
      state.dock.open = false;
    }
  }
}

export const toolCopy: Record<string, [string, string]> = {
  select: ["Select and move devices", "Drag devices to arrange the network."],
  computer: ["Add client PC", "Click the canvas to place a client PC."],
  laptop: ["Add laptop", "Click the canvas to place a WiFi laptop (associate it to an access point)."],
  kali: ["Add Kali PC", "Click the canvas to place a Kali Linux workstation — drive nmap / arpspoof by hand from its terminal."],
  server: ["Add server", "Click the canvas to place a server (DNS/DHCP via dnsmasq)."],
  "dns-server": ["Add DNS server", "Click the canvas to place a DNS server (dnsmasq — add A-records to resolve names)."],
  "dhcp-server": ["Add DHCP server", "Click the canvas to place a DHCP server (dnsmasq — set a dhcp-range to hand out addresses)."],
  "radius-server": ["Add RADIUS server", "Click the canvas to place a RADIUS server (the 802.1X authentication back-end — add user accounts)."],
  "web-server": ["Add web server", "Click the canvas to place a web server (listening on TCP/80)."],
  switch: ["Add switch", "Click the canvas to place a switch."],
  "managed-switch": ["Add managed switch", "Click the canvas to place a managed switch."],
  connect: ["Connect devices", "Click one device, then another to cable them (auto-picks free ports; Shift-click the second to choose ports)."],
  router: ["Add internal router", "Click the canvas to place an internal/core router (interior forwarding)."],
  "border-router": ["Add border router", "Click the canvas to place a border/edge router (faces the outside — pair it with NAT + a firewall)."],
  internet: ["Add internet", "Click the canvas to place the internet cloud — connect several routers (each on its own public subnet) and it routes between them by destination, presenting a default gateway to each."],
  firewall: ["Add firewall", "Click the canvas to place a firewall."],
  ids: ["Add IDS", "Click the canvas to place a Snort IDS sensor (cable it to a switch SPAN/monitor port)."],
  attacker: ["Add Red Team host", "Click the canvas to place a Red Team (Kali) host that launches simulated attacks against a target."],
  hub: ["Add hub", "Click the canvas to place a hub (a layer-1 repeater)."],
  "access-point": ["Add access point", "Click the canvas to place a WiFi access point (bridges associated laptops to the wired LAN)."],
  configure: ["Configure device", "Click a device to edit its static configuration."]
};

export const colors = {
  selected: "#f0b429"
};

export const defaultConfig = {
  version: 1,
  devices: [
    { id: "pc-a1", type: "computer", name: "PC-A1", x: -560, y: -300, config: { ipv4Address: "192.168.10.11", gatewayIpv4Address: "192.168.10.1", macAddress: "02:00:00:00:10:11" } },
    { id: "pc-a2", type: "computer", name: "PC-A2", x: -560, y: -150, config: { ipv4Address: "192.168.10.12", gatewayIpv4Address: "192.168.10.1", macAddress: "02:00:00:00:10:12" } },
    { id: "sw-a", type: "switch", name: "Access-SW-A", x: -360, y: -225, config: { managed: false, ethernetPorts: 8 } },
    { id: "pc-b1", type: "computer", name: "PC-B1", x: -560, y: 130, config: { ipv4Address: "192.168.10.21", gatewayIpv4Address: "192.168.10.1", macAddress: "02:00:00:00:10:21" } },
    { id: "pc-b2", type: "computer", name: "PC-B2", x: -560, y: 280, config: { ipv4Address: "192.168.10.22", gatewayIpv4Address: "192.168.10.1", macAddress: "02:00:00:00:10:22" } },
    { id: "sw-b", type: "switch", name: "Access-SW-B", x: -360, y: 205, config: { managed: false, ethernetPorts: 8 } },
    { id: "sw-core", type: "switch", name: "Core-SW", x: -80, y: -10, config: { managed: false, ethernetPorts: 8 } },
    { id: "router", type: "router", name: "Router", x: 210, y: -10, config: { interfaces: [
      { peerId: "sw-core", type: "ethernet", ipv4Address: "192.168.10.1" },
      { peerId: "sw-c", type: "ethernet", ipv4Address: "192.168.30.1" }
    ] } },
    { id: "pc-c1", type: "computer", name: "PC-C1", x: 540, y: -110, config: { ipv4Address: "192.168.30.11", gatewayIpv4Address: "192.168.30.1", macAddress: "02:00:00:00:30:11" } },
    { id: "pc-c2", type: "computer", name: "PC-C2", x: 540, y: 90, config: { ipv4Address: "192.168.30.12", gatewayIpv4Address: "192.168.30.1", macAddress: "02:00:00:00:30:12" } },
    { id: "sw-c", type: "switch", name: "Access-SW-C", x: 360, y: -10, config: { managed: false, ethernetPorts: 8 } }
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
    { id: "sw-a", type: "switch", name: "Edge-SW-A", x: -250, y: -320, config: {
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
    { id: "sw-c", type: "switch", name: "Edge-SW-C", x: -250, y: 320, config: {
      managed: true, ethernetPorts: 8,
      vlans: [{ id: 1, name: "default" }, { id: 10, name: "Sales" }, { id: 20, name: "Engineering" }, { id: 30, name: "Servers" }],
      portVlans: { Ethernet2: 30, Ethernet3: 30 },
      portModes: { Ethernet1: "trunk", Ethernet4: "trunk" },
      trunkNativeVlans: {},
      trunkAllowedVlans: {}
    }},
    // Edge switch D — unmanaged (passes through VLAN 30 traffic transparently)
    { id: "sw-d", type: "switch", name: "Edge-SW-D", x: -520, y: 560, config: {
      managed: false, ethernetPorts: 8
    }},
    // PCs — VLAN 10 (Sales)
    { id: "pc-a1", type: "computer", name: "PC-A1", x: -520, y: -395, config: { ipv4Address: "192.168.10.11", gatewayIpv4Address: "192.168.10.1", macAddress: "02:00:0A:00:01:01" }},
    { id: "pc-a2", type: "computer", name: "PC-A2", x: -520, y: -245, config: { ipv4Address: "192.168.10.12", gatewayIpv4Address: "192.168.10.1", macAddress: "02:00:0A:00:01:02" }},
    // PCs — VLAN 20 (Engineering)
    { id: "pc-b1", type: "computer", name: "PC-B1", x: -520, y: -75, config: { ipv4Address: "192.168.20.11", gatewayIpv4Address: "192.168.20.1", macAddress: "02:00:14:00:01:01" }},
    { id: "pc-b2", type: "computer", name: "PC-B2", x: -520, y: 75, config: { ipv4Address: "192.168.20.12", gatewayIpv4Address: "192.168.20.1", macAddress: "02:00:14:00:01:02" }},
    // PCs — VLAN 30 (Servers) on Edge-SW-C
    { id: "pc-c1", type: "computer", name: "PC-C1", x: -520, y: 245, config: { ipv4Address: "192.168.30.11", gatewayIpv4Address: "192.168.30.1", macAddress: "02:00:1E:00:01:01" }},
    { id: "pc-c2", type: "computer", name: "PC-C2", x: -520, y: 395, config: { ipv4Address: "192.168.30.12", gatewayIpv4Address: "192.168.30.1", macAddress: "02:00:1E:00:01:02" }},
    // PCs — VLAN 30 (Servers) on Edge-SW-D (unmanaged)
    { id: "pc-d1", type: "computer", name: "PC-D1", x: -760, y: 460, config: { ipv4Address: "192.168.30.21", gatewayIpv4Address: "192.168.30.1", macAddress: "02:00:1E:00:02:01" }},
    { id: "pc-d2", type: "computer", name: "PC-D2", x: -760, y: 610, config: { ipv4Address: "192.168.30.22", gatewayIpv4Address: "192.168.30.1", macAddress: "02:00:1E:00:02:02" }},
    { id: "pc-d3", type: "computer", name: "PC-D3", x: -760, y: 760, config: { ipv4Address: "192.168.30.23", gatewayIpv4Address: "192.168.30.1", macAddress: "02:00:1E:00:02:03" }}
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
    { id: "sw4", type: "switch", name: "SW4", x: 80, y: 510, config: { managed: false, ethernetPorts: 8 } },
    // ── PCs — Subnet 192.168.1.0/24 (R1/SW1) ────────────────────────
    { id: "pc-a1", type: "computer", name: "PC-A1", x: -520, y: -150, config: { ipv4Address: "192.168.1.11", gatewayIpv4Address: "192.168.1.1", macAddress: "02:00:01:00:01:11" } },
    { id: "pc-a2", type: "computer", name: "PC-A2", x: -520, y: 20, config:  { ipv4Address: "192.168.1.12", gatewayIpv4Address: "192.168.1.1", macAddress: "02:00:01:00:01:12" } },
    // ── PCs — Subnet 192.168.2.0/24 (R2/SW2) ────────────────────────
    { id: "pc-b1", type: "computer", name: "PC-B1", x: 800, y: -150, config: { ipv4Address: "192.168.2.11", gatewayIpv4Address: "192.168.2.1", macAddress: "02:00:02:00:01:11" } },
    { id: "pc-b2", type: "computer", name: "PC-B2", x: 800, y: 20, config:  { ipv4Address: "192.168.2.12", gatewayIpv4Address: "192.168.2.1", macAddress: "02:00:02:00:01:12" } },
    // ── PCs — Subnet 192.168.4.0/24 (R4/SW4) ────────────────────────
    { id: "pc-d1", type: "computer", name: "PC-D1", x: -100, y: 600, config: { ipv4Address: "192.168.4.11", gatewayIpv4Address: "192.168.4.1", macAddress: "02:00:04:00:01:11" } },
    { id: "pc-d2", type: "computer", name: "PC-D2", x: 260, y: 600, config:  { ipv4Address: "192.168.4.12", gatewayIpv4Address: "192.168.4.1", macAddress: "02:00:04:00:01:12" } }
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

// Campus WiFi: two SSIDs separated by VLAN. A staff SSID (secured) lives on
// VLAN 10 and a guest SSID (open) on VLAN 20, each broadcast by its own access
// point whose wired uplink is an access port in that VLAN. A managed core switch
// trunks every VLAN to a router-on-a-stick gateway, which routes between them
// (and hands out DHCP per VLAN). A shared DNS/file server sits on its own
// Servers VLAN 30 and is reachable from both staff and guest. A FORWARD rule on
// the gateway gives the classic guest isolation: guest clients can reach the
// gateway and the server, but not the staff subnet.
export const wifiVlanConfig = {
  version: 1,
  devices: [
    // Gateway — router-on-a-stick: a sub-interface per VLAN, plus guest isolation.
    { id: "wifi-rtr", type: "router", name: "Gateway", x: 60, y: -340, config: {
      ethernetPorts: 4, serialPorts: 2,
      interfaces: [
        { peerId: "wifi-core", type: "ethernet", ipv4Address: "10.0.10.1", vlanTag: 10 },
        { peerId: "wifi-core", type: "ethernet", ipv4Address: "10.0.20.1", vlanTag: 20 },
        { peerId: "wifi-core", type: "ethernet", ipv4Address: "10.0.30.1", vlanTag: 30 }
      ],
      // Guests may reach the gateway, the internet and the server — but not the
      // staff subnet. The server VLAN is deliberately left open to everyone.
      rules: [{ chain: "forward", target: "drop", src: "10.0.20.0/24", dst: "10.0.10.0/24" }]
    }},
    // Core switch — trunk to the gateway, an access port per AP and the server.
    { id: "wifi-core", type: "switch", name: "Core-SW", x: 60, y: -180, config: {
      managed: true, ethernetPorts: 8,
      vlans: [{ id: 1, name: "default" }, { id: 10, name: "Staff" }, { id: 20, name: "Guest" }, { id: 30, name: "Servers" }],
      portVlans: { Ethernet2: 10, Ethernet3: 20, Ethernet4: 30 },
      portModes: { Ethernet1: "trunk" },
      trunkNativeVlans: {},
      trunkAllowedVlans: {}
    }},
    // Shared server — VLAN 30, reachable from every VLAN via the gateway. Runs
    // dnsmasq with an A-record so all clients can resolve "server.lan".
    { id: "wifi-srv", type: "server", name: "Server", x: 360, y: -300, config: { ipv4Address: "10.0.30.10", gatewayIpv4Address: "10.0.30.1", macAddress: "02:00:0A:1E:00:0A", dnsmasqRunning: true, dnsRecords: [{ name: "server.lan", ip: "10.0.30.10" }] } },
    // Access points — one SSID each, uplinked into its VLAN's access port.
    { id: "ap-staff", type: "access-point", name: "Staff-AP", x: -180, y: 10, config: { managed: false, ethernetPorts: 1, ssid: "Staff", wifiPassword: "staff1234", macTable: [] } },
    { id: "ap-guest", type: "access-point", name: "Guest-AP", x: 300, y: 10, config: { managed: false, ethernetPorts: 1, ssid: "Guest", macTable: [] } },
    // Staff laptops — VLAN 10, joined to the secured "Staff" SSID; resolve via the server.
    { id: "lt-staff1", type: "laptop", name: "Staff-LT1", x: -280, y: 200, config: { ipv4Address: "10.0.10.11", gatewayIpv4Address: "10.0.10.1", macAddress: "02:00:0A:0A:00:11", dnsServerIp: "10.0.30.10", ssid: "Staff", wifiPassword: "staff1234" } },
    { id: "lt-staff2", type: "laptop", name: "Staff-LT2", x: -100, y: 200, config: { ipv4Address: "10.0.10.12", gatewayIpv4Address: "10.0.10.1", macAddress: "02:00:0A:0A:00:12", dnsServerIp: "10.0.30.10", ssid: "Staff", wifiPassword: "staff1234" } },
    // Guest laptop — VLAN 20, joined to the open "Guest" SSID; resolves via the server too.
    { id: "lt-guest", type: "laptop", name: "Guest-LT", x: 300, y: 200, config: { ipv4Address: "10.0.20.11", gatewayIpv4Address: "10.0.20.1", macAddress: "02:00:0A:14:00:11", dnsServerIp: "10.0.30.10", ssid: "Guest" } }
  ],
  links: [
    // Core-SW links first, in port order: Ethernet1 trunk → gateway, Ethernet2 (VLAN 10)
    // → Staff-AP, Ethernet3 (VLAN 20) → Guest-AP, Ethernet4 (VLAN 30) → Server.
    { from: "wifi-core", to: "wifi-rtr" },
    { from: "wifi-core", to: "ap-staff" },
    { from: "wifi-core", to: "ap-guest" },
    { from: "wifi-core", to: "wifi-srv" },
    // Wireless associations (laptop ↔ AP).
    { from: "ap-staff", to: "lt-staff1", wireless: true },
    { from: "ap-staff", to: "lt-staff2", wireless: true },
    { from: "ap-guest", to: "lt-guest", wireless: true }
  ]
};

// Keep all built-in topologies in positive coordinate space.
[defaultConfig, vlanRoasConfig, routerMeshConfig, wifiVlanConfig].forEach(c => shiftToPositive(c));

// --- Derived-state invalidation ---

// A bridge's MAC table is learnt state derived from the cabling it was learnt
// over: an entry names the port a source MAC arrived on. When that cabling
// changes the entry can lie — implicit ports are numbered densely, so removing
// one cable renames every later port on that switch, and a host moved to
// another switch is still "behind" the old port on every bridge in between.
// Hosts' ARP caches stay warm, so no broadcast would ever re-learn it. Real
// bridges flush the downed port and, on a topology change, age out the whole
// broadcast domain quickly (802.1D TCN / 802.1w TC flush); here every learnt
// (DYNAMIC) entry on every bridge in the affected L2 domain is dropped, so the
// next frame floods once and re-learns. STATIC entries are configuration and
// stay. Omit `deviceIds` to flush every bridge (load / undo / redo).
export function flushLearnedMacs(deviceIds?: readonly string[]): void {
  const flush = (device: Device | undefined) => {
    const table = device?.config?.macTable;
    if (Array.isArray(table) && table.length) device!.config!.macTable = table.filter(e => e.type === "STATIC");
  };
  if (!deviceIds) { state.devices.forEach(flush); return; }
  const byId = new Map(state.devices.map(d => [d.id, d]));
  // Every link counts, shut or hidden included — over-flushing costs one flood,
  // under-flushing strands unicast.
  const adjacent = new Map<string, string[]>();
  const connect = (a: string, b: string) => {
    const list = adjacent.get(a);
    if (list) list.push(b); else adjacent.set(a, [b]);
  };
  for (const link of state.links) { connect(link.from, link.to); connect(link.to, link.from); }
  // A router or the internet cloud ends the broadcast domain (as in l2Reachable):
  // it is never expanded through, so a change on one side leaves the other alone.
  const isL3Boundary = (d: Device | undefined) => d?.type === "router" || d?.type === "internet";
  const seen = new Set(deviceIds);
  const queue = [...seen];
  while (queue.length) {
    const id = queue.pop()!;
    const device = byId.get(id);
    flush(device);
    if (isL3Boundary(device)) continue;
    for (const next of adjacent.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
}

// The one hook for "the cabling changed": a link was added, removed, shut or
// un-shut, a device (and its links) went, or the whole topology was replaced.
// Invalidates everything derived from the cabling — learnt MAC tables, then the
// spanning tree (the recomputeStp bridge, which also re-renders). `deviceIds`
// are the devices whose links changed (both ends of a link); omit for "all".
export function linksChanged(deviceIds?: readonly string[]): void {
  flushLearnedMacs(deviceIds);
  sync().recomputeStp();
}

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
    nameCounters: { ...state.nameCounters }
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
    state.redoStack = []; // a new mutation invalidates the redo branch
  }
  syncUndoButton();
}

export function syncUndoButton(): void {
  (document.getElementById("undoButton") as HTMLButtonElement).disabled = state.undoStack.length === 0;
  const redoButton = document.getElementById("redoButton") as HTMLButtonElement | null;
  if (redoButton) redoButton.disabled = state.redoStack.length === 0;
}

// Drop the live + archived packet captures and reset the packet-list view.
// Every path that replaces or tears down the topology (load/import, Clear,
// undo/redo) calls this so neither the live nor saved captures can dangle
// against a gone network. (Mid-run paths reset the live capture themselves.)
export function resetCaptureState(): void {
  state.simulation.capture = [];
  state.savedCaptures = [];
  state.dock.captureView = "live";
  state.dock.compareBaseId = "";
  state.inspectedFrame = null;
  state.inspectedCapture = null;
}

export function restoreSnapshot(snapshot: string): void {
  const restored = JSON.parse(snapshot);
  state.devices = restored.devices;
  state.links = restored.links;
  // Terminal sessions for devices the restored topology lacks would otherwise
  // linger (and the active terminal could point at a vanished device).
  const gone = state.terminalSessions.map(s => s.deviceId).filter((id): id is string => !!id && !restored.devices.some((d: any) => d.id === id));
  if (gone.length) dropTerminalSessions(gone);
  state.selectedId = restored.selectedId;
  state.configuringId = restored.configuringId;
  state.nameCounters = { ...freshNameCounters(), ...(restored.nameCounters || {}) };
  state.linkStartId = null;
  state.selectedLinkId = null;
  state.drag = null;
  state.panDrag = null;
  // The restored topology may not contain the devices/links the saved captures
  // reference — clear the capture archive so the packet list can't dangle.
  resetCaptureState();
  sync().syncPanel();
  sync().syncSimLog();
  // Restoring a different topology can change which ports the spanning tree
  // blocks, and the snapshot's MAC tables were learnt over whatever cabling
  // stood when it was taken — flush them and recompute (also renders).
  linksChanged();
}

// Undo/redo replace the topology; an active run must be torn down first,
// through the engine's own stopSimulation (bridged). The hand-rolled teardown
// that lived here stopped the status but not the animation loop, the boot
// queue, or the transport pill — and redo had no guard at all.
function cancelActiveRun(): void {
  if (state.simulation.status === "running" || state.simulation.status === "paused") sync().stopSimulation?.();
}

export function undo(): void {
  cancelActiveRun();
  const snapshot = state.undoStack.pop();
  if (!snapshot) return;
  state.redoStack.push(networkSnapshot()); // so redo can return here
  if (state.redoStack.length > 80) state.redoStack.shift();
  restoreSnapshot(snapshot);
  syncUndoButton();
}

export function redo(): void {
  cancelActiveRun();
  const snapshot = state.redoStack.pop();
  if (!snapshot) return;
  // Re-entering this state must land on the undo stack without clearing redo.
  if (state.undoStack[state.undoStack.length - 1] !== networkSnapshot()) {
    state.undoStack.push(networkSnapshot());
    if (state.undoStack.length > 80) state.undoStack.shift();
  }
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
