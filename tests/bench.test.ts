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
import { getDevice, linkedPortsFor, connectedIds } from "../src/devices";
import { l2Reachable } from "../src/simulation";
import { processAtSwitch, processAtRouter, buildRoutingTable, runRipConvergence, evaluateFirewall } from "../src/engine";
import { createArpRequest, createArpReply, createIcmpEchoRequest, BROADCAST_MAC } from "../src/frame";
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
    }, { budget: 20 }));
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
    const iface0 = router.config.interfaces[0];
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
    const iface0 = router.config.interfaces[0];
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
    const ifaces = router.config.interfaces;
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

// ── 5. RIP Convergence ──────────────────────────────────────────────────────

describe("bench: RIP convergence", () => {
  const results: BenchResult[] = [];

  beforeEach(() => resetState());

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
    }, { budget: 500, warmup: 20, minTime: 1000 }));
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

// ── Helper ──────────────────────────────────────────────────────────────────

function routerMac(routerIdx: number, ifaceIdx: number): string {
  const hex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  return `02:${hex(routerIdx + 0xB0)}:00:00:${hex(ifaceIdx + 1)}:01`;
}
