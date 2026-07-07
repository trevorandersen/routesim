/**
 * Seeded determinism (src/prng.ts + the `seed` command). By default each run
 * reseeds from the clock so traffic varies; pinning the seed makes the
 * ephemeral, protocol-visible values (TCP source ports, DHCP ids) reproducible —
 * which is what makes the saved-capture Compare a true before/after diff.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { state } from "../src/state";
import { setSeedOverride, getSeedOverride, seedSimRng, currentSimSeed, simRandomInt } from "../src/prng";
import { buildConnectEvents } from "../src/simulation";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());
// The override is module-global — never let a test leak it to other files.
afterEach(() => setSeedOverride(null));

describe("prng — the seeded stream", () => {
  it("a pinned seed reseeds to the same stream every time", () => {
    setSeedOverride(1234);
    expect(seedSimRng()).toBe(1234);
    const a = [simRandomInt(0, 1e6), simRandomInt(0, 1e6), simRandomInt(0, 1e6)];
    expect(seedSimRng()).toBe(1234);              // same pin → same reseed
    const b = [simRandomInt(0, 1e6), simRandomInt(0, 1e6), simRandomInt(0, 1e6)];
    expect(b).toEqual(a);
  });

  it("different seeds give different streams", () => {
    setSeedOverride(1); seedSimRng(); const a = simRandomInt(0, 1e9);
    setSeedOverride(2); seedSimRng(); const b = simRandomInt(0, 1e9);
    expect(a).not.toBe(b);
  });

  it("unpinned reseeds from the clock (a fresh, positive seed)", () => {
    setSeedOverride(null);
    expect(seedSimRng()).toBeGreaterThan(0);
    expect(getSeedOverride()).toBeNull();
  });
});

describe("prng — end-to-end reproducibility", () => {
  beforeEach(() => resetState());

  function segment() {
    runConsoleScript(`
      add computer PC1 at 0 0
      add switch SW at 100 0
      add computer PC2 at 200 0
      link PC1 SW
      link PC2 SW
      ip PC1 192.168.1.10/24
      ip PC2 192.168.1.20/24
      ports PC2 80
    `);
    return state.devices.find(d => d.name === "PC1")!;
  }

  // The SYN's ephemeral source port, wherever the builder parked it.
  function synPort(setup: any): number | undefined {
    const frames = [
      ...setup.events.map((e: any) => e.frame),
      ...Object.values(setup.pendingArp || {}).flat() as any[],
    ];
    const syn = frames.find((f: any) => f?.payload?.type === "ipv4" && f.payload.payload?.type === "tcp");
    return syn?.payload.payload.srcPort;
  }

  it("a pinned seed makes a TCP connect's source port reproducible", () => {
    const pc1 = segment();
    setSeedOverride(777);
    const p1 = synPort(buildConnectEvents(pc1, "192.168.1.20", 80));
    setSeedOverride(777);                          // same pin
    const p2 = synPort(buildConnectEvents(pc1, "192.168.1.20", 80));
    expect(p1).toBeGreaterThanOrEqual(30000);
    expect(p2).toBe(p1);                           // identical run → identical port
  });

  it("the builder records the seed it used (for reproducing a default run)", () => {
    const pc1 = segment();
    setSeedOverride(4242);
    buildConnectEvents(pc1, "192.168.1.20", 80);
    expect(currentSimSeed()).toBe(4242);
  });
});

describe("the seed command", () => {
  beforeEach(() => { resetState(); setSeedOverride(null); });

  it("pins, reports, and clears the override", () => {
    expect(exec("seed 42").ok).toBe(true);
    expect(getSeedOverride()).toBe(42);
    expect(exec("seed").output.join(" ")).toContain("42");     // reports the pin
    expect(exec("seed off").ok).toBe(true);
    expect(getSeedOverride()).toBeNull();
    expect(exec("seed").output.join(" ").toLowerCase()).toContain("clock");
  });

  it("rejects a non-numeric / out-of-range seed", () => {
    expect(exec("seed banana").ok).toBe(false);
    expect(exec("seed -1").ok).toBe(false);
    expect(getSeedOverride()).toBeNull();          // a rejected seed changes nothing
  });
});
