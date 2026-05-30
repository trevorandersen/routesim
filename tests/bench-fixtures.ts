/**
 * Programmatic topology generators for benchmarks.
 *
 * Each function returns { devices, links } compatible with direct assignment
 * to state.devices / state.links after resetState().
 */
import { deviceSize } from "../src/normalise";

function device(id: string, type: string, name: string, config: any = {}) {
  const size = deviceSize(type);
  return { id, type, name, x: 0, y: 0, width: size.width, height: size.height, config };
}

function mac(a: number, b: number, c: number): string {
  const hex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  return `02:00:${hex(a)}:${hex(b)}:${hex(c)}:01`;
}

function routerMac(routerIdx: number, ifaceIdx: number): string {
  const hex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  return `02:${hex(routerIdx + 0xB0)}:00:00:${hex(ifaceIdx + 1)}:01`;
}

// ─── smallLinear ────────────────────────────────────────────────────────────
// n PCs → 1 switch. All in 192.168.1.0/24.

export function smallLinear(n: number = 5) {
  const devices: any[] = [];
  const links: any[] = [];
  const swId = "sw-0";

  devices.push(device(swId, "switch", "SW-0", {
    managed: false,
    ethernetPorts: Math.max(8, n + 2),
    macTable: [],
  }));

  for (let i = 0; i < n; i++) {
    const pcId = `pc-${i}`;
    devices.push(device(pcId, "computer", `PC-${i}`, {
      ipv4Address: `192.168.1.${10 + i}`,
      gatewayIpv4Address: "192.168.1.1",
      macAddress: mac(1, 0, 10 + i),
      arpTable: [],
    }));
    links.push({
      id: `link-sw0-pc${i}`,
      from: swId,
      to: pcId,
      fromPort: i + 1,
      toPort: 1,
    });
  }

  return { devices, links };
}

// ─── mediumStar ─────────────────────────────────────────────────────────────
// n PCs split across 4 switches, 1 router in the center. 4 subnets.

export function mediumStar(n: number = 20) {
  const devices: any[] = [];
  const links: any[] = [];
  const pcsPerSwitch = Math.ceil(n / 4);

  // Router
  const rtrId = "rtr-0";
  const rtrInterfaces: any[] = [];

  for (let s = 0; s < 4; s++) {
    const swId = `sw-${s}`;
    const subnet = s + 1; // 192.168.1.0/24 .. 192.168.4.0/24

    devices.push(device(swId, "switch", `SW-${s}`, {
      managed: false,
      ethernetPorts: Math.max(8, pcsPerSwitch + 2),
      macTable: [],
    }));

    // Router interface for this switch
    rtrInterfaces.push({
      peerId: swId,
      type: "ethernet",
      name: "",
      ipv4Address: `192.168.${subnet}.1`,
      macAddress: routerMac(0, s),
      arpTable: [],
      dhcpLeases: [],
      vlanTag: null,
    });

    // Link: router ↔ switch
    links.push({
      id: `link-rtr-sw${s}`,
      from: rtrId,
      to: swId,
      fromPort: s + 1,
      toPort: 1,
    });

    // PCs on this switch
    const count = Math.min(pcsPerSwitch, n - s * pcsPerSwitch);
    for (let i = 0; i < count; i++) {
      const pcIdx = s * pcsPerSwitch + i;
      const pcId = `pc-${pcIdx}`;
      devices.push(device(pcId, "computer", `PC-${pcIdx}`, {
        ipv4Address: `192.168.${subnet}.${10 + i}`,
        gatewayIpv4Address: `192.168.${subnet}.1`,
        macAddress: mac(subnet, i, 10 + i),
        arpTable: [],
      }));
      links.push({
        id: `link-sw${s}-pc${pcIdx}`,
        from: swId,
        to: pcId,
        fromPort: i + 2, // port 1 is the router
        toPort: 1,
      });
    }
  }

  devices.push(device(rtrId, "router", "RTR-0", {
    ethernetPorts: 8,
    serialPorts: 4,
    interfaces: rtrInterfaces,
    staticRoutes: [],
  }));

  return { devices, links };
}

