/**
 * NAT/PAT + router netfilter chains.
 *
 * The reference topology gives the outside server NO route back to the inside
 * network (no gateway): replies can only arrive if the router translated the
 * flow onto its outside address — NAT visibly fixes the return path.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { runSimulationHeadless, processAtRouter } from "../src/engine";
import { createIcmpTimeExceeded } from "../src/frame";
import { buildPingEvents, buildConnectEvents, buildHttpEvents } from "../src/simulation";
import { buildConfigPayload, parseConfig } from "../src/config";
import { runConsoleScript, runConsoleCommand as exec, exportTopologyScript } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());

function natTopology() {
  runConsoleScript(`
    add computer PC1 at 0 0
    add router R1 at 200 0
    add computer SRV at 400 0
    link PC1 R1
    link R1 SRV
    ip PC1 192.168.1.10/24
    gateway PC1 192.168.1.1
    ip SRV 203.0.113.10/24
    interface R1 PC1 ip 192.168.1.1
    interface R1 SRV ip 203.0.113.2
  `);
  return {
    pc1: state.devices.find(d => d.name === "PC1")!,
    r1: state.devices.find(d => d.name === "R1")!,
    srv: state.devices.find(d => d.name === "SRV")!,
  };
}

function enableNat() {
  runConsoleScript(`
    cli R1 enable
    cli R1 configure terminal
    cli R1 interface Ethernet1
    cli R1 ip nat inside
    cli R1 exit
    cli R1 interface Ethernet2
    cli R1 ip nat outside
  `);
}

describe("nat — PAT overload", () => {
  beforeEach(() => resetState());

  it("without NAT the server cannot reply (no return route)", () => {
    const { pc1 } = natTopology();
    const r = runSimulationHeadless(buildPingEvents(pc1, "203.0.113.10") as any, pc1.id, "203.0.113.10", "ping");
    expect(r.success).toBe(false);
  });

  it("ip nat inside/outside marks the interfaces", () => {
    const { r1 } = natTopology();
    enableNat();
    const roles = (r1.config.interfaces! || []).map(i => i.natRole);
    expect(roles).toContain("inside");
    expect(roles).toContain("outside");
  });

  it("with NAT, ping is translated out and restored on return", () => {
    const { pc1, r1 } = natTopology();
    enableNat();
    const r = runSimulationHeadless(buildPingEvents(pc1, "203.0.113.10") as any, pc1.id, "203.0.113.10", "ping");
    expect(r.success).toBe(true);
    expect(r.log.some(l => /NAT 192\.168\.1\.10 → 203\.0\.113\.2/.test(l.summary))).toBe(true);
    expect(r.log.some(l => /un-PAT/.test(l.summary))).toBe(true);
    const t = r1.config.natTranslations!;
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ protocol: "icmp", insideIp: "192.168.1.10", outsideIp: "203.0.113.2", destIp: "203.0.113.10" });
  });

  it("TCP connects through NAT and records a tcp translation", () => {
    const { pc1, r1 } = natTopology();
    enableNat();
    const r = runSimulationHeadless(buildConnectEvents(pc1, "203.0.113.10", 80) as any, pc1.id, "203.0.113.10", "tcp", 80);
    expect(r.success).toBe(true);
    const t = r1.config.natTranslations!.filter(e => e.protocol === "tcp");
    expect(t).toHaveLength(1);
    expect(t[0].insideIp).toBe("192.168.1.10");
    expect(t[0].outsidePort).not.toBe(t[0].insidePort);
  });

  it("PAT allocates distinct outside ids for distinct inside flows", () => {
    const { pc1 } = natTopology();
    runConsoleScript(`
      add computer PC2 at 0 200
      link PC2 R1
      ip PC2 192.168.1.11/24
      gateway PC2 192.168.1.1
    `);
    enableNat();
    const pc2 = state.devices.find(d => d.name === "PC2")!;
    runSimulationHeadless(buildPingEvents(pc1, "203.0.113.10") as any, pc1.id, "203.0.113.10", "ping");
    runSimulationHeadless(buildPingEvents(pc2, "203.0.113.10") as any, pc2.id, "203.0.113.10", "ping");
    const r1 = state.devices.find(d => d.name === "R1")!;
    const ids = r1.config.natTranslations!.map(t => t.outsidePort);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("show ip nat translations lists flows; clear empties them", () => {
    const { pc1 } = natTopology();
    enableNat();
    runSimulationHeadless(buildPingEvents(pc1, "203.0.113.10") as any, pc1.id, "203.0.113.10", "ping");
    const show = exec("cli R1 show ip nat translations");
    expect(show.output.join("\n")).toContain("203.0.113.2");
    expect(show.output.join("\n")).toContain("192.168.1.10");
    exec("cli R1 clear ip nat translation *");
    const r1 = state.devices.find(d => d.name === "R1")!;
    expect(r1.config.natTranslations).toHaveLength(0);
  });

  it("pinging the outside interface itself still gets the router's own reply", () => {
    const { srv } = natTopology();
    enableNat();
    const r = runSimulationHeadless(buildPingEvents(srv, "203.0.113.2") as any, srv.id, "203.0.113.2", "ping");
    expect(r.success).toBe(true); // INPUT accept by default; no translation matches a fresh echo request
  });

  it("natRole and rules survive a config round-trip", () => {
    natTopology();
    enableNat();
    exec("cli R1 end");   // config-if -> privileged: iptables runs in privileged/config mode, as `?` says
    exec("cli R1 iptables -A FORWARD -p tcp --dport 23 -j DROP");
    const round = parseConfig(JSON.stringify(buildConfigPayload()));
    const r1 = round.devices.find((d: any) => d.name === "R1")!;
    expect(r1.config.interfaces!.map((i: any) => i.natRole)).toContain("outside");
    expect(r1.config.rules!).toHaveLength(1);
    expect(r1.config.rules![0]).toMatchObject({ chain: "forward", target: "drop", protocol: "tcp", dport: 23 });
  });
});

describe("nat — ICMP errors restored via the embedded original datagram", () => {
  beforeEach(() => resetState());

  it("un-NATs a Time-Exceeded from beyond the edge back to the inside sender", () => {
    const { pc1, r1, srv } = natTopology();
    enableNat();
    // Prime the translation (and ARP caches) with a real NAT'd ping.
    const setup = buildPingEvents(pc1, "203.0.113.10");
    expect(runSimulationHeadless(setup as any, pc1.id, "203.0.113.10", "ping").success).toBe(true);
    const entry = r1.config!.natTranslations!.find(t => t.protocol === "icmp")!;

    // An ICMP error arrives from an intermediate router beyond the NAT,
    // addressed to R1's outside IP (and, at L2, its outside interface MAC),
    // quoting the TRANSLATED flow — as the internet cloud's TTL branch (or any
    // far router) would send it.
    const outsideMac = r1.config!.interfaces!.find(i => i.peerId === srv.id)!.macAddress!;
    const te = createIcmpTimeExceeded(
      "02:99:99:99:99:99", outsideMac,
      "203.0.113.99", "203.0.113.2", 64, null,
      { srcIp: entry.outsideIp, dstIp: entry.destIp, proto: "icmp", flowId: entry.outsidePort });
    const out = processAtRouter(r1, te, srv.id);
    expect(out.length).toBe(1);
    const restored = out[0].frame.payload as any;
    expect(restored.dstIp).toBe("192.168.1.10");                 // delivered inside
    expect(restored.srcIp).toBe("203.0.113.99");                 // the reporting hop is preserved
    expect(restored.payload.original.srcIp).toBe("192.168.1.10"); // quoted header un-NAT'd too
    expect(restored.payload.original.flowId).toBe(entry.insidePort);
    expect(out[0].toDeviceId).toBe(pc1.id);
  });

  it("an error quoting no known flow is not restored (stays router-destined)", () => {
    const { r1, srv } = natTopology();
    enableNat();
    const outsideMac = r1.config!.interfaces!.find(i => i.peerId === srv.id)!.macAddress!;
    const te = createIcmpTimeExceeded(
      "02:99:99:99:99:99", outsideMac,
      "203.0.113.99", "203.0.113.2", 64, null,
      { srcIp: "203.0.113.2", dstIp: "203.0.113.77", proto: "icmp", flowId: 4242 });
    // No matching translation → the self-destined branch consumes it (no echo
    // to answer), and nothing is forwarded inside.
    expect(processAtRouter(r1, te, srv.id)).toEqual([]);
  });
});

describe("DNAT / port-forwarding", () => {
  beforeEach(() => resetState());

  // CLIENT (outside) — R1 — WEB (inside web server). A port-forward publishes
  // R1's outside IP:80 to WEB:80.
  function pfTopology() {
    runConsoleScript(`
      add computer CLIENT at -300 0
      add router R1 at 0 0
      add server WEB at 300 0
      link CLIENT R1
      link R1 WEB
      ip CLIENT 203.0.113.5/24
      gateway CLIENT 203.0.113.1
      interface R1 CLIENT ip 203.0.113.1/24
      interface R1 WEB ip 10.0.0.1/24
      ip WEB 10.0.0.80/24
      gateway WEB 10.0.0.1
      web WEB on
    `);
    return state.devices.find(d => d.name === "CLIENT")!;
  }

  function addPortForward() {
    exec("cli R1 enable");
    exec("cli R1 configure terminal");
    exec("cli R1 ip nat inside source static tcp 10.0.0.80 80 203.0.113.1 80");
    exec("cli R1 end");
  }

  it("a GET to the router's published IP reaches the inside server (DNAT + return SNAT)", () => {
    const client = pfTopology();
    addPortForward();
    const r = runSimulationHeadless(buildHttpEvents(client, "203.0.113.1") as any, client.id, "203.0.113.1", "http", 80);
    expect(r.httpStatus).toBe(200);
    const nat = state.simulation.log.filter(l => l.kind === "sim-nat").map(l => l.action);
    expect(nat.some(a => a.includes("203.0.113.1:80 → 10.0.0.80:80 (port-forward)"))).toBe(true);   // inbound DNAT
    expect(nat.some(a => a.includes("port-forward reply"))).toBe(true);                              // return SNAT
  });

  it("without the port-forward the connection reaches only the router (no service)", () => {
    const client = pfTopology();
    const r = runSimulationHeadless(buildHttpEvents(client, "203.0.113.1") as any, client.id, "203.0.113.1", "http", 80);
    expect(r.httpStatus).toBeNull();
  });

  it("the router CLI adds and removes a static port-forward", () => {
    pfTopology();
    addPortForward();
    const r1 = state.devices.find(d => d.name === "R1")!;
    expect(r1.config.portForwards!).toHaveLength(1);
    expect(r1.config.portForwards![0]).toMatchObject({ proto: "tcp", outsideIp: "203.0.113.1", outsidePort: 80, insideIp: "10.0.0.80", insidePort: 80 });
    exec("cli R1 configure terminal");
    exec("cli R1 no ip nat inside source static tcp 10.0.0.80 80 203.0.113.1 80");
    expect(r1.config.portForwards!).toHaveLength(0);
  });

  it("port-forwards round-trip through the config payload", () => {
    pfTopology();
    addPortForward();
    const round = parseConfig(JSON.stringify(buildConfigPayload()));
    const r1 = round.devices.find((d: any) => d.name === "R1")!;
    expect(r1.config.portForwards!).toHaveLength(1);
    expect(r1.config.portForwards![0]).toMatchObject({ outsideIp: "203.0.113.1", outsidePort: 80, insideIp: "10.0.0.80", insidePort: 80 });
  });

  it("port-forwards survive a script export/replay", () => {
    pfTopology();
    addPortForward();
    const script = exportTopologyScript();
    expect(script).toContain("ip nat inside source static tcp 10.0.0.80 80 203.0.113.1 80");
    resetState();
    runConsoleScript(script);
    expect(state.devices.find(d => d.name === "R1")!.config.portForwards).toHaveLength(1);
  });

  it("an unrelated inside→inside flow to the server's port is NOT source-translated", () => {
    // CLIENT (outside) — R1 — { WEB (inside A), INSIDE2 (inside B) }, with WEB:80
    // published. INSIDE2 connects directly to WEB:80 — a flow that never touches
    // the public IP, so its reply must keep the real server source (the static
    // rule alone would have wrongly rewritten any reply from WEB:80).
    runConsoleScript(`
      add computer CLIENT at -300 0
      add router R1 at 0 0
      add server WEB at 300 -120
      add computer INSIDE2 at 300 120
      link CLIENT R1
      link R1 WEB
      link R1 INSIDE2
      ip CLIENT 203.0.113.5/24
      gateway CLIENT 203.0.113.1
      interface R1 CLIENT ip 203.0.113.1/24
      interface R1 WEB ip 10.0.0.1/24
      interface R1 INSIDE2 ip 10.0.1.1/24
      ip WEB 10.0.0.80/24
      gateway WEB 10.0.0.1
      ip INSIDE2 10.0.1.20/24
      gateway INSIDE2 10.0.1.1
      web WEB on
      cli R1 enable
      cli R1 configure terminal
      cli R1 ip nat inside source static tcp 10.0.0.80 80 203.0.113.1 80
      cli R1 end
    `);
    const inside2 = state.devices.find(d => d.name === "INSIDE2")!;
    const r = runSimulationHeadless(buildHttpEvents(inside2, "10.0.0.80") as any, inside2.id, "10.0.0.80", "http", 80);
    expect(r.httpStatus).toBe(200);            // the direct connection works
    expect(r.responderIp).toBe("10.0.0.80");   // answered as the real server, not the public IP
    const nat = state.simulation.log.filter(l => l.kind === "sim-nat").map(l => l.action);
    expect(nat.some(a => a.includes("port-forward reply"))).toBe(false); // not wrongly translated
  });

  it("rejects a non-tcp static NAT instead of creating a bogus rule", () => {
    pfTopology();
    exec("cli R1 enable");
    exec("cli R1 configure terminal");
    exec("cli R1 ip nat inside source static udp 10.0.0.80 80 203.0.113.1 80");
    const r1 = state.devices.find(d => d.name === "R1")!;
    expect(r1.config.portForwards! || []).toHaveLength(0);
  });
});

describe("router netfilter chains", () => {
  beforeEach(() => resetState());

  it("INPUT drops traffic to the router itself without affecting forwarding", () => {
    const { pc1, srv } = natTopology();
    enableNat();
    exec("cli R1 end");   // config-if -> privileged
    exec("cli R1 iptables -A INPUT -p icmp -j DROP");
    const toRouter = runSimulationHeadless(buildPingEvents(pc1, "192.168.1.1") as any, pc1.id, "192.168.1.1", "ping");
    expect(toRouter.success).toBe(false);
    expect(toRouter.log.some(l => /Firewall DROP .*\(INPUT/.test(l.summary))).toBe(true);
    const through = runSimulationHeadless(buildPingEvents(pc1, "203.0.113.10") as any, pc1.id, "203.0.113.10", "ping");
    expect(through.success).toBe(true);
  });

  it("FORWARD filters routed traffic by port; iptables requires privileged mode", () => {
    const { pc1 } = natTopology();
    enableNat();
    exec("cli R1 end");   // config-if -> privileged
    exec("cli R1 exit");  // privileged -> exec
    const denied = exec("cli R1 iptables -L");
    expect(denied.output.join(" ")).toContain("Privileged");
    exec("cli R1 enable");
    exec("cli R1 iptables -A FORWARD -p tcp --dport 23 -j DROP");
    expect(runSimulationHeadless(buildConnectEvents(pc1, "203.0.113.10", 23) as any, pc1.id, "203.0.113.10", "tcp", 23).success).toBe(false);
    expect(runSimulationHeadless(buildConnectEvents(pc1, "203.0.113.10", 22) as any, pc1.id, "203.0.113.10", "tcp", 22).success).toBe(true);
    expect(runSimulationHeadless(buildPingEvents(pc1, "203.0.113.10") as any, pc1.id, "203.0.113.10", "ping").success).toBe(true);
  });

  it("the transparent firewall still rejects INPUT (FORWARD-only device)", () => {
    runConsoleScript("add firewall FW1 at 0 0");
    state.terminal.deviceId = state.devices[0].id;
    const r = exec("cli FW1 iptables -A INPUT -p icmp -j DROP");
    expect(r.output.join(" ")).toContain("chain must be FORWARD");
  });
});
