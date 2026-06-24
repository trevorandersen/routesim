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
 *  17. wifi-join            join a secured WiFi network from a new laptop
 *  18. troubleshoot-wifi    laptop "associated" but offline — a wrong WiFi password
 *  19. wifi-dhcp            join an open hotspot, then pull a lease over the air
 *  20. port-auth-8021x      authenticate an 802.1X `auto` switch port to pass data
 *  21. macsec-link          key a must-secure trunk to bring the encrypted link up
 *  22. secure-access        capstone: 802.1X auth that also derives the MACsec key
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

const wifiJoin: Scenario = {
  id: "wifi-join",
  name: "Join a WiFi network",
  objective: "A new laptop LT-1 is not yet on the office WiFi. The access point AP-1 broadcasts the secured SSID \"Acme-Corp\" with password \"marigold42\". Set LT-1's SSID and password to match, then associate it to AP-1 so it can reach the wired server SRV-1.",
  topology: {
    version: 1,
    devices: [
      { id: "wj-lt", type: "laptop", name: "LT-1", x: -280, y: 200, config: { ipv4Address: "192.168.1.30", gatewayIpv4Address: "192.168.1.1", macAddress: "02:00:00:00:21:01", ssid: "", wifiPassword: "" } },
      { id: "wj-ap", type: "access-point", name: "AP-1", x: -180, y: 0, config: { managed: false, ethernetPorts: 1, ssid: "Acme-Corp", wifiPassword: "marigold42", macTable: [] } },
      { id: "wj-sw", type: "switch", name: "SW-1", x: 60, y: 0, config: { managed: false, ethernetPorts: 4, macTable: [] } },
      { id: "wj-srv", type: "computer", name: "SRV-1", x: 300, y: 0, config: { ipv4Address: "192.168.1.20", gatewayIpv4Address: "192.168.1.1", macAddress: "02:00:00:00:21:20", arpTable: [], openPorts: [80] } },
    ],
    links: [
      { from: "wj-ap", to: "wj-sw" },
      { from: "wj-srv", to: "wj-sw" },
    ],
  },
  checks: [
    { kind: "link", a: "LT-1", b: "AP-1", label: "LT-1 is associated to AP-1" },
    { kind: "ping", from: "LT-1", to: "SRV-1", label: "LT-1 can reach SRV-1" },
    { kind: "tcp", from: "LT-1", to: "SRV-1", port: 80, label: "LT-1 can reach the web port (80)" },
  ],
};

const troubleshootWifi: Scenario = {
  id: "troubleshoot-wifi",
  name: "Troubleshoot: wrong WiFi password",
  objective: "LT-1 shows as associated to the Acme-Guest WiFi but cannot reach SRV-1. The classic symptom of a wrong saved password — the network is \"Acme-Guest\" with password \"tulip-2024\". Re-join LT-1 with the correct credentials.",
  topology: {
    version: 1,
    devices: [
      { id: "tw-lt", type: "laptop", name: "LT-1", x: -300, y: 180, config: { ipv4Address: "192.168.1.10", gatewayIpv4Address: "", macAddress: "02:00:00:00:22:0A", arpTable: [], ssid: "Acme-Guest", wifiPassword: "hunter2" } },
      { id: "tw-ap", type: "access-point", name: "AP-1", x: -180, y: 0, config: { managed: false, ethernetPorts: 1, ssid: "Acme-Guest", wifiPassword: "tulip-2024", macTable: [] } },
      { id: "tw-sw", type: "switch", name: "SW-1", x: 60, y: 0, config: { managed: false, ethernetPorts: 8, macTable: [] } },
      { id: "tw-srv", type: "computer", name: "SRV-1", x: 300, y: 0, config: { ipv4Address: "192.168.1.20", gatewayIpv4Address: "", macAddress: "02:00:00:00:22:1F", arpTable: [], openPorts: [80] } },
    ],
    links: [
      { from: "tw-ap", to: "tw-lt", wireless: true },
      { from: "tw-ap", to: "tw-sw" },
      { from: "tw-sw", to: "tw-srv" },
    ],
  },
  checks: [
    { kind: "config", device: "LT-1", field: "wifiPassword", equals: "tulip-2024", label: "LT-1 has the correct WiFi password" },
    { kind: "ping", from: "LT-1", to: "SRV-1", label: "LT-1 can reach SRV-1 over the WiFi" },
    { kind: "tcp", from: "LT-1", to: "SRV-1", port: 80, label: "LT-1 can reach the web server (80)" },
  ],
};

