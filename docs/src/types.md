# `src/types.ts` — TypeScript interfaces

The single source of truth for the data model. No runtime code — only `interface`/`type` declarations imported across the codebase.

## Device model

- **`DeviceType`** = `"computer" | "server" | "switch" | "router" | "firewall" | "ids" | "hub" | "lan"`.
- **`Device`** — `id`, `type`, `name`, position/size, `config`, and optional flags (`hidden`, `poweredOff`, `collapsedBy`).
- **Per-type configs** — `ComputerConfig`, `ServerConfig`, `SwitchConfig`, `RouterConfig`, `FirewallConfig`, `IdsConfig`, `LanConfig` describe each device type's `config` shape (e.g. computer: `ipv4Address`/`ipSource` (static/dhcp/apipa)/`macAddress`/`arpTable`/`openPorts`/`dnsServerIp`; server **extends** the computer with the dnsmasq fields — `dnsmasqRunning`/`dnsRecords`/`dhcpRangeStart`/`dhcpRangeEnd`/`dhcpRouterIp`/`dhcpLeases`; switch: `managed`/`ethernetPorts`/`vlans`/`portVlans`/`mirror` (the SPAN session)/…; router: `interfaces`/`staticRoutes`/`rip`/`natTranslations`; firewall: `rules`/`policy`; ids: `idsRules` (raw Snort `local.rules` lines — named `idsRules`, not `rules`, to avoid colliding with `FirewallConfig.rules` in the superset) + `alerts` (the runtime fast-alert log, capped, **not serialised**); hub: just `ethernetPorts` (a layer-1 repeater, no tables); lan: `anchorId`/`members`).
- **`DeviceConfig`** = `Partial<ComputerConfig & ServerConfig & SwitchConfig & RouterConfig & FirewallConfig & IdsConfig & HubConfig & LanConfig>` — a permissive superset where every field is optional. `Device.config` is typed as this.

> **Why a superset, not a discriminated union?** Most code accesses `device.config?.field` generically (e.g. in `engine.ts`, `inspector.ts`). A discriminated union would require narrowing at ~200 call sites. The all-optional superset gives real type-safety (typos and wrong field types are caught; `arpTable` is `ArpEntry[]`, not `any`) with **zero** churn at access sites. Where strictness helps, narrow explicitly.

## Supporting element types

`ArpEntry`, `MacTableEntry`, `Vlan`, `DhcpLease`, `RouterInterface`, `RouteEntry`, `StaticRoute`, `RipRoute`, `RipConfig`, `PortMode`, `DnsRecord`, `NatEntry`, `FirewallRule` (the netfilter rule — target/chain/protocol/src/dst/dport/… plus `states?: ConnState[]` (from `-m state --state` / `-m conntrack --ctstate`) and `rejectWith?: string` (from `--reject-with`, e.g. `"tcp-reset"`)), `ConnState` (`"new" | "established" | "related" | "invalid"` — the netfilter connection-tracking state; only `new`/`established` are ever assigned, while `related`/`invalid` parse in a rule but never match, a documented simplification), `ConntrackEntry` (`proto`/`srcIp`/`dstIp`/`srcPort`/`dstPort`/`established` — one tracked connection; the "original" direction is the first packet, a packet matching the swapped tuple is the reply), `MirrorSession` (`SwitchConfig.mirror` — `name`/`dest`/`sources?`, a managed-switch SPAN session).

## Frames & simulation

- **`EthernetFrame`** — `srcMac`/`dstMac`/`etherType`/`vlanTag`/`payload`. The payload is `ArpPayload | Ipv4Payload` (an L2 frame carries either ARP or IPv4; `Ipv4Payload.payload` is itself `IcmpPayload | DhcpPayload | TcpPayload | DnsPayload`).
- **`SimEvent`, `ActiveTransit`, `SimLogEntry`, `SimulationState`** — the queue, animated dots, log lines, and overall sim status used by `engine.ts`. `SimulationState.conntrack` is `Record<string, ConntrackEntry[]>` — connection tracking per filtering device (firewall/router), runtime only and reset each run.
- **`CaptureEntry`** — one packet-list row: running number, step, frame, endpoint device ids, link id (`sim.capture`).

## App state

- **`AppState`** — the shape of the `state` singleton.
- **`TerminalSession`** — one device CLI session (device id, mode machine, scrollback, history); **`DockState`/`DockTab`** — the bottom dock (`open`, `activeTab`, `height`, `logView`, `logFilter`, `captureView`, `compareBaseId`); **`LogFilter`** — the packet-list display filter (`protocols`/`device`/`expr`, see [packet-filter.md](packet-filter.md)); **`SavedCapture`** — an archived completed run's packet capture (for multi-run compare); **`ConsoleState`** — the command console's lines/history.
- **`DisplayOptions`, `DragState`, `PanDragState`, `InspectorResizeState`, `PortSelectionState`, `PortOption`, `ConfigStore`, `FrameHistoryEntry`, `Link`, `Point`** — supporting state shapes (`Link` carries an optional `name`, `shutdown`, and `bandwidth`/`latency`/`loss`; `ActiveTransit` carries a `latencyFactor`).

## How it fits

Type-only module: it has no runtime cost (esbuild erases it) and no dependencies. Changing the data model starts here. Because esbuild doesn't type-check, type changes can't break the build — run `bunx tsc --noEmit` to validate.