// ─── largeMesh ──────────────────────────────────────────────────────────────
// n PCs across 10 switches, 5 routers in partial mesh. Static routes.

export function largeMesh(n: number = 50) {
  const devices: any[] = [];
  const links: any[] = [];
  const numSwitches = 10;
  const numRouters = 5;
  const pcsPerSwitch = Math.ceil(n / numSwitches);

  // Create routers with serial mesh links
  for (let r = 0; r < numRouters; r++) {
    const rtrId = `rtr-${r}`;
    const rtrInterfaces: any[] = [];
    const staticRoutes: any[] = [];

    // Each router connects to 2 switches
    const sw1 = r * 2;
    const sw2 = r * 2 + 1;
    for (const sIdx of [sw1, sw2]) {
      if (sIdx < numSwitches) {
        const subnet = sIdx + 1;
        rtrInterfaces.push({
          peerId: `sw-${sIdx}`,
          type: "ethernet",
          name: "",
          ipv4Address: `192.168.${subnet}.1`,
          macAddress: routerMac(r, rtrInterfaces.length),
          arpTable: [],
          dhcpLeases: [],
          vlanTag: null,
        });
      }
    }

    // Serial links to adjacent routers
    for (let other = 0; other < numRouters; other++) {
      if (other === r) continue;
      if (Math.abs(other - r) === 1 || (r === 0 && other === numRouters - 1)) {
        const transitSubnet = 100 + r * 10 + other;
        rtrInterfaces.push({
          peerId: `rtr-${other}`,
          type: "serial",
          name: "",
          ipv4Address: `10.0.${transitSubnet}.${r + 1}`,
          macAddress: routerMac(r, rtrInterfaces.length),
          arpTable: [],
          dhcpLeases: [],
          vlanTag: null,
        });
      }
    }

    // Static routes to all non-directly-connected subnets
    for (let sIdx = 0; sIdx < numSwitches; sIdx++) {
      const subnet = sIdx + 1;
      const directlyConnected = sIdx === sw1 || sIdx === sw2;
      if (!directlyConnected) {
        // Route through next router in chain
        const nextRouter = r < numRouters - 1 ? r + 1 : r - 1;
        const transitSubnet = 100 + Math.min(r, nextRouter) * 10 + Math.max(r, nextRouter);
        staticRoutes.push({
          network: `192.168.${subnet}.0/24`,
          nextHop: `10.0.${transitSubnet}.${nextRouter + 1}`,
        });
      }
    }

    devices.push(device(rtrId, "router", `RTR-${r}`, {
      ethernetPorts: 4,
      serialPorts: 8,
      interfaces: rtrInterfaces,
      staticRoutes,
    }));
  }

  // Create switches and PCs
  for (let s = 0; s < numSwitches; s++) {
    const swId = `sw-${s}`;
    const routerIdx = Math.floor(s / 2);
    const subnet = s + 1;

    devices.push(device(swId, "switch", `SW-${s}`, {
      managed: false,
      ethernetPorts: Math.max(8, pcsPerSwitch + 2),
      macTable: [],
    }));

    // Link: router ↔ switch
    links.push({
      id: `link-rtr${routerIdx}-sw${s}`,
      from: `rtr-${routerIdx}`,
      to: swId,
      fromPort: (s % 2) + 1,
      toPort: 1,
    });

    // PCs on this switch
    const count = Math.min(pcsPerSwitch, n - s * pcsPerSwitch);
    for (let i = 0; i < count && i >= 0; i++) {
      const pcIdx = s * pcsPerSwitch + i;
      if (pcIdx >= n) break;
      const pcId = `pc-${pcIdx}`;
      devices.push(device(pcId, "computer", `PC-${pcIdx}`, {
        ipv4Address: `192.168.${subnet}.${10 + i}`,
        gatewayIpv4Address: `192.168.${subnet}.1`,
        macAddress: mac(subnet, s, 10 + i),
        arpTable: [],
      }));
      links.push({
        id: `link-sw${s}-pc${pcIdx}`,
        from: swId,
        to: pcId,
        fromPort: i + 2,
        toPort: 1,
      });
    }
  }

  // Router-to-router serial links
  for (let r = 0; r < numRouters; r++) {
    const next = r + 1;
    if (next < numRouters) {
      links.push({
        id: `link-rtr${r}-rtr${next}`,
        from: `rtr-${r}`,
        to: `rtr-${next}`,
        fromPort: 3 + r,
        toPort: 3 + r,
      });
    }
  }
  // Wrap-around link: last → first
  links.push({
    id: `link-rtr${numRouters - 1}-rtr0`,
    from: `rtr-${numRouters - 1}`,
    to: `rtr-0`,
    fromPort: 3 + numRouters,
    toPort: 3 + numRouters,
  });

  return { devices, links };
}

