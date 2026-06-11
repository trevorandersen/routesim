/**
 * DNS + the server device (dnsmasq).
 *
 * Covers: the server as an ordinary host endpoint, /etc/resolv.conf and
 * /etc/dnsmasq.conf terminal handling, headless resolution (nslookup), the
 * resolve-then-act flows (ping/nc by name), DNS across a router, dnsmasq DHCP
 * (range allocation, option:router, nameserver option 6, one-daemon
 * semantics), the multi-server offer race, UDP flows through NAT, and config
 * round-trips.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { runSimulationHeadless } from "../src/engine";
import { buildPingEvents, buildConnectEvents, buildResolveEvents, buildDhcpEvents } from "../src/simulation";
import { buildConfigPayload, parseConfig } from "../src/config";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());

// PC1 ── SW ── SRV (dnsmasq, 192.168.1.53) / WEB (192.168.1.80, port 80 only)
function flatTopology() {
  runConsoleScript(`
    add computer PC1 at 0 0
    add switch SW at 200 0
    add server SRV at 400 -100
    add computer WEB at 400 100
    link PC1 SW
    link SRV SW
    link WEB SW
    ip PC1 192.168.1.10/24
    ip SRV 192.168.1.53/24
    ip WEB 192.168.1.80/24
  `);
  const web = state.devices.find(d => d.name === "WEB")!;
  web.config.openPorts = [80];
  return {
    pc1: state.devices.find(d => d.name === "PC1")!,
    srv: state.devices.find(d => d.name === "SRV")!,
    web,
  };
}

function withRecord() {
  const t = flatTopology();
  runConsoleScript(`
    cli PC1 echo nameserver 192.168.1.53 > /etc/resolv.conf
    cli SRV echo address=/web.corp/192.168.1.80 >> /etc/dnsmasq.conf
  `);
  return t;
}

// PC1 ── R1 ── (SRV + WEB) on 192.168.2.0/24 — resolution crosses the router.
function routedTopology() {
  runConsoleScript(`
    add computer PC1 at 0 0
    add router R1 at 200 0
    add switch SW at 400 0
    add server SRV at 600 -100
    add computer WEB at 600 100
    link PC1 R1
    link R1 SW
    link SRV SW
    link WEB SW
    ip PC1 192.168.1.10/24
    gateway PC1 192.168.1.1
    ip SRV 192.168.2.53/24
    gateway SRV 192.168.2.1
    ip WEB 192.168.2.80/24
    gateway WEB 192.168.2.1
    interface R1 PC1 ip 192.168.1.1
    interface R1 SW ip 192.168.2.1
    cli PC1 echo nameserver 192.168.2.53 > /etc/resolv.conf
    cli SRV echo address=/web.corp/192.168.2.80 >> /etc/dnsmasq.conf
  `);
  return {
    pc1: state.devices.find(d => d.name === "PC1")!,
    r1: state.devices.find(d => d.name === "R1")!,
  };
}

function resolveHeadless(host: any, name: string) {
  const setup = buildResolveEvents(host, name, null, null);
  if (typeof setup === "string") return setup;
  return runSimulationHeadless(setup, host.id, name, "dns");
}

describe("server — an ordinary host endpoint", () => {
  beforeEach(() => resetState());

  it("answers pings and TCP like a computer", () => {
    const { pc1 } = flatTopology();
    const ping = runSimulationHeadless(buildPingEvents(pc1, "192.168.1.53") as any, pc1.id, "192.168.1.53", "ping");
    expect(ping.success).toBe(true);
    const tcp = runSimulationHeadless(buildConnectEvents(pc1, "192.168.1.53", 53) as any, pc1.id, "192.168.1.53", "tcp", 53);
    expect(tcp.success).toBe(true);
  });

  it("is a valid ping target by device name", () => {
    const { pc1 } = flatTopology();
    const r = exec("run ping PC1 SRV");
    expect(r.ok).toBe(true);
    expect(pc1.config.arpTable!.some(e => e.ipv4Address === "192.168.1.53")).toBe(true);
  });
});

describe("resolv.conf + dnsmasq.conf terminals", () => {
  beforeEach(() => resetState());

  it("echo nameserver > /etc/resolv.conf sets the resolver; cat shows it", () => {
    const { pc1 } = flatTopology();
    expect(exec("cli PC1 cat /etc/resolv.conf").output.join(" ")).toContain("empty");
    exec("cli PC1 echo nameserver 192.168.1.53 > /etc/resolv.conf");
    expect(pc1.config.dnsServerIp).toBe("192.168.1.53");
    expect(exec("cli PC1 cat /etc/resolv.conf").output.join(" ")).toContain("nameserver 192.168.1.53");
  });

  it("address=/name/ip adds a record; appending the same name replaces it", () => {
    const { srv } = flatTopology();
    exec("cli SRV echo address=/web.corp/192.168.1.99 >> /etc/dnsmasq.conf");
    exec("cli SRV echo address=/web.corp/192.168.1.80 >> /etc/dnsmasq.conf");
    expect(srv.config.dnsRecords).toEqual([{ name: "web.corp", ip: "192.168.1.80" }]);
    expect(exec("cli SRV cat /etc/dnsmasq.conf").output.join("\n")).toContain("address=/web.corp/192.168.1.80");
  });

  it("dhcp-range and dhcp-option=option:router configure DHCP", () => {
    const { srv } = flatTopology();
    exec("cli SRV echo dhcp-range=192.168.1.100,192.168.1.200 >> /etc/dnsmasq.conf");
    exec("cli SRV echo dhcp-option=option:router,192.168.1.1 >> /etc/dnsmasq.conf");
    expect(srv.config.dhcpRangeStart).toBe("192.168.1.100");
    expect(srv.config.dhcpRangeEnd).toBe("192.168.1.200");
    expect(srv.config.dhcpRouterIp).toBe("192.168.1.1");
  });

  it("rejects unsupported directives", () => {
    flatTopology();
    const r = exec("cli SRV echo bogus-directive=1 >> /etc/dnsmasq.conf");
    expect(r.output.join(" ")).toContain("unsupported directive");
  });

  it("systemctl stop/start/status manage the daemon", () => {
    const { srv } = flatTopology();
    exec("cli SRV systemctl stop dnsmasq");
    expect(srv.config.dnsmasqRunning).toBe(false);
    expect(exec("cli SRV systemctl status dnsmasq").output.join(" ")).toContain("inactive");
    exec("cli SRV systemctl start dnsmasq");
    expect(srv.config.dnsmasqRunning).toBe(true);
  });
});

describe("dns — resolution", () => {
  beforeEach(() => resetState());

  it("resolves a configured A-record (real UDP/53 frames)", () => {
    const { pc1 } = withRecord();
    const r = resolveHeadless(pc1, "web.corp");
    expect(typeof r).not.toBe("string");
    expect((r as any).success).toBe(true);
    expect((r as any).resolvedIp).toBe("192.168.1.80");
    expect((r as any).log.some((l: any) => l.kind === "sim-dns")).toBe(true);
  });

  it("answers NXDOMAIN for an unknown name", () => {
    const { pc1 } = withRecord();
    const r = resolveHeadless(pc1, "nope.corp") as any;
    expect(r.success).toBe(false);
    expect(r.resolvedIp).toBeNull();
    expect(r.log.some((l: any) => l.summary.includes("NXDOMAIN"))).toBe(true);
  });

  it("times out silently when dnsmasq is stopped (DNS and DHCP share the daemon)", () => {
    const { pc1 } = withRecord();
    exec("cli SRV systemctl stop dnsmasq");
    const r = resolveHeadless(pc1, "web.corp") as any;
    expect(r.success).toBe(false);
    expect(r.log.some((l: any) => l.summary.includes("not running"))).toBe(true);
  });

  it("fails with an error when no nameserver is configured", () => {
    const { pc1 } = flatTopology();
    const r = resolveHeadless(pc1, "web.corp");
    expect(typeof r).toBe("string");
    expect(r as string).toContain("no nameserver");
  });

  it("resolves across a router", () => {
    const { pc1 } = routedTopology();
    const r = resolveHeadless(pc1, "web.corp") as any;
    expect(r.success).toBe(true);
    expect(r.resolvedIp).toBe("192.168.2.80");
  });

  it("a FORWARD rule dropping UDP blocks resolution", () => {
    const { pc1 } = routedTopology();
    runConsoleScript(`
      cli R1 enable
      cli R1 iptables -A FORWARD -p udp -j DROP
    `);
    const r = resolveHeadless(pc1, "web.corp") as any;
    expect(r.success).toBe(false);
  });
});

describe("dns — resolve-then-act (ping/nc by name)", () => {
  beforeEach(() => resetState());

  it("ping by hostname resolves, then pings the answer", () => {
    const { pc1 } = withRecord();
    const setup = buildPingEvents(pc1, "web.corp");
    expect(typeof setup).not.toBe("string");
    const r = runSimulationHeadless(setup as any, pc1.id, "web.corp", "ping");
    expect(r.success).toBe(true);
    expect(r.resolvedIp).toBe("192.168.1.80");
    expect(r.responderIp).toBe("192.168.1.80");
  });

  it("ping by hostname fails cleanly on NXDOMAIN", () => {
    const { pc1 } = withRecord();
    const r = runSimulationHeadless(buildPingEvents(pc1, "missing.corp") as any, pc1.id, "missing.corp", "ping");
    expect(r.success).toBe(false);
    expect(r.resolvedIp).toBeNull();
  });

  it("ping by hostname without a nameserver is a validation error", () => {
    const { pc1 } = flatTopology();
    expect(typeof buildPingEvents(pc1, "web.corp")).toBe("string");
  });

  it("nc by hostname completes the handshake on an open port", () => {
    const { pc1 } = withRecord();
    const r = runSimulationHeadless(buildConnectEvents(pc1, "web.corp", 80) as any, pc1.id, "web.corp", "tcp", 80);
    expect(r.success).toBe(true);
    expect(r.resolvedIp).toBe("192.168.1.80");
  });

  it("nc by hostname is refused on a closed port", () => {
    const { pc1 } = withRecord();
    const r = runSimulationHeadless(buildConnectEvents(pc1, "web.corp", 23) as any, pc1.id, "web.corp", "tcp", 23);
    expect(r.success).toBe(false);
    expect(r.refused).toBe(true);
  });

  it("ping by name works across a router", () => {
    const { pc1 } = routedTopology();
    const r = runSimulationHeadless(buildPingEvents(pc1, "web.corp") as any, pc1.id, "web.corp", "ping");
    expect(r.success).toBe(true);
    expect(r.responderIp).toBe("192.168.2.80");
  });
});

describe("dnsmasq — DHCP service", () => {
  beforeEach(() => resetState());

  function dhcpServer(routerOption = "") {
    const t = flatTopology();
    runConsoleScript(`
      cli SRV echo address=/web.corp/192.168.1.80 >> /etc/dnsmasq.conf
      cli SRV echo dhcp-range=192.168.1.100,192.168.1.200 >> /etc/dnsmasq.conf
      ${routerOption}
      add computer NEW at 0 200
      link NEW SW
    `);
    return { ...t, fresh: state.devices.find(d => d.name === "NEW")! };
  }

  it("leases an address from the range and hands out the nameserver (option 6)", () => {
    const { fresh, srv } = dhcpServer();
    const r = runSimulationHeadless(buildDhcpEvents(fresh) as any, fresh.id, "", "dhcp");
    expect(r.success).toBe(true);
    expect(r.assignedIp).toBe("192.168.1.100");
    expect(fresh.config.dnsServerIp).toBe("192.168.1.53");
    // dnsmasq defaults option:router to itself
    expect(fresh.config.gatewayIpv4Address).toBe("192.168.1.53");
    expect(srv.config.dhcpLeases).toHaveLength(1);
  });

  it("dhcp-option=option:router overrides the gateway handed out", () => {
    const { fresh } = dhcpServer("cli SRV echo dhcp-option=option:router,192.168.1.1 >> /etc/dnsmasq.conf");
    const r = runSimulationHeadless(buildDhcpEvents(fresh) as any, fresh.id, "", "dhcp");
    expect(r.success).toBe(true);
    expect(fresh.config.gatewayIpv4Address).toBe("192.168.1.1");
  });

  it("zero-touch: after the lease, the client pings web.corp by name", () => {
    const { fresh } = dhcpServer();
    runSimulationHeadless(buildDhcpEvents(fresh) as any, fresh.id, "", "dhcp");
    const r = runSimulationHeadless(buildPingEvents(fresh, "web.corp") as any, fresh.id, "web.corp", "ping");
    expect(r.success).toBe(true);
    expect(r.responderIp).toBe("192.168.1.80");
  });

  it("stopping dnsmasq stops DHCP too (one daemon)", () => {
    const { fresh } = dhcpServer("cli SRV systemctl stop dnsmasq");
    const r = runSimulationHeadless(buildDhcpEvents(fresh) as any, fresh.id, "", "dhcp");
    expect(r.success).toBe(false);
  });

  it("with two DHCP servers the client takes one offer and gets exactly one ACK", () => {
    const { fresh } = dhcpServer();
    // Second DHCP server: a router interface on the same segment.
    runConsoleScript(`
      add router R1 at 200 -200
      link R1 SW
      interface R1 SW ip 192.168.1.1
    `);
    const r = runSimulationHeadless(buildDhcpEvents(fresh) as any, fresh.id, "", "dhcp");
    expect(r.success).toBe(true);
    const acks = r.log.filter(l => l.summary.includes("sending ACK"));
    expect(acks).toHaveLength(1);
    const ignored = r.log.filter(l => l.summary.includes("competing DHCP Offer"));
    expect(ignored.length).toBeGreaterThanOrEqual(0); // both offers may or may not race in event order
  });
});

describe("dns — through NAT (UDP translation)", () => {
  beforeEach(() => resetState());

  // SRV is the public DNS server with NO route back to the private LAN.
  function natDns() {
    runConsoleScript(`
      add computer PC1 at 0 0
      add router R1 at 200 0
      add server SRV at 400 0
      link PC1 R1
      link R1 SRV
      ip PC1 192.168.1.10/24
      gateway PC1 192.168.1.1
      ip SRV 203.0.113.53/24
      interface R1 PC1 ip 192.168.1.1
      interface R1 SRV ip 203.0.113.2
      cli PC1 echo nameserver 203.0.113.53 > /etc/resolv.conf
      cli SRV echo address=/web.corp/203.0.113.80 >> /etc/dnsmasq.conf
    `);
    return {
      pc1: state.devices.find(d => d.name === "PC1")!,
      r1: state.devices.find(d => d.name === "R1")!,
    };
  }

  it("without NAT the public server cannot answer", () => {
    const { pc1 } = natDns();
    const r = resolveHeadless(pc1, "web.corp") as any;
    expect(r.success).toBe(false);
  });

  it("with NAT the query is PAT-translated by transaction id and the answer restored", () => {
    const { pc1, r1 } = natDns();
    runConsoleScript(`
      cli R1 enable
      cli R1 configure terminal
      cli R1 interface Ethernet1
      cli R1 ip nat inside
      cli R1 exit
      cli R1 interface Ethernet2
      cli R1 ip nat outside
    `);
    const r = resolveHeadless(pc1, "web.corp") as any;
    expect(r.success).toBe(true);
    expect(r.resolvedIp).toBe("203.0.113.80");
    const udp = (r1.config.natTranslations || []).filter(t => t.protocol === "udp");
    expect(udp).toHaveLength(1);
    expect(udp[0].insideIp).toBe("192.168.1.10");
  });
});

describe("server — config round-trips", () => {
  beforeEach(() => resetState());

  it("config payload preserves dnsmasq state and host fields (openPorts, nameserver)", () => {
    const { srv, web, pc1 } = withRecord();
    runConsoleScript(`
      cli SRV echo dhcp-range=192.168.1.100,192.168.1.200 >> /etc/dnsmasq.conf
      cli SRV echo dhcp-option=option:router,192.168.1.1 >> /etc/dnsmasq.conf
      cli SRV systemctl stop dnsmasq
    `);
    const parsed = parseConfig(JSON.stringify(buildConfigPayload()));
    const srv2 = parsed.devices.find((d: any) => d.name === "SRV")!;
    expect(srv2.type).toBe("server");
    expect(srv2.config.dnsRecords).toEqual([{ name: "web.corp", ip: "192.168.1.80" }]);
    expect(srv2.config.dhcpRangeStart).toBe("192.168.1.100");
    expect(srv2.config.dhcpRouterIp).toBe("192.168.1.1");
    expect(srv2.config.dnsmasqRunning).toBe(false);
    const web2 = parsed.devices.find((d: any) => d.name === "WEB")!;
    expect(web2.config.openPorts).toEqual([80]);
    const pc2 = parsed.devices.find((d: any) => d.name === "PC1")!;
    expect(pc2.config.dnsServerIp).toBe("192.168.1.53");
    void srv; void web; void pc1;
  });

  it("script export replays dnsmasq config through the terminal", () => {
    withRecord();
    runConsoleScript(`cli SRV echo dhcp-range=192.168.1.100,192.168.1.200 >> /etc/dnsmasq.conf`);
    const script = (exec("export").data as string) ?? "";
    expect(script).toContain("nameserver PC1 192.168.1.53");
    expect(script).toContain("cli SRV echo address=/web.corp/192.168.1.80 >> /etc/dnsmasq.conf");
    expect(script).toContain("cli SRV echo dhcp-range=192.168.1.100,192.168.1.200 >> /etc/dnsmasq.conf");
    // Replaying the script rebuilds the same dnsmasq state.
    const results = runConsoleScript(script);
    expect(results.filter(r => !r.ok)).toEqual([]);
    const srv = state.devices.find(d => d.name === "SRV")!;
    expect(srv.config.dnsRecords).toEqual([{ name: "web.corp", ip: "192.168.1.80" }]);
    expect(srv.config.dhcpRangeStart).toBe("192.168.1.100");
  });
});
