/**
 * Scenario library — the built-in curriculum. A progression from L2 basics to
 * routing, services, and security, ending with troubleshooting:
 *
 *   1. connect-lan         (in scenarios.ts — the original)
 *   2. vlan-segmentation   VLANs isolate departments on one switch
 *   3. router-on-a-stick   inter-VLAN routing via sub-interfaces
 *   4. static-routes       route between two router LANs
 *   5. dhcp-service        bring up DHCP for an unconfigured host
 *   6. rip-convergence     dynamic routing across a 3-router chain
 *   7. firewall-guard      allow SSH, block Telnet with iptables
 *   8. troubleshoot-gateway fix a broken default gateway
 *   9. troubleshoot-vlan     find the misassigned switch port
 *  10. troubleshoot-firewall fix a rule that blocks the wrong port
 *  11. troubleshoot-static-route fix a typo'd next-hop
 *  12. nat-gateway          PAT a private LAN onto one public address
 *  13. harden-gateway       protect the router itself with the INPUT chain
 *  14. dns-service          stand up dnsmasq so names resolve
 *  15. troubleshoot-dns     the IP pings but the name doesn't
 *  16. server-dhcp          zero-touch client config from dnsmasq DHCP
 *
 * Data only — evaluation lives in scenarios.ts. Type-only import: no cycle.
 */
import type { Scenario } from "./scenarios";

const vlanSegmentation: Scenario = {
  id: "vlan-segmentation",
  name: "VLAN segmentation",
  objective: "Sales (PC-S1, PC-S2) and Engineering (PC-E1, PC-E2) share one switch. Create VLAN 10 (Sales: Ethernet1-2) and VLAN 20 (Engineering: Ethernet3-4) so each team can only reach itself.",
  topology: {
    version: 1,
    devices: [
      { id: "v2-sw", type: "switch", name: "MSW-1", x: 0, y: 0,
        config: { managed: true, ethernetPorts: 8, macTable: [], vlans: [], portVlans: {}, portModes: {} } },
      { id: "v2-s1", type: "computer", name: "PC-S1", x: -260, y: -240, config: { ipv4Address: "192.168.1.11", gatewayIpv4Address: "", macAddress: "02:00:00:00:01:11", arpTable: [] } },
      { id: "v2-s2", type: "computer", name: "PC-S2", x: 260, y: -240, config: { ipv4Address: "192.168.1.12", gatewayIpv4Address: "", macAddress: "02:00:00:00:01:12", arpTable: [] } },
      { id: "v2-e1", type: "computer", name: "PC-E1", x: -260, y: 240, config: { ipv4Address: "192.168.1.21", gatewayIpv4Address: "", macAddress: "02:00:00:00:01:21", arpTable: [] } },
      { id: "v2-e2", type: "computer", name: "PC-E2", x: 260, y: 240, config: { ipv4Address: "192.168.1.22", gatewayIpv4Address: "", macAddress: "02:00:00:00:01:22", arpTable: [] } },
    ],
    links: [
      { from: "v2-sw", to: "v2-s1", fromPort: 1 },
      { from: "v2-sw", to: "v2-s2", fromPort: 2 },
      { from: "v2-sw", to: "v2-e1", fromPort: 3 },
      { from: "v2-sw", to: "v2-e2", fromPort: 4 },
    ],
  },
  checks: [
    { kind: "ping", from: "PC-S1", to: "PC-S2", label: "Sales can reach Sales" },
    { kind: "ping", from: "PC-E1", to: "PC-E2", label: "Engineering can reach Engineering" },
    { kind: "ping-fail", from: "PC-S1", to: "PC-E1", label: "Sales cannot reach Engineering" },
    { kind: "ping-fail", from: "PC-E2", to: "PC-S2", label: "Engineering cannot reach Sales" },
  ],
};

