/**
 * Tutorial mode — guards the scripted demo from drifting. Runs the tutorial's
 * own step actions (the real console commands it fires under the faux cursor),
 * skipping only the animated ping, and asserts the build is the intended
 * two-LAN + router topology that pings across the gateway. If a command verb is
 * renamed or the sequence breaks, this fails instead of the demo silently dying.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { state, undo, redo, undoBlockReason } from "../src/state";
import { runConsoleCommand as exec, runConsoleScript } from "../src/commands";
import { buildSteps, startTutorial, exitTutorial, tutorialControls } from "../src/tutorial";
import { handleGlobalKeydown } from "../src/ui";
import { runImportedScript } from "../src/io";
import { registerNoopCallbacks, resetState } from "./helpers";
import { freshNameCounters } from "../src/device-registry";

beforeAll(() => registerNoopCallbacks());

beforeEach(() => {
  resetState();
  state.nameCounters = freshNameCounters();
  state.configStore = { version: 1, configs: {} } as any;
});

describe("tutorial — the scripted demo builds a working network", () => {
  it("running the step actions yields a routable two-LAN topology", () => {
    const steps = buildSteps();
    // Fire every step's real action except the animated ping (waitForSim) — the
    // test harness's synchronous rAF can't drive an animated run.
    for (const step of steps) {
      if (step.waitForSim) continue;
      step.action?.();
    }

    const byName = (n: string) => state.devices.find(d => d.name === n);
    expect(state.devices).toHaveLength(5);
    expect(state.links).toHaveLength(4);
    expect(byName("R1")?.type).toBe("router");
    expect(byName("SW1")?.type).toBe("switch");
    expect(byName("PC-A")?.config.ipv4Address).toBe("192.168.1.10");
    expect(byName("PC-A")?.config.gatewayIpv4Address).toBe("192.168.1.1");
    expect(byName("PC-B")?.config.ipv4Address).toBe("192.168.2.10");
    const r1 = byName("R1")!;
    const ifaceIps = (r1.config.interfaces || []).map((i: any) => i.ipv4Address).sort();
    expect(ifaceIps).toEqual(["192.168.1.1", "192.168.2.1"]);

    // The headless equivalent of the demo's finale: PC-A reaches PC-B across R1.
    const ping = exec("run ping PC-A PC-B");
    expect(ping.ok).toBe(true);
    expect((ping.data as any).success).toBe(true);
  });
});

// R43: the tutorial takes one snapshot of the learner's network and runs its
// demo as a composite change. An undo mid-demo popped that snapshot back onto
// the canvas, and the next Back/Replay then cleared it with pushes suppressed —
// the learner's work was in neither undo nor redo.
describe("tutorial — the learner's own network survives the demo", () => {
  const names = () => state.devices.map(d => d.name).sort();
  const ctrl = (key: string, extra: object = {}) => {
    let prevented = false;
    const event = { key, ctrlKey: true, metaKey: false, shiftKey: false, target: {}, preventDefault() { prevented = true; }, ...extra } as any;
    handleGlobalKeydown(event);
    return prevented;
  };

  function learnerNetwork(): string[] {
    runConsoleScript(`
      add computer Mine-PC at 0 0
      add switch Mine-SW at 200 0
      link Mine-PC Mine-SW
      ip Mine-PC 10.9.9.9/24
    `);
    return names();
  }

  // The play loop is async (cursor glides on timers); every test ends the
  // tutorial so the loop aborts at its next gate.
  afterEach(() => { exitTutorial(); });

  it("starting the tutorial clears the canvas and freezes undo/redo", () => {
    learnerNetwork();
    expect(undoBlockReason()).toBeNull();
    startTutorial();
    expect(state.tutorialActive).toBe(true);
    expect(names().some(n => n.startsWith("Mine-"))).toBe(false);
    expect(undoBlockReason()).toContain("tutorial");
    const depth = state.undoStack.length;
    undo();
    redo();
    expect(state.undoStack.length).toBe(depth);                       // the stack did not move
    expect(names().some(n => n.startsWith("Mine-"))).toBe(false);     // nothing was restored under the demo
  });

  it("Ctrl+Z then Replay no longer destroys the learner's network (the reported sequence)", () => {
    const mine = learnerNetwork();
    startTutorial();
    expect(ctrl("z")).toBe(true);                    // swallowed, with the reason on the status line
    tutorialControls.replay();                       // clears the canvas with undo pushes suppressed
    tutorialControls.back();
    exitTutorial();
    expect(state.tutorialActive).toBe(false);
    undo();                                          // "one Undo brings your network back"
    expect(names()).toEqual(mine);
    expect(state.devices.find(d => d.name === "Mine-PC")!.config!.ipv4Address).toBe("10.9.9.9");
  });

  it("the editing shortcuts are gated while the tutorial plays", () => {
    learnerNetwork();
    startTutorial();
    exec("add computer Demo-PC at 0 0");
    exec("select Demo-PC");
    handleGlobalKeydown({ key: "Delete", target: {}, preventDefault() {} } as any);
    expect(names()).toContain("Demo-PC");            // Delete did not reach the demo network
    const tool = state.tool;
    handleGlobalKeydown({ key: "r", target: {}, preventDefault() {} } as any);
    expect(state.tool).toBe(tool);                   // nor did a tool shortcut
    expect(ctrl("y")).toBe(true);
    expect(ctrl("z", { shiftKey: true })).toBe(true);
  });

  it("the console's undo and redo say why they are refused", () => {
    learnerNetwork();
    startTutorial();
    const u = exec("undo");
    expect(u.ok).toBe(false);
    expect(u.output.join(" ")).toContain("tutorial");
    expect(exec("redo").ok).toBe(false);
  });

  it("a script imported mid-demo does not end the tutorial's composite change", () => {
    const mine = learnerNetwork();
    startTutorial();
    const depth = state.undoStack.length;
    runImportedScript("add computer Imported at 50 50");
    expect(state.isApplyingCompositeChange).toBe(true);
    exec("add computer After at 90 90");             // would push an undo point if the flag had been cleared
    expect(state.undoStack.length).toBe(depth);
    exitTutorial();
    undo();
    expect(names()).toEqual(mine);
  });

  it("exit puts the learner's snapshot back if the stack was emptied anyway", () => {
    const mine = learnerNetwork();
    startTutorial();
    state.undoStack = [];                            // simulate any path that bypassed the freeze
    exitTutorial();
    undo();
    expect(names()).toEqual(mine);
  });

  it("undo and redo work normally again after exit", () => {
    learnerNetwork();
    startTutorial();
    exitTutorial();
    expect(undoBlockReason()).toBeNull();
    expect(exec("undo").ok).toBe(true);
    expect(exec("redo").ok).toBe(true);
  });
});
