/**
 * RouteSim benchmark suite.
 *
 * Measures wall-clock performance of critical hot paths at various
 * topology scales. Each benchmark has a p99 budget calibrated for
 * low-end CPUs (~2 GHz Celeron). Run with:
 *
 *   bun test tests/bench.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { getDevice, linkedPortsFor, connectedIds, linkById, linkAuthorizedForData } from "../src/devices";
import { l2Reachable, getVlanForDevice, buildScanEvents } from "../src/simulation";
import { runConsoleScript } from "../src/commands";
import { isTrunkLink } from "../src/canvas";
import { processAtSwitch, processAtRouter, processAtServer, processAtInternet, buildRoutingTable, routingLookup, runRipConvergence, runStpConvergence, evaluateFirewall, connectionState } from "../src/engine";
import { createArpRequest, createArpReply, createIcmpEchoRequest, createIcmpEchoReply, createTcpSegment, createDnsResponse, createDhcpDiscover, packetColumns, BROADCAST_MAC } from "../src/frame";
import { runIdsRules } from "../src/snort";
import { applyLogFilter, type FilterRow } from "../src/packet-filter";
import { registerNoopCallbacks, resetState } from "./helpers";
import { bench, printResults, type BenchResult } from "./bench-harness";
import {
  smallLinear,
  mediumStar,
  largeMesh,
  stressGrid,
  ripStress,
  managedSwitch,
  routerWithRoutes,
} from "./bench-fixtures";

beforeAll(() => {
  registerNoopCallbacks();
});

// ── 0. The harness itself ───────────────────────────────────────────────────

describe("bench harness", () => {
  it("batches a sub-µs function so the clock's overhead doesn't swamp it", () => {
    let x = 0;
    const r = bench("harness — trivial", () => { x++; }, { budget: 1, warmup: 10, minTime: 20 });
    expect(r.batch).toBeGreaterThan(1);
    expect(r.ops).toBeGreaterThan(r.batch);   // ops counts every call, not every sample
    expect(x).toBeGreaterThan(r.ops);         // (warmup + calibration ran too)
  });

  it("re-measures an over-budget pass and reports how many passes it took", () => {
    const r = bench("harness — always slow", () => { const t = performance.now(); while (performance.now() - t < 0.02) { /* spin 20 µs */ } },
      { budget: 1, warmup: 2, minTime: 5, minIters: 10, attempts: 3 });
    expect(r.passed).toBe(false);
    expect(r.attempts).toBe(3);
    expect(r.batch).toBe(1);
    const ok = bench("harness — fast enough", () => {}, { budget: 1000, warmup: 2, minTime: 5 });
    expect(ok.passed).toBe(true);
    expect(ok.attempts).toBe(1);
  });
});

// ── 1. Device Lookup ────────────────────────────────────────────────────────