const routerOnAStick: Scenario = {
  id: "router-on-a-stick",
  name: "Router on a stick",
  objective: "VLAN 10 and VLAN 20 are configured on MSW-1 with a trunk to RTR-1, but the router has no sub-interfaces. Give RTR-1 a dot1q sub-interface per VLAN (192.168.10.1 on VLAN 10, 192.168.20.1 on VLAN 20) so the VLANs can reach each other.",
  topology: {
    version: 1,
    devices: [
      { id: "v3-rtr", type: "router", name: "RTR-1", x: 300, y: 0, config: { ethernetPorts: 4, serialPorts: 0, interfaces: [] } },
      { id: "v3-sw", type: "switch", name: "MSW-1", x: 0, y: 0, config: {
        managed: true, ethernetPorts: 8, macTable: [],
        vlans: [{ id: 10, name: "Sales" }, { id: 20, name: "Engineering" }],
        portVlans: { Ethernet2: 10, Ethernet3: 20 },
        portModes: { Ethernet1: "trunk" },
      } },
      { id: "v3-a", type: "computer", name: "PC-A", x: -280, y: -110, config: { ipv4Address: "192.168.10.10", gatewayIpv4Address: "192.168.10.1", macAddress: "02:00:00:00:03:0A", arpTable: [] } },
      { id: "v3-b", type: "computer", name: "PC-B", x: -280, y: 110, config: { ipv4Address: "192.168.20.10", gatewayIpv4Address: "192.168.20.1", macAddress: "02:00:00:00:03:0B", arpTable: [] } },
    ],
    links: [
      { from: "v3-sw", to: "v3-rtr", fromPort: 1 },
      { from: "v3-sw", to: "v3-a", fromPort: 2 },
      { from: "v3-sw", to: "v3-b", fromPort: 3 },
    ],
  },
  checks: [
    { kind: "ping", from: "PC-A", to: "PC-B", label: "VLAN 10 can reach VLAN 20" },
    { kind: "ping", from: "PC-B", to: "PC-A", label: "VLAN 20 can reach VLAN 10" },
  ],
};

const staticRoutes: Scenario = {
  id: "static-routes",
  name: "Static routes",
  objective: "Two offices connect over a serial link (10.0.0.0/24) but neither router knows about the other's LAN. Add a static route on each router so PC-A and PC-B can reach each other.",
  topology: {
    version: 1,
    devices: [
      { id: "v4-r1", type: "router", name: "R1", x: -140, y: 0, config: { ethernetPorts: 2, serialPorts: 2, interfaces: [
        { peerId: "v4-swa", type: "ethernet", ipv4Address: "192.168.1.1" },
        { peerId: "v4-r2", type: "serial", ipv4Address: "10.0.0.1" },
      ] } },
      { id: "v4-r2", type: "router", name: "R2", x: 140, y: 0, config: { ethernetPorts: 2, serialPorts: 2, interfaces: [
        { peerId: "v4-swb", type: "ethernet", ipv4Address: "192.168.2.1" },
        { peerId: "v4-r1", type: "serial", ipv4Address: "10.0.0.2" },
      ] } },
      { id: "v4-swa", type: "switch", name: "SW-A", x: -400, y: 0, config: { managed: false, ethernetPorts: 4, macTable: [] } },
      { id: "v4-swb", type: "switch", name: "SW-B", x: 400, y: 0, config: { managed: false, ethernetPorts: 4, macTable: [] } },
      { id: "v4-a", type: "computer", name: "PC-A", x: -640, y: 0, config: { ipv4Address: "192.168.1.10", gatewayIpv4Address: "192.168.1.1", macAddress: "02:00:00:00:04:0A", arpTable: [] } },
      { id: "v4-b", type: "computer", name: "PC-B", x: 640, y: 0, config: { ipv4Address: "192.168.2.10", gatewayIpv4Address: "192.168.2.1", macAddress: "02:00:00:00:04:0B", arpTable: [] } },
    ],
    links: [
      { from: "v4-a", to: "v4-swa" },
      { from: "v4-swa", to: "v4-r1" },
      { from: "v4-r1", to: "v4-r2" },
      { from: "v4-r2", to: "v4-swb" },
      { from: "v4-swb", to: "v4-b" },
    ],
  },
  checks: [
    { kind: "ping", from: "PC-A", to: "PC-B", label: "PC-A can reach PC-B" },
    { kind: "ping", from: "PC-B", to: "PC-A", label: "PC-B can reach PC-A" },
  ],
};

