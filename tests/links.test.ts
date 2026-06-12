/**
 * Nameable links: the derived default ("A ↔ B", follows device renames), the
 * user-given override, config round-trips, and the surfaces that show it.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { linkName, deleteLink, deleteSelection, addLink } from "../src/devices";
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
