/**
 * Run ownership: one run owns `state.simulation` at a time (engine beginRun).
 * A second animated run is refused while the user's run is in flight, a
 * headless run (console `run`, traceroute, scenario Check) stops it first with
 * a surfaced note, a manual run preempts a network boot and cancels the rest
 * of its queue, and the terminal input lock follows the run (derived from the
 * same policy, scoped to the shell that started it) rather than the command
 * that started the run. Before this, every one of these silently
 * replaced the in-flight run (review R5/R61).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { state } from "../src/state";
import { dom } from "../src/dom";
import { startNetworkBoot, stepOnce, stopSimulation, runSimulationHeadless, takePreemptionNote, RUN_BUSY } from "../src/engine";
import { buildPingEvents } from "../src/simulation";
import { simRandom, mulberry32 } from "../src/prng";
import { openTerminalFor, runTerminalCommand, submitTerminalCommand, syncTerminal, sessionFor } from "../src/terminal";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { diagnoseState } from "../src/diagnostics";
import { registerNoopCallbacks, resetState } from "./helpers";

// The engine re-renders the terminal through the callback bridge (it no longer
// imports the terminal UI), so the input-lock tests register the real view.
beforeAll(() => registerNoopCallbacks({ syncTerminal }));
afterAll(() => registerNoopCallbacks());

// The preload's synchronous rAF would recurse through the animation loop, so
// stub it to a no-op and pump animated runs with stepOnce().
const realRaf = (globalThis as any).requestAnimationFrame;
let savedOptions: { autoDhcp: boolean; apipaFallback: boolean };
beforeEach(() => {
  resetState();
  savedOptions = { autoDhcp: state.options.autoDhcp, apipaFallback: state.options.apipaFallback };
  (globalThis as any).requestAnimationFrame = () => 0;
  takePreemptionNote();   // no note carried over from another suite
});
afterEach(() => {
  stopSimulation();       // never leave a run (or a boot queue) behind for the next test
  state.options.autoDhcp = savedOptions.autoDhcp;
  state.options.apipaFallback = savedOptions.apipaFallback;
  (globalThis as any).requestAnimationFrame = realRaf;
});

const dev = (name: string) => state.devices.find(d => d.name === name)!;
const linesOf = (name: string) => (sessionFor(dev(name).id)?.lines ?? []).map(l => l.text).join("\n");

function lan(): void {
  runConsoleScript(`
    add computer PC1 at 0 0
    add switch SW at 200 0
    add computer PC2 at 400 0
    add computer PC3 at 200 200
    link PC1 SW
    link PC2 SW
    link PC3 SW
    ip PC1 192.168.1.10/24
    ip PC2 192.168.1.20/24
    ip PC3 192.168.1.30/24
  `);
}

function pumpToDone(): void {
  let guard = 0;
  while (state.simulation.status !== "done" && guard++ < 2000) stepOnce();
  expect(state.simulation.status).toBe("done");
}

describe("a second animated run is refused while one is in flight", () => {
  it("a second terminal ping keeps the first run, which still reports its result", () => {
    lan();
    openTerminalFor(dev("PC1"));
    runTerminalCommand("ping 192.168.1.20");
    expect(state.simulation.status).toBe("running");
    const first = { origin: state.simulation.originDeviceId, target: state.simulation.pingTargetIp };

    // A second ping from the same shell (reached via the console `cli` verb or
    // an injected command — the input itself is read-only, see below).
    runTerminalCommand("ping 192.168.1.30");
    expect(linesOf("PC1")).toContain(RUN_BUSY);
    expect(state.simulation.status).toBe("running");
    expect(state.simulation.originDeviceId).toBe(first.origin);
    expect(state.simulation.pingTargetIp).toBe(first.target);

    // The first run finishes and its result lands in PC1's session.
    pumpToDone();
    expect(state.simulation.pingSuccess).toBe(true);
    expect(linesOf("PC1")).toContain("1 packets transmitted, 1 received");
  });

  it("a ping from another device's shell is refused too", () => {
    lan();
    openTerminalFor(dev("PC1"));
    runTerminalCommand("ping 192.168.1.20");
    openTerminalFor(dev("PC3"));
    runTerminalCommand("ping 192.168.1.10");
    expect(linesOf("PC3")).toContain(RUN_BUSY);
    expect(state.simulation.originDeviceId).toBe(dev("PC1").id);
  });

  it("the console's animated verbs refuse with the reason, while paused as well", () => {
    lan();
    expect(exec("ping PC1 PC2").ok).toBe(true);
    exec("pause");
    expect(state.simulation.status).toBe("paused");
    const r = exec("ping PC3 PC2");
    expect(r.ok).toBe(false);
    expect(r.output.join("\n")).toContain(RUN_BUSY);
    expect(exec("dhcp PC3").ok).toBe(false);
    expect(state.simulation.originDeviceId).toBe(dev("PC1").id);
    expect(state.simulation.status).toBe("paused");
  });

  it("a refused command builds nothing (no PRNG reseed under the in-flight run)", () => {
    lan();
    exec("seed 42");
    try {
      exec("ping PC1 PC2");            // reseeds the run stream to 42
      simRandom(); simRandom();         // the in-flight run has drawn twice
      const undoDepth = state.undoStack.length;
      expect(exec("connect PC3 PC2 80").ok).toBe(false);
      // A builder would have reseeded (and drawn a source port), rewinding the
      // run's stream: its next draw must still be the third from seed 42.
      const reference = mulberry32(42); reference(); reference();
      expect(simRandom()).toBe(reference());
      // Nothing was pushed or started for the refused connect.
      expect(state.undoStack.length).toBe(undoDepth);
      expect(state.simulation.mode).toBe("ping");
    } finally { exec("seed clock"); }
  });
});

const submit = (text: string) => {
  dom.terminalInput.value = text;
  submitTerminalCommand({ preventDefault() {} } as unknown as Event);
};

describe("the terminal input lock follows the run", () => {
  it("stays read-only for the whole run, however often the terminal re-syncs", () => {
    lan();
    openTerminalFor(dev("PC1"));
    dom.terminalInput.value = "ping 192.168.1.20";
    submitTerminalCommand({ preventDefault() {} } as unknown as Event);
    expect(state.simulation.status).toBe("running");
    // The old lock was set by the command and cleared again by the syncTerminal
    // at the end of the same submit — the input was never actually locked.
    expect(dom.terminalInput.readOnly).toBe(true);
    syncTerminal();
    expect(dom.terminalInput.readOnly).toBe(true);
    pumpToDone();
    expect(dom.terminalInput.readOnly).toBe(false);
  });

  it("a submit that slips through mid-run is refused, not run", () => {
    lan();
    openTerminalFor(dev("PC1"));
    runTerminalCommand("ping 192.168.1.20");
    dom.terminalInput.value = "ping 192.168.1.30";
    submitTerminalCommand({ preventDefault() {} } as unknown as Event);
    expect(linesOf("PC1")).toContain(RUN_BUSY);
    expect(state.simulation.pingTargetIp).toBe("192.168.1.20");
  });

  it("only the shell that started the run is locked; others stay usable mid-run", () => {
    lan();
    openTerminalFor(dev("PC1"));
    runTerminalCommand("ping 192.168.1.20");
    exec("pause");   // the frame inspector pauses the run — the lock lasts longest here
    expect(state.simulation.status).toBe("paused");
    expect(dom.terminalInput.readOnly).toBe(true);
    expect(dom.terminalInput.placeholder).toBe("Simulation paused — Ctrl+C to stop");

    // PC2's shell is not the busy one: reading its ARP cache mid-run works.
    openTerminalFor(dev("PC2"));
    expect(dom.terminalInput.readOnly).toBe(false);
    submit("arp -n");
    expect(linesOf("PC2")).not.toContain(RUN_BUSY);
    expect(linesOf("PC2")).toContain("arp -n");
    // ...but starting a run there is still refused, by the command itself.
    submit("ping 192.168.1.10");
    expect(linesOf("PC2")).toContain(RUN_BUSY);
    expect(state.simulation.originDeviceId).toBe(dev("PC1").id);
    expect(state.simulation.status).toBe("paused");

    // Back on PC1, its shell is still busy.
    openTerminalFor(dev("PC1"));
    expect(dom.terminalInput.readOnly).toBe(true);
  });

  it("the placeholder says running while the run runs", () => {
    lan();
    openTerminalFor(dev("PC1"));
    runTerminalCommand("ping 192.168.1.20");
    expect(dom.terminalInput.placeholder).toBe("Simulation running — Ctrl+C to stop");
  });

  it("stopping the run unlocks it", () => {
    lan();
    openTerminalFor(dev("PC1"));
    runTerminalCommand("ping 192.168.1.20");
    expect(dom.terminalInput.readOnly).toBe(true);
    stopSimulation();
    expect(dom.terminalInput.readOnly).toBe(false);
  });
});

describe("a headless run stops an animated run first, and says so", () => {
  it("console `run ping` mid-animation: the animated run is torn down with a note", () => {
    lan();
    openTerminalFor(dev("PC1"));
    runTerminalCommand("ping 192.168.1.20");
    expect(state.simulation.status).toBe("running");

    const r = exec("run ping PC3 PC2");
    expect(r.ok).toBe(true);
    // Surfaced in the console output and in the interrupted run's terminal.
    expect(r.output[0]).toContain("Simulation stopped before it finished");
    // Named by what the learner did, never the internal word "headless".
    expect(r.output[0]).toContain("the console's `run ping` needed the simulator");
    expect(r.output[0]).not.toContain("headless");
    expect(linesOf("PC1")).toContain("Simulation stopped before it finished");
    // The headless run's own result, on a quiet model.
    expect(r.output.join("\n")).toContain("reachable");
    expect(state.simulation.transits).toEqual([]);
    expect(state.simulation.headless).toBe(false);
    expect(diagnoseState(state)).toEqual([]);
  });

  it("traceroute during a run: the trace is correct and the interrupted run explains itself", () => {
    lan();
    openTerminalFor(dev("PC1"));
    runTerminalCommand("ping 192.168.1.20");
    openTerminalFor(dev("PC3"));
    runTerminalCommand("traceroute 192.168.1.20");
    expect(linesOf("PC3")).toContain("traceroute to 192.168.1.20");
    expect(linesOf("PC3")).not.toContain("destination not reached");
    expect(linesOf("PC1")).toContain("Simulation stopped before it finished — a traceroute from PC3 needed the simulator");
    // ...and the tracing shell says what its traceroute did, too.
    expect(linesOf("PC3")).toContain("a traceroute from PC3 needed the simulator");
    // The animated run is gone; nothing points at its transits.
    expect(state.simulation.transits).toEqual([]);
    expect(diagnoseState(state)).toEqual([]);
  });

  it("console traceroute carries the note in its output", () => {
    lan();
    exec("ping PC1 PC2");
    const r = exec("traceroute PC3 PC2");
    expect(r.ok).toBe(true);
    expect(r.output[0]).toContain("Simulation stopped before it finished");
  });

  it("a headless run that throws mid-drain still ends, so later runs aren't refused", () => {
    lan();
    const pc1 = dev("PC1");
    // A malformed event (no frame) makes the computer's handler throw.
    const broken = { events: [{ deviceId: pc1.id, frame: null, linkId: null, fromDeviceId: null }], pendingArp: {} };
    expect(() => runSimulationHeadless(broken as any, pc1.id, "192.168.1.20", "ping")).toThrow();
    expect(state.simulation.status).toBe("done");
    expect(state.simulation.headless).toBe(false);
    expect(state.simulation.events).toEqual([]);
    // Before, the stale "running" headless run refused every animated run and
    // locked PC1's shell, with no transport pill to stop it from.
    openTerminalFor(pc1);
    expect(dom.terminalInput.readOnly).toBe(false);
    expect(exec("ping PC1 PC2").ok).toBe(true);
  });

  it("a headless run with nothing in flight adds no note", () => {
    lan();
    const r = exec("run ping PC1 PC2");
    expect(r.output.join("\n")).not.toContain("stopped");
    expect(takePreemptionNote()).toBeNull();
  });
});

describe("a manual run preempts a network boot", () => {
  function bootLan(): void {
    // Two unconfigured hosts on a switch with no DHCP server (each boot times
    // out), plus two addressed hosts the learner pings between.
    runConsoleScript(`
      add switch SW at 200 0
      add computer H1 at 0 0
      add computer H2 at 0 200
      add computer PCA at 400 0
      add computer PCB at 400 200
      link H1 SW
      link H2 SW
      link PCA SW
      link PCB SW
      ip PCA 10.0.0.1/24
      ip PCB 10.0.0.2/24
    `);
    state.options.autoDhcp = true;
    state.options.apipaFallback = false;   // a timed-out boot leaves the host unassigned
  }

  it("an animated ping during a boot takes over and the boot queue is cancelled", () => {
    bootLan();
    expect(startNetworkBoot()).toBe(true);
    expect(state.simulation.mode).toBe("dhcp");

    const r = exec("ping PCA PCB");
    expect(r.ok).toBe(true);
    expect(r.output[0]).toContain("Network boot interrupted");
    expect(r.output[0]).toContain("2 hosts still unassigned");
    expect(state.simulation.mode).toBe("ping");
    expect(state.simulation.originDeviceId).toBe(dev("PCA").id);

    // When the ping finishes, the boot chain must NOT resume behind it.
    pumpToDone();
    expect(state.simulation.mode).toBe("ping");
    expect(state.simulation.pingSuccess).toBe(true);
    expect(state.simulation.status).toBe("done");
    expect(dev("H2").config?.ipv4Address || "").toBe("");
  });

  it("a ping typed in a host terminal during a boot takes over, as the console does", () => {
    bootLan();
    expect(startNetworkBoot()).toBe(true);
    openTerminalFor(dev("PCA"));
    // A boot doesn't lock the shells: a user's run may preempt it.
    expect(dom.terminalInput.readOnly).toBe(false);
    submit("ping 10.0.0.2");
    expect(linesOf("PCA")).not.toContain(RUN_BUSY);
    expect(linesOf("PCA")).toContain("Network boot interrupted");
    expect(state.simulation.mode).toBe("ping");
    expect(state.simulation.originDeviceId).toBe(dev("PCA").id);
    // Now PCA's own ping holds its shell.
    expect(dom.terminalInput.readOnly).toBe(true);
    pumpToDone();
    expect(state.simulation.pingSuccess).toBe(true);
    expect(dev("H2").config?.ipv4Address || "").toBe("");
  });

  it("a headless run during a boot stops it and leaves no queue behind", () => {
    bootLan();
    startNetworkBoot();
    const setup = buildPingEvents(dev("PCA"), "10.0.0.2");
    expect(typeof setup).not.toBe("string");
    const res = runSimulationHeadless(setup as any, dev("PCA").id, "10.0.0.2", "ping");
    expect(res.success).toBe(true);
    expect(takePreemptionNote()).toContain("Network boot interrupted");
    // A later animated run finishing must not wake a stale boot queue.
    expect(exec("ping PCA PCB").ok).toBe(true);
    pumpToDone();
    expect(state.simulation.mode).toBe("ping");
  });

  it("one Play press is one undo point, however many hosts boot", () => {
    bootLan();
    state.options.apipaFallback = true;   // each boot ends with an address, so the chain runs to the end
    const before = state.undoStack.length;
    expect(startNetworkBoot()).toBe(true);
    pumpToDone();   // stepOnce keeps pumping through the chained boots
    expect(dev("H1").config?.ipv4Address).toBeTruthy();
    expect(dev("H2").config?.ipv4Address).toBeTruthy();
    expect(state.undoStack.length - before).toBe(1);
  });

  it("a Play press that boots nothing takes no undo point (and keeps redo)", () => {
    bootLan();
    // No MAC: buildDhcpEvents refuses each host, so nothing boots or changes.
    dev("H1").config!.macAddress = "";
    dev("H2").config!.macAddress = "";
    state.redoStack.push(state.undoStack[state.undoStack.length - 1]);
    const undoDepth = state.undoStack.length;
    const redoDepth = state.redoStack.length;
    expect(startNetworkBoot()).toBe(false);
    expect(state.undoStack.length).toBe(undoDepth);
    expect(state.redoStack.length).toBe(redoDepth);
  });
});
