/**
 * First-boot autoconf: an unconfigured host whose cable comes up (or that is
 * powered on while cabled) behaves like a real machine — it tries DHCP, and
 * self-assigns APIPA 169.254.x.y/16 when no server answers. Wired through the
 * device-callback registry (addLink → linkUp → engine.autoBootLinkedHosts),
 * which this file registers for real, as app.ts does.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { registerDeviceCallbacks } from "../src/devices";
import { autoBootLinkedHosts, bootHostAutoconf } from "../src/engine";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => {
  registerNoopCallbacks();
  registerDeviceCallbacks({ setTool: () => {}, setNetworkPanel: () => {}, linkUp: autoBootLinkedHosts });
});

// Don't leak the hook into other test files (bun shares module state).
afterAll(() => registerDeviceCallbacks({ setTool: () => {}, setNetworkPanel: () => {} }));

const pc = (name: string) => state.devices.find(d => d.name === name)!;

describe("first boot — link-up autoconf", () => {
  beforeEach(() => resetState());

  it("self-assigns APIPA /16 when no DHCP server answers", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      add switch SW at 200 0
      link PC1 SW
    `);
    const c = pc("PC1").config;
    expect(c.ipv4Address).toMatch(/^169\.254\.\d+\.\d+$/);
    expect(c.prefixLength).toBe(16);
    expect(c.gatewayIpv4Address).toBe("");
    expect(c.ipSource).toBe("apipa");
  });

  it("leases from a reachable DHCP router instead", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      add switch SW at 200 0
      add router R1 at 400 0
      link SW R1
    `);
    exec("interface R1 SW ip 192.168.1.1");
    exec("link PC1 SW");
    const c = pc("PC1").config;
    expect(c.ipv4Address).toBe("192.168.1.100");
    expect(c.gatewayIpv4Address).toBe("192.168.1.1");
    expect(c.ipSource).toBe("dhcp");
  });

  it("leases from a dnsmasq server, learning the nameserver too", () => {
    runConsoleScript(`
      add server SRV at 0 0
      add switch SW at 200 0
      ip SRV 192.168.1.53/24
      cli SRV echo dhcp-range=192.168.1.100,192.168.1.200 >> /etc/dnsmasq.conf
      link SRV SW
      add computer PC1 at 400 0
      link PC1 SW
    `);
    const c = pc("PC1").config;
    expect(c.ipv4Address).toBe("192.168.1.100");
    expect(c.dnsServerIp).toBe("192.168.1.53");
  });

  it("never touches a host that already has an address", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      add switch SW at 200 0
      ip PC1 10.0.0.5/8
      link PC1 SW
    `);
    expect(pc("PC1").config.ipv4Address).toBe("10.0.0.5");
    expect(pc("PC1").config.prefixLength).toBe(8);
  });

  it("ignores powered-off hosts and non-host endpoints", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      add switch SW1 at 200 0
      add switch SW2 at 400 0
    `);
    pc("PC1").poweredOff = true;
    exec("link PC1 SW1");
    exec("link SW1 SW2");
    expect(pc("PC1").config.ipv4Address || "").toBe("");
  });

  it("does not clobber an active simulation", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      add switch SW at 200 0
    `);
    state.simulation.status = "running";
    exec("link PC1 SW");
    expect(pc("PC1").config.ipv4Address || "").toBe("");
    state.simulation.status = "idle";
  });
});

describe("first boot — power-on autoconf", () => {
  beforeEach(() => resetState());

  it("powering on an unconfigured, cabled host boots it (APIPA here)", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      add switch SW at 200 0
    `);
    pc("PC1").poweredOff = true;
    exec("link PC1 SW");                 // powered off: nothing happens
    expect(pc("PC1").config.ipv4Address || "").toBe("");
    pc("PC1").poweredOff = false;        // the inspector's power button does this…
    bootHostAutoconf(pc("PC1"));         // …then calls bootHostAutoconf
    expect(pc("PC1").config.ipv4Address).toMatch(/^169\.254\./);
    expect(pc("PC1").config.prefixLength).toBe(16);
  });

  it("a boot with no cable does nothing (no carrier, no address)", () => {
    runConsoleScript(`add computer PC1 at 0 0`);
    bootHostAutoconf(pc("PC1"));
    expect(pc("PC1").config.ipv4Address || "").toBe("");
  });
});