describe("bench: getDevice", () => {
  const results: BenchResult[] = [];

  beforeEach(() => resetState());

  it("getDevice — 5 devices", () => {
    const topo = smallLinear(5);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const lastId = state.devices[state.devices.length - 1].id;
    results.push(bench("getDevice — 5 devices", () => {
      getDevice(lastId);
    }, { budget: 2 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("getDevice — 50 devices", () => {
    const topo = largeMesh(50);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const lastId = state.devices[state.devices.length - 1].id;
    results.push(bench("getDevice — 50 devices", () => {
      getDevice(lastId);
    }, { budget: 10 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("getDevice — 100 devices", () => {
    const topo = stressGrid(100);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const lastId = state.devices[state.devices.length - 1].id;
    results.push(bench("getDevice — 100 devices", () => {
      getDevice(lastId);
    }, { budget: 25 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("prints results", () => {
    if (results.length) printResults(results);
  });
});

// ── 2. Port Resolution ──────────────────────────────────────────────────────

describe("bench: linkedPortsFor", () => {
  const results: BenchResult[] = [];

  beforeEach(() => resetState());

  it("linkedPortsFor — 8-port switch", () => {
    const topo = smallLinear(5);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const swId = "sw-0";
    results.push(bench("linkedPortsFor — 5 links", () => {
      linkedPortsFor(swId);
    }, { budget: 20 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("linkedPortsFor — 20 links", () => {
    const topo = mediumStar(20);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    // Router has links to 4 switches
    const rtrId = "rtr-0";
    results.push(bench("linkedPortsFor — 20-link topo", () => {
      linkedPortsFor(rtrId);
    }, { budget: 80 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("linkedPortsFor — 50-link topo", () => {
    const topo = largeMesh(50);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    // Pick a switch with the most connections
    const swId = "sw-0";
    results.push(bench("linkedPortsFor — 50-link topo", () => {
      linkedPortsFor(swId);
    }, { budget: 200 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("prints results", () => {
    if (results.length) printResults(results);
  });
});

// ── 2b. Connected-id lookup (link adjacency index) ──────────────────────────

describe("bench: connectedIds", () => {
  const results: BenchResult[] = [];

  beforeEach(() => resetState());

  it("connectedIds — 20-link topo", () => {
    const topo = mediumStar(20);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    results.push(bench("connectedIds — 20-link topo", () => {
      connectedIds("rtr-0");
    }, { budget: 40 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("connectedIds — 50-link topo", () => {
    const topo = largeMesh(50);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    results.push(bench("connectedIds — 50-link topo", () => {
      connectedIds("sw-0");
    }, { budget: 100 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("prints results", () => {
    if (results.length) printResults(results);
  });
});

// ── 2c. L2 reachability (BFS over the link index) ───────────────────────────

describe("bench: l2Reachable", () => {
  const results: BenchResult[] = [];

  beforeEach(() => resetState());

  it("l2Reachable — 20 hosts on a segment", () => {
    const topo = smallLinear(20);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    results.push(bench("l2Reachable — 20-host segment", () => {
      l2Reachable("pc-0", "pc-19", null);
    }, { budget: 60 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("l2Reachable — 50 hosts on a segment", () => {
    const topo = smallLinear(50);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    results.push(bench("l2Reachable — 50-host segment", () => {
      l2Reachable("pc-0", "pc-49", null);
    }, { budget: 150 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("prints results", () => {
    if (results.length) printResults(results);
  });
});

// ── 2d. Render-path hot helpers (memoised per-frame normalisation) ──────────

describe("bench: render-path helpers", () => {
  const results: BenchResult[] = [];
  beforeEach(() => resetState());

  it("getVlanForDevice — host on an 8-port managed switch", () => {
    const topo = managedSwitch(8);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    getVlanForDevice("pc-0"); // warm the port-vlan memo + lazy indexes
    results.push(bench("getVlanForDevice — managed 8p", () => {
      getVlanForDevice("pc-0");
    }, { budget: 25 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("isTrunkLink — managed-switch endpoint", () => {
    const topo = managedSwitch(8);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const sw = state.devices.find(d => d.id === "msw-0")!;
    const pc = state.devices.find(d => d.id === "pc-0")!;
    isTrunkLink(sw, pc); // warm the port-mode memo
    results.push(bench("isTrunkLink — managed endpoint", () => {
      isTrunkLink(sw, pc);
    }, { budget: 25 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("prints results", () => {
    if (results.length) printResults(results);
  });
});

// ── 2e. Link-by-id index ────────────────────────────────────────────────────

describe("bench: linkById", () => {
  const results: BenchResult[] = [];
  beforeEach(() => resetState());

  it("linkById — 50-link topo", () => {
    const topo = largeMesh(50);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const id = state.links[state.links.length - 1].id;
    linkById(id); // build the index once
    results.push(bench("linkById — 50-link topo", () => {
      linkById(id);
    }, { budget: 5 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("prints results", () => {
    if (results.length) printResults(results);
  });
});

// ── 2f. The data-path gate (run on every transit) ───────────────────────────
// linkAuthorizedForData is the boolean wrapper over linkDataBlockReason, so
// these time the reason-returning gate (an open link builds no string).

describe("bench: linkAuthorizedForData", () => {
  const results: BenchResult[] = [];
  beforeEach(() => resetState());

  it("linkAuthorizedForData — no 802.1X (the common case)", () => {
    const topo = managedSwitch(24);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const link = state.links[state.links.length - 1];
    results.push(bench("linkAuthorizedForData — open port", () => {
      linkAuthorizedForData(link);
    }, { budget: 5 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("linkAuthorizedForData — 802.1X port control, 24-port switch", () => {
    // Worst case: every port under port control and the link on the last one,
    // so the port-name resolution walks the whole port list.
    const topo = managedSwitch(24);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const sw = state.devices.find(d => d.id === "msw-0")!;
    sw.config.portAuth = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`Ethernet${i + 1}`, "auto" as const]));
    const link = state.links[state.links.length - 1];
    link.dot1xAuthorized = true;
    results.push(bench("linkAuthorizedForData — 802.1X 24p", () => {
      linkAuthorizedForData(link);
    }, { budget: 25 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("prints results", () => {
    if (results.length) printResults(results);
  });
});

// ── 3. Switch Processing ────────────────────────────────────────────────────

function initSim(): void {
  state.simulation = {
    status: "running",
    mode: "ping",
    events: [],
    log: [],
    transits: [],
    pendingArp: {},
    speed: 1000,
    autoPlay: false,
    stepTimer: null,
    animFrame: null,
    stepIndex: 0,
  } as any;
}

describe("bench: processAtSwitch", () => {
  const results: BenchResult[] = [];

  beforeEach(() => resetState());

  it("unmanaged flood — 5 ports", () => {
    const topo = smallLinear(5);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    initSim();
    const sw = state.devices.find(d => d.id === "sw-0")!;
    // Use uppercase MACs — normaliseMacTable uppercases via normaliseMacAddress,
    // so lowercase srcMac would never match after normalisation, causing unbounded table growth.
    const frame = createArpRequest("02:00:01:00:0A:01", "192.168.1.10", "192.168.1.20");
    results.push(bench("processAtSwitch — unmanaged flood 5p", () => {
      state.simulation.log.length = 0;
      processAtSwitch(sw, frame, "pc-0");
    }, { budget: 30 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("managed VLAN flood — 8 ports", () => {
    const topo = managedSwitch(8);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    initSim();
    const sw = state.devices.find(d => d.id === "msw-0")!;
    const frame = createArpRequest("02:00:0A:00:0A:01", "192.168.10.10", "192.168.10.20");
    results.push(bench("processAtSwitch — managed VLAN flood 8p", () => {
      state.simulation.log.length = 0;
      sw.config.macTable = [];
      processAtSwitch(sw, frame, "pc-0");
    }, { budget: 50 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("known unicast", () => {
    const topo = smallLinear(5);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    initSim();
    const sw = state.devices.find(d => d.id === "sw-0")!;
    // Pre-learn PC-1's MAC (uppercase so normalisation matches)
    const learnFrame = createArpReply("02:00:01:00:0B:01", "192.168.1.11", "02:00:01:00:0A:01", "192.168.1.10");
    processAtSwitch(sw, learnFrame, "pc-1");
    state.simulation.log.length = 0;
    // Now send unicast to PC-1's MAC
    const unicast = createIcmpEchoRequest("02:00:01:00:0A:01", "02:00:01:00:0B:01", "192.168.1.10", "192.168.1.11", 64);
    results.push(bench("processAtSwitch — known unicast", () => {
      state.simulation.log.length = 0;
      processAtSwitch(sw, unicast, "pc-0");
    }, { budget: 20 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("unmanaged flood — 20 ports", () => {
    const topo = smallLinear(20);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    initSim();
    const sw = state.devices.find(d => d.id === "sw-0")!;
    const frame = createArpRequest("02:00:01:00:0A:01", "192.168.1.10", "192.168.1.30");
    results.push(bench("processAtSwitch — unmanaged flood 20p", () => {
      state.simulation.log.length = 0;
      processAtSwitch(sw, frame, "pc-0");
    }, { budget: 100 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("prints results", () => {
    if (results.length) printResults(results);
  });
});

// ── 3a-ii. Internet cloud (L3 transit) ───────────────────────────────────────

function internetTopo(routers: number) {
  const devices: any[] = [{ id: "net-0", type: "internet", name: "NET", x: 0, y: 0, config: { ethernetPorts: 16 } }];
  const links: any[] = [];
  for (let i = 0; i < routers; i++) {
    devices.push({ id: `r-${i}`, type: "router", name: `R${i}`, x: 100 * (i + 1), y: 0, config: {
      ethernetPorts: 4, serialPorts: 0,
      interfaces: [{ peerId: "net-0", type: "ethernet", ipv4Address: `203.0.${i}.1`, prefixLength: 30, macAddress: `02:00:00:0${i % 10}:00:01`, arpTable: [], dhcpLeases: [], vlanTag: null }],
    } });
    links.push({ id: `l-${i}`, from: `r-${i}`, to: "net-0" });
  }
  return { devices, links };
}

describe("bench: processAtInternet", () => {
  const results: BenchResult[] = [];
  beforeEach(() => resetState());

  it("routes to the worst-case (last) router — 8 routers", () => {
    const topo = internetTopo(8);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    initSim();
    const net = state.devices.find(d => d.id === "net-0")!;
    // Destined to the last router's public address, so the routing scan visits every port.
    const frame = createIcmpEchoRequest("02:00:00:00:00:01", "02:11:22:33:44:55", "203.0.0.1", "203.0.7.1", 64);
    results.push(bench("processAtInternet — route, 8 routers", () => {
      state.simulation.log.length = 0;
      processAtInternet(net, frame, "r-0");
    }, { budget: 60 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("prints results", () => {
    if (results.length) printResults(results);
  });
});

// ── 3b. Firewall rule evaluation ─────────────────────────────────────────────

describe("bench: firewall", () => {
  const results: BenchResult[] = [];

  it("evaluateFirewall — fall through 50 rules", () => {
    // 50 non-matching rules → worst case (full scan, then the chain policy).
    const rules = Array.from({ length: 50 }, (_, i) => ({
      chain: "forward", target: "drop" as const, protocol: "icmp" as const,
      src: `10.${i}.0.0/16`,
    }));
    const fw: any = { config: { rules, policy: { forward: "accept" } } };
    const ipv4: any = { type: "ipv4", srcIp: "192.168.1.10", dstIp: "192.168.1.20", ttl: 64, protocol: 1, payload: { type: "icmp", icmpType: 8, sequence: 1 } };
    results.push(bench("evaluateFirewall — 50 rules (miss)", () => {
      evaluateFirewall(fw, ipv4, "forward");
    }, { budget: 100 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("connectionState — lookup over 50 tracked flows", () => {
    // Worst case: a NEW frame scans the whole conntrack table without matching.
    const fw: any = { id: "fw-ct" };
    state.simulation.conntrack = { "fw-ct": Array.from({ length: 50 }, (_, i) => ({
      proto: "tcp", srcIp: `10.0.0.${i}`, dstIp: "8.8.8.8", srcPort: 40000 + i, dstPort: 80, established: i % 2 === 0,
    })) };
    const ipv4: any = { type: "ipv4", srcIp: "192.168.1.99", dstIp: "1.2.3.4", ttl: 64, protocol: 6, payload: { type: "tcp", srcPort: 50000, dstPort: 443, flags: "syn" } };
    results.push(bench("connectionState — 50 tracked flows (miss)", () => {
      connectionState(fw, ipv4);
    }, { budget: 80 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("prints results", () => {
    if (results.length) printResults(results);
  });
});

// ── 3c. DNS lookup at the server ─────────────────────────────────────────────

describe("bench: dns", () => {
  const results: BenchResult[] = [];

  beforeEach(() => resetState());

  it("processAtServer — A-record lookup among 50 records", () => {
    const records = Array.from({ length: 50 }, (_, i) => ({ name: `host${i}.corp`, ip: `10.0.${i}.10` }));
    const srv: any = {
      id: "srv", type: "server", name: "SRV",
      config: { ipv4Address: "192.168.1.53", gatewayIpv4Address: "", macAddress: "02:00:00:00:00:53", arpTable: [], dnsmasqRunning: true, dnsRecords: records },
    };
    state.devices = [srv];
    const query: any = {
      id: "f1", srcMac: "02:00:00:00:00:0A", dstMac: "02:00:00:00:00:53", etherType: 0x0800, vlanTag: null,
      payload: { type: "ipv4", srcIp: "192.168.1.10", dstIp: "192.168.1.53", ttl: 64, protocol: 17, payload: { type: "dns", op: "query", id: 7, name: "host49.corp", address: null } },
    };
    results.push(bench("processAtServer — DNS, 50 records", () => {
      processAtServer(srv, query, "pc");
    }, { budget: 100 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("prints results", () => {
    if (results.length) printResults(results);
  });
});

// ── 3d. Packet-list column mapping ───────────────────────────────────────────

describe("bench: packetColumns", () => {
  const results: BenchResult[] = [];

  it("packetColumns — mixed frame kinds", () => {
    // One of each protocol family; the packet list calls this per visible row
    // (up to 1000) on every sim-log sync during an animated run.
    const frames = [
      createArpRequest("02:00:01:00:0A:01", "192.168.1.10", "192.168.1.20"),
      createIcmpEchoRequest("02:00:01:00:0A:01", "02:00:01:00:0B:01", "192.168.1.10", "192.168.1.20", 64),
      createIcmpEchoReply("02:00:01:00:0B:01", "02:00:01:00:0A:01", "192.168.1.20", "192.168.1.10", 64),
      createTcpSegment("02:00:01:00:0A:01", "02:00:01:00:0B:01", "192.168.1.10", "192.168.1.20", 30000, 80, "syn"),
      createDnsResponse("02:00:01:00:0B:01", "02:00:01:00:0A:01", "192.168.1.53", "192.168.1.10", "web.corp", "192.168.1.80", 7),
      createDhcpDiscover("02:00:01:00:0A:01", "bench-1"),
    ];
    let i = 0;
    results.push(bench("packetColumns — mixed kinds", () => {
      packetColumns(frames[i++ % 6]);
    }, { budget: 5 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("prints results", () => {
    if (results.length) printResults(results);
  });
});

// ── 4. Routing ──────────────────────────────────────────────────────────────

describe("bench: routing", () => {
  const results: BenchResult[] = [];

  beforeEach(() => resetState());

  it("buildRoutingTable — 2 ifaces", () => {
    const topo = mediumStar(8);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const router = state.devices.find(d => d.id === "rtr-0")!;
    results.push(bench("buildRoutingTable — 4 ifaces", () => {
      buildRoutingTable(router);
    }, { budget: 40 }));   // re-baselined: a GC tail from per-call interface normalisation — see docs/benchmarking.md
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("buildRoutingTable — 5 ifaces + 10 statics", () => {
    const topo = routerWithRoutes(5, 10);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const router = state.devices.find(d => d.id === "rtr-0")!;
    results.push(bench("buildRoutingTable — 5i + 10s", () => {
      buildRoutingTable(router);
    }, { budget: 40 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("buildRoutingTable — 10 ifaces + 20 statics", () => {
    const topo = routerWithRoutes(10, 20);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const router = state.devices.find(d => d.id === "rtr-0")!;
    results.push(bench("buildRoutingTable — 10i + 20s", () => {
      buildRoutingTable(router);
    }, { budget: 80 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("processAtRouter — connected route", () => {
    const topo = mediumStar(8);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    state.simulation = {
      status: "running",
      mode: "ping",
      events: [],
      log: [],
      transits: [],
      pendingArp: {},
      speed: 1000,
      autoPlay: false,
      stepTimer: null,
      animFrame: null,
      stepIndex: 0,
    } as any;
    const router = state.devices.find(d => d.id === "rtr-0")!;
    // Pre-populate ARP on egress interface so the frame actually routes
    const iface0 = router.config.interfaces![0];
    iface0.arpTable = [{ ipv4Address: "192.168.1.10", macAddress: "02:00:01:00:0a:01" }];
    // ICMP from subnet 2 to subnet 1 (connected route)
    const frame = createIcmpEchoRequest(
      "02:00:02:00:0a:01", routerMac(0, 1),
      "192.168.2.10", "192.168.1.10", 64
    );
    results.push(bench("processAtRouter — connected route", () => {
      state.simulation.log.length = 0;
      processAtRouter(router, frame, "sw-1");
    }, { budget: 50 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("processAtRouter — static route", () => {
    const topo = routerWithRoutes(5, 10);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    state.simulation = {
      status: "running",
      mode: "ping",
      events: [],
      log: [],
      transits: [],
      pendingArp: {},
      speed: 1000,
      autoPlay: false,
      stepTimer: null,
      animFrame: null,
      stepIndex: 0,
    } as any;
    const router = state.devices.find(d => d.id === "rtr-0")!;
    // Pre-populate ARP for next-hop
    const iface0 = router.config.interfaces![0];
    iface0.arpTable = [{ ipv4Address: "192.168.1.2", macAddress: "02:aa:bb:cc:dd:ee" }];
    // ICMP to a static-routed destination
    const frame = createIcmpEchoRequest(
      "02:00:02:00:0a:01", routerMac(0, 1),
      "192.168.2.10", "10.0.0.10", 64
    );
    results.push(bench("processAtRouter — static route", () => {
      state.simulation.log.length = 0;
      processAtRouter(router, frame, "sw-1");
    }, { budget: 60 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("processAtRouter — NAT translate (PAT)", () => {
    const topo = routerWithRoutes(5, 10);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    state.simulation = {
      status: "running", mode: "ping", events: [], log: [], transits: [],
      pendingArp: {}, speed: 1000, autoPlay: false, stepIndex: 0,
    } as any;
    const router = state.devices.find(d => d.id === "rtr-0")!;
    const ifaces = router.config.interfaces!;
    ifaces[0].arpTable = [{ ipv4Address: "192.168.1.2", macAddress: "02:aa:bb:cc:dd:ee" }];
    // Mark NAT roles so the forward path translates every frame.
    ifaces.forEach((i: any, idx: number) => { i.natRole = idx === 0 ? "outside" : "inside"; });
    const ingress = ifaces.find((i: any) => i.natRole === "inside")!;
    const frame = createIcmpEchoRequest(
      "02:00:02:00:0a:01", routerMac(0, 1),
      "10.9.9.10", "192.168.1.2", 64
    );
    results.push(bench("processAtRouter — NAT translate", () => {
      state.simulation.log.length = 0;
      router.config.natTranslations = []; // fresh table each run
      processAtRouter(router, frame, ingress.peerId);
    }, { budget: 100 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("prints results", () => {
    if (results.length) printResults(results);
  });
});

// ── 4b. Routing lookup (per-frame; ARP-flush reuses one table) ──────────────

describe("bench: routingLookup", () => {
  const results: BenchResult[] = [];
  beforeEach(() => resetState());

  it("routingLookup — builds the table per call (5i + 10s)", () => {
    const topo = routerWithRoutes(5, 10);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const router = state.devices.find(d => d.id === "rtr-0")!;
    results.push(bench("routingLookup — build per call", () => {
      routingLookup(router, "10.0.0.10");
    }, { budget: 60 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("routingLookup — prebuilt table (ARP-flush reuse)", () => {
    const topo = routerWithRoutes(5, 10);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const router = state.devices.find(d => d.id === "rtr-0")!;
    const table = buildRoutingTable(router);
    results.push(bench("routingLookup — prebuilt table", () => {
      routingLookup(router, "10.0.0.10", table);
    }, { budget: 25 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("prints results", () => {
    if (results.length) printResults(results);
  });
});

// ── 5. RIP Convergence ──────────────────────────────────────────────────────

describe("bench: RIP convergence", () => {
  const results: BenchResult[] = [];

  beforeEach(() => resetState());

  it("the ripStress fixture converges every router to a full table (cross-links and LANs included)", () => {
    // Guards R112: the cross-links were once addressed on one end only, so the
    // bench measured a plain ring, and the "LAN" networks were never connected,
    // so nothing advertised them.
    for (const n of [5, 10, 15]) {
      resetState();
      const topo = ripStress(n);
      state.devices = topo.devices as any;
      state.links = topo.links as any;
      runRipConvergence();
      const crosses = Array.from({ length: n }, (_, i) => i).filter(i => i % 3 === 0 && i + 3 < n).length;
      const routers = state.devices.filter(d => d.type === "router");
      for (const r of routers) expect(buildRoutingTable(r).length).toBe(n + crosses + 2 * n);
      // Router 3 hears router 0's LANs over the direct cross-link (1 hop), not round the ring.
      const viaCross = state.devices.find(d => d.id === "rtr-3")!.config.rip!.learnedRoutes.find(r => r.network === "192.168.1.0/24");
      expect(viaCross?.metric).toBe(1);
      expect(viaCross?.nextHop).toBe("10.0.100.1");
    }
  });

  it("runRipConvergence — 5 routers", () => {
    const topo = ripStress(5);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    results.push(bench("runRipConvergence — 5 routers", () => {
      // Clear learned routes before each iteration
      for (const d of state.devices) {
        if (d.config?.rip) d.config.rip.learnedRoutes = [];
      }
      runRipConvergence();
    }, { budget: 1000, warmup: 20, minTime: 1000 }));   // re-baselined with the R112 fixture fix — see docs/benchmarking.md
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("runRipConvergence — 10 routers", () => {
    const topo = ripStress(10);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    results.push(bench("runRipConvergence — 10 routers", () => {
      for (const d of state.devices) {
        if (d.config?.rip) d.config.rip.learnedRoutes = [];
      }
      runRipConvergence();
    }, { budget: 2000, warmup: 10, minTime: 2000 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("runRipConvergence — 15 routers", () => {
    const topo = ripStress(15);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    results.push(bench("runRipConvergence — 15 routers", () => {
      for (const d of state.devices) {
        if (d.config?.rip) d.config.rip.learnedRoutes = [];
      }
      runRipConvergence();
    }, { budget: 5000, warmup: 5, minTime: 3000 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("prints results", () => {
    if (results.length) printResults(results);
  });
});

describe("bench: STP convergence", () => {
  const results: BenchResult[] = [];
  beforeEach(() => resetState());

  // A ring of managed switches plus a chord every few hops — many L2 loops for
  // the spanning tree to resolve. runStpConvergence runs before every sim.
  function switchRing(n: number) {
    const devices = Array.from({ length: n }, (_, i) => ({
      id: `sw-${i}`, type: "switch", name: `SW-${i}`, x: i * 80, y: 0, width: 60, height: 60,
      config: { managed: true, ethernetPorts: 8, macTable: [] },
    }));
    const links: any[] = [];
    for (let i = 0; i < n; i++) links.push({ id: `r-${i}`, from: `sw-${i}`, to: `sw-${(i + 1) % n}` });
    for (let i = 0; i < n; i += 4) links.push({ id: `c-${i}`, from: `sw-${i}`, to: `sw-${(i + 2) % n}` });
    return { devices, links };
  }

  for (const [n, budget] of [[10, 500], [30, 2500]] as const) {
    it(`runStpConvergence — ${n} switches`, () => {
      const topo = switchRing(n);
      state.devices = topo.devices as any;
      state.links = topo.links as any;
      results.push(bench(`runStpConvergence — ${n} switches`, () => {
        runStpConvergence();
      }, { budget, warmup: 10, minTime: 1500 }));
      expect(results[results.length - 1].passed).toBe(true);
    });
  }

  it("prints results", () => {
    if (results.length) printResults(results);
  });
});

describe("bench: IDS rule matching", () => {
  const results: BenchResult[] = [];

  it("runIdsRules — 25 Snort rules per frame", () => {
    // A realistic-ish rule set the sensor evaluates against every mirrored frame.
    const rules = Array.from({ length: 25 }, (_, i) =>
      `alert tcp any any -> any ${1000 + i} (msg:"rule ${i}"; sid:${2000 + i}; rev:1;)`);
    rules.push(`alert tcp any any -> any 23 (msg:"Telnet"; sid:1000002; rev:1;)`);
    const frame = createTcpSegment("02:00:00:00:00:01", "02:00:00:00:00:02", "10.0.0.1", "10.0.0.2", 40000, 23, "syn");
    results.push(bench("runIdsRules — 25 rules", () => {
      runIdsRules(rules, frame);
    }, { budget: 200, warmup: 50, minTime: 1000 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("prints results", () => { if (results.length) printResults(results); });
});

describe("bench: Red Team attack building", () => {
  const results: BenchResult[] = [];

  beforeEach(() => resetState());

  it("buildScanEvents — SYN scan setup", () => {
    // A Red Team host scanning a server across a switch — the per-launch work of
    // resolving the next hop and seeding a SYN to every common port.
    runConsoleScript(`
      add switch SW1 at 0 0
      add attacker RT1 at -150 0
      add server SRV at 150 0
      ip RT1 10.0.0.66/24
      ip SRV 10.0.0.10/24
      link RT1 SW1
      link SRV SW1
    `);
    const rt = state.devices.find(d => d.name === "RT1")!;
    rt.config.arpTable = [{ ipv4Address: "10.0.0.10", macAddress: "02:00:00:00:00:10" }];
    results.push(bench("buildScanEvents — 13-port scan", () => {
      buildScanEvents(rt, "SRV");
    }, { budget: 80, warmup: 50, minTime: 1000 }));
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("prints results", () => { if (results.length) printResults(results); });
});

describe("bench: packet-list display filter", () => {
  const results: BenchResult[] = [];

  it("applyLogFilter — full (1000-row) capture, mixed expression", () => {
    // The sim-log render re-filters the whole capture each animation step; this
    // measures a worst-case full (capped) capture against a non-trivial filter.
    const rows: FilterRow[] = [];
    for (let i = 0; i < 1000; i++) {
      const m = i % 4;
      const frame = m === 0
        ? createArpRequest("02:00:00:00:00:0a", "10.0.0.1", "10.0.0.2")
        : m === 1
          ? createIcmpEchoRequest("02:00:00:00:00:0a", "02:00:00:00:00:0b", "10.0.0.1", "10.0.0.2", 64)
          : m === 2
            ? createTcpSegment("02:00:00:00:00:0a", "02:00:00:00:00:0b", "10.0.0.1", "10.0.0.2", 50000, 80, "syn")
            : createDnsResponse("02:00:00:00:00:0a", "02:00:00:00:00:0b", "10.0.0.53", "10.0.0.1", "host", "10.0.0.9", 0x1234);
      rows.push({ frame, macsec: false, no: i + 1, step: i, fromId: "d1", toId: "d2", fromName: "PC-A", toName: "SW-1", linkId: "l1" });
    }
    const filter = { protocols: ["icmp", "dns", "tcp"], device: "", expr: "icmp || dns || tcp.port == 80" };
    results.push(bench("applyLogFilter — 1000 rows", () => {
      applyLogFilter(rows, filter);
    }, { budget: 300, warmup: 20, minTime: 1000 }));   // tightened once the hot loop stopped allocating — see docs/benchmarking.md
    expect(results[results.length - 1].passed).toBe(true);
  });

  it("prints results", () => { if (results.length) printResults(results); });
});

// ── Helper ──────────────────────────────────────────────────────────────────

function routerMac(routerIdx: number, ifaceIdx: number): string {
  const hex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  return `02:${hex(routerIdx + 0xB0)}:00:00:${hex(ifaceIdx + 1)}:01`;
}
