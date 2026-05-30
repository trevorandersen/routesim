/**
 * Reusable test topologies.
 *
 * IMPORTANT: linkedPortsFor() derives port numbers from the order links
 * appear in state.links. The first link to a switch = Ethernet1, second = Ethernet2, etc.
 * Link ordering in these fixtures is therefore intentional.
 */
import { deviceSize } from "../src/normalise";

function device(id: string, type: string, name: string, config: any = {}) {
  const size = deviceSize(type);
  return { id, type, name, x: 0, y: 0, width: size.width, height: size.height, config };
}

// ─── Basic topology ─────────────────────────────────────────────────────────
// 2 PCs + 1 unmanaged switch. Same subnet, no router.
//
// Link order for SW1:
//   Ethernet1 → PC1
//   Ethernet2 → PC2
// ─────────────────────────────────────────────────────────────────────────────
export function basicTopology() {
  return {
    devices: [
      device("pc1", "computer", "PC-1", {
        ipv4Address: "192.168.1.10",
        gatewayIpv4Address: "192.168.1.1",
        macAddress: "02:00:00:00:01:10",
        arpTable: [],
      }),
      device("pc2", "computer", "PC-2", {
        ipv4Address: "192.168.1.20",
        gatewayIpv4Address: "192.168.1.1",
        macAddress: "02:00:00:00:01:20",
        arpTable: [],
      }),
      device("sw1", "switch", "SW-1", {
        managed: false,
        ethernetPorts: 8,
        macTable: [],
      }),
    ],
    links: [
      { from: "sw1", to: "pc1", id: "l1" },
      { from: "sw1", to: "pc2", id: "l2" },
    ],
  };
}

// ─── Routed topology ────────────────────────────────────────────────────────
// 2 PCs on different subnets + 2 unmanaged switches + 1 router.
//
// Link order for SW-A: Ethernet1 → PC-A, Ethernet2 → RTR
// Link order for SW-B: Ethernet1 → PC-B, Ethernet2 → RTR
// Link order for RTR: Ethernet1 → SW-A, Ethernet2 → SW-B (via linkedPortsFor)
// ─────────────────────────────────────────────────────────────────────────────
export function routedTopology() {
  return {
    devices: [
      device("pc-a", "computer", "PC-A", {
        ipv4Address: "192.168.10.10",
        gatewayIpv4Address: "192.168.10.1",
        macAddress: "02:00:00:00:10:10",
        arpTable: [],
      }),
      device("pc-b", "computer", "PC-B", {
        ipv4Address: "192.168.20.10",
        gatewayIpv4Address: "192.168.20.1",
        macAddress: "02:00:00:00:20:10",
        arpTable: [],
      }),
      device("sw-a", "switch", "SW-A", {
        managed: false, ethernetPorts: 8, macTable: [],
      }),
      device("sw-b", "switch", "SW-B", {
        managed: false, ethernetPorts: 8, macTable: [],
      }),
      device("rtr", "router", "RTR-1", {
        ethernetPorts: 4, serialPorts: 2,
        interfaces: [
          { peerId: "sw-a", type: "ethernet", name: "", ipv4Address: "192.168.10.1", macAddress: "02:01:00:00:01:01", arpTable: [], dhcpLeases: [], vlanTag: null },
          { peerId: "sw-b", type: "ethernet", name: "", ipv4Address: "192.168.20.1", macAddress: "02:01:00:00:02:01", arpTable: [], dhcpLeases: [], vlanTag: null },
        ],
      }),
    ],
    links: [
      { from: "sw-a", to: "pc-a", id: "l1" },
      { from: "sw-a", to: "rtr",  id: "l2" },
      { from: "sw-b", to: "pc-b", id: "l3" },
      { from: "sw-b", to: "rtr",  id: "l4" },
    ],
  };
}

