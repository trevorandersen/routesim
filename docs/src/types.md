# `src/types.ts` — TypeScript interfaces

The single source of truth for the data model. No runtime code — only `interface`/`type` declarations imported across the codebase.

## Device model

- **`DeviceType`** = `"computer" | "server" | "switch" | "router" | "firewall" | "lan"`.
- **`Device`** — `id`, `type`, `name`, position/size, `config`, and optional flags (`hidden`, `poweredOff`, `collapsedBy`).
- **Per-type configs** — `ComputerConfig`, `ServerConfig`, `SwitchConfig`, `RouterConfig`, `FirewallConfig`, `LanConfig` describe each device type's `config` shape (e.g. computer: `ipv4Address`/`ipSource` (static/dhcp/apipa)/`macAddress`/`arpTable`/`openPorts`/`dnsServerIp`; server **extends** the computer with the dnsmasq fields — `dnsmasqRunning`/`dnsRecords`/`dhcpRangeStart`/`dhcpRangeEnd`/`dhcpRouterIp`/`dhcpLeases`; switch: `managed`/`ethernetPorts`/`vlans`/`portVlans`/…; router: `interfaces`/`staticRoutes`/`rip`/`natTranslations`; firewall: `rules`/`policy`; lan: `anchorId`/`members`).
- **`DeviceConfig`** = `Partial<ComputerConfig & ServerConfig & SwitchConfig & RouterConfig & FirewallConfig & LanConfig>` — a permissive superset where every field is optional. `Device.config` is typed as this.

> **Why a superset, not a discriminated union?** Most code accesses `device.config?.field` generically (e.g. in `engine.ts`, `inspector.ts`). A discriminated union would require narrowing at ~200 call sites. The all-optional superset gives real type-safety (typos and wrong field types are caught; `arpTable` is `ArpEntry[]`, not `any`) with **zero** churn at access sites. Where strictness helps, narrow explicitly.

## Supporting element types

`ArpEntry`, `MacTableEntry`, `Vlan`, `DhcpLease`, `RouterInterface`, `RouteEntry`, `StaticRoute`, `RipRoute`, `RipConfig`, `PortMode`, `DnsRecord`, `NatEntry`, `FirewallRule`.

## Frames & simulation

- **`EthernetFrame`** — `srcMac`/`dstMac`/`etherType`/`vlanTag`/`payload`. Payloads form a union: `ArpPayload | IcmpPayload | DhcpPayload | Ipv4Payload` (with `Ipv4Payload.payload` itself being `IcmpPayload | DhcpPayload | TcpPayload | DnsPayload`).
- **`SimEvent`, `ActiveTransit`, `SimLogEntry`, `SimulationState`** — the queue, animated dots, log lines, and overall sim status used by `engine.ts`.
- **`CaptureEntry`** — one packet-list row: running number, step, frame, endpoint device ids, link id (`sim.capture`).

## App state

- **`AppState`** — the shape of the `state` singleton.
- **`TerminalSession`** — one device CLI session (device id, mode machine, scrollback, history); **`DockState`/`DockTab`** — the bottom dock (`open`, `activeTab`, `height`, `logView`); **`ConsoleState`** — the command console's lines/history.
- **`DisplayOptions`, `DragState`, `PanDragState`, `InspectorResizeState`, `PortSelectionState`, `PortOption`, `ConfigStore`, `FrameHistoryEntry`, `Link`, `Point`** — supporting state shapes (`Link` carries an optional user-given `name`).

## How it fits

Type-only module: it has no runtime cost (esbuild erases it) and no dependencies. Changing the data model starts here. Because esbuild doesn't type-check, type changes can't break the build — run `bunx tsc --noEmit` to validate.