const dhcpService: Scenario = {
  id: "dhcp-service",
  name: "DHCP service",
  objective: "PC-A has no address and nothing is cabled. Wire PC-A to SW-1 and SW-1 to R1, then obtain a lease (R1 serves 192.168.50.0/24 on its LAN interface).",
  topology: {
    version: 1,
    devices: [
      { id: "v5-a", type: "computer", name: "PC-A", x: -440, y: 0, config: { ipv4Address: "", gatewayIpv4Address: "", macAddress: "02:00:00:00:05:0A", arpTable: [] } },
      { id: "v5-sw", type: "switch", name: "SW-1", x: -150, y: 0, config: { managed: false, ethernetPorts: 4, macTable: [] } },
      { id: "v5-r1", type: "router", name: "R1", x: 150, y: 0, config: { ethernetPorts: 2, serialPorts: 0, interfaces: [
        { peerId: "v5-sw", type: "ethernet", ipv4Address: "192.168.50.1" },
      ] } },
    ],
    links: [],
  },
  checks: [
    { kind: "link", a: "PC-A", b: "SW-1", label: "PC-A linked to SW-1" },
    { kind: "link", a: "SW-1", b: "R1", label: "SW-1 linked to R1" },
    { kind: "dhcp", host: "PC-A", label: "PC-A obtains a DHCP lease" },
  ],
};

const ripConvergence: Scenario = {
  id: "rip-convergence",
  name: "RIP convergence",
  objective: "Three routers in a chain, no routes between the end LANs. Enable RIP on R1, R2, and R3 (advertise each router's connected networks) so PC-A and PC-C can reach each other.",
  topology: {
    version: 1,
    devices: [
      { id: "v6-r1", type: "router", name: "R1", x: -300, y: 0, config: { ethernetPorts: 2, serialPorts: 2, interfaces: [
        { peerId: "v6-a", type: "ethernet", ipv4Address: "192.168.1.1" },
        { peerId: "v6-r2", type: "serial", ipv4Address: "10.0.12.1" },
      ] } },
      { id: "v6-r2", type: "router", name: "R2", x: 0, y: 0, config: { ethernetPorts: 2, serialPorts: 2, interfaces: [
        { peerId: "v6-r1", type: "serial", ipv4Address: "10.0.12.2" },
        { peerId: "v6-r3", type: "serial", ipv4Address: "10.0.23.2" },
      ] } },
      { id: "v6-r3", type: "router", name: "R3", x: 300, y: 0, config: { ethernetPorts: 2, serialPorts: 2, interfaces: [
        { peerId: "v6-r2", type: "serial", ipv4Address: "10.0.23.3" },
        { peerId: "v6-c", type: "ethernet", ipv4Address: "192.168.3.1" },
      ] } },
      { id: "v6-a", type: "computer", name: "PC-A", x: -560, y: 0, config: { ipv4Address: "192.168.1.10", gatewayIpv4Address: "192.168.1.1", macAddress: "02:00:00:00:06:0A", arpTable: [] } },
      { id: "v6-c", type: "computer", name: "PC-C", x: 560, y: 0, config: { ipv4Address: "192.168.3.10", gatewayIpv4Address: "192.168.3.1", macAddress: "02:00:00:00:06:0C", arpTable: [] } },
    ],
    links: [
      { from: "v6-a", to: "v6-r1" },
      { from: "v6-r1", to: "v6-r2" },
      { from: "v6-r2", to: "v6-r3" },
      { from: "v6-r3", to: "v6-c" },
    ],
  },
  checks: [
    { kind: "ping", from: "PC-A", to: "PC-C", label: "PC-A can reach PC-C" },
    { kind: "ping", from: "PC-C", to: "PC-A", label: "PC-C can reach PC-A" },
  ],
};

