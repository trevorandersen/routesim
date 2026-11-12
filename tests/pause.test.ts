/**
 * Pause semantics (review R10). A paused run is frozen: in-flight dots neither
 * advance nor get delivered nor get captured, and resuming carries each dot on
 * from the progress it held rather than jumping it forward by the paused gap.
 *
 * The animation loop (`animationTick`) is normally driven by requestAnimationFrame;
 * here rAF is stubbed to a no-op and ticks are delivered by hand with explicit
 * timestamps, so a "late" tick during a pause can be simulated deterministically.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import {
  startSimulation, pauseSimulation, resumeSimulation, animationTick, stopSimulation,
} from "../src/engine";
import { buildPingEvents } from "../src/simulation";
import { basicTopology } from "./fixtures";
import { registerNoopCallbacks, resetState } from "./helpers";

let raf: any, caf: any;
beforeAll(() => {
  registerNoopCallbacks();
  raf = (globalThis as any).requestAnimationFrame;
  caf = (globalThis as any).cancelAnimationFrame;
  (globalThis as any).requestAnimationFrame = () => 1;   // non-null id; never self-fires
  (globalThis as any).cancelAnimationFrame = () => {};
});
afterAll(() => {
  (globalThis as any).requestAnimationFrame = raf;
  (globalThis as any).cancelAnimationFrame = caf;
});

function startPing() {
  const t = basicTopology();
  state.devices = t.devices as any;
  state.links = t.links as any;
  const pc1 = state.devices.find(d => d.id === "pc1")!;
  startSimulation(buildPingEvents(pc1, "192.168.1.20") as any, pc1.id, "192.168.1.20");
}

/** How long a dot takes to cross, in the timestamp units animationTick reads. */
const span = (t: any) => state.simulation.speed * (t.latencyFactor ?? 1);

describe("pause freezes the run (R10)", () => {
  beforeEach(() => resetState());

  it("a late tick while paused advances nothing, delivers nothing, captures nothing", () => {
    startPing();
    const transit = state.simulation.transits[0];
    expect(transit).toBeTruthy();

    // Carry the dot to mid-flight with a running tick.
    animationTick(transit.startTime + 0.5 * span(transit));
    expect(transit.progress).toBeCloseTo(0.5, 5);
    expect(state.simulation.status).toBe("running");

    pauseSimulation();
    expect(state.simulation.status).toBe("paused");
    const frozenProgress = transit.progress;
    const capturedBefore = state.simulation.capture.length;
    const inFlightBefore = state.simulation.transits.length;

    // A tick arriving long after the pause must do nothing at all.
    animationTick(transit.startTime + 1000 * span(transit));
    expect(transit.progress).toBe(frozenProgress);             // did not advance
    expect(state.simulation.transits.length).toBe(inFlightBefore); // not delivered
    expect(state.simulation.capture.length).toBe(capturedBefore);  // not captured
    expect(state.simulation.status).toBe("paused");

    stopSimulation();
  });

  it("resume carries the dot on from where it froze, not forward by the paused gap", () => {
    startPing();
    const transit = state.simulation.transits[0];
    animationTick(transit.startTime + 0.4 * span(transit));
    expect(transit.progress).toBeCloseTo(0.4, 5);

    pauseSimulation();
    resumeSimulation();
    expect(state.simulation.status).toBe("running");
    // The rebase preserves the frozen progress; the dot has not jumped ahead.
    expect(transit.progress).toBeCloseTo(0.4, 5);

    // A tick a tenth of a crossing later advances it a little, still mid-flight.
    animationTick(transit.startTime + 0.5 * span(transit));
    expect(transit.progress).toBeCloseTo(0.5, 5);
    expect(transit.progress).toBeLessThan(1);

    stopSimulation();
  });

  it("after resume the run completes — the dot is delivered and captured", () => {
    startPing();
    const transit = state.simulation.transits[0];
    const linkId = transit.linkId;
    animationTick(transit.startTime + 0.5 * span(transit));
    pauseSimulation();
    resumeSimulation();

    // Drive the resumed dot to the end of its wire.
    const t = state.simulation.transits[0];
    animationTick(t.startTime + span(t));
    expect(state.simulation.capture.some(c => c.linkId === linkId)).toBe(true);

    stopSimulation();
  });
});
