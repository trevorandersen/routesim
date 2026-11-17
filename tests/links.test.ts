/**
 * Nameable links: the derived default ("A ↔ B", follows device renames), the
 * user-given override, config round-trips, and the surfaces that show it.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { runSimulationHeadless } from "../src/engine";
import { buildPingEvents } from "../src/simulation";
import { linkName, deleteLink, deleteSelection, addLink, toggleLinkShutdown } from "../src/devices";
import { linkStatusLabel, linkLabelText, placeLinkLabel, deviceFootprint } from "../src/canvas";
import type { Box } from "../src/canvas";
import { buildConfigPayload, parseConfig } from "../src/config";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());

function pairTopology() {
  runConsoleScript(`
    add computer PC1 at 0 0
    add switch SW at 200 0
    link PC1 SW
  `);
  return state.links[0];
}

describe("links — naming", () => {
  beforeEach(() => resetState());

  it("defaults to the endpoint combo and follows device renames", () => {
    const link = pairTopology();
    expect(linkName(link)).toBe("PC1 ↔ SW");
    exec("rename PC1 WS-7");
    expect(linkName(link)).toBe("WS-7 ↔ SW");
  });

  it("a user-given name overrides the default", () => {
    const link = pairTopology();
    link.name = "uplink-1";
    expect(linkName(link)).toBe("uplink-1");
    delete link.name;
    expect(linkName(link)).toBe("PC1 ↔ SW");
  });

  it("round-trips through config save/load", () => {
    const link = pairTopology();
    link.name = "uplink-1";
    const parsed = parseConfig(JSON.stringify(buildConfigPayload()));
    expect(parsed.links[0].name).toBe("uplink-1");
    // Unnamed links stay unnamed (no name key serialised).
    delete link.name;
    const parsed2 = parseConfig(JSON.stringify(buildConfigPayload()));
    expect(parsed2.links[0].name).toBeUndefined();
  });

  it("`list links` shows the link name", () => {
    const link = pairTopology();
    expect(exec("list links").output).toEqual(["PC1 ↔ SW"]);
    link.name = "uplink-1";
    expect(exec("list links").output).toEqual(["uplink-1"]);
  });
});

describe("links — deletion", () => {
  beforeEach(() => resetState());

  it("deleteLink removes the link and clears the selection", () => {
    const link = pairTopology();
    state.selectedLinkId = link.id;
    expect(deleteLink(link.id)).toBe(true);
    expect(state.links).toHaveLength(0);
    expect(state.selectedLinkId).toBeNull();
  });

  it("deleteLink is undoable and reports a miss", () => {
    const link = pairTopology();
    expect(deleteLink("no-such-link")).toBe(false);
    expect(state.links).toHaveLength(1);
    deleteLink(link.id);
    expect(state.links).toHaveLength(0);
    exec("undo");
    expect(state.links).toHaveLength(1);
  });

  it("deleteSelection deletes a selected link (the Delete key / ribbon path)", () => {
    const link = pairTopology();
    state.selectedId = null;
    state.selectedLinkId = link.id;
    deleteSelection();
    expect(state.links).toHaveLength(0);
  });
});

describe("links — single NIC per host", () => {
  beforeEach(() => resetState());

  function twoSwitches() {
    runConsoleScript(`
      add computer PC1 at 0 0
      add switch SW1 at 200 0
      add switch SW2 at 400 0
      link PC1 SW1
    `);
    return state.devices.find(d => d.name === "PC1")!;
  }

  it("a host refuses a second cable", () => {
    const pc1 = twoSwitches();
    const sw2 = state.devices.find(d => d.name === "SW2")!;
    addLink(pc1.id, sw2.id);
    // Still just the first link; PC1 is on SW1 only.
    expect(state.links).toHaveLength(1);
    expect(state.links.some(l => l.from === pc1.id && l.to === sw2.id || l.to === pc1.id && l.from === sw2.id)).toBe(false);
  });

  it("the console `link` command enforces it too", () => {
    twoSwitches();
    runConsoleScript(`link PC1 SW2`);
    expect(state.links).toHaveLength(1);
  });

  it("switches and routers may hold many cables", () => {
    runConsoleScript(`
      add switch SW at 0 0
      add computer PC1 at 200 0
      add computer PC2 at 200 100
      add router R1 at 400 0
      link PC1 SW
      link PC2 SW
      link R1 SW
    `);
    expect(state.links).toHaveLength(3); // the switch holds three; each PC one
  });
});

describe("links — admin status (shutdown)", () => {
  beforeEach(() => resetState());

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
    const sw = state.devices.find(d => d.name === "SW")!;
    const pc2 = state.devices.find(d => d.name === "PC2")!;
    return state.links.find(l => (l.from === pc2.id && l.to === sw.id) || (l.from === sw.id && l.to === pc2.id))!;
  }

  it("a shut link carries no traffic; noshut restores it", () => {
    const link = lan();
    expect(exec("run ping PC1 192.168.1.20").ok).toBe(true);   // reachable to start
    exec("shut PC2 SW");
    expect(link.shutdown).toBe(true);
    expect(exec("run ping PC1 192.168.1.20").ok).toBe(false);  // its only path is down
    exec("noshut PC2 SW");
    expect(link.shutdown).toBeUndefined();
    expect(exec("run ping PC1 192.168.1.20").ok).toBe(true);   // back up
  });

  it("shut state round-trips through config and the script export", () => {
    const link = lan();
    link.shutdown = true;
    const parsed = parseConfig(JSON.stringify(buildConfigPayload()));
    expect(parsed.links.find((l: any) => l.shutdown)).toBeDefined();
    expect(exec("export").data).toContain("shut PC2 SW");
  });

  it("shut/noshut report a missing link", () => {
    runConsoleScript(`add computer PC1 at 0 0\nadd computer PC2 at 200 0`);
    expect(exec("shut PC1 PC2").ok).toBe(false);
  });

  it("toggleLinkShutdown flips state and selects the link (the canvas dbl-click path)", () => {
    const link = lan();
    expect(link.shutdown).toBeUndefined();
    expect(toggleLinkShutdown(link.id)!.shutdown).toBe(true);
    expect(state.selectedLinkId).toBe(link.id);
    expect(toggleLinkShutdown(link.id)!.shutdown).toBeUndefined(); // back up
    expect(toggleLinkShutdown("no-such-link")).toBeNull();
  });
});

describe("links — bandwidth / latency / loss", () => {
  beforeEach(() => resetState());

  it("round-trip through config; non-positive values are dropped", () => {
    const link = pairTopology();
    link.bandwidth = 100; link.latency = 20; link.loss = 5;
    const parsed = parseConfig(JSON.stringify(buildConfigPayload())).links[0];
    expect(parsed).toMatchObject({ bandwidth: 100, latency: 20, loss: 5 });
    // loss is capped at 100; zero/blank values are omitted entirely.
    link.loss = 250; link.bandwidth = 0; delete link.latency;
    const p2 = parseConfig(JSON.stringify(buildConfigPayload())).links[0];
    expect(p2.loss).toBe(100);
    expect(p2.bandwidth).toBeUndefined();
    expect(p2.latency).toBeUndefined();
  });

  it("a headless run notes a lossy link once instead of silently ignoring it", () => {
    // Loss is animated-only (checks stay deterministic) — the divergence must
    // be SURFACED: a headless run crossing a lossy link logs one note per link.
    runConsoleScript(`
      add computer PC1 at 0 0
      add computer PC2 at 300 0
      link PC1 PC2
      ip PC1 192.168.1.10/24
      ip PC2 192.168.1.20/24
    `);
    state.links[0].loss = 40;
    const pc1 = state.devices.find(d => d.name === "PC1")!;
    const r = runSimulationHeadless(buildPingEvents(pc1, "192.168.1.20") as any, pc1.id, "192.168.1.20", "ping");
    expect(r.success).toBe(true);   // deterministic — loss never drops headless frames
    const notes = state.simulation.log.filter(l => l.action.includes("not applied in this headless run"));
    expect(notes.length).toBe(1);   // once per link per run, though several frames crossed it
  });
});

describe("link state carries a non-colour marker (R54 — perceivable by everyone)", () => {
  it("every colour-only state yields a text marker", () => {
    expect(linkStatusLabel({ shut: true })).toEqual({ text: "down", tone: "danger" });
    expect(linkStatusLabel({ unauth: true })).toEqual({ text: "auth failed", tone: "danger" });
    expect(linkStatusLabel({ macsec: "failed" })).toEqual({ text: "MACsec ✗", tone: "danger" });
    expect(linkStatusLabel({ macsec: "secured" })).toEqual({ text: "MACsec ✓", tone: "secure" });
    expect(linkStatusLabel({ blocked: true })).toEqual({ text: "STP blocked", tone: "stp" });
  });

  it("an open/healthy link has no marker", () => {
    expect(linkStatusLabel({})).toBeNull();
    expect(linkStatusLabel({ macsec: "open" })).toBeNull();
  });

  it("precedence matches the link colour: danger before stp before secured", () => {
    expect(linkStatusLabel({ shut: true, macsec: "secured" })).toEqual({ text: "down", tone: "danger" });
    expect(linkStatusLabel({ blocked: true, macsec: "failed" })).toEqual({ text: "MACsec ✗", tone: "danger" });
    expect(linkStatusLabel({ blocked: true, macsec: "secured" })).toEqual({ text: "STP blocked", tone: "stp" });
  });
});

describe("latency and loss on the canvas label (text, not colour)", () => {
  it("a link with neither, no name and no state marker has no label (drawn as it always was)", () => {
    expect(linkLabelText({})).toBe("");
    expect(linkLabelText({ latency: 0, loss: 0 })).toBe("");
  });

  it("the name and the state marker are kept as before", () => {
    expect(linkLabelText({ name: "WAN" })).toBe("WAN");
    expect(linkLabelText({ name: "WAN" }, "down")).toBe("WAN · down");
    expect(linkLabelText({}, "STP blocked")).toBe("STP blocked");
  });

  it("a non-default latency and loss join the label, after the name and before the marker", () => {
    expect(linkLabelText({ name: "WAN", latency: 40, loss: 5 })).toBe("WAN · 40 ms · 5% loss");
    expect(linkLabelText({ name: "WAN", latency: 40, loss: 5 }, "down")).toBe("WAN · 40 ms · 5% loss · down");
    expect(linkLabelText({ latency: 40 })).toBe("40 ms");          // an unnamed link shows just this part
    expect(linkLabelText({ loss: 12.5 })).toBe("12.5% loss");
  });

  it("numbers are shown readably and loss never above 100%", () => {
    expect(linkLabelText({ latency: 2.5 })).toBe("2.5 ms");
    expect(linkLabelText({ latency: 0.1 + 0.2 })).toBe("0.3 ms");
    expect(linkLabelText({ loss: 250 })).toBe("100% loss");
  });

  it("a link set with linkset carries its latency and loss into the label", () => {
    resetState();
    runConsoleScript(`
      add computer PC1
      add computer PC2
      link PC1 PC2
      linkset PC1 PC2 latency 40
      linkset PC1 PC2 loss 5
    `);
    expect(linkLabelText(state.links[0])).toBe("40 ms · 5% loss");
    runConsoleScript("linkset PC1 PC2 latency 0");
    expect(linkLabelText(state.links[0])).toBe("5% loss");
  });
});

// On a short link the label used to run under an endpoint device (devices are
// drawn after links), and a clipped number reads as another number: "40 ms ·
// 5% loss" between PC-A1 and its switch showed as "0 ms · 5% loss".
describe("a link label stays clear of the devices at its ends", () => {
  beforeEach(() => { resetState(); registerNoopCallbacks(); });

  const labelBox = (at: { x: number; y: number }, width: number): Box => ({ x: at.x - width / 2, y: at.y - 12, w: width, h: 12 });
  const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const dev = (name: string) => state.devices.find(d => d.name === name)!;
  // The label's anchor for the cable between two devices, as drawLink places it.
  function placed(a: string, b: string, width: number) {
    const from = dev(a), to = dev(b);
    const obstacles = [...deviceFootprint(from), ...deviceFootprint(to)];
    const at = placeLinkLabel((from.x + to.x) / 2, (from.y + to.y) / 2, width, obstacles);
    return { at, obstacles, home: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - 8 } };
  }

  it("with room at the midpoint it sits where it always did", () => {
    runConsoleScript("add computer PC1 at 0 0\nadd switch SW at 600 0\nlink PC1 SW");
    const { at, home } = placed("PC1", "SW", 80);
    expect(at).toEqual(home);
    expect(placeLinkLabel(100, 100, 80, [])).toEqual({ x: 100, y: 92 });
  });

  it("on a short link it moves just far enough to clear both ends", () => {
    // A PC and its switch 160 apart, labelled "40 ms · 5% loss" (about 80 wide):
    // at the midpoint the label's ends are under both icons.
    runConsoleScript("add computer PC1 at 0 0\nadd switch SW at 160 40\nlink PC1 SW");
    const { at, obstacles, home } = placed("PC1", "SW", 80);
    expect(obstacles.some(o => overlaps(labelBox(home, 80), o))).toBe(true);       // the old spot was under a device
    expect(obstacles.some(o => overlaps(labelBox(at, 80), o))).toBe(false);        // the new one is clear
    expect(Math.hypot(at.x - home.x, at.y - home.y)).toBeLessThanOrEqual(72 * Math.SQRT2);   // and still beside its link
  });

  it("the ring drawn round a selected device counts as part of it — the reported case", () => {
    // The Basic Network's PC-A1 → Access-SW-A: the label's first character sat
    // under PC-A1's selection ring, so "40 ms" read as "0 ms".
    exec("topology basic");
    const pc = dev("PC-A1");
    const [icon] = deviceFootprint(pc);
    expect(icon.x + icon.w).toBeGreaterThanOrEqual(pc.x + pc.width / 2 + 7 + 2);   // the ring's outer edge
    const width = 2 * ((pc.x + dev("Access-SW-A").x) / 2 - (pc.x + pc.width / 2 + 7));   // a label reaching just into the ring
    const { at, obstacles } = placed("PC-A1", "Access-SW-A", width);
    expect(obstacles.some(o => overlaps(labelBox(at, width), o))).toBe(false);
  });

  it("every cable of every built-in topology can carry a long label without touching its ends", () => {
    for (const name of ["basic", "vlan-roas", "router-mesh", "wifi-vlan"]) {
      exec(`topology ${name}`);
      for (const link of state.links) {
        const from = state.devices.find(d => d.id === link.from)!, to = state.devices.find(d => d.id === link.to)!;
        if (from.hidden || to.hidden) continue;
        const obstacles = [...deviceFootprint(from), ...deviceFootprint(to)];
        const width = 150;   // "Uplink · 120 ms · 12.5% loss · down"
        const at = placeLinkLabel((from.x + to.x) / 2, (from.y + to.y) / 2, width, obstacles);
        expect(obstacles.some(o => overlaps(labelBox(at, width), o)), `${name}: ${from.name} ↔ ${to.name}`).toBe(false);
      }
    }
  });

  it("moves the least distance that clears, and sideways when that is no further than up or down", () => {
    // A box over the left end of the usual spot, reaching 2 above its baseline:
    // up 24 clears it; sideways would take 42. Up wins.
    expect(placeLinkLabel(100, 100, 80, [{ x: 60, y: 70, w: 40, h: 40 }])).toEqual({ x: 100, y: 68 });
    // A thin post just inside the right end, the height of the label: 6 left
    // clears it, and so would 18 up — sideways is nearer, and keeps it level.
    expect(placeLinkLabel(100, 100, 80, [{ x: 136, y: 60, w: 4, h: 60 }])).toEqual({ x: 94, y: 92 });
    expect(placeLinkLabel(100, 100, 80, [{ x: 60, y: 60, w: 4, h: 60 }])).toEqual({ x: 106, y: 92 });   // the mirror image
  });

  it("with nowhere clear within reach it stays put rather than wander off", () => {
    expect(placeLinkLabel(100, 100, 80, [{ x: -1000, y: -1000, w: 2000, h: 2000 }])).toEqual({ x: 100, y: 92 });
  });

  it("a device's footprint is its icon and the text under it, as the display options show it", () => {
    runConsoleScript("add computer PC1 at 0 0\nip PC1 10.0.0.1/24\nadd switch SW at 600 0");
    const pc = dev("PC1");
    const [icon, text] = deviceFootprint(pc);
    expect(icon.x).toBeLessThan(pc.x - pc.width / 2);            // out to the selection ring
    expect(icon.y + icon.h).toBeGreaterThan(pc.y + pc.height / 2);
    expect(text.y).toBe(pc.y + pc.height / 2 + 10);
    expect(text.h).toBe(17 + 15 + 13);                           // name, address, MAC
    expect(text.w).toBeGreaterThanOrEqual(108);
    expect(deviceFootprint(dev("SW"))[1].h).toBe(17);            // a switch shows only its name
    state.options.showDeviceNames = false;
    state.options.showIpAddresses = false;
    state.options.showMacAddresses = false;
    expect(deviceFootprint(pc).length).toBe(1);                  // nothing under it: the icon alone
  });
});