// ─── VLAN topology ──────────────────────────────────────────────────────────
// 2 PCs on different VLANs (10, 20) + 1 managed switch + 1 router with sub-interfaces.
//
// Link order for MSW:
//   Ethernet1 → RTR (trunk)
//   Ethernet2 → PC-V10 (access VLAN 10)
//   Ethernet3 → PC-V20 (access VLAN 20)
// ─────────────────────────────────────────────────────────────────────────────
export function vlanTopology() {
  return {
    devices: [
      device("pc-v10", "computer", "PC-V10", {
        ipv4Address: "192.168.10.10",
        gatewayIpv4Address: "192.168.10.1",
        macAddress: "02:00:0A:00:01:10",
        arpTable: [],
      }),
      device("pc-v20", "computer", "PC-V20", {
        ipv4Address: "192.168.20.10",
        gatewayIpv4Address: "192.168.20.1",
        macAddress: "02:00:14:00:01:10",
        arpTable: [],
      }),
      device("msw", "switch", "MSW-1", {
        managed: true,
        ethernetPorts: 8,
        macTable: [],
        vlans: [
          { id: 1, name: "default" },
          { id: 10, name: "Sales" },
          { id: 20, name: "Engineering" },
        ],
        portVlans: { Ethernet2: 10, Ethernet3: 20 },
        portModes: { Ethernet1: "trunk" },
        trunkNativeVlans: {},
        trunkAllowedVlans: {},
      }),
      device("rtr-v", "router", "RTR-V", {
        ethernetPorts: 4, serialPorts: 2,
        interfaces: [
          { peerId: "msw", type: "ethernet", name: "", ipv4Address: "192.168.10.1", macAddress: "02:01:00:00:01:01", arpTable: [], dhcpLeases: [], vlanTag: 10 },
          { peerId: "msw", type: "ethernet", name: "", ipv4Address: "192.168.20.1", macAddress: "02:01:00:00:02:01", arpTable: [], dhcpLeases: [], vlanTag: 20 },
        ],
      }),
    ],
    links: [
      // MSW ports: Ethernet1=rtr-v(trunk), Ethernet2=pc-v10(access), Ethernet3=pc-v20(access)
      { from: "msw", to: "rtr-v",  id: "lv1" },
      { from: "msw", to: "pc-v10", id: "lv2" },
      { from: "msw", to: "pc-v20", id: "lv3" },
    ],
  };
}

// ─── Trunk topology ─────────────────────────────────────────────────────────
// 2 managed switches connected via trunk, 1 PC on each, same VLAN 10.
//
// Link order for MSW-A: Ethernet1 → MSW-B (trunk), Ethernet2 → PC-T1 (access VLAN 10)
// Link order for MSW-B: Ethernet1 → MSW-A (trunk), Ethernet2 → PC-T2 (access VLAN 10)
// ─────────────────────────────────────────────────────────────────────────────
export function trunkTopology() {
  return {
    devices: [
      device("pc-t1", "computer", "PC-T1", {
        ipv4Address: "192.168.10.11",
        gatewayIpv4Address: "192.168.10.1",
        macAddress: "02:00:0A:00:01:11",
        arpTable: [],
      }),
      device("pc-t2", "computer", "PC-T2", {
        ipv4Address: "192.168.10.12",
        gatewayIpv4Address: "192.168.10.1",
        macAddress: "02:00:0A:00:01:12",
        arpTable: [],
      }),
      device("msw-a", "switch", "MSW-A", {
        managed: true, ethernetPorts: 8, macTable: [],
        vlans: [{ id: 1, name: "default" }, { id: 10, name: "Sales" }],
        portVlans: { Ethernet2: 10 },
        portModes: { Ethernet1: "trunk" },
        trunkNativeVlans: {},
        trunkAllowedVlans: {},
      }),
      device("msw-b", "switch", "MSW-B", {
        managed: true, ethernetPorts: 8, macTable: [],
        vlans: [{ id: 1, name: "default" }, { id: 10, name: "Sales" }],
        portVlans: { Ethernet2: 10 },
        portModes: { Ethernet1: "trunk" },
        trunkNativeVlans: {},
        trunkAllowedVlans: {},
      }),
    ],
    links: [
      // MSW-A: Eth1=MSW-B(trunk), Eth2=PC-T1(access)
      { from: "msw-a", to: "msw-b", id: "lt1" },
      { from: "msw-a", to: "pc-t1", id: "lt2" },
      // MSW-B: Eth1=MSW-A(trunk), Eth2=PC-T2(access)
      // Note: MSW-B's link to MSW-A is lt1 (from msw-a perspective it's Eth1,
      //   from msw-b perspective it's also the first link involving msw-b → Eth1)
      { from: "msw-b", to: "pc-t2", id: "lt3" },
    ],
  };
}
