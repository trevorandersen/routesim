/**
 * Scenario framework tests — loading, goal evaluation, and console parity.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state, defaultConfig, vlanRoasConfig, routerMeshConfig, wifiVlanConfig } from "../src/state";
import { SCENARIOS, getScenario, loadScenario, checkScenario } from "../src/scenarios";
import { addLink } from "../src/devices";
import { runConsoleCommand as exec, runConsoleScript } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

describe("built-in topologies & scenarios — positive coordinates", () => {
  const configs: [string, any][] = [
    ["default", defaultConfig], ["vlan-roas", vlanRoasConfig], ["router-mesh", routerMeshConfig],
    ["wifi-vlan", wifiVlanConfig],
    ...SCENARIOS.map(s => [`scenario:${s.id}`, s.topology] as [string, any]),
  ];
  for (const [name, cfg] of configs) {
    it(`${name} has all device coordinates >= 0`, () => {
      for (const d of cfg.devices) {
        expect(d.x, `${name} ${d.name || d.id} x`).toBeGreaterThanOrEqual(0);
        expect(d.y, `${name} ${d.name || d.id} y`).toBeGreaterThanOrEqual(0);
      }
    });
  }
});

beforeAll(() => registerNoopCallbacks());

describe("scenarios — Connect a LAN", () => {
  beforeEach(() => resetState());

  it("loads the initial topology (unlinked) and sets the active scenario", () => {
    expect(loadScenario("connect-lan")).toBe(true);
    expect(state.activeScenarioId).toBe("connect-lan");
    expect(state.devices.map(d => d.name).sort()).toEqual(["PC-A", "PC-B", "Switch-1"]);
    expect(state.links).toHaveLength(0);
  });

  it("rejects an unknown scenario id", () => {
    expect(loadScenario("nope")).toBe(false);
  });

  it("fails the goal before linking, passes after linking", () => {
    loadScenario("connect-lan");
    const scenario = getScenario("connect-lan")!;

    const before = checkScenario(scenario);
    expect(before.passed).toBe(false);
    expect(before.checks.every(c => !c.passed)).toBe(true);

    // Wire PC-A and PC-B to the switch.
    addLink("s1-pc-a", "s1-sw");
    addLink("s1-pc-b", "s1-sw");

    const after = checkScenario(scenario);
    expect(after.passed).toBe(true);
    expect(after.checks.find(c => c.label.includes("ping"))!.passed).toBe(true);
  });
});

describe("scenarios — console parity", () => {
  beforeEach(() => resetState());

  it("scenario list / load / check via the command engine", () => {
    expect(exec("scenario list").output.join("\n")).toContain("connect-lan");
    expect(exec("scenario load connect-lan").ok).toBe(true);

    const before = exec("scenario check");
    expect(before.ok).toBe(false);
    expect((before.data as any).passed).toBe(false);

    addLink("s1-pc-a", "s1-sw");
    addLink("s1-pc-b", "s1-sw");

    const after = exec("scenario check");
    expect(after.ok).toBe(true);
    expect((after.data as any).passed).toBe(true);
  });
});

// ─── Curriculum solvability ────────────────────────────────────────────────────
// Every scenario must (a) not be already-solved when loaded and (b) pass after
// applying its reference solution via the console — proof the curriculum works.

const SOLUTIONS: Record<string, string> = {
  "connect-lan": `
    link PC-A Switch-1
    link PC-B Switch-1
  `,
  "vlan-segmentation": `
    cli MSW-1 config vlan add 10
    cli MSW-1 config vlan add 20
    cli MSW-1 config vlan member add 10 Ethernet1
    cli MSW-1 config vlan member add 10 Ethernet2
    cli MSW-1 config vlan member add 20 Ethernet3
    cli MSW-1 config vlan member add 20 Ethernet4
  `,
  "router-on-a-stick": `
    interface RTR-1 MSW-1 ip 192.168.10.1 vlan 10
    interface RTR-1 MSW-1 ip 192.168.20.1 vlan 20
  `,
  "static-routes": `
    route R1 192.168.2.0/24 10.0.0.2
    route R2 192.168.1.0/24 10.0.0.1
  `,
  "dhcp-service": `
    link PC-A SW-1
    link SW-1 R1
  `,
  "rip-convergence": `
    cli R1 enable
    cli R1 configure terminal
    cli R1 router rip
    cli R1 network 192.168.1.0/24
    cli R1 network 10.0.12.0/24
    cli R2 enable
    cli R2 configure terminal
    cli R2 router rip
    cli R2 network 10.0.12.0/24
    cli R2 network 10.0.23.0/24
    cli R3 enable
    cli R3 configure terminal
    cli R3 router rip
    cli R3 network 10.0.23.0/24
    cli R3 network 192.168.3.0/24
  `,
  "firewall-guard": `
    cli FW-1 iptables -A FORWARD -p tcp --dport 23 -j DROP
  `,
  "troubleshoot-gateway": `
    gateway PC-A 192.168.1.1
  `,
  "troubleshoot-vlan": `
    cli MSW-1 config vlan member add 10 Ethernet2
  `,
  "troubleshoot-firewall": `
    cli FW-1 iptables -D FORWARD 1
    cli FW-1 iptables -A FORWARD -p tcp --dport 23 -j DROP
  `,
  "troubleshoot-static-route": `
    cli R1 enable
    cli R1 configure terminal
    cli R1 no ip route 192.168.2.0/24
    cli R1 ip route 192.168.2.0/24 10.0.0.2
  `,
  "nat-gateway": `
    cli R1 enable
    cli R1 configure terminal
    cli R1 interface Ethernet1
    cli R1 ip nat inside
    cli R1 exit
    cli R1 interface Ethernet2
    cli R1 ip nat outside
  `,
  "harden-gateway": `
    cli R1 enable
    cli R1 iptables -A INPUT -p icmp -j DROP
  `,
  "dns-service": `
    cli PC-A echo nameserver 192.168.1.53 > /etc/resolv.conf
    cli SRV-1 echo address=/web.corp/192.168.1.80 >> /etc/dnsmasq.conf
  `,
  "troubleshoot-dns": `
    cli SRV-1 echo address=/web.corp/192.168.1.80 >> /etc/dnsmasq.conf
  `,
  "server-dhcp": `
    cli SRV-1 echo dhcp-range=192.168.1.100,192.168.1.200 >> /etc/dnsmasq.conf
  `,
};

describe("scenarios — every curriculum entry is solvable", () => {
  beforeEach(() => resetState());

  for (const scenario of SCENARIOS) {
    it(`${scenario.id}: fails fresh, passes after the reference solution`, () => {
      const solution = SOLUTIONS[scenario.id];
      expect(solution, `missing reference solution for ${scenario.id}`).toBeDefined();
      expect(loadScenario(scenario.id)).toBe(true);

      const before = checkScenario(scenario);
      expect(before.passed, `${scenario.id} must not be pre-solved`).toBe(false);

      const results = runConsoleScript(solution);
      const failed = results.filter(r => !r.ok);
      expect(failed.map(f => f.output.join(" ")), `${scenario.id} solution commands all succeed`).toEqual([]);

      const after = checkScenario(scenario);
      expect(after.checks.filter(c => !c.passed).map(c => c.label), `${scenario.id} checks after solving`).toEqual([]);
      expect(after.passed).toBe(true);
    });
  }
});
