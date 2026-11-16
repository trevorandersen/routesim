/**
 * Network boot. Adding/cabling/powering a host no longer auto-configures it —
 * it stays "unassigned" until the user starts the simulation. Then Play
 * (engine.startNetworkBoot) boots every unconfigured cabled host with an
 * *animated* DHCP exchange, self-assigning APIPA only after the simulated DHCP
 * times out. These tests drive the animated boot via the rAF-stub harness.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { state } from "../src/state";
import { startNetworkBoot, unconfiguredBootableHosts, stepOnce } from "../src/engine";
import { launchRedTeam } from "../src/security/offensive/red-team";
import { dom } from "../src/dom";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());

const pc = (name: string) => state.devices.find(d => d.name === name)!;

// The preload's synchronous rAF would recurse through the animation loop, so
// stub it to a no-op and pump the (possibly chained) boots via stepOnce.
const realRaf = (globalThis as any).requestAnimationFrame;
beforeEach(() => {
  resetState();
  state.options.autoDhcp = true;        // global toggles now default off; turn them on for the boot tests
  state.options.apipaFallback = true;   // (resetState restores both to off)
  (globalThis as any).requestAnimationFrame = () => 0;
});
afterEach(() => { (globalThis as any).requestAnimationFrame = realRaf; });
afterAll(() => resetState());   // do not hand Auto-DHCP / APIPA on to the next file

function runBoot(): boolean {
  const started = startNetworkBoot();
  if (!started) return false;
  let guard = 0;
  while (state.simulation.status !== "done" && guard++ < 2000) stepOnce();
  return true;
}

describe("network boot — adding/cabling no longer auto-configures", () => {
  it("a freshly cabled host stays unassigned (no silent APIPA)", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      add switch SW at 200 0
      link PC1 SW
    `);
    expect(pc("PC1").config.ipv4Address || "").toBe("");
  });

  it("power-cycling a host doesn't boot it either", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      add switch SW at 200 0
      link PC1 SW
    `);
    pc("PC1").poweredOff = true;
    pc("PC1").poweredOff = false;
    expect(pc("PC1").config.ipv4Address || "").toBe("");
  });
});

describe("network boot — Play (startNetworkBoot) boots unconfigured hosts", () => {
  it("self-assigns APIPA /16 when no DHCP server answers", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      add switch SW at 200 0
      link PC1 SW
    `);
    expect(runBoot()).toBe(true);
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
      link PC1 SW
    `);
    exec("interface R1 SW ip 192.168.1.1");
    runBoot();
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
    runBoot();
    const c = pc("PC1").config;
    expect(c.ipv4Address).toBe("192.168.1.100");
    expect(c.dnsServerIp).toBe("192.168.1.53");
  });

  it("boots several unconfigured hosts in turn", () => {
    runConsoleScript(`
      add router R1 at 600 0
      add switch SW at 300 0
      link SW R1
      add computer PC1 at 0 0
      add computer PC2 at 0 200
      link PC1 SW
      link PC2 SW
    `);
    exec("interface R1 SW ip 192.168.1.1");
    runBoot();
    // Each got a distinct lease from the router's .100–.254 range.
    expect(pc("PC1").config.ipv4Address).toMatch(/^192\.168\.1\.1\d\d$/);
    expect(pc("PC2").config.ipv4Address).toMatch(/^192\.168\.1\.1\d\d$/);
    expect(pc("PC1").config.ipv4Address).not.toBe(pc("PC2").config.ipv4Address);
  });
});

describe("network boot — which hosts qualify", () => {
  it("excludes configured, powered-off, and uncabled hosts", () => {
    runConsoleScript(`
      add computer CONFIGURED at 0 0
      add computer OFF at 0 100
      add computer LONELY at 0 200
      add computer BOOTME at 0 300
      add switch SW at 300 0
      ip CONFIGURED 10.0.0.5/8
      link CONFIGURED SW
      link OFF SW
      link BOOTME SW
    `);
    pc("OFF").poweredOff = true;
    const names = unconfiguredBootableHosts().map(d => d.name).sort();
    expect(names).toEqual(["BOOTME"]); // not CONFIGURED (has IP), OFF (powered off), LONELY (no cable)
  });

  it("startNetworkBoot returns false when there's nothing to boot", () => {
    runConsoleScript(`add computer PC1 at 0 0`); // no cable
    expect(startNetworkBoot()).toBe(false);
  });
});

describe("network boot — the global Auto-DHCP / APIPA toggles", () => {
  it("both off: Play boots nothing — the host stays unassigned", () => {
    runConsoleScript(`add computer PC1 at 0 0\nadd switch SW at 200 0\nlink PC1 SW`);
    state.options.autoDhcp = false;
    state.options.apipaFallback = false;
    expect(startNetworkBoot()).toBe(false);
    expect(pc("PC1").config.ipv4Address || "").toBe("");
  });

  it("Auto-DHCP off but APIPA on: the host self-assigns link-local directly (no DHCP)", () => {
    runConsoleScript(`add computer PC1 at 0 0\nadd switch SW at 200 0\nlink PC1 SW`);
    state.options.autoDhcp = false; // APIPA stays on (beforeEach)
    // No DHCP frames are sent, so the boot is instant — startNetworkBoot itself
    // assigns the address rather than queuing an animated run.
    expect(startNetworkBoot()).toBe(false); // nothing left running
    expect(pc("PC1").config.ipv4Address).toMatch(/^169\.254\.\d+\.\d+$/);
    expect(pc("PC1").config.ipSource).toBe("apipa");
    expect(pc("PC1").config.prefixLength).toBe(16);
  });

  it("APIPA off (Auto-DHCP on): a failed DHCP leaves the host with no address", () => {
    runConsoleScript(`add computer PC1 at 0 0\nadd switch SW at 200 0\nlink PC1 SW`);
    state.options.apipaFallback = false;
    runBoot(); // animated DHCP runs, finds no server
    expect(pc("PC1").config.ipv4Address || "").toBe(""); // unassigned — APIPA suppressed
  });

  it("both on (default here): a failed DHCP self-assigns APIPA", () => {
    runConsoleScript(`add computer PC1 at 0 0\nadd switch SW at 200 0\nlink PC1 SW`);
    runBoot();
    expect(pc("PC1").config.ipv4Address).toMatch(/^169\.254\./);
  });
});

// R9: the Red Team actor is a full host, so Play boots it like any other. It was
// missing from the boot set, so an unconfigured actor never got an address and
// Play said "every host already has an address" — then launched nothing.
describe("network boot — the Red Team actor is a host too (R9)", () => {
  it("Play leases an address to an unconfigured Red Team actor", () => {
    runConsoleScript(`
      add attacker RT1 at 0 0
      add switch SW at 200 0
      add router R1 at 400 0
      link SW R1
      link RT1 SW
    `);
    exec("interface R1 SW ip 192.168.1.1");
    expect(unconfiguredBootableHosts().map(d => d.name)).toEqual(["RT1"]);
    expect(runBoot()).toBe(true);
    expect(pc("RT1").config.ipv4Address).toBe("192.168.1.100");
    expect(pc("RT1").config.ipSource).toBe("dhcp");
  });

  it("a Kali PC boots the same way", () => {
    runConsoleScript(`
      add kali K1 at 0 0
      add switch SW at 200 0
      link K1 SW
    `);
    expect(runBoot()).toBe(true);
    expect(pc("K1").config.ipv4Address).toMatch(/^169\.254\./);
  });

  it("with nothing to boot, Play says why an actor can't launch instead of a false all-clear", () => {
    runConsoleScript(`add attacker RT1 at 0 0`);   // uncabled, so not bootable
    state.options.autoDhcp = false;
    state.options.apipaFallback = false;
    expect(startNetworkBoot()).toBe(false);
    expect(launchRedTeam()).toBe(false);
    expect(dom.modeLabel.textContent).toBe("RT1 has no IP address and no cable — connect it to the network first.");
  });

  it("an addressed actor with no attacks enabled says so", () => {
    runConsoleScript(`
      add attacker RT1 at 0 0
      ip RT1 10.0.0.66/24
    `);
    pc("RT1").config.attacks = [];
    expect(launchRedTeam()).toBe(false);
    expect(dom.modeLabel.textContent).toContain("RT1 has no attacks enabled");
  });
});