// ─── stressGrid ─────────────────────────────────────────────────────────────
// n PCs across 20 switches, 10 routers in 2×5 grid. Static routes.

export function stressGrid(n: number = 100) {
  const devices: any[] = [];
  const links: any[] = [];
  const numSwitches = 20;
  const numRouters = 10;
  const pcsPerSwitch = Math.ceil(n / numSwitches);

  // Create routers in a 2×5 grid
  for (let r = 0; r < numRouters; r++) {
    const rtrId = `rtr-${r}`;
    const rtrInterfaces: any[] = [];
    const staticRoutes: any[] = [];
    const row = Math.floor(r / 5);
    const col = r % 5;

    // Each router connects to 2 switches
    const sw1 = r * 2;
    const sw2 = r * 2 + 1;
    for (const sIdx of [sw1, sw2]) {
      if (sIdx < numSwitches) {
        const subnet = sIdx + 1;
        rtrInterfaces.push({
          peerId: `sw-${sIdx}`,
          type: "ethernet",
          name: "",
          ipv4Address: `172.16.${subnet}.1`,
          macAddress: routerMac(r, rtrInterfaces.length),
          arpTable: [],
          dhcpLeases: [],
          vlanTag: null,
        });
      }
    }

    // Grid links: right neighbor + bottom neighbor
    const right = row * 5 + col + 1;
    if (col < 4 && right < numRouters) {
      const ts = 50 + r * 2;
      rtrInterfaces.push({
        peerId: `rtr-${right}`,
        type: "serial",
        name: "",
        ipv4Address: `10.0.${ts}.1`,
        macAddress: routerMac(r, rtrInterfaces.length),
        arpTable: [],
        dhcpLeases: [],
        vlanTag: null,
      });
    }
    const below = (row + 1) * 5 + col;
    if (row < 1 && below < numRouters) {
      const ts = 50 + r * 2 + 1;
      rtrInterfaces.push({
        peerId: `rtr-${below}`,
        type: "serial",
        name: "",
        ipv4Address: `10.0.${ts}.1`,
        macAddress: routerMac(r, rtrInterfaces.length),
        arpTable: [],
        dhcpLeases: [],
        vlanTag: null,
      });
    }

    // Default route toward router 0 (simplified — sufficient for benchmarking)
    if (r > 0) {
      // Next hop toward center via grid neighbor
      const nextR = col > 0 ? r - 1 : below !== undefined && row > 0 ? r - 5 : r - 1;
      const nextRouter = Math.max(0, Math.min(numRouters - 1, nextR));
      if (nextRouter !== r) {
        // Find transit subnet toward nextRouter
        const transitIface = rtrInterfaces.find((i: any) => i.peerId === `rtr-${nextRouter}`);
        if (transitIface) {
          const parts = transitIface.ipv4Address.split(".");
          const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
          staticRoutes.push({
            network: "0.0.0.0/0",
            nextHop: `${prefix}.2`,
          });
        }
      }
    }

    devices.push(device(rtrId, "router", `RTR-${r}`, {
      ethernetPorts: 4,
      serialPorts: 8,
      interfaces: rtrInterfaces,
      staticRoutes,
    }));
  }

  // Create switches and PCs
  for (let s = 0; s < numSwitches; s++) {
    const swId = `sw-${s}`;
    const routerIdx = Math.floor(s / 2);
    const subnet = s + 1;

    devices.push(device(swId, "switch", `SW-${s}`, {
      managed: false,
      ethernetPorts: Math.max(8, pcsPerSwitch + 2),
      macTable: [],
    }));

    links.push({
      id: `link-rtr${routerIdx}-sw${s}`,
      from: `rtr-${routerIdx}`,
      to: swId,
      fromPort: (s % 2) + 1,
      toPort: 1,
    });

    const count = Math.min(pcsPerSwitch, n - s * pcsPerSwitch);
    for (let i = 0; i < count && i >= 0; i++) {
      const pcIdx = s * pcsPerSwitch + i;
      if (pcIdx >= n) break;
      const pcId = `pc-${pcIdx}`;
      devices.push(device(pcId, "computer", `PC-${pcIdx}`, {
        ipv4Address: `172.16.${subnet}.${10 + i}`,
        gatewayIpv4Address: `172.16.${subnet}.1`,
        macAddress: mac(subnet, s, 10 + i),
        arpTable: [],
      }));
      links.push({
        id: `link-sw${s}-pc${pcIdx}`,
        from: swId,
        to: pcId,
        fromPort: i + 2,
        toPort: 1,
      });
    }
  }

  // Router grid links
  for (let r = 0; r < numRouters; r++) {
    const row = Math.floor(r / 5);
    const col = r % 5;
    // Right neighbor
    if (col < 4) {
      links.push({
        id: `link-rtr${r}-rtr${r + 1}`,
        from: `rtr-${r}`,
        to: `rtr-${r + 1}`,
      });
    }
    // Bottom neighbor
    if (row < 1) {
      links.push({
        id: `link-rtr${r}-rtr${r + 5}`,
        from: `rtr-${r}`,
        to: `rtr-${r + 5}`,
      });
    }
  }

  return { devices, links };
}

