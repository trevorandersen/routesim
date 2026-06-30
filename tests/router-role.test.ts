/**
 * Router roles (border/edge vs internal/core): the placement archetype on a
 * router — the `border-router` tool variant, the `role` console command, the
 * badge-driving config flag, and the JSON + script round-trips.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { placeToolDevice } from "../src/devices";
import { buildConfigPayload, parseConfig } from "../src/config";
import { normaliseConfig } from "../src/normalise";
import { runConsoleScript, runConsoleCommand as exec, exportTopologyScript } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());
beforeEach(() => resetState());

const dev = (name: string) => state.devices.find(d => d.name === name)!;

describe("router roles", () => {
  it("the border-router tool places a router flagged role:border", () => {
    const device = placeToolDevice("border-router", 0, 0);
    expect(device.type).toBe("router");
    expect((device.config as any).role).toBe("border");
    expect(device.name).toMatch(/^Border-\d+$/);
    // the plain router tool stays an internal/core router (no role)
    const plain = placeToolDevice("router", 200, 0);
    expect((plain.config as any).role).toBeUndefined();
  });

  it("`role <router> border|internal` sets and clears the flag", () => {
    runConsoleScript(`add router R1 at 0 0`);
    expect(exec("role R1 border").ok).toBe(true);
    expect(dev("R1").config!.role).toBe("border");
    expect(exec("role R1 internal").ok).toBe(true);
    expect(dev("R1").config!.role).toBeUndefined(); // internal is the plain default
    // rejected on a non-router and a bad value
    runConsoleScript(`add switch SW at 200 0`);
    expect(exec("role SW border").ok).toBe(false);
    expect(exec("role R1 sideways").ok).toBe(false);
  });

  it("the role round-trips through JSON config and the script export", () => {
    runConsoleScript(`add router R1 at 0 0\nrole R1 border`);
    // JSON
    const round = parseConfig(JSON.stringify(buildConfigPayload()));
    expect(round.devices.find((d: any) => d.name === "R1").config.role).toBe("border");
    // script
    const script = exportTopologyScript();
    expect(script).toContain("role R1 border");
    resetState();
    runConsoleScript(script);
    expect(dev("R1").config!.role).toBe("border");
  });

  it("normalise keeps a valid role and drops a bogus one", () => {
    const normal = normaliseConfig({ version: 1, devices: [
      { id: "r", type: "router", name: "R1", x: 0, y: 0, config: { role: "border", interfaces: [] } },
      { id: "r2", type: "router", name: "R2", x: 0, y: 0, config: { role: "sideways", interfaces: [] } },
    ], links: [] } as any);
    expect((normal.devices[0].config as any).role).toBe("border");
    expect((normal.devices[1].config as any).role).toBeUndefined();
  });
});