const wifiDhcp: Scenario = {
  id: "wifi-dhcp",
  name: "WiFi hotspot + DHCP",
  objective: "LT-1 has no address and is not on the WiFi. AP-1 broadcasts the open guest network \"Cafe-Guest\", bridged through SW-1 to SRV-1 (dnsmasq, serving 192.168.7.100-200). Join the hotspot (set LT-1's SSID to \"Cafe-Guest\", then associate it to AP-1) so LT-1 pulls an address automatically over the air.",
  topology: {
    version: 1,
    devices: [
      { id: "wd-lt", type: "laptop", name: "LT-1", x: -300, y: 160, config: { ipv4Address: "", gatewayIpv4Address: "", macAddress: "02:00:00:00:23:0A", arpTable: [], ssid: "RouteSim" } },
      { id: "wd-ap", type: "access-point", name: "AP-1", x: -300, y: 0, config: { managed: false, ethernetPorts: 1, ssid: "Cafe-Guest", macTable: [] } },
      { id: "wd-sw", type: "switch", name: "SW-1", x: 0, y: 0, config: { managed: false, ethernetPorts: 8, macTable: [] } },
      { id: "wd-srv", type: "server", name: "SRV-1", x: 320, y: 0, config: { ipv4Address: "192.168.7.1", gatewayIpv4Address: "", macAddress: "02:00:00:00:23:35", arpTable: [], dnsmasqRunning: true, dhcpRangeStart: "192.168.7.100", dhcpRangeEnd: "192.168.7.200", dnsRecords: [] } },
    ],
    links: [
      { from: "wd-ap", to: "wd-sw" },
      { from: "wd-srv", to: "wd-sw" },
    ],
  },
  checks: [
    { kind: "config", device: "LT-1", field: "ssid", equals: "Cafe-Guest", label: "LT-1 is set to the Cafe-Guest SSID" },
    { kind: "link", a: "LT-1", b: "AP-1", label: "LT-1 is associated to AP-1" },
    { kind: "dhcp", host: "LT-1", label: "LT-1 obtains a DHCP lease over the air" },
  ],
};

const portAuth8021x: Scenario = {
  id: "port-auth-8021x",
  name: "802.1X port authentication",
  objective: "SW-1's port to PC-1 is locked with 802.1X (`auto`): until PC-1 authenticates, the port carries no data, so PC-1 cannot reach PC-2. The RADIUS server RAD already holds the account (identity \"emp01\", password \"Net$2024\"). Give PC-1 those supplicant credentials, then authenticate the port (`run dot1x PC-1`) so it opens and PC-1 can ping PC-2.",
  topology: {
    version: 1,
    devices: [
      { id: "px-pc1", type: "computer", name: "PC-1", x: -300, y: 0, config: { ipv4Address: "10.10.0.10", gatewayIpv4Address: "", macAddress: "02:00:00:00:24:01", arpTable: [] } },
      { id: "px-sw", type: "switch", name: "SW-1", x: 0, y: 0, config: { managed: true, ethernetPorts: 8, macTable: [], vlans: [], portVlans: {}, portModes: {}, portAuth: { Ethernet1: "auto" } } },
      { id: "px-pc2", type: "computer", name: "PC-2", x: 300, y: 0, config: { ipv4Address: "10.10.0.20", gatewayIpv4Address: "", macAddress: "02:00:00:00:24:02", arpTable: [] } },
      { id: "px-rad", type: "server", name: "RAD", x: 0, y: 240, config: { ipv4Address: "10.10.0.53", gatewayIpv4Address: "", macAddress: "02:00:00:00:24:53", arpTable: [], radius: { users: [{ identity: "emp01", password: "Net$2024" }] } } },
    ],
    links: [
      { from: "px-sw", to: "px-pc1", fromPort: 1 },
      { from: "px-sw", to: "px-pc2", fromPort: 2 },
      { from: "px-sw", to: "px-rad", fromPort: 3 },
    ],
  },
  checks: [
    { kind: "ping", from: "PC-1", to: "PC-2", label: "PC-1 can reach PC-2 once the port is authenticated" },
  ],
};

