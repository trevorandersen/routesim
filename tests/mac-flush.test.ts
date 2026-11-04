/**
 * Learned-forwarding invalidation — a switch's (or AP's) MAC table is derived
 * from the cabling it learned over, so it must be flushed when that cabling
 * changes. Implicit ports are numbered densely, so deleting one cable renames
 * every later port; a stale entry then points at a missing or re-peered port
 * (the R1 bug: `Drop … — dest port is ingress` with warm ARP caches, so no
 * broadcast ever re-learned the moved host).
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state, undo, redo } from "../src/state";
import { runConsoleCommand as exec, runConsoleScript } from "../src/commands";
import { linksChanged } from "../src/state";
import { processAtSwitch } from "../src/engine";
import { createArpRequest } from "../src/frame";
import { registerNoopCallbacks, resetState } from "./helpers";
import { freshNameCounters } from "../src/device-registry";
import type { Device } from "../src/types";

beforeAll(() => registerNoopCallbacks());

function reset() {
  resetState();
  state.nameCounters = freshNameCounters();
}

const dev = (name: string): Device => state.devices.find(d => d.name === name)!;
const macs = (name: string) => (dev(name).config?.macTable || []).map(e => e.macAddress);

// SW-1 with three hosts on implicit (dense) ports: PC1=Ethernet1, PC2=Ethernet2, PC3=Ethernet3.
function threeHostLan() {
  runConsoleScript(`
    add switch SW-1 at 0 0
    add computer PC1 at -200 200
    add computer PC2 at 0 200
    add computer PC3 at 200 200
    link SW-1 PC1
    link SW-1 PC2
    link SW-1 PC3
    ip PC1 10.0.0.1/24
    ip PC2 10.0.0.2/24
    ip PC3 10.0.0.3/24
  `);
}

describe("MAC table invalidation on link change", () => {
  beforeEach(reset);

  it("unlinking a cable that renumbers later ports does not strand unicast (review R1)", () => {
    threeHostLan();
    const first = exec("run ping PC2 PC3");
    expect(first.ok).toBe(true);
    expect((first.data as any).success).toBe(true);
    expect(macs("SW-1").length).toBeGreaterThan(0);

    // PC1's cable goes: PC2/PC3 slide from Ethernet2/3 down to Ethernet1/2.
    expect(exec("unlink SW-1 PC1").ok).toBe(true);
    expect(macs("SW-1")).toEqual([]);   // the stale port names were flushed

    const second = exec("run ping PC2 PC3");
    expect((second.data as any).success).toBe(true);
    expect(state.simulation.log.some(l => /dest port is ingress/.test(l.summary))).toBe(false);
  });

  it("ping, delete a cable, re-cable the host on a different port, ping again", () => {
    threeHostLan();
    expect((exec("run ping PC1 PC3").data as any).success).toBe(true);
    // Move PC1 from Ethernet1 to a pinned Ethernet5 (and PC2/PC3 renumber).
    expect(exec("unlink SW-1 PC1").ok).toBe(true);
    expect(exec("link SW-1 PC1 5 1").ok).toBe(true);
    const r = exec("run ping PC1 PC3");
    expect((r.data as any).success).toBe(true);
    const r2 = exec("run ping PC3 PC1");
    expect((r2.data as any).success).toBe(true);
  });

  it("shut / no shut and device removal flush the switch", () => {
    threeHostLan();
    exec("run ping PC2 PC3");
    expect(macs("SW-1").length).toBeGreaterThan(0);
    exec("shut SW-1 PC1");
    expect(macs("SW-1")).toEqual([]);
    exec("noshut SW-1 PC1");
    exec("run ping PC2 PC3");
    expect(macs("SW-1").length).toBeGreaterThan(0);
    exec("remove PC1");
    expect(macs("SW-1")).toEqual([]);
    expect((exec("run ping PC2 PC3").data as any).success).toBe(true);
  });

  it("flushes every bridge in the L2 domain, but not across a router", () => {
    // PC-A — SW-A — SW-B — R1 — SW-C — PC-C. A change at SW-B's far end
    // invalidates SW-A too (a moved host is reached through it), not SW-C.
    runConsoleScript(`
      add switch SW-A at 0 0
      add switch SW-B at 200 0
      add router R1 at 400 0
      add switch SW-C at 600 0
      add computer PC-A at 0 200
      add computer PC-B at 200 200
      add computer PC-C at 600 200
      link SW-A PC-A
      link SW-A SW-B
      link SW-B PC-B
      link SW-B R1
      link R1 SW-C
      link SW-C PC-C
    `);
    const fill = (name: string) => { (dev(name).config as any).macTable = [{ macAddress: "02:00:00:00:00:99", port: "Ethernet1", type: "DYNAMIC", vlan: "" }]; };
    ["SW-A", "SW-B", "SW-C"].forEach(fill);
    exec("unlink SW-B PC-B");
    expect(macs("SW-A")).toEqual([]);
    expect(macs("SW-B")).toEqual([]);
    expect(macs("SW-C")).toEqual(["02:00:00:00:00:99"]);   // behind R1: a different broadcast domain
  });

  it("keeps a static entry (only learned DYNAMIC entries age out)", () => {
    threeHostLan();
    (dev("SW-1").config as any).macTable = [
      { macAddress: "02:00:00:00:00:01", port: "Ethernet1", type: "STATIC", vlan: "" },
      { macAddress: "02:00:00:00:00:02", port: "Ethernet2", type: "DYNAMIC", vlan: "" },
    ];
    linksChanged([dev("SW-1").id]);
    expect(macs("SW-1")).toEqual(["02:00:00:00:00:01"]);
  });

  it("undo and redo flush learned entries (the snapshot's table is not trusted)", () => {
    threeHostLan();
    exec("run ping PC2 PC3");
    exec("unlink SW-1 PC1");
    exec("run ping PC2 PC3");   // relearned under the renumbered ports
    expect(macs("SW-1").length).toBeGreaterThan(0);
    undo();                     // PC1's cable is back: PC2/PC3 are Ethernet2/3 again
    expect(macs("SW-1")).toEqual([]);
    expect((exec("run ping PC2 PC3").data as any).success).toBe(true);
    redo();
    expect(macs("SW-1")).toEqual([]);
  });

  it("a stale entry that survives anyway is flooded with a stated reason, not dropped", () => {
    threeHostLan();
    const sw = dev("SW-1");
    const pc2 = dev("PC2");
    const pc3 = dev("PC3");
    // Hand-plant an entry for PC3 on a port that has no cable (Ethernet7).
    (sw.config as any).macTable = [{ macAddress: pc3.config!.macAddress, port: "Ethernet7", type: "DYNAMIC", vlan: "" }];
    state.simulation.log = [];
    const frame = { ...createArpRequest(pc2.config!.macAddress!, "10.0.0.2", "10.0.0.3"), dstMac: pc3.config!.macAddress! };
    const out = processAtSwitch(sw, frame, pc2.id);
    expect(out.map(o => o.toDeviceId).sort()).toEqual([dev("PC1").id, pc3.id].sort());
    const text = state.simulation.log.map(l => l.summary).join("\n");
    expect(text).toMatch(/stale/i);
    expect(text).not.toMatch(/dest port is ingress/);
    // The stale entry is forgotten; the source is learned fresh.
    expect(macs("SW-1")).not.toContain(pc3.config!.macAddress);
  });
});