// ─── ripStress ──────────────────────────────────────────────────────────────
// r routers in a ring with cross-links. Pure RIP convergence test.

export function ripStress(r: number = 15) {
  const devices: any[] = [];
  const links: any[] = [];

  for (let i = 0; i < r; i++) {
    const rtrId = `rtr-${i}`;
    const rtrInterfaces: any[] = [];

    // Ring: connect to next router
    const next = (i + 1) % r;
    rtrInterfaces.push({
      peerId: `rtr-${next}`,
      type: "serial",
      name: "",
      ipv4Address: `10.0.${i}.1`,
      macAddress: routerMac(i, 0),
      arpTable: [],
      dhcpLeases: [],
      vlanTag: null,
    });

    // Ring: connect to previous router
    const prev = (i - 1 + r) % r;
    rtrInterfaces.push({
      peerId: `rtr-${prev}`,
      type: "serial",
      name: "",
      ipv4Address: `10.0.${prev}.2`,
      macAddress: routerMac(i, 1),
      arpTable: [],
      dhcpLeases: [],
      vlanTag: null,
    });

    // Cross-links: every 3rd router connects to router i+3
    if (i % 3 === 0 && i + 3 < r) {
      const crossTarget = i + 3;
      const crossSubnet = 100 + i;
      rtrInterfaces.push({
        peerId: `rtr-${crossTarget}`,
        type: "serial",
        name: "",
        ipv4Address: `10.0.${crossSubnet}.1`,
        macAddress: routerMac(i, 2),
        arpTable: [],
        dhcpLeases: [],
        vlanTag: null,
      });
    }

    // 2 "LAN" subnets per router (simulated as networks to advertise)
    const lan1 = `192.168.${i * 2 + 1}.0/24`;
    const lan2 = `192.168.${i * 2 + 2}.0/24`;

    // All transit subnets this router participates in
    const ripNetworks: string[] = [
      `10.0.${i}.0/24`,    // ring link i→next
      `10.0.${prev}.0/24`, // ring link prev→i
      lan1,
      lan2,
    ];
    if (i % 3 === 0 && i + 3 < r) {
      ripNetworks.push(`10.0.${100 + i}.0/24`);
    }

    devices.push(device(rtrId, "router", `RTR-${i}`, {
      ethernetPorts: 2,
      serialPorts: 8,
      interfaces: rtrInterfaces,
      staticRoutes: [],
      rip: {
        enabled: true,
        networks: ripNetworks,
        passiveInterfaces: [],
        learnedRoutes: [],
      },
    }));
  }

  // Ring links
  for (let i = 0; i < r; i++) {
    const next = (i + 1) % r;
    links.push({
      id: `link-ring-${i}-${next}`,
      from: `rtr-${i}`,
      to: `rtr-${next}`,
    });
  }

  // Cross-links
  for (let i = 0; i < r; i += 3) {
    if (i + 3 < r) {
      links.push({
        id: `link-cross-${i}-${i + 3}`,
        from: `rtr-${i}`,
        to: `rtr-${i + 3}`,
      });
    }
  }

  return { devices, links };
}