const macsecLink: Scenario = {
  id: "macsec-link",
  name: "MACsec the inter-switch trunk",
  objective: "Compliance requires the SW-1 ↔ SW-2 trunk to be encrypted with MACsec. SW-1 is already keyed must-secure with the CAK CAKKEY0123456789, but its peer SW-2 has no matching key — so the link has failed and PC-A cannot reach PC-B. Configure SW-2 with the same key and mode to bring the now-encrypted trunk up.",
  topology: {
    version: 1,
    devices: [
      { id: "ms-a", type: "computer", name: "PC-A", x: -440, y: 0, config: { ipv4Address: "192.168.5.10", gatewayIpv4Address: "", macAddress: "02:00:00:00:25:0A", arpTable: [] } },
      { id: "ms-sw1", type: "switch", name: "SW-1", x: -150, y: 0, config: { managed: true, ethernetPorts: 8, macTable: [], macsec: { "ms-sw2": { cak: "CAKKEY0123456789", mode: "must" } } } },
      { id: "ms-sw2", type: "switch", name: "SW-2", x: 150, y: 0, config: { managed: true, ethernetPorts: 8, macTable: [] } },
      { id: "ms-b", type: "computer", name: "PC-B", x: 440, y: 0, config: { ipv4Address: "192.168.5.20", gatewayIpv4Address: "", macAddress: "02:00:00:00:25:0B", arpTable: [] } },
    ],
    links: [
      { from: "ms-a", to: "ms-sw1", fromPort: 1 },
      { from: "ms-sw1", to: "ms-sw2", fromPort: 2 },
      { from: "ms-sw2", to: "ms-b", fromPort: 1 },
    ],
  },
  checks: [
    { kind: "ping", from: "PC-A", to: "PC-B", label: "PC-A can reach PC-B across the encrypted trunk" },
    { kind: "ping", from: "PC-B", to: "PC-A", label: "PC-B can reach PC-A across the encrypted trunk" },
  ],
};

const secureAccess: Scenario = {
  id: "secure-access",
  name: "Secure access (802.1X + MACsec)",
  objective: "Capstone: PC-1 sits on an `auto` 802.1X port of SW-1, and both ends of the PC-1 ↔ SW-1 link key MACsec from that 802.1X exchange (must-secure). PC-1 has no supplicant credentials, so the port stays unauthorised and the link cannot derive a key — PC-1 cannot reach PC-2. Give PC-1 the RADIUS account (emp01 / Net$2024), then run 802.1X (`run dot1x PC-1`): the single exchange authorises the port AND derives the MACsec key, bringing the encrypted link up.",
  topology: {
    version: 1,
    devices: [
      { id: "sa-pc1", type: "computer", name: "PC-1", x: -260, y: -120, config: { ipv4Address: "10.20.0.10", gatewayIpv4Address: "", macAddress: "02:00:00:00:26:01", arpTable: [], macsec: { "sa-sw": { derive: true, mode: "must" } } } },
      { id: "sa-sw", type: "switch", name: "SW-1", x: 0, y: 0, config: { managed: true, ethernetPorts: 8, macTable: [], vlans: [], portVlans: {}, portModes: {}, portAuth: { Ethernet1: "auto" }, macsec: { "sa-pc1": { derive: true, mode: "must" } } } },
      { id: "sa-pc2", type: "computer", name: "PC-2", x: -260, y: 120, config: { ipv4Address: "10.20.0.20", gatewayIpv4Address: "", macAddress: "02:00:00:00:26:02", arpTable: [] } },
      { id: "sa-rad", type: "server", name: "RAD", x: 220, y: 0, config: { ipv4Address: "10.20.0.2", gatewayIpv4Address: "", macAddress: "02:00:00:00:26:03", arpTable: [], radius: { users: [{ identity: "emp01", password: "Net$2024" }] } } },
    ],
    links: [
      { from: "sa-pc1", to: "sa-sw", fromPort: 1 },
      { from: "sa-sw", to: "sa-pc2", fromPort: 2 },
      { from: "sa-sw", to: "sa-rad", fromPort: 3 },
    ],
  },
  checks: [
    { kind: "ping", from: "PC-1", to: "PC-2", label: "PC-1 reaches PC-2 over the authenticated, encrypted link" },
  ],
};

