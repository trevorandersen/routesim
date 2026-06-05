export type DeviceType = "computer" | "switch" | "router" | "lan";
export type PortMode = "access" | "trunk";

export interface Point {
  x: number;
  y: number;
}

export interface TerminalLine {
  kind: string;
  text: string;
}

export interface TerminalState {
  open: boolean;
  deviceId: string | null;
  mode: string;
  interfacePeerId: string | null;
  interfaceVlanTag: number | null;
  lines: TerminalLine[];
  history: string[];
  historyIndex: number;
}

export interface DisplayOptions {
  showDeviceNames: boolean;
  showIpAddresses: boolean;
  showMacAddresses: boolean;
  displayOptionsOpen: boolean;
  networkPanelOpen: boolean;
}

export interface ArpEntry {
  ipv4Address: string;
  macAddress: string;
}

export interface MacTableEntry {
  vlan: string;
  macAddress: string;
  type: string;
  port: string;
}

export interface Vlan {
  id: number;
  name: string;
}

export interface DhcpLease {
  macAddress: string;
  ipv4Address: string;
}

export interface RouterInterface {
  peerId: string;
  type: string;
  name: string;
  ipv4Address: string;
  macAddress: string;
  arpTable: ArpEntry[];
  dhcpLeases: DhcpLease[];
  vlanTag: number | null;
}

export interface RouteEntry {
  network: string;       // "192.168.1.0/24"
  nextHop: string;       // next-hop IP, or "" for connected
  interface?: string;    // egress interface name (for display)
  type: "C" | "S" | "R"; // Connected, Static, RIP
  metric: number;        // 0=connected, 1=static, 2+=RIP
}

export interface StaticRoute {
  network: string;
  nextHop: string;
}

export interface RipRoute {
  network: string;
  nextHop: string;
  interface?: string;
  metric: number;
}

export interface RipConfig {
  enabled: boolean;
  networks: string[];
  passiveInterfaces: string[];
  learnedRoutes: RipRoute[];
}

// --- Per-device config shapes (see normalise.ts) ---

export interface ComputerConfig {
  ipv4Address: string;
  gatewayIpv4Address: string;
  macAddress: string;
  arpTable: ArpEntry[];
}

export interface SwitchConfig {
  managed: boolean;
  ethernetPorts: number;
  macTable: MacTableEntry[];
  vlans?: Vlan[];
  portVlans?: Record<string, number>;
  portModes?: Record<string, PortMode>;
  trunkAllowedVlans?: Record<string, number[]>;
  trunkNativeVlans?: Record<string, number>;
}

export interface RouterConfig {
  ethernetPorts: number;
  serialPorts: number;
  interfaces: RouterInterface[];
  staticRoutes?: StaticRoute[];
  rip?: RipConfig;
}

export interface LanConfig {
  anchorId?: string;
  members: string[];
  absorbedLans?: string[];
}

// Permissive superset (every field optional) so existing `device.config?.x`
// access sites compile unchanged, while typos and wrong field types are caught.
// The strict per-type interfaces above type the normalise layer and the
// asComputer/asSwitch/asRouter/asLan accessors.
export type DeviceConfig = Partial<ComputerConfig & SwitchConfig & RouterConfig & LanConfig>;

export interface DragState {
  id: string;
  dx: number;
  dy: number;
  undoSnapshot: string | null;
}

export interface PanDragState {
  startX: number;
  startY: number;
  panX: number;
  panY: number;
}

export interface InspectorResizeState {
  startX: number;
  startWidth: number;
}

export interface Device {
  id: string;
  type: DeviceType;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  config: DeviceConfig;
  hidden?: boolean;
  poweredOff?: boolean;
  collapsedBy?: string;
}

export interface FrameHistoryEntry {
  step: number;
  frame: EthernetFrame;
  fromDeviceId: string;
  toDeviceId: string;
  timestamp: number;
}

