/**
 * Broadcast-storm detection by evidence (R2). A storm is declared when the
 * same frame lineage comes back round to cross the same wire in the same
 * direction again (an L2 loop), not after a fixed number of steps. So a large
 * loop-free run (an 8-host ping sweep, a DHCP lease across a 70-host LAN)
 * completes on the animated path exactly as it does headless, while a looped
 * topology with STP off is still caught, and named, on both paths. An IP
 * routing loop is not a storm: TTL bounds it, so each lap differs.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { state } from "../src/state";
import { runConsoleCommand as exec, runConsoleScript } from "../src/commands";
import { buildPingEvents, buildDhcpEvents, buildSweepEvents } from "../src/simulation";
import { runSimulationHeadless, startSimulation, stepOnce, STORM_DIAGNOSIS } from "../src/engine";
import { runStpConvergence } from "../src/stp";
import { freshNameCounters } from "../src/device-registry";
import { registerNoopCallbacks, resetState } from "./helpers";
import type { PingSetup } from "../src/simulation";
import type { Device, SimMode } from "../src/types";

beforeAll(() => registerNoopCallbacks());

// The preload's synchronous rAF would recurse inside the animation loop, so
// animated runs are pumped by hand with stepOnce().
const realRaf = (globalThis as any).requestAnimationFrame;
beforeEach(() => {
  resetState();
  state.nameCounters = freshNameCounters();
  state.configStore = { version: 1, configs: {} } as any;
  (globalThis as any).requestAnimationFrame = () => 0;
});
afterEach(() => {
  (globalThis as any).requestAnimationFrame = realRaf;
});

const byName = (name: string): Device => state.devices.find(d => d.name === name)!;
const drops = () => state.simulation.log.filter(e => e.kind === "sim-drop").map(e => e.action);

function setupOf(setup: PingSetup | string): PingSetup {
  if (typeof setup === "string") throw new Error(setup);
  return setup;
}

function runAnimated(source: Device, setup: PingSetup | string, target: string, mode: SimMode): void {
  state.simulation.autoPlay = true;
  expect(startSimulation(setupOf(setup), source.id, target, mode)).toBeNull();
  let guard = 0;
  while (state.simulation.status !== "done" && guard++ < 50000) stepOnce();
  expect(state.simulation.status).toBe("done");
}

// One switch, eight hosts and a Red Team node — no loop anywhere.
function eightHostLan(): void {
  runConsoleScript(`
    add switch SW at 0 0
    add attacker RT at 0 -200
    link RT SW
    ip RT 10.0.0.66/24
  `);
  byName("SW").config.ethernetPorts = 16;
  for (let i = 1; i <= 8; i++) {
    runConsoleScript(`
      add computer PC${i} at ${i * 120 - 540} 200
      link PC${i} SW
      ip PC${i} 10.0.0.${i}/24
    `);
  }
}

// A core switch with ten access switches of seven hosts each (70 hosts), and a
// router on the core serving DHCP — a tree, so loop-free.
function seventyHostTree(): void {
  runConsoleScript(`
    add switch CORE at 0 0
    add router R1 at 0 -200
    link R1 CORE
    interface R1 CORE ip 10.0.0.1/24
  `);
  byName("CORE").config.ethernetPorts = 16;
  let pc = 0;
  for (let s = 1; s <= 10; s++) {
    runConsoleScript(`add switch SW${s} at ${s * 200} 200\nlink SW${s} CORE`);
    for (let h = 1; h <= 7; h++) {
      pc++;
      runConsoleScript(`add computer PC${pc} at ${s * 200} ${300 + h * 150}\nlink PC${pc} SW${s}`);
    }
  }
}

// Three managed switches in a triangle, spanning tree off on all of them.
function stormingTriangle(): void {
  runConsoleScript(`
    add computer PC1 at 0 0
    add computer PC2 at 400 0
    add switch SW1 at 100 0
    add switch SW2 at 300 0
    add switch SW3 at 200 200
    managed SW1 on
    managed SW2 on
    managed SW3 on
    ip PC1 10.0.0.1/24
    ip PC2 10.0.0.2/24
    link PC1 SW1
    link PC2 SW2
    link SW1 SW2
    link SW2 SW3
    link SW3 SW1
    stp SW1 off
    stp SW2 off
    stp SW3 off
  `);
  runStpConvergence();
}

describe("no false broadcast storm on loop-free animated runs (R2)", () => {
  it("an animated 8-host ping sweep finds every host, like the headless run", () => {
    eightHostLan();
    const rt = byName("RT");
    // Animated first, on cold ARP caches: every probe ARPs, and each ARP
    // broadcast is flooded to all nine ports — well past the old 200-step cap.
    runAnimated(rt, buildSweepEvents(rt, "10.0.0.0/24"), "", "attack");
    expect(state.simulation.stormDetected).toBe(false);
    expect(state.simulation.stepIndex).toBeGreaterThan(200);
    expect(drops()).not.toContain(STORM_DIAGNOSIS);
    const found = [...state.simulation.sweepLive].sort();
    expect(found).toHaveLength(8);

    const headless = runSimulationHeadless(setupOf(buildSweepEvents(rt, "10.0.0.0/24")), rt.id, "", "attack");
    expect(headless.storm).toBe(false);
    expect([...state.simulation.sweepLive].sort()).toEqual(found);
  });

  it("an animated DHCP lease across a 70-host tree succeeds without a storm", () => {
    seventyHostTree();
    const pc = byName("PC1");
    runAnimated(pc, buildDhcpEvents(pc), "", "dhcp");
    expect(state.simulation.stormDetected).toBe(false);
    expect(state.simulation.dhcpSuccess).toBe(true);
    expect(state.simulation.stepIndex).toBeGreaterThan(200);
    expect(state.simulation.diagnosis).toEqual([]);
    expect(pc.config.ipv4Address).toMatch(/^10\.0\.0\./);

    const pc2 = byName("PC70");
    const headless = runSimulationHeadless(setupOf(buildDhcpEvents(pc2)), pc2.id, "", "dhcp");
    expect(headless.storm).toBe(false);
    expect(headless.success).toBe(true);
  });

  it("an IP routing loop is bounded by TTL, not called a storm, on both paths", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      add switch SW at 150 0
      add router R1 at 300 0
      add router R2 at 450 0
      link PC1 SW
      link SW R1
      link R1 R2
      ip PC1 10.0.0.10/24
      gateway PC1 10.0.0.1
      interface R1 SW ip 10.0.0.1/24
      interface R1 R2 ip 10.1.0.1/30
      interface R2 R1 ip 10.1.0.2/30
      route R1 0.0.0.0/0 10.1.0.2
      route R2 0.0.0.0/0 10.1.0.1
    `);
    const pc = byName("PC1");
    const headless = runSimulationHeadless(setupOf(buildPingEvents(pc, "8.8.8.8")), pc.id, "8.8.8.8", "ping");
    expect(headless.storm).toBe(false);
    expect(headless.timeExceeded).toBe(true);

    runAnimated(pc, buildPingEvents(pc, "8.8.8.8"), "8.8.8.8", "ping");
    expect(state.simulation.stormDetected).toBe(false);
    expect(state.simulation.pingTimeExceeded).toBe(true);
  });
});

describe("a real L2 loop is still a storm, on both paths (R2)", () => {
  it("headless: detected by the looping frame, long before the step backstop", () => {
    stormingTriangle();
    const r = exec("run ping PC1 PC2");
    const data = r.data as { storm: boolean; steps: number };
    expect(data.storm).toBe(true);
    expect(data.steps).toBeLessThan(100);
    expect(r.output).toContain(STORM_DIAGNOSIS);
    // The evidence is named: which frame came back round, over which wire.
    // (Here SW2 is about to hand PC2 a second copy of the ARP it already sent.)
    expect(drops().some(d => /came back round to cross .+ \(SW\d → \w+\) again/.test(d))).toBe(true);
  });

  it("animated: the same verdict, at the same step, with queues cleared", () => {
    stormingTriangle();
    const pc = byName("PC1");
    runSimulationHeadless(setupOf(buildPingEvents(pc, "10.0.0.2")), pc.id, "10.0.0.2", "ping");
    const headlessSteps = state.simulation.stepIndex;
    const headlessEvidence = drops().find(d => /came back round/.test(d));

    runAnimated(pc, buildPingEvents(pc, "10.0.0.2"), "10.0.0.2", "ping");
    expect(state.simulation.stormDetected).toBe(true);
    expect(state.simulation.diagnosis).toEqual([STORM_DIAGNOSIS]);
    // The animated run counts the source emitting as step 1 (its seeded first
    // leg); otherwise it processes the very same events in the same order.
    expect(state.simulation.stepIndex).toBe(headlessSteps + 1);
    expect(drops().find(d => /came back round/.test(d))).toBe(headlessEvidence);
    expect(state.simulation.events).toEqual([]);
    expect(state.simulation.transits).toEqual([]);
  });
});
