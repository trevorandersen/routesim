/**
 * Tutorial mode — guards the scripted demo from drifting. Runs the tutorial's
 * own step actions (the real console commands it fires under the faux cursor),
 * skipping only the animated ping, and asserts the build is the intended
 * two-LAN + router topology that pings across the gateway. If a command verb is
 * renamed or the sequence breaks, this fails instead of the demo silently dying.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { runConsoleCommand as exec } from "../src/commands";
import { buildSteps } from "../src/tutorial";
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