const firewallGuard: Scenario = {
  id: "firewall-guard",
  name: "Firewall: allow SSH, block Telnet",
  objective: "SRV-1 runs SSH (22) and Telnet (23). Configure FW-1 with iptables so Telnet from PC-A is blocked while SSH and ping keep working.",
  topology: {
    version: 1,
    devices: [
      { id: "v7-a", type: "computer", name: "PC-A", x: -440, y: 0, config: { ipv4Address: "192.168.1.10", gatewayIpv4Address: "", macAddress: "02:00:00:00:07:0A", arpTable: [] } },
      { id: "v7-fw", type: "firewall", name: "FW-1", x: -150, y: 0, config: { ethernetPorts: 2, rules: [], policy: { forward: "accept" } } },
      { id: "v7-sw", type: "switch", name: "SW-1", x: 150, y: 0, config: { managed: false, ethernetPorts: 4, macTable: [] } },
      { id: "v7-srv", type: "computer", name: "SRV-1", x: 440, y: 0, config: { ipv4Address: "192.168.1.20", gatewayIpv4Address: "", macAddress: "02:00:00:00:07:1F", arpTable: [], openPorts: [22, 23] } },
    ],
    links: [
      { from: "v7-a", to: "v7-fw" },
      { from: "v7-fw", to: "v7-sw" },
      { from: "v7-sw", to: "v7-srv" },
    ],
  },
  checks: [
    { kind: "ping", from: "PC-A", to: "SRV-1", label: "Ping still works" },
    { kind: "tcp", from: "PC-A", to: "SRV-1", port: 22, label: "SSH (22) still connects" },
    { kind: "tcp-fail", from: "PC-A", to: "SRV-1", port: 23, label: "Telnet (23) is blocked" },
  ],
};

const troubleshootGateway: Scenario = {
  id: "troubleshoot-gateway",
  name: "Troubleshoot: broken gateway",
  objective: "Users report PC-A cannot reach the 192.168.2.0/24 office, but replies from there work. Find the misconfiguration and fix it (hint: traceroute / ip route show on PC-A).",
  topology: {
    version: 1,
    devices: [
      { id: "v8-a", type: "computer", name: "PC-A", x: -440, y: 0, config: { ipv4Address: "192.168.1.10", gatewayIpv4Address: "192.168.1.254", macAddress: "02:00:00:00:08:0A", arpTable: [] } },
      { id: "v8-sw", type: "switch", name: "SW-1", x: -150, y: 0, config: { managed: false, ethernetPorts: 4, macTable: [] } },
      { id: "v8-r1", type: "router", name: "R1", x: 150, y: 0, config: { ethernetPorts: 2, serialPorts: 0, interfaces: [
        { peerId: "v8-sw", type: "ethernet", ipv4Address: "192.168.1.1" },
        { peerId: "v8-b", type: "ethernet", ipv4Address: "192.168.2.1" },
      ] } },
      { id: "v8-b", type: "computer", name: "PC-B", x: 440, y: 0, config: { ipv4Address: "192.168.2.10", gatewayIpv4Address: "192.168.2.1", macAddress: "02:00:00:00:08:0B", arpTable: [] } },
    ],
    links: [
      { from: "v8-a", to: "v8-sw" },
      { from: "v8-sw", to: "v8-r1" },
      { from: "v8-r1", to: "v8-b" },
    ],
  },
  checks: [
    { kind: "ping", from: "PC-A", to: "PC-B", label: "PC-A can reach PC-B" },
    { kind: "ping", from: "PC-B", to: "PC-A", label: "PC-B can reach PC-A" },
  ],
};

