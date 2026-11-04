/**
 * Device registry — the single place that describes each device type: display
 * label, auto-name prefix, canvas size/palette/icon, default config, default
 * Ethernet port count, and the capability **roles** (is it a host, does it
 * take a single cable, does Play network-boot it, can it be an 802.1X
 * supplicant, does it carry a hostname / a terminal). Code asks the role
 * helpers below (`isHost`, `hasSingleNic`, `isBootable`, …) instead of listing
 * device types by hand, so a new type is classified in one place.
 *
 * A leaf module (imports types only) so every other module can read it without
 * cycles. Behaviour (frame processing, CLIs) stays in engine/terminal, wired
 * through their own small dispatch maps keyed by DeviceType.
 *
 * Adding a device type = one entry here + a `processAt<Type>` in engine.ts +
 * (optionally) a CLI in terminal/ + the `--<paletteVar>-*` CSS vars per theme
 * + a tool button in template.html. See CLAUDE.md "Adding a device type".
 */
import type { DeviceType, DeviceConfig } from "./types";

// The WiFi network name a fresh access point broadcasts and a fresh laptop is
// configured to join. Sharing one default means a new laptop + new AP associate
// out of the box; change either SSID to teach a mismatch (or set a password).
export const DEFAULT_SSID = "RouteSim";

// A role a type holds always (true), never (false), or only while the device's
// management plane is on ("managed" — a switch: an unmanaged one has no shell
// and no hostname, a managed one runs SONiC).
export type RoleGate = boolean | "managed";

// What a device type *is*, behaviourally. Each role is its own question, even
// where today's memberships coincide (every host is also bootable and a
// supplicant) — a future static-only appliance host would differ.
export interface DeviceRoles {
  host: boolean;            // An IP end-system: one IP/prefix/gateway/MAC/ARP cache — a ping/name target, the inspector host fields, the IP canvas label
  singleNic: boolean;       // One NIC, so at most one cable and nothing to pick in the port picker (hosts + the IDS sensor)
  bootable: boolean;        // Network-boots on Play when unconfigured (DHCP, then APIPA)
  dot1xSupplicant: boolean; // Can run an 802.1X supplicant (identity + password) on its port
  hostname: RoleGate;       // Its canvas name is a validated hostname (a CLI device)
  terminal: RoleGate;       // Has a device CLI the user can open
}

export interface DeviceSpec {
  label: string;             // Human label ("Computer", "Firewall", ...)
  namePrefix: string;        // Auto-name prefix (PC-1, FW-2, ...)
  width: number;
  height: number;
  paletteVar: string;        // CSS var prefix: --<paletteVar>-fill/-stroke/-accent/-icon
  iconPaths: string[];       // MIT-licensed Tabler icon path data, drawn on canvas
  iconRadius: number;        // Body corner radius when drawn
  iconStrokeWidth?: number;  // Icon stroke override (default 1.7)
  userAddable: boolean;      // Offered by the add tool/console (LANs come from collapse)
  roles: DeviceRoles;
  defaultPorts?: number;     // Default Ethernet port count (the `ethernetPorts` a fresh device gets); absent = no configurable ports
  defaultConfig: () => DeviceConfig;   // Type-specific defaults; `ethernetPorts` is added from defaultPorts by defaultConfigFor
}

const NO_ROLES: DeviceRoles = { host: false, singleNic: false, bootable: false, dot1xSupplicant: false, hostname: false, terminal: false };
// Every end-system (PC, laptop, server, Kali PC, Red Team actor) is a full
// Linux host: one NIC, network-booted on Play, a possible 802.1X supplicant.
const HOST_ROLES: DeviceRoles = { host: true, singleNic: true, bootable: true, dot1xSupplicant: true, hostname: true, terminal: true };
// A CLI-managed network appliance (router, firewall): a hostname and a shell.
const APPLIANCE_ROLES: DeviceRoles = { ...NO_ROLES, hostname: true, terminal: true };

