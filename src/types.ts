export type DeviceType = "computer" | "laptop" | "kali" | "server" | "switch" | "router" | "firewall" | "hub" | "access-point" | "internet" | "ids" | "attacker" | "lan";
export type PortMode = "access" | "trunk";

export interface Point {
  x: number;
  y: number;
}

export interface TerminalLine {
  kind: string;
  text: string;
  injected?: boolean;  // issued by the simulator (a GUI inspector edit), not typed by the user
}

// One terminal session per device: its own scrollback, command history, and
// CLI mode (the router mode machine lives here, so config mode survives
// switching tabs). `state.terminal` points at the active session; all open
// sessions live in `state.terminalSessions` (the dock's tab order).
export interface TerminalSession {
  deviceId: string | null;   // null = detached placeholder (open-failure messages)
  mode: string;
  interfacePeerId: string | null;
  interfaceVlanTag: number | null;
  lines: TerminalLine[];
  history: string[];
  historyIndex: number;
}

export interface ConsoleState {
  lines: TerminalLine[];
  history: string[];
  historyIndex: number;
}

// The bottom dock: one resizable panel hosting the per-device terminal
// sessions (as tabs), the command console, and the sim log.
export type DockTab = "terminal" | "console" | "simlog";
export interface DockState {
  open: boolean;
  activeTab: DockTab;
  height: number;   // px, drag-resizable (drives --terminal-height)
  // Sim-log pane view: the Wireshark-style packet list, or the narrative
  // event log (MAC learns, routing decisions, verdicts).
  logView: "packets" | "events";
  // The packet-list display filter (three ANDed dimensions). See packet-filter.ts.
  logFilter: LogFilter;
  // Which capture the packet list shows: "live" (the running/most-recent
  // sim.capture) or a SavedCapture id. `compareBaseId` ("" = off) is the
  // baseline shown side-by-side on the left in compare mode.
  captureView: string;
  compareBaseId: string;
}

// A completed animated run's packet capture, archived so a later run can be
// compared against it (before/after). Runtime/session only — not serialised.
export interface SavedCapture {
  id: string;
  index: number;        // monotonic run ordinal, for stable labelling
  label: string;        // e.g. "#3 ping PC-A1 ✓"
  mode: string;         // the sim mode that produced it
  entries: CaptureEntry[];
}

// The sim-log packet-list display filter. `protocols` is the active protocol
// chips (OR within the set; empty = all), `device` a device id the frame must
// have crossed ("" = any), and `expr` a free-text Wireshark-style expression
// ("" = no constraint). All three are ANDed.
export interface LogFilter {
  protocols: string[];
  device: string;
  link?: string;   // a link id — a frame shows only if it crossed this wire (undefined/"" = any); set by the link inspector's "open in packet log" jump
  expr: string;
}