const troubleshootVlan: Scenario = {
  id: "troubleshoot-vlan",
  name: "Troubleshoot: wrong VLAN",
  objective: "PC-W was re-cabled during maintenance and can no longer reach its team. All of Sales should be on VLAN 10 — find the misassigned switch port and fix it.",
  topology: {
    version: 1,
    devices: [
      { id: "v9-sw", type: "switch", name: "MSW-1", x: 0, y: 0, config: {
        managed: true, ethernetPorts: 8, macTable: [],
        vlans: [{ id: 10, name: "Sales" }, { id: 20, name: "Guests" }],
        portVlans: { Ethernet1: 10, Ethernet2: 20, Ethernet3: 10 },  // Ethernet2 is wrong
        portModes: {},
      } },
      { id: "v9-a", type: "computer", name: "PC-A", x: -280, y: -160, config: { ipv4Address: "192.168.1.11", gatewayIpv4Address: "", macAddress: "02:00:00:00:09:0A", arpTable: [] } },
      { id: "v9-w", type: "computer", name: "PC-W", x: -280, y: 160, config: { ipv4Address: "192.168.1.12", gatewayIpv4Address: "", macAddress: "02:00:00:00:09:0B", arpTable: [] } },
      { id: "v9-c", type: "computer", name: "PC-C", x: 280, y: 0, config: { ipv4Address: "192.168.1.13", gatewayIpv4Address: "", macAddress: "02:00:00:00:09:0C", arpTable: [] } },
    ],
    links: [
      { from: "v9-sw", to: "v9-a", fromPort: 1 },
      { from: "v9-sw", to: "v9-w", fromPort: 2 },
      { from: "v9-sw", to: "v9-c", fromPort: 3 },
    ],
  },
  checks: [
    { kind: "ping", from: "PC-A", to: "PC-W", label: "PC-A can reach PC-W" },
    { kind: "ping", from: "PC-W", to: "PC-C", label: "PC-W can reach PC-C" },
  ],
};

const troubleshootFirewall: Scenario = {
  id: "troubleshoot-firewall",
  name: "Troubleshoot: overzealous firewall",
  objective: "A change request asked for Telnet (23) to be blocked, but since the change users cannot SSH to SRV-1 — and Telnet still works. Inspect FW-1's rules (iptables -L --line-numbers) and fix them.",
  topology: {
    version: 1,
    devices: [
      { id: "v10-a", type: "computer", name: "PC-A", x: -440, y: 0, config: { ipv4Address: "192.168.1.10", gatewayIpv4Address: "", macAddress: "02:00:00:00:0A:0A", arpTable: [] } },
      { id: "v10-fw", type: "firewall", name: "FW-1", x: -150, y: 0, config: {
        ethernetPorts: 2,
        rules: [{ chain: "forward", target: "drop", protocol: "tcp", dport: 22 }],  // wrong port blocked
        policy: { forward: "accept" },
      } },
      { id: "v10-sw", type: "switch", name: "SW-1", x: 150, y: 0, config: { managed: false, ethernetPorts: 4, macTable: [] } },
      { id: "v10-srv", type: "computer", name: "SRV-1", x: 440, y: 0, config: { ipv4Address: "192.168.1.20", gatewayIpv4Address: "", macAddress: "02:00:00:00:0A:1F", arpTable: [], openPorts: [22, 23] } },
    ],
    links: [
      { from: "v10-a", to: "v10-fw" },
      { from: "v10-fw", to: "v10-sw" },
      { from: "v10-sw", to: "v10-srv" },
    ],
  },
  checks: [
    { kind: "tcp", from: "PC-A", to: "SRV-1", port: 22, label: "SSH (22) connects" },
    { kind: "tcp-fail", from: "PC-A", to: "SRV-1", port: 23, label: "Telnet (23) is blocked" },
    { kind: "ping", from: "PC-A", to: "SRV-1", label: "Ping still works" },
  ],
};

