/**
 * Derived state is recomputed, never trusted or stored (review R58).
 *
 * RIP's learned routes, the spanning tree's roles and a bridge's dynamic MAC
 * entries are derived from the topology. Two things went wrong with them:
 *   - the router's show commands printed `learnedRoutes` as stored — dead paths
 *     after an unlink, and no RIP routes at all until the first simulation;
 *   - undo snapshots stored them, so two snapshots of the same network compared
 *     unequal and the docs' "snapshots strip derived data" was not true.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { state, networkSnapshot, pushUndo, undo, redo, registerCallbacks } from "../src/state";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { runRipConvergence, runStpConvergence, runSimulationHeadless } from "../src/engine";
import { buildPingEvents } from "../src/simulation";
import { showRouterRoute, showRouterRouteRip, showRouterRip, showRouterRipRoutes, runRouterTerminalCommand } from "../src/terminal";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());
afterAll(() => registerNoopCallbacks());
beforeEach(() => resetState());

const dev = (name: string) => state.devices.find(d => d.name === name)!;

// R1 ── R2 over a /30, a LAN behind each, RIP on both.
function ripPair(): void {
  runConsoleScript(`
    add computer PC-A at -600 0
    add router R1 at -400 0
    add router R2 at -100 0
    add computer PC-B at 100 0
    link PC-A R1
    link R1 R2
    link PC-B R2
    ip PC-A 192.168.1.10/24
    gateway PC-A 192.168.1.1
    interface R1 PC-A ip 192.168.1.1/24
    interface R1 R2 ip 10.0.12.1/30
    interface R2 R1 ip 10.0.12.2/30
    interface R2 PC-B ip 192.168.2.1/24
    ip PC-B 192.168.2.10/24
    gateway PC-B 192.168.2.1
    cli R1 enable
    cli R1 configure terminal
    cli R1 router rip
    cli R1 network 192.168.1.0/24
    cli R1 network 10.0.12.0/30
    cli R1 end
    cli R2 enable
    cli R2 configure terminal
    cli R2 router rip
    cli R2 network 192.168.2.0/24
    cli R2 network 10.0.12.0/30
    cli R2 end
  `);
}

describe("router show commands converge RIP first (R58)", () => {
  it("show ip route lists RIP routes before any simulation has run", () => {
    ripPair();
    expect(dev("R1").config!.rip!.learnedRoutes).toEqual([]);   // nothing has converged yet
    expect(showRouterRoute(dev("R1"))).toContain("R>* 192.168.2.0/24 via 10.0.12.2");
  });

  it("show ip route rip, show ip rip and show ip rip status agree with it", () => {
    ripPair();
    expect(showRouterRouteRip(dev("R1"))).toContain("192.168.2.0/24");
    dev("R1").config!.rip!.learnedRoutes = [];
    expect(showRouterRipRoutes(dev("R1"))).toContain("192.168.2.0/24");
    dev("R1").config!.rip!.learnedRoutes = [];
    expect(showRouterRip(dev("R1"))).toContain("Learned routes: 1");
  });

  it("an unlinked path is gone from the table at once, with no run in between", () => {
    ripPair();
    runRipConvergence();
    expect(dev("R1").config!.rip!.learnedRoutes.length).toBe(1);
    exec("unlink R1 R2");
    expect(showRouterRoute(dev("R1"))).not.toContain("192.168.2.0/24");
    expect(showRouterRouteRip(dev("R1"))).toContain("No RIP routes");
    expect(showRouterRip(dev("R1"))).toContain("Learned routes: 0");
  });

  it("a shut cable, a powered-off neighbour and a removed network statement all show immediately", () => {
    ripPair();
    exec("shut R1 R2");
    expect(showRouterRoute(dev("R1"))).not.toContain("192.168.2.0/24");
    exec("noshut R1 R2");
    expect(showRouterRoute(dev("R1"))).toContain("192.168.2.0/24");
    dev("R2").poweredOff = true;
    expect(showRouterRoute(dev("R1"))).not.toContain("192.168.2.0/24");
    dev("R2").poweredOff = false;
    dev("R2").config!.rip!.networks = ["10.0.12.0/30"];   // no longer advertising its LAN
    expect(showRouterRoute(dev("R1"))).not.toContain("192.168.2.0/24");
  });

  it("the shell's `show ip route` and `do show ip route` use the same fresh table", () => {
    ripPair();
    const r1 = dev("R1");
    state.terminal = { deviceId: r1.id, mode: "privileged", interfacePeerId: null, interfaceVlanTag: null, lines: [], history: [], historyIndex: -1 } as any;
    const run = (c: string) => { const n = state.terminal.lines.length; runRouterTerminalCommand(r1, c); return state.terminal.lines.slice(n).map((l: any) => l.text).join("\n"); };
    expect(run("show ip route")).toContain("R>* 192.168.2.0/24");
    run("configure terminal");
    exec("unlink R1 R2");
    expect(run("do show ip route")).not.toContain("192.168.2.0/24");
  });

  it("clear ip rip database is not an undo point, and the routes are relearned", () => {
    ripPair();
    const r1 = dev("R1");
    runRipConvergence();
    state.terminal = { deviceId: r1.id, mode: "privileged", interfacePeerId: null, interfaceVlanTag: null, lines: [], history: [], historyIndex: -1 } as any;
    const undoPoints = state.undoStack.length;
    runRouterTerminalCommand(r1, "clear ip rip database");
    expect(r1.config!.rip!.learnedRoutes).toEqual([]);
    expect(state.undoStack.length).toBe(undoPoints);
    expect(showRouterRoute(r1)).toContain("192.168.2.0/24");
  });
});

describe("undo snapshots carry no derived state (R58)", () => {
  // Three managed switches in a triangle (a loop STP must break), a PC on two of them.
  function loop(): void {
    runConsoleScript(`
      add switch SW1 at 0 0
      add switch SW2 at 300 0
      add switch SW3 at 150 200
      managed SW1 on
      managed SW2 on
      managed SW3 on
      link SW1 SW2
      link SW2 SW3
      add computer PC1 at -200 0
      add computer PC2 at 500 0
      link PC1 SW1
      link PC2 SW2
      ip PC1 10.0.0.1/24
      ip PC2 10.0.0.2/24
    `);
    exec("link SW3 SW1");                     // closes the loop — the last undo point
  }

  it("RIP learned routes are not stored, and converging leaves the snapshot unchanged", () => {
    ripPair();
    const before = networkSnapshot();
    runRipConvergence();
    expect(dev("R1").config!.rip!.learnedRoutes.length).toBe(1);
    expect(networkSnapshot()).toBe(before);
    const stored = JSON.parse(before).devices.find((d: any) => d.name === "R1");
    expect(stored.config.rip).toEqual({ enabled: true, networks: ["192.168.1.0/24", "10.0.12.0/30"], passiveInterfaces: [], learnedRoutes: [] });
  });

  it("the live device is not touched by taking a snapshot", () => {
    ripPair();
    runRipConvergence();
    networkSnapshot();
    expect(dev("R1").config!.rip!.learnedRoutes.length).toBe(1);
  });

  it("spanning-tree roles and the per-link block are not stored", () => {
    loop();
    runStpConvergence();
    expect(state.links.some(l => l.stpBlocked)).toBe(true);
    expect(dev("SW1").config!.stp!.ports).toBeDefined();
    const snap = JSON.parse(networkSnapshot());
    for (const d of snap.devices.filter((d: any) => d.type === "switch")) {
      expect(Object.keys(d.config.stp ?? {}).filter(k => !["enabled", "priority"].includes(k))).toEqual([]);
    }
    expect(snap.links.some((l: any) => "stpBlocked" in l)).toBe(false);
    expect(snap.links.some((l: any) => "frameHistory" in l)).toBe(false);
  });

  it("STP configuration (enabled, priority) is stored", () => {
    loop();
    exec("stp SW1 priority 4096");
    exec("stp SW2 off");
    runStpConvergence();
    const snap = JSON.parse(networkSnapshot());
    const stpOf = (name: string) => snap.devices.find((d: any) => d.name === name).config.stp;
    expect(stpOf("SW1").priority).toBe(4096);
    expect(stpOf("SW2").enabled).toBe(false);
  });

  it("dynamic MAC entries are not stored; static ones are", () => {
    loop();
    const sw1 = dev("SW1");
    sw1.config!.macTable = [
      { vlan: "1", macAddress: "02:00:00:00:00:aa", type: "DYNAMIC", port: "Ethernet2" },
      { vlan: "1", macAddress: "02:00:00:00:00:bb", type: "STATIC", port: "Ethernet2" },
    ];
    const stored = JSON.parse(networkSnapshot()).devices.find((d: any) => d.name === "SW1");
    expect(stored.config.macTable).toEqual([{ vlan: "1", macAddress: "02:00:00:00:00:bb", type: "STATIC", port: "Ethernet2" }]);
    expect(sw1.config!.macTable!.length).toBe(2);
  });

  it("a headless run that learns only MAC entries leaves the snapshot equal", () => {
    loop();
    runStpConvergence();
    exec("run ping PC1 PC2");                 // fills the ARP caches (learnt state — kept)
    const before = networkSnapshot();
    for (const d of state.devices) if (d.type === "switch") d.config!.macTable = [];
    const setup = buildPingEvents(dev("PC1"), "10.0.0.2");
    expect(typeof setup).not.toBe("string");
    expect(runSimulationHeadless(setup as any, dev("PC1").id, "10.0.0.2", "ping").success).toBe(true);
    expect(dev("SW1").config!.macTable!.length).toBeGreaterThan(0);
    expect(networkSnapshot()).toBe(before);
  });

  it("what a device learnt from traffic (an ARP cache) is still stored and undone", () => {
    loop();
    pushUndo();
    exec("run ping PC1 PC2");
    expect(dev("PC1").config!.arpTable!.length).toBe(1);
    expect(JSON.parse(networkSnapshot()).devices.find((d: any) => d.name === "PC1").config.arpTable.length).toBe(1);
    undo();
    expect(dev("PC1").config!.arpTable ?? []).toEqual([]);
  });

  it("undo and redo recompute the spanning tree for the restored cabling before the panel renders", () => {
    const seen: string[] = [];
    registerCallbacks({
      render: () => {}, syncTerminal: () => {}, resizeCanvas: () => {}, syncScenarioPanel: () => {}, syncCoordReadout: () => {},
      syncOptionControls: () => {}, syncSimLog: () => {},
      recomputeStp: () => { runStpConvergence(); seen.push("stp"); },
      // What the inspector would draw: the tree must already be current.
      syncPanel: () => { seen.push(`panel:${state.links.filter(l => l.stpBlocked).length}`); },
    });
    loop();                                   // the closing cable was the last undo point
    expect(state.links.filter(l => l.stpBlocked).length).toBe(1);
    seen.length = 0;
    undo();                                   // the loop is open again: nothing blocked
    expect(state.links.some(l => l.stpBlocked)).toBe(false);
    expect(dev("SW1").config!.stp!.ports).toBeDefined();
    expect(seen.indexOf("stp")).toBeLessThan(seen.findIndex(s => s.startsWith("panel:")));
    expect(seen.filter(s => s.startsWith("panel:"))).toEqual(["panel:0"]);
    seen.length = 0;
    redo();                                   // the loop is back, and blocked again
    expect(state.links.filter(l => l.stpBlocked).length).toBe(1);
    expect(seen.filter(s => s.startsWith("panel:"))).toEqual(["panel:1"]);
  });
});