export interface DisplayOptions {
  showDeviceNames: boolean;
  showIpAddresses: boolean;
  showMacAddresses: boolean;
  packetCallouts: boolean;   // draw a field callout beside each in-flight frame (off by default)
  networkPanelOpen: boolean;
  // Simulation-behaviour toggles (pedagogical): whether booting hosts attempt
  // DHCP, and whether a failed DHCP falls back to link-local APIPA.
  autoDhcp: boolean;
  apipaFallback: boolean;
  // "Silent" toggles: resolve these instantly with no animated frames or packet
  // rows — the engine still runs the exchange, it just isn't shown. Handy once a
  // learner understands the mechanism and wants the higher-layer flow uncluttered.
  silentArp: boolean;
  silentDhcp: boolean;
  silentDns: boolean;
  silentWifi: boolean;   // suppress the 802.11 association/auth frame animation
  silentStp: boolean;    // suppress the BPDU (spanning-tree) frame animation
  // When on, a device *name* used as a target (e.g. `ping PC-A1`) resolves
  // straight to its IP with no DNS query — a built-in hosts file. When off, a
  // name needs a reachable DNS server (which auto-resolves device hostnames).
  // Defaults on for topologies, off when a scenario is loaded.
  instantDns: boolean;
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

// The "named view" of a router interface that `routerInterfacesWithNames` builds:
// the resolved port name + peer plus the underlying `RouterInterface` config.
// Distinct from the flat `RouterInterface` (address at top level vs under .config)
// so the two are not silently interchanged on the routing hot path.
export interface NamedRouterIface {
  name: string;
  type: string;
  peer: Device | null;
  peerId: string;
  config: Partial<RouterInterface>;
  link?: Link | null;   // the cable to the peer (so routing/RIP can honour link.shutdown)
}

// An IPv4 CIDR parsed to integers (utils.ts: parseCidr/cachedCidr/cidrHas) —
// what the routing, RIP, and firewall hot paths compare instead of strings.
export interface Cidr {
  readonly net: number;      // network address, already masked (unsigned 32-bit)
  readonly mask: number;     // netmask (unsigned 32-bit), e.g. 0xffffff00 for /24
  readonly prefix: number;   // prefix length 0–32
}

export interface RouteEntry {
  network: string;       // "192.168.1.0/24"
  // `network` parsed once when the table is built (null if it isn't a valid
  // CIDR — such a route never matches), so a lookup compares integers.
  cidr: Cidr | null;
  nextHop: string;       // next-hop IP, or "" for connected
  interface?: string;    // egress interface name (for display)
  // Stable identity of a connected route's interface (derived names shift as
  // cables change), so routingLookup resolves the SELECTED route's own stored
  // interface rather than the first raw one whose subnet contains the target.
  peerId?: string;
  vlanTag?: number | null;
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
  // How the current address was assigned: hand-configured, leased via DHCP, or
  // self-assigned link-local after DHCP failed. A bare IP with no source reads
  // as static (e.g. built-in topologies). Cleared when the address is flushed.
  ipSource?: "static" | "dhcp" | "apipa";
  gatewayIpv4Address: string;
  macAddress: string;
  arpTable: ArpEntry[];
  // TCP listener model: undefined = accept connections on any port (permissive
  // teaching default); a list = only these ports answer SYN, others send RST.
  openPorts?: number[];
  // The resolver (/etc/resolv.conf nameserver). Set by hand or learned via
  // DHCP option 6. Empty/undefined = names cannot be resolved.
  dnsServerIp?: string;
  // 802.1X supplicant credentials — the identity/password the host presents to
  // an authenticator port. Absent = the host can't authenticate on an `auto` port.
  dot1x?: { identity: string; password: string };
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
  // RADIUS authentication server (the 802.1X back end): the user database an
  // authenticator validates supplicants against. Presence enables the service.
  radius?: { users: { identity: string; password: string }[] };
  // HTTP service: when enabled, the server answers an HTTP GET (on a listening
  // port, default 80) with 200 OK — the application layer riding the TCP
  // handshake. `httpTitle` is the served page's one-line body.
  httpEnabled?: boolean;
  httpTitle?: string;
}

// Spanning Tree (802.1D) per managed switch. `enabled` and `priority` are
// configuration (persisted, round-tripped through JSON/script). Everything else
// is *derived* by runStpConvergence (stp.ts) before each run and is NOT
// serialised — it recomputes from the live topology, like RIP's learnedRoutes.
export type StpRole = "root" | "designated" | "alternate" | "disabled";
export type StpState = "forwarding" | "blocking";
export interface StpPortInfo {
  role: StpRole;
  state: StpState;
}
export interface StpConfig {
  enabled: boolean;
  priority?: number;                     // bridge priority (default 32768); the high half of the bridge id
  bridgeId?: string;                     // derived: "priority.baseMAC"
  rootId?: string;                       // derived: the elected root's bridge id (=== bridgeId on the root)
  rootCost?: number;                     // derived: this bridge's least-cost path to the root (hops)
  ports?: Record<string, StpPortInfo>;   // derived: port name → role/state
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
  // 802.1X port control per port (the authenticator role). Absent / "force-authorized"
  // = open (today's behaviour); "auto" = require 802.1X; "force-unauthorized" = closed.
  portAuth?: Record<string, "auto" | "force-authorized" | "force-unauthorized">;
  // Spanning Tree on this managed switch (default enabled). See StpConfig.
  stp?: StpConfig;
  // Port mirroring (SPAN): copy traffic to a monitor port (where an IDS listens).
  mirror?: MirrorSession;
}

// A SPAN (port-mirroring) session on a managed switch: copy traffic from the
// source ports (or every port, when `sources` is empty/absent) to the `dest`
// monitor port. The monitor port carries only mirrored traffic — it is excluded
// from normal forwarding. Modelled on SONiC `config mirror_session span add`.
export interface MirrorSession {
  name: string;
  dest: string;        // monitor port, e.g. "Ethernet8"
  sources?: string[];  // mirrored source ports; empty/absent = all ports
}

// A passive Snort IDS sensor (network monitor). It attaches to a switch's SPAN
// monitor port, watches the mirrored copy of traffic, and raises alerts when a
// frame matches a rule — it is never in the data path, so it cannot drop. Rules
// are stored as raw Snort rule text (the `local.rules` file); alerts are runtime
// fast-format log lines (not serialised).
export interface IdsConfig {
  // `idsRules` (not `rules`) to avoid colliding with FirewallConfig.rules in the
  // permissive DeviceConfig superset.
  idsRules?: string[];   // Snort rule lines (local.rules)
  alerts?: string[];     // fast-alert log lines (runtime; not persisted)
}

// A "Red Team" host — a Kali Linux box that, when run, launches simulated
// attacks against a target: a TCP SYN port scan, an ICMP/ARP ping sweep, and
// gratuitous-ARP cache poisoning (MITM). It is a real host (IP/MAC/ARP), so it
// extends ComputerConfig; the attack behaviour is generated, not user-typed.
export type AttackKind = "scan" | "sweep" | "arp-spoof";
export interface AttackerConfig extends ComputerConfig {
  attackTarget?: string;   // scan target IP, or a sweep subnet/host
  attacks?: AttackKind[];  // which behaviours are enabled (autonomous on Play)
  spoofIp?: string;        // the IP to impersonate in an ARP-spoof (default: the gateway)
  attackLog?: string[];    // last run's findings (runtime; not persisted)
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

// A static destination-NAT (port-forward): an outside-facing IP:port is
// published to an inside server. `ip nat inside source static tcp …`.
export interface PortForward {
  proto: "tcp";
  outsideIp: string;
  outsidePort: number;
  insideIp: string;
  insidePort: number;
}

export interface RouterConfig {
  ethernetPorts: number;
  serialPorts: number;
  // Placement archetype (teaching role): a "border"/edge router faces the
  // outside (the natural place for NAT + a firewall), an "internal"/core router
  // does interior forwarding only. Cosmetic + a default NAT-marking convenience;
  // absent = a plain (internal) router.
  role?: "border" | "internal";
  interfaces: RouterInterface[];
  staticRoutes?: StaticRoute[];
  rip?: RipConfig;
  natTranslations?: NatEntry[];   // live PAT table (interfaces carry natRole marks)
  portForwards?: PortForward[];   // static destination-NAT (port-forwarding) rules
  rules?: FirewallRule[];         // netfilter INPUT/FORWARD rules (always available)
  policy?: Record<string, "accept" | "drop">;
  ruleLang?: RuleLang;            // which language the shell view / form / export speak
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
// The rule language a firewall/router presents its one netfilter ruleset in.
// Both front doors (the `iptables` and `nft` shells) always parse into the same
// FirewallRule model; this only picks the native-view, add-rule-form and script
// export dialect. Default (absent) is iptables. See docs/src/firewall.md.
export type RuleLang = "iptables" | "nftables";
// Connection-tracking state (netfilter conntrack). The model assigns only "new"
// (first packet of a flow) and "established" (return traffic of a flow we let
// out); "related"/"invalid" parse in a rule but are never assigned (a documented
// simplification — see docs/src/firewall.md).
export type ConnState = "new" | "established" | "related" | "invalid";
export interface FirewallRule {
  chain: string;                              // "forward" (v1); "input"/"output" reserved
  target: FirewallTarget;
  protocol?: "icmp" | "udp" | "tcp" | "all";  // default "all"
  src?: string;                               // IPv4 or CIDR
  dst?: string;                               // IPv4 or CIDR
  icmpType?: string;                          // e.g. "echo-request"
  dport?: number;                             // TCP destination port (with protocol "tcp")
  states?: ConnState[];                       // -m state --state / -m conntrack --ctstate
  rejectWith?: string;                        // REJECT response, e.g. "tcp-reset" | "icmp-port-unreachable"
}
// A tracked connection (one per device, runtime only). The "original" direction
// is the first packet; a packet matching the swapped tuple is the reply.
export interface ConntrackEntry {
  proto: string;                              // "tcp" | "udp" | "icmp" | "other"
  srcIp: string; dstIp: string;
  srcPort: number; dstPort: number;
  established: boolean;                        // a reply has been seen
}
export interface FirewallConfig {
  ethernetPorts: number;
  rules: FirewallRule[];
  policy: Record<string, "accept" | "drop">;  // chain → default policy
  ruleLang?: RuleLang;                         // native-view / form / export dialect
}

// A hub is a layer-1 repeater — a "legacy" device. No MAC table, no VLANs, no
// management: it copies every incoming frame out all other ports.
export interface HubConfig {
  ethernetPorts: number;
}

// WiFi association fields. On an access point, `ssid` is the network it
// broadcasts; on a laptop, the network it is configured to join. `wifiPassword`
// is the optional WPA2 PSK — empty/undefined means an open network.
export interface WifiConfig {
  ssid?: string;
  wifiPassword?: string;
}

// MACsec (802.1AE) per-link key, keyed by the peer device id (so it's naturally
// per-link and uniform across device types). Either a static pre-shared `cak`
// (both ends must match for the link to secure), or `derive` — the key is
// bootstrapped from a successful 802.1X exchange on the link (MKA), so no PSK is
// configured and the link only secures after authentication. `mode` "must" drops
// traffic when the link can't be secured; "should" falls back to plaintext.
export interface MacsecConfig {
  macsec?: Record<string, { cak?: string; mode: "must" | "should"; derive?: boolean }>;
}

// Permissive superset (every field optional) so existing `device.config?.x`
// access sites compile unchanged, while typos and wrong field types are caught.
// The strict per-type interfaces above type the normalise layer and the
// asComputer/asSwitch/asRouter/asLan accessors.
export type DeviceConfig = Partial<ComputerConfig & ServerConfig & SwitchConfig & RouterConfig & FirewallConfig & HubConfig & WifiConfig & MacsecConfig & IdsConfig & AttackerConfig & LanConfig>;

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
  name?: string;       // user-given name; unnamed links derive "A ↔ B" (linkName in devices.ts)
  wireless?: boolean;  // a WiFi association (laptop ↔ access point) rather than a cable
  dot1xAuthorized?: boolean; // an 802.1X `auto` port that has authenticated its supplicant (data allowed)
  stpBlocked?: boolean; // a Spanning Tree alternate port blocks data on this link (derived by stp.ts; not serialised)
  shutdown?: boolean;  // administratively down — present in the topology but carries no traffic
  bandwidth?: number;  // capacity in Mbps (the streams sim's input; metadata in packet mode)
  latency?: number;    // ms — slows this link's transit animation (a far/WAN link crawls)
  loss?: number;       // % drop probability applied per forwarded traversal (animated runs only)
  fromPort?: number;   // 1-based port number on the "from" device
  toPort?: number;     // 1-based port number on the "to" device
  hidden?: boolean;
  collapsedBy?: string;
  proxy?: boolean;
  visibleBeforeParentCollapse?: boolean;
  frameHistory?: FrameHistoryEntry[];
}

// A serialised topology (the JSON export shape). Device/link config sub-objects
// are type-specific and re-normalised on load, so they stay loosely typed.
export interface SerialisedDevice {
  id: string;
  type: DeviceType;
  name: string;
  x: number;
  y: number;
  hidden?: boolean;
  poweredOff?: boolean;
  collapsedBy?: string;
  config?: Record<string, any>;
}
export interface SerialisedLink {
  from: string;
  to: string;
  name?: string;
  wireless?: boolean;   // a laptop ↔ access-point association (drawn dotted; not an ethernet port)
  shutdown?: boolean;
  bandwidth?: number;
  latency?: number;
  loss?: number;
  fromPort?: number;
  toPort?: number;
  hidden?: boolean;
  collapsedBy?: string;
  proxy?: boolean;
}
export interface SerialisedTopology {
  version: number;
  devices: SerialisedDevice[];
  links: SerialisedLink[];
}

export interface ConfigStore {
  version: number;
  configs: Record<string, SerialisedTopology>;
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

// The embedded original datagram of an ICMP error (types 11/3). Real ICMP
// carries the original IP header + first 8 bytes — enough to identify the flow
// the error refers to; this is the sim's equivalent. It is what lets a NAT
// router match the error to a translation and deliver it to the inside sender
// (traceroute from behind NAT depends on it).
export interface IcmpOriginal {
  srcIp: string;
  dstIp: string;
  proto: "icmp" | "tcp" | "udp";
  flowId: number;   // icmp echo sequence / tcp source port / dns transaction id
}

export interface IcmpPayload {
  type: "icmp";
  icmpType: 8 | 0 | 11 | 3;   // 8 = echo request, 0 = echo reply, 11 = time exceeded, 3 = dest unreachable
  sequence: number;
  original?: IcmpOriginal;    // errors (11/3) carry the offending datagram's summary
}

export type TcpFlags = "syn" | "syn-ack" | "ack" | "rst";

export interface TcpPayload {
  type: "tcp";
  srcPort: number;
  dstPort: number;
  flags: TcpFlags;
  http?: HttpInfo;   // HTTP application data carried on an established (ACK) segment
}

// HTTP/1.1 application data on a TCP segment — a GET request or its response.
// Carried on a flags:"ack" segment (data on the established connection), so the
// packet list shows it as HTTP rather than a bare ACK.
export interface HttpInfo {
  kind: "request" | "response";
  method?: string;       // request: "GET"
  path?: string;         // request: "/"
  host?: string;         // request: the Host header
  status?: number;       // response: 200 / 404
  statusText?: string;   // response: "OK" / "Not Found"
  title?: string;        // response: the served page's one-line body
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

// An 802.11 management / EAPOL frame exchanged between a laptop and its access
// point when it joins: discovery (probe), open-system authentication, the
// association, and — on a secured network — the WPA2 4-way key handshake.
export type Dot11Subtype =
  | "probe-req" | "probe-resp"
  | "auth-req" | "auth-resp"
  | "assoc-req" | "assoc-resp"
  | "eapol-start" | "eapol-m1" | "eapol-m2" | "eapol-m3" | "eapol-m4"
  | "deauth";   // the AP rejects the client (e.g. a WPA2 key mismatch — wrong password)

export interface Dot11Payload {
  type: "dot11";
  subtype: Dot11Subtype;
  ssid: string;
}

// An 802.1X port-authentication frame: EAP over LAN between the supplicant (host)
// and authenticator (switch port), and RADIUS between the authenticator and the
// authentication server. One reactive exchange, three roles.
export type Dot1xSubtype =
  | "eapol-start" | "eap-req-id" | "eap-resp-id"
  | "radius-request" | "radius-accept" | "radius-reject"
  | "eap-success" | "eap-failure";

export interface Dot1xPayload {
  type: "dot1x";
  subtype: Dot1xSubtype;
  identity?: string;   // the supplicant identity, carried through the exchange
  // The initiating host's MAC — the session key. Identities need not be unique;
  // correlating by identity alone validated one host's password and authorised
  // another host's port.
  supplicantMac?: string;
}

// A Spanning Tree (802.1D) BPDU exchanged between bridges. A Configuration BPDU
// carries the sender's view of the tree — the root it knows, its cost to that
// root, and its own bridge + port id — which is how bridges elect a root and
// settle port roles. Real BPDUs are LLC-encapsulated to the bridge group
// address 01:80:C2:00:00:00 with no EtherType; we keep that faithful
// destination MAC and tag the frame with a sentinel EtherType (0x0802).
export interface BpduPayload {
  type: "bpdu";
  flavour: "config" | "tcn";   // Configuration BPDU, or a Topology Change Notification
  rootId: string;              // the root bridge id this BPDU advertises
  bridgeId: string;            // the sending bridge's id
  rootCost: number;            // the sending bridge's cost to the root
  portId: string;              // the sending port (e.g. "Ethernet2")
}

export interface EthernetFrame {
  id: string;
  srcMac: string;
  dstMac: string;
  etherType: 0x0806 | 0x0800 | 0x888e | 0x0802;   // ARP, IPv4, 802.11/EAPOL/802.1X, or STP (BPDU sentinel)
  vlanTag: number | null;
  payload: ArpPayload | Ipv4Payload | Dot11Payload | Dot1xPayload | BpduPayload;
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
  latencyFactor?: number;  // multiplies this dot's crossing time (per-link latency); 1 = normal
  silent?: boolean;        // a "silent" ARP/DHCP/DNS frame: delivered instantly, not drawn or captured
  prevFrame?: EthernetFrame;  // the frame this hop was derived from — for the callout's rewrite diff (issue #2)
}

export interface SimLogEntry {
  step: number;
  deviceId: string;
  deviceName: string;
  action: string;
  kind: string;    // "sim-arp" | "sim-icmp" | "sim-learn" | "sim-forward" | "sim-drop"
  summary: string;
}

// One row of the Wireshark-style packet list: a frame captured as it crossed
// a wire (one entry per link traversal, like a capture point on every cable).
export interface CaptureEntry {
  no: number;        // 1-based capture number (Wireshark's "No.")
  step: number;      // simulation step it was delivered on
  frame: EthernetFrame;
  fromDeviceId: string;
  toDeviceId: string;
  linkId: string;
  macsec?: boolean;  // traversed a MACsec-secured link — shown encrypted in the packet list
}

// The kind of run a simulation is — one name for the union both run entry
// points (startSimulation / runSimulationHeadless) take.
export type SimMode = SimulationState["mode"];

export interface SimulationState {
  status: "idle" | "running" | "paused" | "done";
  mode: "ping" | "dhcp" | "tcp" | "dns" | "http" | "associate" | "dot1x" | "stp" | "attack";
  events: SimEvent[];
  log: SimLogEntry[];
  capture: CaptureEntry[];   // packet list (animated runs only; capped)
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
  pingUnreachableFrom: string | null; // who answered with an ICMP Destination Unreachable (a REJECT), if anyone
  tcpSuccess: boolean;               // three-way handshake completed (mode "tcp"/"http")
  tcpRefused: boolean;               // destination answered RST (port closed)
  tcpTargetPort: number | null;
  // HTTP (mode "http"): the GET path, and the response once it arrives.
  httpPath: string;
  httpSuccess: boolean;              // a 2xx response came back
  httpStatus: number | null;        // the response status code
  httpStatusText: string | null;
  httpServerTitle: string | null;   // the served page's one-line body
  headless: boolean;                 // running synchronously (no animation / terminal output)
  dnsName: string | null;            // name being resolved (DNS flows and ping/tcp/http-by-name)
  dnsResolvedIp: string | null;      // the answer, once the DNS response arrives
  resolveThen: "ping" | "tcp" | "http" | null; // follow-on flow the origin starts after resolution
  dhcpOfferTaken: boolean;           // client accepted an Offer (ignore competing servers)
  dhcpSuccess: boolean;
  dhcpAssignedIp: string | null;
  dhcpAssignedGateway: string | null;
  wifiAssociated: boolean;           // the 802.11 association handshake completed (mode "associate")
  dot1xAuthorized: boolean;          // the 802.1X EAP exchange authorised the port (mode "dot1x")
  // Why the 802.1X login failed, stated by the handler that decided it (the
  // port is force-unauthorized, no RADIUS server, Access-Reject). Reset each
  // run; the post-mortem puts it in `diagnosis`.
  dot1xFailure: string | null;
  stormDetected: boolean;            // a frame came back round a switching loop (no spanning tree), or the run hit the storm backstop
  // The run's post-mortem (finishSimulation): plain-language reasons the origin's
  // flow failed that no single step could state — an ARP nobody answered (its
  // queued frames never sent), a broadcast storm. Empty when the run met its
  // goal, except for a storm. Reset each run; also on SimResult.
  diagnosis: string[];
  // Why ARP frames were dropped on the way this run, keyed by the address being
  // resolved (a request's targetIp, a reply's senderIp): the data-gate, shut-cable,
  // powered-off and loss reasons the post-mortem quotes instead of guessing "is
  // the address right?". `atOwner` = the frame was headed to a device owning that
  // address (the drop that certainly mattered, not a flooded copy). Reset each run.
  arpDrops: Record<string, { reason: string; atOwner: boolean }[]>;
  // Red-team attack run (mode "attack") findings: open/closed scanned ports and
  // live hosts a sweep discovered. Reset each run; reported in finishSimulation.
  scanOpen: number[];
  scanClosed: number[];
  sweepLive: string[];
  // Netfilter connection tracking, per filtering device (firewall/router), reset
  // each run — drives stateful `-m state` rule matching. deviceId → flow entries.
  conntrack: Record<string, ConntrackEntry[]>;
  // Active DNAT (port-forward) sessions, per router, reset each run — records the
  // outside client of each forwarded connection so the *return* leg is matched
  // precisely (not just any traffic from the inside server's port). deviceId → sessions.
  dnatSessions: Record<string, { clientIp: string; clientPort: number; insideIp: string; insidePort: number; outsideIp: string; outsidePort: number }[]>;
  // Link ids already noted as "loss ignored" this headless run — loss is
  // animated-only (checks stay deterministic), and the divergence is surfaced
  // once per link in the events log rather than silently skipped.
  lossNoted?: Set<string>;
  // Broadcast-storm evidence, reset each run: every (frame lineage, wire,
  // direction, IPv4 TTL) a frame has crossed. Seeing one again means a copy came
  // back round an L2 loop — the storm verdict, identical on both paths.
  loopTrace: Set<string>;
  // Steps this run that put frames on the wire — the storm backstop counts these.
  wireSteps: number;
}

// What a model-layer mutator tells its caller. The model does not decide how a
// result is shown: the canvas puts it on the status line, the console returns
// it, a script import counts it. (Mutators used to write `dom.modeLabel`
// themselves and return void, so console, script and API callers saw a bare
// "Linked" whatever had actually happened.)
export interface MutationResult {
  ok: boolean;          // false = nothing was changed
  error?: string;       // why not (when !ok)
  message?: string;     // what happened, in the learner's words (when ok)
  warnings: string[];   // it happened, but not quite as asked — each says what and why
}

// addLink's result: the cable (new or already there) and whether this call made it.
export interface LinkResult extends MutationResult {
  link?: Link;
  created: boolean;
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
  terminal: TerminalSession;            // the active session (see TerminalSession)
  terminalSessions: TerminalSession[];  // open sessions, in tab order
  dock: DockState;
  console: ConsoleState;
  activeScenarioId: string | null;
  options: DisplayOptions;
  nameCounters: Record<DeviceType, number>;
  configStore: ConfigStore;
  undoStack: string[];
  redoStack: string[];
  inspectedFrame: EthernetFrame | null;  // click-a-packet: frame shown in the inspector
  inspectedCapture: CaptureEntry | null; // selected packet-list row: cross-links the wire + endpoints on the canvas
  savedCaptures: SavedCapture[];         // archived completed runs (for multi-run compare)
  isApplyingCompositeChange: boolean;
  // The faux-cursor tutorial is on screen. While it is, undo/redo are refused
  // (see undoBlockReason in state.ts) and the global shortcuts are gated.
  tutorialActive: boolean;
  simulation: SimulationState;
  portSelection: PortSelectionState | null;
}
