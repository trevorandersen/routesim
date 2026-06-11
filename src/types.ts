export type DeviceType = "computer" | "server" | "switch" | "router" | "firewall" | "lan";
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

export interface ConsoleState {
  open: boolean;
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
  prefixLength?: number;  // subnet prefix for the interface network (default 24)
  macAddress: string;
  arpTable: ArpEntry[];
  dhcpLeases: DhcpLease[];
  vlanTag: number | null;
  natRole?: "inside" | "outside";  // Cisco-style `ip nat inside|outside` mark
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
  prefixLength?: number;  // subnet prefix (default 24)
  gatewayIpv4Address: string;
  macAddress: string;
  arpTable: ArpEntry[];
  // TCP listener model: undefined = accept connections on any port (permissive
  // teaching default); a list = only these ports answer SYN, others send RST.
  openPorts?: number[];
  // The resolver (/etc/resolv.conf nameserver). Set by hand or learned via
  // DHCP option 6. Empty/undefined = names cannot be resolved.
  dnsServerIp?: string;
}

// One dnsmasq A-record: `address=/name/ip`.
export interface DnsRecord {
  name: string;
  ip: string;
}

// A server is a host (same L2/L3 endpoint behaviour as a computer) that also
// runs dnsmasq — DNS A-records plus DHCP, exactly like the real daemon: DHCP
// activates when a dhcp-range is set, and stopping the service stops both.
export interface ServerConfig extends ComputerConfig {
  dnsmasqRunning?: boolean;     // systemctl start/stop dnsmasq (default true)
  dnsRecords?: DnsRecord[];     // address=/name/ip lines
  dhcpRangeStart?: string;      // dhcp-range=<start>,<end> — presence enables DHCP
  dhcpRangeEnd?: string;
  dhcpRouterIp?: string;        // dhcp-option=option:router,<ip> (default: the server itself)
  dhcpLeases?: DhcpLease[];
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

// One PAT (overload) translation: an inside flow mapped onto the router's
// outside interface address. `insidePort`/`outsidePort` hold the TCP source
// port, the ICMP sequence, or the DNS transaction id used as the flow identifier.
export interface NatEntry {
  protocol: "icmp" | "tcp" | "udp";
  insideIp: string;
  insidePort: number;
  outsideIp: string;
  outsidePort: number;
  destIp: string;
}

export interface RouterConfig {
  ethernetPorts: number;
  serialPorts: number;
  interfaces: RouterInterface[];
  staticRoutes?: StaticRoute[];
  rip?: RipConfig;
  natTranslations?: NatEntry[];   // live PAT table (interfaces carry natRole marks)
  rules?: FirewallRule[];         // netfilter INPUT/FORWARD rules (always available)
  policy?: Record<string, "accept" | "drop">;
}

export interface LanConfig {
  anchorId?: string;
  members: string[];
  absorbedLans?: string[];
}

// A transparent inline firewall: a 2-port node that bridges ARP and filters
// IPv4 on the FORWARD chain (first match wins, else the chain policy). Matches
// L3 fields plus TCP destination ports (`-p tcp --dport`). See
// docs/src/firewall.md.
export type FirewallTarget = "accept" | "drop" | "reject";
export interface FirewallRule {
  chain: string;                              // "forward" (v1); "input"/"output" reserved
  target: FirewallTarget;
  protocol?: "icmp" | "udp" | "tcp" | "all";  // default "all"
  src?: string;                               // IPv4 or CIDR
  dst?: string;                               // IPv4 or CIDR
  icmpType?: string;                          // e.g. "echo-request"
  dport?: number;                             // TCP destination port (with protocol "tcp")
}
export interface FirewallConfig {
  ethernetPorts: number;
  rules: FirewallRule[];
  policy: Record<string, "accept" | "drop">;  // chain → default policy
}

// Permissive superset (every field optional) so existing `device.config?.x`
// access sites compile unchanged, while typos and wrong field types are caught.
// The strict per-type interfaces above type the normalise layer and the
// asComputer/asSwitch/asRouter/asLan accessors.
export type DeviceConfig = Partial<ComputerConfig & ServerConfig & SwitchConfig & RouterConfig & FirewallConfig & LanConfig>;

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
  icmpType: 8 | 0 | 11;   // 8 = echo request, 0 = echo reply, 11 = time exceeded
  sequence: number;
}

export type TcpFlags = "syn" | "syn-ack" | "ack" | "rst";

export interface TcpPayload {
  type: "tcp";
  srcPort: number;
  dstPort: number;
  flags: TcpFlags;
}

export interface DhcpPayload {
  type: "dhcp";
  messageType: "discover" | "offer" | "request" | "ack";
  transactionId: string;
  clientMac: string;
  assignedIp?: string;
  prefixLength?: number;  // subnet-mask option carried in Offer/ACK
  gatewayIp?: string;
  serverIp?: string;
  requestedIp?: string;
  dnsServerIp?: string;   // DNS-server option (6) carried in Offer/ACK
}

// A DNS exchange over UDP/53: one question (an A-record name), one answer
// (the address, or null = NXDOMAIN). `id` is the transaction identifier —
// it also serves as the PAT flow id when the query crosses a NAT router.
export interface DnsPayload {
  type: "dns";
  op: "query" | "response";
  id: number;
  name: string;
  address: string | null;
}

export interface Ipv4Payload {
  type: "ipv4";
  srcIp: string;
  dstIp: string;
  ttl: number;
  protocol: number;   // 1 = ICMP, 6 = TCP, 17 = UDP (DHCP/DNS)
  payload: IcmpPayload | DhcpPayload | TcpPayload | DnsPayload;
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
  mode: "ping" | "dhcp" | "tcp" | "dns";
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
  pingResponderIp: string | null;   // who answered (echo reply, or a router's TTL-exceeded)
  pingTimeExceeded: boolean;         // the last answer was an ICMP Time-Exceeded
  tcpSuccess: boolean;               // three-way handshake completed (mode "tcp")
  tcpRefused: boolean;               // destination answered RST (port closed)
  tcpTargetPort: number | null;
  headless: boolean;                 // running synchronously (no animation / terminal output)
  dnsName: string | null;            // name being resolved (DNS flows and ping/tcp-by-name)
  dnsResolvedIp: string | null;      // the answer, once the DNS response arrives
  resolveThen: "ping" | "tcp" | null; // follow-on flow the origin starts after resolution
  dhcpOfferTaken: boolean;           // client accepted an Offer (ignore competing servers)
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
  console: ConsoleState;
  activeScenarioId: string | null;
  options: DisplayOptions;
  nameCounters: Record<DeviceType, number>;
  configStore: ConfigStore;
  undoStack: string[];
  redoStack: string[];
  inspectedFrame: EthernetFrame | null;  // click-a-packet: frame shown in the inspector
  isApplyingCompositeChange: boolean;
  simulation: SimulationState;
  portSelection: PortSelectionState | null;
}
