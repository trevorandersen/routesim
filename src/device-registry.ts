/**
 * Device registry — the single place that describes each device type: display
 * label, auto-name prefix, canvas size/palette/icon, and default config.
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
  defaultConfig: () => DeviceConfig;
}

export const DEVICE_SPECS: Record<DeviceType, DeviceSpec> = {
  computer: {
    label: "Client PC", namePrefix: "PC", width: 92, height: 68,
    paletteVar: "pc", iconRadius: 10, userAddable: true,
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
    paletteVar: "server", iconRadius: 10, userAddable: true,
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
    paletteVar: "pc", iconRadius: 10, userAddable: true,
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
    paletteVar: "kali", iconRadius: 10, userAddable: true,
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
    iconPaths: [
      "M16 3l4 4l-4 4",
      "M10 7l10 0",
      "M8 13l-4 4l4 4",
      "M4 17l9 0"
    ],
    defaultConfig: () => ({ managed: false, ethernetPorts: 8, macTable: [], vlans: [], portVlans: {}, portModes: {}, trunkAllowedVlans: {}, trunkNativeVlans: {} })
  },
  router: {
    label: "Router", namePrefix: "RTR", width: 92, height: 70,
    paletteVar: "router", iconRadius: 12, iconStrokeWidth: 0.77, userAddable: true,
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
    defaultConfig: () => ({ ethernetPorts: 4, serialPorts: 4, interfaces: [] })
  },
  firewall: {
    label: "Firewall", namePrefix: "FW", width: 96, height: 66,
    paletteVar: "fw", iconRadius: 10, userAddable: true,
    iconPaths: [
      "M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3",
      "M9 12l2 2l4 -4"
    ],
    defaultConfig: () => ({ ethernetPorts: 2, rules: [], policy: { forward: "accept" } })
  },
  hub: {
    label: "Hub", namePrefix: "HUB", width: 96, height: 56,
    paletteVar: "hub", iconRadius: 8, userAddable: true,
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
    defaultConfig: () => ({ ethernetPorts: 4 })
  },
  "access-point": {
    label: "Access Point", namePrefix: "AP", width: 88, height: 58,
    paletteVar: "switch", iconRadius: 8, userAddable: true,
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
    defaultConfig: () => ({ managed: false, ethernetPorts: 1, macTable: [], ssid: DEFAULT_SSID })
  },
  internet: {
    label: "Internet", namePrefix: "Internet", width: 112, height: 70,
    paletteVar: "internet", iconRadius: 10, userAddable: true,
    // A cloud — the external internet. An L3 transit (engine: processAtInternet):
    // connect several routers, each on its own public subnet, and it routes IPv4
    // between them by destination, presenting a default gateway to each.
    iconPaths: [
      "M6.657 18c-2.572 0 -4.657 -2.007 -4.657 -4.483c0 -2.475 2.085 -4.482 4.657 -4.482c.393 -1.762 1.794 -3.2 3.675 -3.773c1.88 -.572 3.956 -.193 5.444 1c1.488 1.19 2.162 3.007 1.77 4.769h.99c1.913 0 3.464 1.56 3.464 3.486c0 1.927 -1.551 3.487 -3.465 3.487h-12.15z"
    ],
    defaultConfig: () => ({ ethernetPorts: 8 })
  },
  ids: {
    label: "IDS", namePrefix: "IDS", width: 92, height: 66,
    paletteVar: "ids", iconRadius: 10, userAddable: true,
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
    paletteVar: "attacker", iconRadius: 10, userAddable: true,
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
    paletteVar: "lan", iconRadius: 14, userAddable: false,
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