export interface Link {
  id: string;
  from: string;
  to: string;
  fromPort?: number;   // 1-based port number on the "from" device
  toPort?: number;     // 1-based port number on the "to" device
  hidden?: boolean;
  collapsedBy?: string;
  proxy?: boolean;
  visibleBeforeParentCollapse?: boolean;
  frameHistory?: FrameHistoryEntry[];
}

export interface ConfigStore {
  version: number;
  configs: Record<string, any>;
}

// --- Frame-level simulation types ---

export interface ArpPayload {
  type: "arp";
  operation: "request" | "reply";
  senderMac: string;
  senderIp: string;
  targetMac: string;
  targetIp: string;
}

export interface IcmpPayload {
  type: "icmp";
  icmpType: 8 | 0;   // 8 = echo request, 0 = echo reply
  sequence: number;
}

export interface DhcpPayload {
  type: "dhcp";
  messageType: "discover" | "offer" | "request" | "ack";
  transactionId: string;
  clientMac: string;
  assignedIp?: string;
  gatewayIp?: string;
  serverIp?: string;
  requestedIp?: string;
}

export interface Ipv4Payload {
  type: "ipv4";
  srcIp: string;
  dstIp: string;
  ttl: number;
  protocol: number;   // 1 = ICMP, 17 = UDP/DHCP
  payload: IcmpPayload | DhcpPayload;
}

export interface EthernetFrame {
  id: string;
  srcMac: string;
  dstMac: string;
  etherType: 0x0806 | 0x0800;   // ARP or IPv4
  vlanTag: number | null;
  payload: ArpPayload | Ipv4Payload;
}

export interface SimEvent {
  type: "frame_arrive";
  frame: EthernetFrame;
  deviceId: string;
  fromDeviceId: string | null;
  linkId: string | null;
}

export interface ActiveTransit {
  frame: EthernetFrame;
  linkId: string;
  fromDeviceId: string;
  toDeviceId: string;
  progress: number;
  startTime: number;
}

export interface SimLogEntry {
  step: number;
  deviceId: string;
  deviceName: string;
  action: string;
  kind: string;    // "sim-arp" | "sim-icmp" | "sim-learn" | "sim-forward" | "sim-drop"
  summary: string;
}

export interface SimulationState {
  status: "idle" | "running" | "paused" | "done";
  mode: "ping" | "dhcp";
  events: SimEvent[];
  log: SimLogEntry[];
  transits: ActiveTransit[];
  pendingArp: Record<string, EthernetFrame[]>;
  speed: number;
  autoPlay: boolean;
  stepIndex: number;
  originDeviceId: string | null;
  pingTargetIp: string | null;
  pingSuccess: boolean;
  pingTtl: number;
  dhcpSuccess: boolean;
  dhcpAssignedIp: string | null;
  dhcpAssignedGateway: string | null;
}

export interface PortOption {
  name: string;
  port: number;
  available: boolean;
  connectedTo: string | null;
}

export interface PortSelectionState {
  fromId: string;
  toId: string;
  fromPorts: PortOption[];
  toPorts: PortOption[];
  selectedFrom: number | null;
  selectedTo: number | null;
  showFromPicker: boolean;
  showToPicker: boolean;
}

export interface AppState {
  tool: string;
  devices: Device[];
  links: Link[];
  selectedId: string | null;
  selectedLinkId: string | null;
  configuringId: string | null;
  linkStartId: string | null;
  pointer: Point | null;
  drag: DragState | null;
  panDrag: PanDragState | null;
  pan: Point;
  scale: number;
  theme: string;
  inspectorWidth: number;
  inspectorResize: InspectorResizeState | null;
  terminal: TerminalState;
  options: DisplayOptions;
  nextComputer: number;
  nextSwitch: number;
  nextRouter: number;
  configStore: ConfigStore;
  configFileHandle: any;
  undoStack: string[];
  isApplyingCompositeChange: boolean;
  simulation: SimulationState;
  portSelection: PortSelectionState | null;
}