const spanningTree: Scenario = {
  id: "spanning-tree",
  name: "Break the loop (spanning tree)",
  objective: "SW-1, SW-2 and SW-3 are wired in a triangle for redundancy, but spanning tree has been switched off on all three. With no tree to block a redundant link, a broadcast loops forever — the network is in a broadcast storm and PC-A cannot reach PC-B. Turn spanning tree back on (it is on by default for managed switches) so the bridges elect a root and block one redundant port, clearing the storm.",
  topology: {
    version: 1,
    devices: [
      { id: "stp-pc-a", type: "computer", name: "PC-A", x: -300, y: -120, config: { ipv4Address: "10.0.0.10", gatewayIpv4Address: "", macAddress: "02:00:00:00:27:0A", arpTable: [] } },
      { id: "stp-pc-b", type: "computer", name: "PC-B", x: 300, y: -120, config: { ipv4Address: "10.0.0.20", gatewayIpv4Address: "", macAddress: "02:00:00:00:27:0B", arpTable: [] } },
      { id: "stp-sw1", type: "switch", name: "SW-1", x: -180, y: 40, config: { managed: true, ethernetPorts: 8, macTable: [], vlans: [], portVlans: {}, portModes: {}, stp: { enabled: false } } },
      { id: "stp-sw2", type: "switch", name: "SW-2", x: 180, y: 40, config: { managed: true, ethernetPorts: 8, macTable: [], vlans: [], portVlans: {}, portModes: {}, stp: { enabled: false } } },
      { id: "stp-sw3", type: "switch", name: "SW-3", x: 0, y: 220, config: { managed: true, ethernetPorts: 8, macTable: [], vlans: [], portVlans: {}, portModes: {}, stp: { enabled: false } } },
    ],
    links: [
      { from: "stp-pc-a", to: "stp-sw1" },
      { from: "stp-pc-b", to: "stp-sw2" },
      { from: "stp-sw1", to: "stp-sw2" },
      { from: "stp-sw2", to: "stp-sw3" },
      { from: "stp-sw3", to: "stp-sw1" },
    ],
  },
  checks: [
    { kind: "ping", from: "PC-A", to: "PC-B", label: "PC-A can reach PC-B (the loop is broken)" },
  ],
};

const idsMonitor: Scenario = {
  id: "ids-monitor",
  name: "Catch the intruder (IDS + SPAN)",
  objective: "PC-INTRUDER is telnetting to SRV (an insecure, monitored protocol). A Snort IDS sensor (IDS-1) is already wired into SW-1 and loaded with a Telnet-detection rule, but it isn't seeing any traffic — a passive sensor only watches a copy of the traffic it's fed. Configure port mirroring (SPAN) on SW-1 to mirror the LAN to the sensor's monitor port (Ethernet3) so it detects the attack. Try the console: `mirror SW-1 Ethernet3`.",
  topology: {
    version: 1,
    devices: [
      { id: "ids-sw", type: "switch", name: "SW-1", x: 0, y: 0, config: { managed: true, ethernetPorts: 8, macTable: [], vlans: [], portVlans: {}, portModes: {} } },
      { id: "ids-atk", type: "computer", name: "PC-INTRUDER", x: -280, y: -120, config: { ipv4Address: "10.0.0.66", gatewayIpv4Address: "", macAddress: "02:00:00:00:28:66", arpTable: [] } },
      { id: "ids-srv", type: "server", name: "SRV", x: 280, y: -120, config: { ipv4Address: "10.0.0.10", gatewayIpv4Address: "", macAddress: "02:00:00:00:28:10", arpTable: [], dnsmasqRunning: false, openPorts: [23] } },
      { id: "ids-ids", type: "ids", name: "IDS-1", x: 0, y: 180, config: { idsRules: [
        `alert tcp any any -> any 23 (msg:"Telnet connection attempt"; sid:1000002; rev:1;)`,
        `alert icmp any any -> any any (msg:"ICMP traffic detected"; itype:8; sid:1000001; rev:1;)`,
      ], alerts: [] } },
    ],
    links: [
      { from: "ids-sw", to: "ids-atk", fromPort: 1 },
      { from: "ids-sw", to: "ids-srv", fromPort: 2 },
      { from: "ids-sw", to: "ids-ids", fromPort: 3 },
    ],
  },
  checks: [
    { kind: "alert", from: "PC-INTRUDER", to: "SRV", port: 23, contains: "Telnet", label: "IDS-1 detects the Telnet attempt" },
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
  wifiJoin,
  troubleshootWifi,
  wifiDhcp,
  portAuth8021x,
  macsecLink,
  secureAccess,
  spanningTree,
  idsMonitor,
];
