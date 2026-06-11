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
    label: "Computer", namePrefix: "PC", width: 92, height: 68,
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