const troubleshootStaticRoute: Scenario = {
  id: "troubleshoot-static-route",
  name: "Troubleshoot: bad static route",
  objective: "The two offices stopped reaching each other after a maintenance window. Check the routing tables (show ip route) — one router's static route has a typo'd next-hop.",
  topology: {
    version: 1,
    devices: [
      { id: "v11-r1", type: "router", name: "R1", x: -140, y: 0, config: { ethernetPorts: 2, serialPorts: 2,
        staticRoutes: [{ network: "192.168.2.0/24", nextHop: "10.0.0.5" }],  // typo: should be .2
        interfaces: [
          { peerId: "v11-swa", type: "ethernet", ipv4Address: "192.168.1.1" },
          { peerId: "v11-r2", type: "serial", ipv4Address: "10.0.0.1" },
        ] } },
      { id: "v11-r2", type: "router", name: "R2", x: 140, y: 0, config: { ethernetPorts: 2, serialPorts: 2,
        staticRoutes: [{ network: "192.168.1.0/24", nextHop: "10.0.0.1" }],
        interfaces: [
          { peerId: "v11-swb", type: "ethernet", ipv4Address: "192.168.2.1" },
          { peerId: "v11-r1", type: "serial", ipv4Address: "10.0.0.2" },
        ] } },
      { id: "v11-swa", type: "switch", name: "SW-A", x: -400, y: 0, config: { managed: false, ethernetPorts: 4, macTable: [] } },
      { id: "v11-swb", type: "switch", name: "SW-B", x: 400, y: 0, config: { managed: false, ethernetPorts: 4, macTable: [] } },
      { id: "v11-a", type: "computer", name: "PC-A", x: -640, y: 0, config: { ipv4Address: "192.168.1.10", gatewayIpv4Address: "192.168.1.1", macAddress: "02:00:00:00:0B:0A", arpTable: [] } },
      { id: "v11-b", type: "computer", name: "PC-B", x: 640, y: 0, config: { ipv4Address: "192.168.2.10", gatewayIpv4Address: "192.168.2.1", macAddress: "02:00:00:00:0B:0B", arpTable: [] } },
    ],
    links: [
      { from: "v11-a", to: "v11-swa" },
      { from: "v11-swa", to: "v11-r1" },
      { from: "v11-r1", to: "v11-r2" },
      { from: "v11-r2", to: "v11-swb" },
      { from: "v11-swb", to: "v11-b" },
    ],
  },
  checks: [
    { kind: "ping", from: "PC-A", to: "PC-B", label: "PC-A can reach PC-B" },
    { kind: "ping", from: "PC-B", to: "PC-A", label: "PC-B can reach PC-A" },
  ],
};

const natGateway: Scenario = {
  id: "nat-gateway",
  name: "NAT gateway",
  objective: "The ISP server (203.0.113.10) has no route back to your private LAN, so nothing gets a reply. Configure PAT on R1 (`ip nat inside` on the LAN interface, `ip nat outside` on the ISP interface) so PC-A reaches the server through R1's public address.",
  topology: {
    version: 1,
    devices: [
      { id: "v12-a", type: "computer", name: "PC-A", x: -440, y: 0, config: { ipv4Address: "192.168.1.10", gatewayIpv4Address: "192.168.1.1", macAddress: "02:00:00:00:0C:0A", arpTable: [] } },
      { id: "v12-r1", type: "router", name: "R1", x: -50, y: 0, config: { ethernetPorts: 2, serialPorts: 0, interfaces: [
        { peerId: "v12-a", type: "ethernet", ipv4Address: "192.168.1.1" },
        { peerId: "v12-srv", type: "ethernet", ipv4Address: "203.0.113.2" },
      ] } },
      { id: "v12-srv", type: "computer", name: "ISP-SRV", x: 360, y: 0, config: { ipv4Address: "203.0.113.10", gatewayIpv4Address: "", macAddress: "02:00:00:00:0C:1F", arpTable: [], openPorts: [80] } },
    ],
    links: [
      { from: "v12-a", to: "v12-r1" },
      { from: "v12-r1", to: "v12-srv" },
    ],
  },
  checks: [
    { kind: "ping", from: "PC-A", to: "ISP-SRV", label: "PC-A can ping the ISP server" },
    { kind: "tcp", from: "PC-A", to: "ISP-SRV", port: 80, label: "PC-A can reach the web server (80)" },
  ],
};