export const DEVICE_SPECS: Record<DeviceType, DeviceSpec> = {
  computer: {
    label: "Client PC", namePrefix: "PC", width: 92, height: 68,
    paletteVar: "pc", iconRadius: 10, userAddable: true, roles: HOST_ROLES,
    iconPaths: [
      "M3 5a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-10",
      "M7 20h10",
      "M9 16v4",
      "M15 16v4"
    ],
    defaultConfig: () => ({ ipv4Address: "", gatewayIpv4Address: "", macAddress: "", arpTable: [] })
  },
  server: {
    label: "Server", namePrefix: "SRV", width: 92, height: 70,
    paletteVar: "server", iconRadius: 10, userAddable: true, roles: HOST_ROLES,
    iconPaths: [
      "M3 7a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3z",
      "M3 15a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3z",
      "M7 8l0 .01",
      "M7 16l0 .01"
    ],
    // dnsmasq is modelled as preinstalled and running; DHCP activates once a
    // dhcp-range is configured (exactly like the real daemon).
    defaultConfig: () => ({ ipv4Address: "", gatewayIpv4Address: "", macAddress: "", arpTable: [], dnsmasqRunning: true, dnsRecords: [] })
  },
  laptop: {
    label: "Laptop", namePrefix: "LT", width: 92, height: 64,
    paletteVar: "pc", iconRadius: 10, userAddable: true, roles: HOST_ROLES,
    iconPaths: [
      "M3 19l18 0",
      "M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1 -1 1h-14a1 1 0 0 1 -1 -1v-9a1 1 0 0 1 1 -1z"
    ],
    // A WiFi-only host: same config as a computer, but it associates to an AP
    // instead of taking a cable (see the connect-tool guard in devices.ts), and
    // it carries the SSID (+ optional password) of the network it wants to join.
    defaultConfig: () => ({ ipv4Address: "", gatewayIpv4Address: "", macAddress: "", arpTable: [], ssid: DEFAULT_SSID })
  },
  kali: {
    label: "Kali PC", namePrefix: "KALI", width: 92, height: 68,
    paletteVar: "kali", iconRadius: 10, userAddable: true, roles: HOST_ROLES,
    // A monitor with a shell prompt — a pentest workstation you drive by hand
    // (the Kali terminal: nmap, arpspoof). Distinct from the plain Client PC.
    iconPaths: [
      "M3 5a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-10",
      "M7 20h10",
      "M9 16v4",
      "M15 16v4",
      "M6.5 8l2 2l-2 2",
      "M11 12h3.5"
    ],
    // A normal single-NIC host that runs Kali Linux; the user issues the attacks
    // manually from its terminal, so it carries no autonomous attack config.
    defaultConfig: () => ({ ipv4Address: "", gatewayIpv4Address: "", macAddress: "", arpTable: [] })
  },
  switch: {
    label: "Switch", namePrefix: "SW", width: 104, height: 58,
    paletteVar: "switch", iconRadius: 8, userAddable: true,
    roles: { ...NO_ROLES, hostname: "managed", terminal: "managed" }, defaultPorts: 8,
    iconPaths: [
      "M16 3l4 4l-4 4",
      "M10 7l10 0",
      "M8 13l-4 4l4 4",
      "M4 17l9 0"
    ],
    defaultConfig: () => ({ managed: false, macTable: [], vlans: [], portVlans: {}, portModes: {}, trunkAllowedVlans: {}, trunkNativeVlans: {} })
  },
  router: {
    label: "Router", namePrefix: "RTR", width: 92, height: 70,
    paletteVar: "router", iconRadius: 12, iconStrokeWidth: 0.77, userAddable: true,
    roles: APPLIANCE_ROLES, defaultPorts: 4,
    iconPaths: [
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
    defaultConfig: () => ({ serialPorts: 4, interfaces: [] })
  },
  firewall: {
    label: "Firewall", namePrefix: "FW", width: 96, height: 66,
    paletteVar: "fw", iconRadius: 10, userAddable: true, roles: APPLIANCE_ROLES, defaultPorts: 2,
    iconPaths: [
      "M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3",
      "M9 12l2 2l4 -4"
    ],
    defaultConfig: () => ({ rules: [], policy: { forward: "accept" } })
  },
  hub: {
    label: "Hub", namePrefix: "HUB", width: 96, height: 56,
    paletteVar: "hub", iconRadius: 8, userAddable: true, roles: NO_ROLES, defaultPorts: 4,
    iconPaths: [
      "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
      "M5 6m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0",
      "M19 6m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0",
      "M5 18m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0",
      "M19 18m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0",
      "M10.5 10.5l-4 -3",
      "M13.5 10.5l4 -3",
      "M10.5 13.5l-4 3",
      "M13.5 13.5l4 3"
    ],
    defaultConfig: () => ({})
  },
  "access-point": {
    label: "Access Point", namePrefix: "AP", width: 88, height: 58,
    paletteVar: "switch", iconRadius: 8, userAddable: true, roles: NO_ROLES, defaultPorts: 1,
    iconPaths: [
      "M12 12l0 .01",
      "M14.828 9.172a4 4 0 0 1 0 5.656",
      "M17.657 6.343a8 8 0 0 1 0 11.314",
      "M9.172 14.828a4 4 0 0 1 0 -5.656",
      "M6.343 17.657a8 8 0 0 1 0 -11.314"
    ],
    // A transparent L2 bridge (unmanaged-switch semantics) between a single
    // wired uplink and associated wireless clients — engine routes it via
    // processAtSwitch. Wireless associations are not ethernet ports, so the
    // port count is just the one LAN uplink. It broadcasts an SSID (a laptop may
    // only associate if its SSID — and password, if set — match).
    defaultConfig: () => ({ managed: false, macTable: [], ssid: DEFAULT_SSID })
  },
  internet: {
    label: "Internet", namePrefix: "Internet", width: 112, height: 70,
    paletteVar: "internet", iconRadius: 10, userAddable: true, roles: NO_ROLES, defaultPorts: 8,
    // A cloud — the external internet. An L3 transit (engine: processAtInternet):
    // connect several routers, each on its own public subnet, and it routes IPv4
    // between them by destination, presenting a default gateway to each.
    iconPaths: [
      "M6.657 18c-2.572 0 -4.657 -2.007 -4.657 -4.483c0 -2.475 2.085 -4.482 4.657 -4.482c.393 -1.762 1.794 -3.2 3.675 -3.773c1.88 -.572 3.956 -.193 5.444 1c1.488 1.19 2.162 3.007 1.77 4.769h.99c1.913 0 3.464 1.56 3.464 3.486c0 1.927 -1.551 3.487 -3.465 3.487h-12.15z"
    ],
    defaultConfig: () => ({})
  },
  ids: {
    label: "IDS", namePrefix: "IDS", width: 92, height: 66,
    paletteVar: "ids", iconRadius: 10, userAddable: true,
    // A Linux box with one sniffing NIC — a shell and a hostname, but no IP host role.
    roles: { ...NO_ROLES, singleNic: true, hostname: true, terminal: true },
    // An eye — a passive sensor that *watches* a mirrored copy of traffic.
    iconPaths: [
      "M10 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
      "M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"
    ],
    // A passive Snort sensor: cabled to a switch SPAN/monitor port, it inspects
    // the mirrored traffic against rules and alerts. Two starter rules ship so a
    // freshly placed sensor detects something out of the box (edit local.rules).
    defaultConfig: () => ({ idsRules: [
      `alert icmp any any -> any any (msg:"ICMP traffic detected"; itype:8; sid:1000001; rev:1;)`,
      `alert tcp any any -> any 23 (msg:"Telnet connection attempt"; sid:1000002; rev:1;)`,
    ], alerts: [] })
  },
  attacker: {
    label: "Red Team", namePrefix: "RT", width: 92, height: 68,
    paletteVar: "attacker", iconRadius: 10, userAddable: true, roles: HOST_ROLES,
    // A skull — the universal "adversary" glyph.
    iconPaths: [
      "M12 4c4.418 0 8 3.358 8 7.5c0 1.737 -.62 3.34 -1.668 4.628c-.184 .226 -.332 .48 -.332 .755v1.617a1 1 0 0 1 -1 1h-10a1 1 0 0 1 -1 -1v-1.617c0 -.275 -.148 -.529 -.332 -.755a7.287 7.287 0 0 1 -1.668 -4.628c0 -4.142 3.582 -7.5 8 -7.5z",
      "M10 17v3",
      "M14 17v3",
      "M9 11m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
      "M15 11m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"
    ],
    // A real host (IP/MAC/ARP) that launches attacks. Defaults: scan enabled so
    // a freshly placed box does something once a target is set.
    defaultConfig: () => ({ ipv4Address: "", gatewayIpv4Address: "", macAddress: "", arpTable: [], attacks: ["scan"], attackLog: [] })
  },
  lan: {
    label: "LAN", namePrefix: "LAN", width: 112, height: 72,
    paletteVar: "lan", iconRadius: 14, userAddable: false, roles: NO_ROLES,
    iconPaths: [
      "M7 18a4.6 4.4 0 0 1 -1.2 -8.9a5.8 5.6 0 0 1 10.8 -1.9a4.7 4.5 0 0 1 1.4 8.8",
      "M8 18h9",
      "M10 15h4",
      "M12 13v5",
      "M8 20h8"
    ],
    defaultConfig: () => ({ members: [] })
  },
};

export const DEVICE_TYPES = Object.keys(DEVICE_SPECS) as DeviceType[];
export const USER_ADDABLE_TYPES = DEVICE_TYPES.filter(t => DEVICE_SPECS[t].userAddable);

export function freshNameCounters(): Record<DeviceType, number> {
  return Object.fromEntries(DEVICE_TYPES.map(t => [t, 1])) as Record<DeviceType, number>;
}

// A fresh device's config: the type's defaults plus its default port count.
export function defaultConfigFor(type: DeviceType): DeviceConfig {
  const spec = DEVICE_SPECS[type];
  if (!spec) return {};
  return spec.defaultPorts != null ? { ethernetPorts: spec.defaultPorts, ...spec.defaultConfig() } : spec.defaultConfig();
}

// The Ethernet port count a device of this type has when its config names none
// (0 for a type with no configurable ports — hosts, the IDS, a LAN).
export function defaultPortCount(type: DeviceType): number {
  return DEVICE_SPECS[type]?.defaultPorts ?? 0;
}

// ── Capability roles ─────────────────────────────────────────────────────────
// Ask these instead of listing device types: a type's roles live in its spec.
// The type-keyed ones take `undefined` (an unresolved device) and answer false.

export function isHost(type: DeviceType | undefined): boolean {
  return !!type && DEVICE_SPECS[type]?.roles.host === true;
}

export function hasSingleNic(type: DeviceType | undefined): boolean {
  return !!type && DEVICE_SPECS[type]?.roles.singleNic === true;
}

export function isBootable(type: DeviceType | undefined): boolean {
  return !!type && DEVICE_SPECS[type]?.roles.bootable === true;
}

export function isDot1xSupplicant(type: DeviceType | undefined): boolean {
  return !!type && DEVICE_SPECS[type]?.roles.dot1xSupplicant === true;
}

type GatedDevice = { type: DeviceType; config?: DeviceConfig };

function gateHolds(gate: RoleGate | undefined, device: GatedDevice): boolean {
  return gate === "managed" ? !!device.config?.managed : gate === true;
}

// CLI devices carry a hostname — it's their canvas name, prompt, and the name
// they resolve as. (Unmanaged switches and hubs have no shell; LANs are groups.)
export function hasHostname(device: GatedDevice): boolean {
  return gateHolds(DEVICE_SPECS[device.type]?.roles.hostname, device);
}

// Whether this device offers a terminal right now: its type has a CLI and, for
// a switch, the management plane is on. (Power is checked by canOpenTerminal.)
export function offersTerminal(device: GatedDevice): boolean {
  return gateHolds(DEVICE_SPECS[device.type]?.roles.terminal, device);
}
