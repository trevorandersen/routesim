/**
 * Spanning Tree (802.1D) — convergence, loop-breaking, and the broadcast-storm
 * signal. Builds small managed-switch loops and asserts STP blocks exactly one
 * redundant port (so a cross-switch ping works without storming), that a
 * loop-free topology blocks nothing, and that disabling STP on a loop storms.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { runConsoleCommand as exec, runConsoleScript, exportTopologyScript } from "../src/commands";
import { runStpConvergence, isStpParticipant, isRootBridge } from "../src/stp";
import { getDevice } from "../src/devices";
import { runSwitchTerminalCommand, showSwitchSpanningTree } from "../src/terminal/switch";
import { linkedPortsFor, switchInterfacesWithNames, routerInterfacesWithNames } from "../src/devices";
import { isTrunkLink } from "../src/canvas";
import { processAtFirewall } from "../src/engine";
import { createArpRequest } from "../src/frame";
import { buildConfigPayload } from "../src/config";
import { normaliseConfig } from "../src/normalise";
import { registerNoopCallbacks, resetState } from "./helpers";
import { freshNameCounters } from "../src/device-registry";

beforeAll(() => registerNoopCallbacks());

function reset() {
  resetState();
  state.nameCounters = freshNameCounters();
  state.configStore = { version: 1, configs: {} } as any;
}

function managed(name: string): any {
  const sw = state.devices.find(d => d.name === name)!;
  sw.config.managed = true;
  return sw;
}

// Three managed switches wired in a triangle (the minimal representable L2 loop —
// the model rejects parallel links between one pair), with a PC on two of them.
// STP must break the loop by blocking one inter-switch port.
function switchTriangle() {
  exec("add computer PC1 at 0 0");
  exec("add computer PC2 at 400 0");
  exec("add switch SW1 at 100 0");
  exec("add switch SW2 at 300 0");
  exec("add switch SW3 at 200 200");
  managed("SW1"); managed("SW2"); managed("SW3");
  exec("ip PC1 10.0.0.1/24");
  exec("ip PC2 10.0.0.2/24");
  exec("link PC1 SW1");
  exec("link PC2 SW2");
  exec("link SW1 SW2");
  exec("link SW2 SW3");
  exec("link SW3 SW1");   // closes the triangle → loop
}

function interSwitchLinks() {
  return state.links.filter(l => {
    const a = getDevice(l.from), b = getDevice(l.to);
    return a?.type === "switch" && b?.type === "switch";
  });
}

function blockedLinks() {
  return state.links.filter(l => l.stpBlocked);
}

describe("STP — convergence", () => {
  beforeEach(reset);

  it("a managed switch participates by default; an unmanaged or disabled one does not", () => {
    exec("add switch SW1 at 0 0");
    const sw = state.devices.find(d => d.name === "SW1")!;
    expect(isStpParticipant(sw)).toBe(false);          // unmanaged
    sw.config.managed = true;
    expect(isStpParticipant(sw)).toBe(true);            // managed → on by default
    sw.config.stp = { enabled: false };
    expect(isStpParticipant(sw)).toBe(false);           // explicitly disabled
  });

  it("blocks exactly one port on a switch-triangle loop and elects a single root", () => {
    switchTriangle();
    const result = runStpConvergence();
    expect(result.participants).toBe(3);
    expect(result.roots).toBe(1);
    // One inter-switch link blocked; the other two carry the spanning tree.
    expect(blockedLinks()).toHaveLength(1);
    // Exactly one switch is the root, and it forwards on every port at cost 0.
    const roots = ["SW1", "SW2", "SW3"].map(n => getDevice(state.devices.find(d => d.name === n)!.id)!).filter(isRootBridge);
    expect(roots).toHaveLength(1);
    const root = roots[0];
    expect(root.config.stp!.rootCost).toBe(0);
    expect(Object.values(root.config.stp!.ports!).every(p => p.state === "forwarding")).toBe(true);
    // The blocked link is between the two non-root switches.
    const blocked = blockedLinks()[0];
    expect(getDevice(blocked.from)!.id === root.id || getDevice(blocked.to)!.id === root.id).toBe(false);
  });

  it("breaks the loop so a cross-switch ping succeeds without a storm", () => {
    switchTriangle();
    const r = exec("run ping PC1 PC2");
    expect(r.ok).toBe(true);
    expect((r.data as any).success).toBe(true);
    expect(state.simulation.stormDetected).toBe(false);
  });

  it("blocks nothing on a loop-free topology (every port forwards)", () => {
    exec("add computer PC1 at 0 0");
    exec("add switch SW1 at 100 0");
    exec("add switch SW2 at 300 0");
    managed("SW1"); managed("SW2");
    exec("link PC1 SW1");
    exec("link SW1 SW2");   // single link — a tree, no loop
    runStpConvergence();
    expect(blockedLinks()).toHaveLength(0);
  });

  it("storms when STP is disabled on the looped switches", () => {
    switchTriangle();
    for (const n of ["SW1", "SW2", "SW3"]) state.devices.find(d => d.name === n)!.config.stp = { enabled: false };
    exec("run ping PC1 PC2");
    expect(blockedLinks()).toHaveLength(0);          // nothing blocks → loop open
    expect(state.simulation.stormDetected).toBe(true);
  });

  it("re-converges after a structural change (shutting a forwarding link frees the blocked one)", () => {
    switchTriangle();
    runStpConvergence();
    expect(blockedLinks()).toHaveLength(1);
    // Shut a *forwarding* inter-switch link; the triangle becomes a path (no
    // loop), so the previously-blocked port re-opens — nothing should block.
    const forwarding = interSwitchLinks().find(l => !l.stpBlocked)!;
    forwarding.shutdown = true;
    runStpConvergence();
    expect(blockedLinks()).toHaveLength(0);
  });

  it("a lower bridge priority forces a specific switch to become root", () => {
    switchTriangle();
    runStpConvergence();
    // Make SW3 the root by giving it the lowest priority.
    exec("stp SW3 priority 4096");
    runStpConvergence();
    const sw3 = state.devices.find(d => d.name === "SW3")!;
    expect(isRootBridge(sw3)).toBe(true);
    expect(sw3.config.stp!.rootCost).toBe(0);
  });
});

describe("STP — console + CLI + round-trip", () => {
  beforeEach(reset);

  it("stp <switch> on/off and priority validate and mutate config", () => {
    exec("add switch SW1 at 0 0");
    managed("SW1");
    expect(exec("stp SW1 off").ok).toBe(true);
    expect(state.devices.find(d => d.name === "SW1")!.config.stp!.enabled).toBe(false);
    expect(exec("stp SW1 on").ok).toBe(true);
    expect(state.devices.find(d => d.name === "SW1")!.config.stp!.enabled).toBe(true);
    expect(exec("stp SW1 priority 8192").ok).toBe(true);
    expect(state.devices.find(d => d.name === "SW1")!.config.stp!.priority).toBe(8192);
    expect(exec("stp SW1 priority 5000").ok).toBe(false);   // not a multiple of 4096
  });

  it("run stp reports convergence headlessly; storms when STP is off on a loop", () => {
    switchTriangle();
    const r = exec("run stp");
    expect(r.ok).toBe(true);
    expect((r.data as any).success).toBe(true);
    for (const n of ["SW1", "SW2", "SW3"]) exec(`stp ${n} off`);
    const r2 = exec("run ping PC1 PC2");
    expect(state.simulation.stormDetected).toBe(true);
  });

  it("the SONiC show spanning_tree CLI reports the bridge, root, and a blocking port", () => {
    switchTriangle();
    runStpConvergence();
    const sw = state.devices.find(d => d.name === "SW1")!;
    const out = showSwitchSpanningTree(sw);
    expect(out).toContain("Bridge ID");
    expect(out).toContain("Root ID");
    // Across the three switches, exactly one port reads Blocking.
    const all = ["SW1", "SW2", "SW3"].map(n => showSwitchSpanningTree(state.devices.find(d => d.name === n)!)).join("\n");
    expect((all.match(/Blocking/g) || []).length).toBe(1);
  });

  it("config spanning_tree disable round-trips through the switch CLI", () => {
    exec("add switch SW1 at 0 0");
    managed("SW1");
    runSwitchTerminalCommand(state.devices.find(d => d.name === "SW1")!, "config spanning_tree disable");
    expect(state.devices.find(d => d.name === "SW1")!.config.stp!.enabled).toBe(false);
  });

  it("disabled STP + a non-default priority round-trip through JSON and the script export", () => {
    exec("add computer PC1 at 0 0");
    exec("add switch SW1 at 100 0");
    exec("add switch SW2 at 300 0");
    managed("SW1"); managed("SW2");
    exec("link SW1 SW2");
    exec("stp SW1 off");
    exec("stp SW2 priority 4096");
    runStpConvergence();   // writes derived fields that must NOT serialise

    // JSON round-trip: enabled/priority survive, derived fields are dropped.
    const payload = buildConfigPayload();
    const sw1 = payload.devices.find((d: any) => d.name === "SW1")!;
    const sw2 = payload.devices.find((d: any) => d.name === "SW2")!;
    expect((sw1.config as any).stp).toEqual({ enabled: false });
    expect((sw2.config as any).stp).toEqual({ enabled: true, priority: 4096 });
    expect((sw1.config as any).stp.ports).toBeUndefined();
    const re = normaliseConfig(payload as any);
    expect(re.devices.find((d: any) => d.name === "SW1")!.config.stp.enabled).toBe(false);
    expect(re.devices.find((d: any) => d.name === "SW2")!.config.stp.priority).toBe(4096);

    // Script export emits the deviations and replays them.
    const script = exportTopologyScript();
    expect(script).toContain("stp SW1 off");
    expect(script).toContain("stp SW2 priority 4096");
    reset();
    runConsoleScript(script);
    expect(state.devices.find(d => d.name === "SW1")!.config.stp!.enabled).toBe(false);
    expect(state.devices.find(d => d.name === "SW2")!.config.stp!.priority).toBe(4096);
  });

  it("a default managed switch serialises no stp block (it runs the default-on tree)", () => {
    exec("add switch SW1 at 0 0");
    managed("SW1");
    runStpConvergence();   // mutates config.stp with derived fields
    const payload = buildConfigPayload();
    const sw1 = payload.devices.find((d: any) => d.name === "SW1")!;
    expect((sw1.config as any).stp).toBeUndefined();
  });
});

// A device with explicit port numbers that skip a slot (or after deleting a
// middle link) gives linkedPortsFor a sparse array with a null gap. The render
// and routing paths must tolerate that without crashing on `p.peer`.
describe("STP — sparse port arrays don't crash the render/routing paths", () => {
  beforeEach(reset);

  it("a switch/router/firewall with a gapped port survives the lookups", () => {
    exec("add switch SW1 at 0 0");
    exec("add router R1 at 200 0");
    exec("add firewall FW1 at 400 0");
    exec("add computer PC1 at 0 100");
    exec("add computer PC2 at 0 200");
    exec("add computer PC3 at 200 100");
    exec("add computer PC4 at 400 100");
    managed("SW1");
    // Explicit ports 1 and 3 (skip 2) → a null at index 1 in linkedPortsFor.
    exec("link SW1 PC1 1 1");
    exec("link SW1 PC2 3 1");
    exec("link R1 PC3 1 1");
    exec("link R1 SW1 3 4");
    exec("link FW1 PC4 1 1");
    exec("link FW1 SW1 3 5");

    const sw1 = state.devices.find(d => d.name === "SW1")!;
    const r1 = state.devices.find(d => d.name === "R1")!;
    const fw1 = state.devices.find(d => d.name === "FW1")!;
    // Confirm the array really is sparse (the precondition for the bug).
    expect(linkedPortsFor(sw1.id).some(p => p == null)).toBe(true);

    // None of these may throw on the null gap.
    expect(() => switchInterfacesWithNames(sw1)).not.toThrow();
    expect(() => routerInterfacesWithNames(r1)).not.toThrow();
    expect(() => isTrunkLink(sw1, state.devices.find(d => d.name === "PC2")!)).not.toThrow();
    expect(() => runStpConvergence()).not.toThrow();
    expect(() => processAtFirewall(fw1, createArpRequest("02:00:00:00:00:01", "1.1.1.1", "1.1.1.2"), null)).not.toThrow();
    // The router still enumerates its two real interfaces (the gap is skipped).
    expect(routerInterfacesWithNames(r1).filter((i: any) => i.peer).length).toBe(2);
  });
});
