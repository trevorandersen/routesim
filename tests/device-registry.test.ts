/**
 * Device capability roles (device-registry.ts). Each `DeviceSpec` declares what
 * its type *is* — host, single NIC, bootable, 802.1X supplicant, hostname,
 * terminal — plus its default Ethernet port count, and the rest of the app asks
 * the role helpers instead of listing device types by hand (the drift that let
 * a Kali PC slip past 802.1X and left a Red Team actor un-bootable).
 *
 * Two layers: the helpers must read the spec faithfully, and the BEHAVIOUR that
 * consumes each role (the cable guard, the port picker, the Play boot set, ping
 * targets, the supplicant command, the terminal gate, the hostname field) must
 * agree with the spec for every device type.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import {
  DEVICE_SPECS, DEVICE_TYPES, USER_ADDABLE_TYPES, defaultConfigFor, defaultPortCount,
  isHost, hasSingleNic, isBootable, isDot1xSupplicant, hasHostname, offersTerminal,
} from "../src/device-registry";
import type { DeviceType } from "../src/types";
import { defaultDeviceConfig } from "../src/normalise";
import { addDevice, addLink, buildPortList } from "../src/devices";
import { unconfiguredBootableHosts } from "../src/engine";
import { findPingTarget } from "../src/simulation";
import { hasTerminal, canOpenTerminal, terminalPromptText } from "../src/terminal";
import { runConsoleCommand as exec } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());
beforeEach(() => resetState());

const roleOf = (t: DeviceType) => DEVICE_SPECS[t].roles;

describe("device registry — helpers read the spec", () => {
  it("every type declares its roles", () => {
    for (const t of DEVICE_TYPES) {
      const r = roleOf(t);
      for (const key of ["host", "singleNic", "bootable", "dot1xSupplicant", "hostname", "terminal"] as const) {
        expect(r[key] === true || r[key] === false || r[key] === "managed").toBe(true);
      }
    }
  });

  it("the type-keyed helpers agree with the spec for every type", () => {
    for (const t of DEVICE_TYPES) {
      expect(isHost(t)).toBe(roleOf(t).host);
      expect(hasSingleNic(t)).toBe(roleOf(t).singleNic);
      expect(isBootable(t)).toBe(roleOf(t).bootable);
      expect(isDot1xSupplicant(t)).toBe(roleOf(t).dot1xSupplicant);
    }
    expect(isHost(undefined)).toBe(false);   // an unresolved device has no roles
  });

  it("the gated helpers follow the management plane only where the spec says \"managed\"", () => {
    for (const t of DEVICE_TYPES) {
      for (const managed of [false, true]) {
        const d = { type: t, config: { managed } };
        const expectFor = (gate: boolean | "managed") => gate === "managed" ? managed : gate;
        expect(hasHostname(d)).toBe(expectFor(roleOf(t).hostname));
        expect(offersTerminal(d)).toBe(expectFor(roleOf(t).terminal));
      }
    }
  });

  it("the terminal role agrees with the CLI dispatch table", () => {
    // A type whose role says it has a terminal must have a CLI to run, and vice versa.
    for (const t of DEVICE_TYPES) {
      expect(hasTerminal({ type: t } as any)).toBe(roleOf(t).terminal !== false);
    }
  });

  it("defaultPorts is the ethernetPorts a fresh device gets", () => {
    for (const t of DEVICE_TYPES) {
      const spec = DEVICE_SPECS[t];
      expect(defaultConfigFor(t).ethernetPorts).toBe(spec.defaultPorts);
      expect(defaultDeviceConfig(t).ethernetPorts).toBe(spec.defaultPorts);
      expect(defaultPortCount(t)).toBe(spec.defaultPorts ?? 0);
    }
  });

  it("pins today's memberships, so a change to them is a deliberate one", () => {
    const hosts = DEVICE_TYPES.filter(isHost).sort();
    expect(hosts).toEqual(["attacker", "computer", "kali", "laptop", "server"]);
    expect(DEVICE_TYPES.filter(hasSingleNic).sort()).toEqual([...hosts, "ids"].sort());
    expect(DEVICE_TYPES.filter(isBootable).sort()).toEqual(hosts);           // R9: the Red Team actor boots too
    expect(DEVICE_TYPES.filter(isDot1xSupplicant).sort()).toEqual(hosts);    // R7: Kali / Red Team can run a supplicant
  });
});

describe("device registry — behaviour agrees with the spec for every addable type", () => {
  it("singleNic: one cable, one eth0 in the port picker", () => {
    for (const t of USER_ADDABLE_TYPES) {
      resetState();
      const d = addDevice(t, 0, 0, "D");
      const a = addDevice("switch", 200, 0, "SW1");
      const b = addDevice("switch", 200, 200, "SW2");
      addLink(d.id, a.id);
      if (t === "laptop") continue;   // a laptop associates to an AP, never cables to a switch
      const before = state.links.length;
      addLink(d.id, b.id);
      expect(state.links.length - before).toBe(hasSingleNic(t) ? 0 : 1);
      const ports = buildPortList(d.id);
      expect(ports.length === 1 && ports[0].name === "eth0").toBe(hasSingleNic(t));
    }
  });

  it("bootable: an unconfigured cabled device is in Play's boot set", () => {
    for (const t of USER_ADDABLE_TYPES) {
      if (t === "laptop") continue;   // cabled only via an AP association (covered in wifi tests)
      resetState();
      const d = addDevice(t, 0, 0, "D");
      const sw = addDevice("switch", 200, 0, "SW");
      addLink(d.id, sw.id);
      expect(unconfiguredBootableHosts().some(h => h.id === d.id)).toBe(isBootable(t));
    }
  });

  it("host: an addressed device is a ping/name target and gets a NIC MAC", () => {
    for (const t of USER_ADDABLE_TYPES) {
      resetState();
      const d = addDevice(t, 0, 0, "D");
      expect(!!d.config.macAddress).toBe(isHost(t));
      d.config.ipv4Address = "10.9.9.9";
      expect(findPingTarget("10.9.9.9")?.id === d.id).toBe(isHost(t));
      expect(findPingTarget("D")?.id === d.id).toBe(isHost(t));
    }
  });

  it("dot1xSupplicant: the supplicant command accepts exactly the supplicant types", () => {
    for (const t of USER_ADDABLE_TYPES) {
      resetState();
      addDevice(t, 0, 0, "D");
      expect(exec("supplicant D alice secret").ok).toBe(isDot1xSupplicant(t));
    }
  });

  it("terminal: canOpenTerminal follows the role (a switch only when managed)", () => {
    for (const t of USER_ADDABLE_TYPES) {
      resetState();
      const d = addDevice(t, 0, 0, "D");
      expect(canOpenTerminal(d)).toBe(offersTerminal(d));
      d.poweredOff = true;
      expect(canOpenTerminal(d)).toBe(false);    // power is the one extra gate
    }
  });
});

// R101: the IDS sensor's shell fell through to the router's vtysh prompt
// (`IDS-1>`). Each CLI device shows its own reference NOS's prompt.
describe("device registry — each terminal device has its own prompt", () => {
  it("hosts, root shells, the switch, the firewall and the router", () => {
    const prompt = (t: DeviceType) => terminalPromptText(addDevice(t, 0, 0, "D"));
    expect(prompt("ids")).toBe("root@D:~#");      // a Snort box editing /etc/snort — not the router's `D>`
    expect(prompt("server")).toBe("root@D:~#");
    for (const t of ["computer", "laptop", "kali", "attacker"] as const) expect(prompt(t)).toBe("D$");
    expect(prompt("switch")).toBe("D#");
    expect(prompt("firewall")).toBe("root@D#");
    expect(prompt("router")).toBe("D>");
  });
});
