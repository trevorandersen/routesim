/**
 * Seeded determinism (src/prng.ts + the `seed` command). By default each run
 * reseeds from the clock so traffic varies; pinning the seed makes the
 * ephemeral, protocol-visible values (TCP source ports, DHCP ids) reproducible —
 * which is what makes the saved-capture Compare a true before/after diff.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { state } from "../src/state";
import { setSeedOverride, getSeedOverride, seedSimRng, currentSimSeed, simRandomInt, seedLossRng, lossRandom } from "../src/prng";
import { buildConnectEvents, buildResolveEvents, buildPingEvents, buildAssociationEvents } from "../src/simulation";
import { startSimulation, stepOnce, startNetworkBoot } from "../src/engine";
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

describe("prng — DNS transaction id is seeded (reproducible)", () => {
  beforeEach(() => { resetState(); setSeedOverride(null); });

  function dnsId(setup: any): number | undefined {
    const frames = [
      ...setup.events.map((e: any) => e.frame),
      ...Object.values(setup.pendingArp || {}).flat() as any[],
    ];
    const q = frames.find((f: any) => f?.payload?.type === "ipv4" && f.payload.payload?.type === "dns");
    return q?.payload.payload.id;
  }

  it("a pinned seed makes an nslookup's transaction id reproducible", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      add server SRV at 200 0
      link PC1 SRV
      ip PC1 192.168.1.10/24
      ip SRV 192.168.1.53/24
      nameserver PC1 192.168.1.53
    `);
    const pc1 = state.devices.find(d => d.name === "PC1")!;
    setSeedOverride(2024);
    const a = dnsId(buildResolveEvents(pc1, "srv.test") as any);
    setSeedOverride(2024);
    const b = dnsId(buildResolveEvents(pc1, "srv.test") as any);
    expect(a).toBeGreaterThanOrEqual(0x1000);
    expect(b).toBe(a);   // identical run → identical xid (was a session counter before)
  });
});

// R13: per-link loss was the one engine draw still on Math.random(), so a
// pinned seed reproduced the ports and ids of a lossy run but not WHICH frames
// the wire dropped — and the saved-capture Compare was no longer a true diff.
describe("prng — link loss is seeded (animated runs)", () => {
  const realRaf = (globalThis as any).requestAnimationFrame;
  const realRandom = Math.random;
  beforeEach(() => { resetState(); (globalThis as any).requestAnimationFrame = () => 0; });
  afterEach(() => {
    (globalThis as any).requestAnimationFrame = realRaf;
    Math.random = realRandom;
  });

  function lossyLan(loss: number) {
    runConsoleScript(`
      add computer PC1 at 0 0
      add switch SW at 200 0
      add computer PC2 at 400 0
      link PC1 SW
      link PC2 SW
      ip PC1 192.168.1.10/24
      ip PC2 192.168.1.20/24
      linkset PC1 SW loss ${loss}
      linkset PC2 SW loss ${loss}
    `);
    return state.devices.find(d => d.name === "PC1")!;
  }

  // What the learner sees of a run: every frame that crossed a wire, every drop.
  function pump(): string {
    let guard = 0;
    while (state.simulation.status !== "done" && guard++ < 500) stepOnce();
    expect(state.simulation.status).toBe("done");
    const drops = state.simulation.log.filter(e => /% loss\)/.test(e.summary)).map(e => e.summary);
    const crossed = state.simulation.capture.map(c => `${c.fromDeviceId}>${c.toDeviceId}`);
    return JSON.stringify({ drops, crossed });
  }

  function lossyPing(seed: number): string {
    resetState();
    const pc1 = lossyLan(40);
    setSeedOverride(seed);
    const setup = buildPingEvents(pc1, "192.168.1.20");
    expect(typeof setup).not.toBe("string");
    state.simulation.autoPlay = true;
    startSimulation(setup as any, pc1.id, "192.168.1.20", "ping");
    return pump().replace(new RegExp(state.devices.map(d => d.id).join("|"), "g"),
      id => state.devices.find(d => d.id === id)!.name);   // ids differ per build — compare by name
  }

  it("the same pinned seed drops the same frames on every run", () => {
    // Math.random is poisoned to a different value each call: any draw still
    // taken from it would make the two runs disagree.
    let n = 0; Math.random = () => ((n += 0.37) % 1);
    const first = lossyPing(42);
    const second = lossyPing(42);
    expect(second).toBe(first);
  });

  it("different seeds drop different frames (the loss really is drawn)", () => {
    const outcomes = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(lossyPing));
    expect(outcomes.size).toBeGreaterThan(1);
  });

  it("loss never draws from Math.random()", () => {
    Math.random = () => { throw new Error("Math.random() used for a simulation draw"); };
    expect(() => lossyPing(7)).not.toThrow();
  });

  it("a run with no seeding builder (802.11 association) is reproducible too", () => {
    // buildAssociationEvents draws no ephemeral value, so it never reseeds the
    // main stream; the loss stream is reseeded by the run itself.
    const lossyAssociation = (): string => {
      resetState();
      runConsoleScript(`add laptop LT1 at 0 0\nadd access-point AP1 at 100 0\nlink LT1 AP1\nlinkset LT1 AP1 loss 35`);
      const lt = state.devices.find(d => d.name === "LT1")!;
      setSeedOverride(11);
      simRandomInt(0, 1000);   // leave the main stream somewhere arbitrary, as a prior run would
      const setup = buildAssociationEvents(lt);
      expect(typeof setup).not.toBe("string");
      state.simulation.autoPlay = true;
      startSimulation(setup as any, lt.id, "", "associate");
      let guard = 0;
      while (state.simulation.status !== "done" && guard++ < 300) stepOnce();
      return JSON.stringify(state.simulation.log.map(e => e.summary));
    };
    const first = lossyAssociation();
    expect(lossyAssociation()).toBe(first);
  });

  it("the loss stream is independent of the main stream", () => {
    setSeedOverride(5);
    seedSimRng(); seedLossRng();
    const loss = [lossRandom(), lossRandom(), lossRandom()];
    seedSimRng(); seedLossRng();
    simRandomInt(0, 10); simRandomInt(0, 10);     // main-stream draws in between
    expect([lossRandom(), lossRandom(), lossRandom()]).toEqual(loss);
  });
});

// R51 (the seed half): Play with Auto-DHCP off self-assigns APIPA directly, with
// no run and therefore no reseed — the address depended on whatever the previous
// run had left in the stream.
describe("prng — direct APIPA boot honours the pinned seed", () => {
  const options = { ...state.options };
  beforeEach(() => { resetState(); state.options.autoDhcp = false; state.options.apipaFallback = true; });
  afterEach(() => { Object.assign(state.options, options); });

  const ipOf = (name: string) => state.devices.find(d => d.name === name)!.config!.ipv4Address;
  function twoHosts() {
    resetState();
    runConsoleScript(`add computer PC1 at 0 0\nadd computer PC2 at 0 200\nadd switch SW at 200 0\nlink PC1 SW\nlink PC2 SW`);
  }

  it("the same pinned seed gives the same link-local addresses, whatever ran before", () => {
    setSeedOverride(99);
    twoHosts();
    startNetworkBoot();
    const first = [ipOf("PC1"), ipOf("PC2")];
    twoHosts();
    seedSimRng(); simRandomInt(0, 100); simRandomInt(0, 100);   // stream history from "an earlier run"
    startNetworkBoot();
    expect([ipOf("PC1"), ipOf("PC2")]).toEqual(first);
    expect(first[0]).toMatch(/^169\.254\.\d+\.\d+$/);
  });

  it("two hosts never claim the same address, even across separate Play presses", () => {
    setSeedOverride(99);
    twoHosts();
    startNetworkBoot();
    expect(ipOf("PC1")).not.toBe(ipOf("PC2"));
    // A host added later boots on a second press, which reseeds to the same
    // stream: its first candidate is PC1's address, so it must move on.
    runConsoleScript(`add computer PC3 at 0 400\nlink PC3 SW`);
    startNetworkBoot();
    expect(new Set([ipOf("PC1"), ipOf("PC2"), ipOf("PC3")]).size).toBe(3);
  });
});
