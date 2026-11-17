/**
 * Nameable links: the derived default ("A ↔ B", follows device renames), the
 * user-given override, config round-trips, and the surfaces that show it.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { runSimulationHeadless } from "../src/engine";
import { buildPingEvents } from "../src/simulation";
import { linkName, deleteLink, deleteSelection, addLink, toggleLinkShutdown } from "../src/devices";
import { linkStatusLabel, linkLabelText } from "../src/canvas";
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