// ─── Managed switch topology for VLAN benchmarks ────────────────────────────
// n PCs on a single managed switch with VLANs configured.

export function managedSwitch(n: number = 8) {
  const devices: any[] = [];
  const links: any[] = [];
  const swId = "msw-0";

  devices.push(device(swId, "switch", "MSW-0", {
    managed: true,
    ethernetPorts: Math.max(8, n + 2),
    macTable: [],
    vlans: [
      { id: 1, name: "default" },
      { id: 10, name: "VLAN10" },
      { id: 20, name: "VLAN20" },
    ],
    portVlans: Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`Ethernet${i + 1}`, i % 2 === 0 ? 10 : 20])
    ),
    portModes: {},
    trunkAllowedVlans: {},
    trunkNativeVlans: {},
  }));

  for (let i = 0; i < n; i++) {
    const pcId = `pc-${i}`;
    const vlan = i % 2 === 0 ? 10 : 20;
    const subnet = vlan === 10 ? 10 : 20;
    devices.push(device(pcId, "computer", `PC-${i}`, {
      ipv4Address: `192.168.${subnet}.${10 + i}`,
      gatewayIpv4Address: `192.168.${subnet}.1`,
      macAddress: mac(subnet, 0, 10 + i),
      arpTable: [],
    }));
    links.push({
      id: `link-msw-pc${i}`,
      from: swId,
      to: pcId,
      fromPort: i + 1,
      toPort: 1,
    });
  }

  return { devices, links };
}

// ─── Router with many routes ────────────────────────────────────────────────
// Single router with n interfaces and m static routes.

export function routerWithRoutes(numIfaces: number = 5, numStatic: number = 10) {
  const devices: any[] = [];
  const links: any[] = [];
  const rtrId = "rtr-0";
  const rtrInterfaces: any[] = [];
  const staticRoutes: any[] = [];

  for (let i = 0; i < numIfaces; i++) {
    const swId = `sw-${i}`;
    const subnet = i + 1;

    devices.push(device(swId, "switch", `SW-${i}`, {
      managed: false,
      ethernetPorts: 8,
      macTable: [],
    }));

    rtrInterfaces.push({
      peerId: swId,
      type: "ethernet",
      name: "",
      ipv4Address: `192.168.${subnet}.1`,
      macAddress: routerMac(0, i),
      arpTable: [],
      dhcpLeases: [],
      vlanTag: null,
    });

    links.push({
      id: `link-rtr-sw${i}`,
      from: rtrId,
      to: swId,
      fromPort: i + 1,
      toPort: 1,
    });
  }

  // Static routes to remote subnets
  for (let i = 0; i < numStatic; i++) {
    const network = `10.${Math.floor(i / 256)}.${i % 256}.0/24`;
    staticRoutes.push({
      network,
      nextHop: `192.168.1.${2 + (i % 253)}`,
    });
  }

  devices.push(device(rtrId, "router", "RTR-0", {
    ethernetPorts: Math.max(4, numIfaces),
    serialPorts: 4,
    interfaces: rtrInterfaces,
    staticRoutes,
  }));

  return { devices, links };
}