const hardenGateway: Scenario = {
  id: "harden-gateway",
  name: "Harden the gateway",
  objective: "Security policy: the gateway router itself must not answer pings from the LAN, but traffic THROUGH it must keep flowing. Use the router's INPUT chain (iptables) — not FORWARD — to drop ICMP addressed to R1.",
  topology: {
    version: 1,
    devices: [
      { id: "v13-a", type: "computer", name: "PC-A", x: -440, y: 0, config: { ipv4Address: "192.168.1.10", gatewayIpv4Address: "192.168.1.1", macAddress: "02:00:00:00:0D:0A", arpTable: [] } },
      { id: "v13-r1", type: "router", name: "R1", x: -50, y: 0, config: { ethernetPorts: 2, serialPorts: 0, interfaces: [
        { peerId: "v13-a", type: "ethernet", ipv4Address: "192.168.1.1" },
        { peerId: "v13-b", type: "ethernet", ipv4Address: "192.168.2.1" },
      ] } },
      { id: "v13-b", type: "computer", name: "PC-B", x: 360, y: 0, config: { ipv4Address: "192.168.2.10", gatewayIpv4Address: "192.168.2.1", macAddress: "02:00:00:00:0D:0B", arpTable: [] } },
    ],
    links: [
      { from: "v13-a", to: "v13-r1" },
      { from: "v13-r1", to: "v13-b" },
    ],
  },
  checks: [
    { kind: "ping-fail", from: "PC-A", to: "192.168.1.1", label: "R1 itself no longer answers pings" },
    { kind: "ping", from: "PC-A", to: "PC-B", label: "Traffic through R1 still flows" },
  ],
};

const dnsService: Scenario = {
  id: "dns-service",
  name: "Name service (DNS)",
  objective: "PC-A should reach the web server by NAME, not address. Point PC-A at the nameserver (`echo nameserver 192.168.1.53 > /etc/resolv.conf` in its terminal), then add an A-record on SRV-1 (`echo address=/web.corp/192.168.1.80 >> /etc/dnsmasq.conf`).",
  topology: {
    version: 1,
    devices: [
      { id: "v14-a", type: "computer", name: "PC-A", x: -440, y: 0, config: { ipv4Address: "192.168.1.10", gatewayIpv4Address: "", macAddress: "02:00:00:00:0E:0A", arpTable: [] } },
      { id: "v14-sw", type: "switch", name: "SW-1", x: 0, y: 0, config: { managed: false, ethernetPorts: 8, macTable: [] } },
      { id: "v14-srv", type: "server", name: "SRV-1", x: 320, y: -170, config: { ipv4Address: "192.168.1.53", gatewayIpv4Address: "", macAddress: "02:00:00:00:0E:35", arpTable: [], dnsmasqRunning: true, dnsRecords: [] } },
      { id: "v14-web", type: "computer", name: "WEB-1", x: 320, y: 170, config: { ipv4Address: "192.168.1.80", gatewayIpv4Address: "", macAddress: "02:00:00:00:0E:50", arpTable: [], openPorts: [80] } },
    ],
    links: [
      { from: "v14-a", to: "v14-sw" },
      { from: "v14-srv", to: "v14-sw" },
      { from: "v14-web", to: "v14-sw" },
    ],
  },
  checks: [
    { kind: "dns", from: "PC-A", name: "web.corp", ip: "192.168.1.80", label: "web.corp resolves to 192.168.1.80" },
    { kind: "ping", from: "PC-A", to: "web.corp", label: "PC-A can ping web.corp by name" },
    { kind: "tcp", from: "PC-A", to: "web.corp", port: 80, label: "The web port (80) answers by name" },
  ],
};

