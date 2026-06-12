/**
 * Nameable links: the derived default ("A ↔ B", follows device renames), the
 * user-given override, config round-trips, and the surfaces that show it.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { linkName } from "../src/devices";
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
