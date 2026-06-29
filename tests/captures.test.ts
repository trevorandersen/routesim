/**
 * Multi-run capture history (Part B of "sim log filtering & captures"): a
 * finished animated run is archived to state.savedCaptures so a later run can be
 * compared against it. Covers the ring buffer, monotonic ids/labels, the view
 * pointer, captureEntriesFor, and the topology-load reset.
 *
 * Animated runs are pumped via stepOnce() with rAF stubbed to a no-op (the
 * preload's synchronous rAF would recurse the animation loop) — see capture.test.ts.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { state, undo } from "../src/state";
import { startSimulation, stepOnce, stopSimulation, startNetworkBoot, captureEntriesFor } from "../src/engine";
import { buildPingEvents } from "../src/simulation";
import { runConsoleScript } from "../src/commands";
import { loadTopology } from "../src/config";
import { clearNetwork } from "../src/devices";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());

describe("multi-run captures", () => {
  const realRaf = (globalThis as any).requestAnimationFrame;
  beforeEach(() => {
    resetState();
    (globalThis as any).requestAnimationFrame = () => 0;
  });
  afterEach(() => {
    (globalThis as any).requestAnimationFrame = realRaf;
  });

  function lan() {
    runConsoleScript(`
      add computer PC1 at 0 0
      add switch SW at 200 0
      add computer PC2 at 400 0
      link PC1 SW
      link PC2 SW
      ip PC1 192.168.1.10/24
      ip PC2 192.168.1.20/24
    `);
    return state.devices.find(d => d.name === "PC1")!;
  }

  function runAnimated(source: any, target: string): void {
    const setup = buildPingEvents(source, target);
    expect(typeof setup).not.toBe("string");
    state.simulation.autoPlay = true;
    startSimulation(setup as any, source.id, target, "ping");
    let guard = 0;
    while (state.simulation.status !== "done" && guard++ < 600) stepOnce();
    expect(state.simulation.status).toBe("done");
  }

  it("archives a finished run and points the view at it", () => {
    const pc1 = lan();
    runAnimated(pc1, "192.168.1.20");
    expect(state.savedCaptures.length).toBe(1);
    const saved = state.savedCaptures[0];
    expect(saved.index).toBe(1);
    expect(saved.id).toBe("cap-1");
    expect(saved.mode).toBe("ping");
    expect(saved.label).toContain("#1 ping PC1");
    expect(saved.label).toContain("✓"); // ✓ — the ping succeeded
    expect(saved.entries.length).toBe(state.simulation.capture.length);
    expect(state.dock.captureView).toBe("cap-1");
  });

  it("a failed run is labelled with ✗", () => {
    const pc1 = lan();
    runAnimated(pc1, "192.168.1.99"); // nobody answers
    expect(state.savedCaptures[0].label).toContain("✗"); // ✗
  });

  it("each run increments the index and moves the view", () => {
    const pc1 = lan();
    runAnimated(pc1, "192.168.1.20");
    runAnimated(pc1, "192.168.1.20");
    expect(state.savedCaptures.map(c => c.index)).toEqual([1, 2]);
    expect(state.dock.captureView).toBe("cap-2");
  });

  it("the history is a bounded ring (cap 12) with monotonic indices", () => {
    const pc1 = lan();
    for (let i = 0; i < 14; i++) runAnimated(pc1, "192.168.1.20");
    expect(state.savedCaptures.length).toBe(12);
    const idx = state.savedCaptures.map(c => c.index);
    expect(idx[0]).toBe(3);   // the two oldest (1, 2) were shifted out
    expect(idx[idx.length - 1]).toBe(14);
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBe(idx[i - 1] + 1);
    // ids stay unique and aligned to the index
    expect(new Set(state.savedCaptures.map(c => c.id)).size).toBe(12);
  });

  it("captureEntriesFor resolves live, saved, and unknown ids", () => {
    const pc1 = lan();
    runAnimated(pc1, "192.168.1.20");
    expect(captureEntriesFor("live")).toBe(state.simulation.capture);
    expect(captureEntriesFor("cap-1")).toBe(state.savedCaptures[0].entries);
    expect(captureEntriesFor("nope")).toEqual([]);
  });

  it("stop falls the view back to the most recent saved run", () => {
    const pc1 = lan();
    runAnimated(pc1, "192.168.1.20");          // saves cap-1
    const setup = buildPingEvents(pc1, "192.168.1.20");
    startSimulation(setup as any, pc1.id, "192.168.1.20", "ping");
    expect(state.dock.captureView).toBe("live"); // a new run shows live
    stopSimulation();
    expect(state.dock.captureView).toBe("cap-1");
  });

  it("loading a topology clears the capture history", () => {
    const pc1 = lan();
    runAnimated(pc1, "192.168.1.20");
    expect(state.savedCaptures.length).toBe(1);
    loadTopology("basic");
    expect(state.savedCaptures.length).toBe(0);
    expect(state.dock.captureView).toBe("live");
    expect(state.dock.compareBaseId).toBe("");
  });

  it("Clear (clearNetwork) resets the capture state", () => {
    const pc1 = lan();
    runAnimated(pc1, "192.168.1.20");
    state.inspectedCapture = state.savedCaptures[0].entries[0];
    clearNetwork();
    expect(state.savedCaptures.length).toBe(0);
    expect(state.dock.captureView).toBe("live");
    expect(state.dock.compareBaseId).toBe("");
    expect(state.inspectedCapture).toBeNull();
  });

  it("undo resets the capture state (the restored topology may differ)", () => {
    const pc1 = lan();
    runAnimated(pc1, "192.168.1.20");
    expect(state.savedCaptures.length).toBe(1);
    undo();
    expect(state.savedCaptures.length).toBe(0);
    expect(state.dock.captureView).toBe("live");
  });

  it("network-boot DHCP chatter is NOT archived to the compare ring", () => {
    // Two unconfigured cabled hosts + auto-DHCP on, no server → each boots over
    // DHCP (frames captured) but the boot runs must stay out of the archive.
    runConsoleScript(`
      add computer H1 at 0 0
      add switch SW at 200 0
      add computer H2 at 400 0
      link H1 SW
      link H2 SW
    `);
    const wasAuto = state.options.autoDhcp;
    state.options.autoDhcp = true;
    try {
      startNetworkBoot();
      let guard = 0;
      while (state.simulation.status !== "done" && guard++ < 2000) stepOnce();
      expect(state.savedCaptures.length).toBe(0); // boot runs not archived
    } finally {
      state.options.autoDhcp = wasAuto;
    }
  });
});