const troubleshootDns: Scenario = {
  id: "troubleshoot-dns",
  name: "Troubleshoot: name vs address",
  objective: "The classic complaint: 192.168.1.80 pings fine but web.corp does not. PC-A's resolver is fine — inspect SRV-1's records (`cat /etc/dnsmasq.conf`) and fix the stale A-record (appending `address=/web.corp/<correct ip>` replaces it).",
  topology: {
    version: 1,
    devices: [
      { id: "v15-a", type: "computer", name: "PC-A", x: -440, y: 0, config: { ipv4Address: "192.168.1.10", gatewayIpv4Address: "", macAddress: "02:00:00:00:0F:0A", arpTable: [], dnsServerIp: "192.168.1.53" } },
      { id: "v15-sw", type: "switch", name: "SW-1", x: 0, y: 0, config: { managed: false, ethernetPorts: 8, macTable: [] } },
      { id: "v15-srv", type: "server", name: "SRV-1", x: 320, y: -170, config: { ipv4Address: "192.168.1.53", gatewayIpv4Address: "", macAddress: "02:00:00:00:0F:35", arpTable: [], dnsmasqRunning: true, dnsRecords: [{ name: "web.corp", ip: "192.168.1.99" }] } },
      { id: "v15-web", type: "computer", name: "WEB-1", x: 320, y: 170, config: { ipv4Address: "192.168.1.80", gatewayIpv4Address: "", macAddress: "02:00:00:00:0F:50", arpTable: [], openPorts: [80] } },
    ],
    links: [
      { from: "v15-a", to: "v15-sw" },
      { from: "v15-srv", to: "v15-sw" },
      { from: "v15-web", to: "v15-sw" },
    ],
  },
  checks: [
    { kind: "ping", from: "PC-A", to: "192.168.1.80", label: "The web server's address answers" },
    { kind: "dns", from: "PC-A", name: "web.corp", ip: "192.168.1.80", label: "web.corp resolves to the web server" },
    { kind: "ping", from: "PC-A", to: "web.corp", label: "web.corp answers pings" },
  ],
};

const serverDhcp: Scenario = {
  id: "server-dhcp",
  name: "DHCP from the server",
  objective: "Bring PC-A up with zero manual configuration. Enable DHCP on SRV-1 (`echo dhcp-range=192.168.1.100,192.168.1.200 >> /etc/dnsmasq.conf`) — dnsmasq hands out address, mask, and nameserver in one exchange, after which PC-A must reach web.corp by name.",
  topology: {
    version: 1,
    devices: [
      { id: "v16-a", type: "computer", name: "PC-A", x: -440, y: 0, config: { ipv4Address: "", gatewayIpv4Address: "", macAddress: "02:00:00:00:10:0A", arpTable: [] } },
      { id: "v16-sw", type: "switch", name: "SW-1", x: 0, y: 0, config: { managed: false, ethernetPorts: 8, macTable: [] } },
      { id: "v16-srv", type: "server", name: "SRV-1", x: 320, y: -170, config: { ipv4Address: "192.168.1.53", gatewayIpv4Address: "", macAddress: "02:00:00:00:10:35", arpTable: [], dnsmasqRunning: true, dnsRecords: [{ name: "web.corp", ip: "192.168.1.80" }] } },
      { id: "v16-web", type: "computer", name: "WEB-1", x: 320, y: 170, config: { ipv4Address: "192.168.1.80", gatewayIpv4Address: "", macAddress: "02:00:00:00:10:50", arpTable: [], openPorts: [80] } },
    ],
    links: [
      { from: "v16-a", to: "v16-sw" },
      { from: "v16-srv", to: "v16-sw" },
      { from: "v16-web", to: "v16-sw" },
    ],
  },
  checks: [
    { kind: "dhcp", host: "PC-A", label: "PC-A obtains a DHCP lease" },
    { kind: "dns", from: "PC-A", name: "web.corp", ip: "192.168.1.80", label: "PC-A's leased resolver answers for web.corp" },
    { kind: "ping", from: "PC-A", to: "web.corp", label: "PC-A can ping web.corp by name" },
  ],
};

export const CURRICULUM: Scenario[] = [
  vlanSegmentation,
  routerOnAStick,
  staticRoutes,
  dhcpService,
  ripConvergence,
  firewallGuard,
  troubleshootGateway,
  troubleshootVlan,
  troubleshootFirewall,
  troubleshootStaticRoute,
  natGateway,
  hardenGateway,
  dnsService,
  troubleshootDns,
  serverDhcp,
];
