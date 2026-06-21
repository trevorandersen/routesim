/**
 * WiFi — the laptop (WiFi-only host) and access point (L2 bridge) devices, the
 * wireless association link, and forwarding through an AP onto the wired LAN.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { addLink, classifyLink, linkBlockReason, switchInterfacesWithNames } from "../src/devices";
import { runSimulationHeadless } from "../src/engine";
import { buildPingEvents } from "../src/simulation";
import { runConsoleScript, runConsoleCommand as exec, exportTopologyScript } from "../src/commands";
import { buildConfigPayload, parseConfig, applyConfig } from "../src/config";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());

const byName = (name: string) => state.devices.find(d => d.name === name)!;

describe("wifi — device types", () => {
  beforeEach(() => resetState());

  it("a laptop is a WiFi-only host (gets a MAC, takes host config)", () => {
    runConsoleScript("add laptop LT1 at 0 0\nip LT1 10.0.0.5/24");
    const lt = byName("LT1");
    expect(lt.type).toBe("laptop");
    expect(lt.config.macAddress).toMatch(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/); // auto NIC MAC on add
    expect(lt.config.ipv4Address).toBe("10.0.0.5");
  });

  it("an access point normalises to an unmanaged bridge with a single wired uplink", () => {
    runConsoleScript("add access-point AP1 at 0 0");
    const ap = byName("AP1");
    expect(ap.type).toBe("access-point");
    expect(ap.config.managed).toBe(false);
    expect(ap.config.ethernetPorts).toBe(1); // one LAN uplink, not a port bank
    expect(switchInterfacesWithNames(ap).map((p: any) => p.name)).toEqual(["Ethernet1"]);
  });

  it("a wireless association is not an ethernet port (does not consume the uplink)", () => {
    runConsoleScript(`
      add access-point AP1 at 0 0
      add laptop LT1 at 0 100
      add switch SW at 100 0
      link AP1 LT1
    `);
    const ap = byName("AP1");
    // The wireless client is associated, yet the wired uplink is still free.
    let ports = switchInterfacesWithNames(ap);
    expect(ports.length).toBe(1);
    expect(ports[0].peer).toBeNull();
    // Wiring the uplink fills exactly that one port.
    addLink(byName("SW").id, ap.id);
    ports = switchInterfacesWithNames(ap);
    expect(ports.length).toBe(1);
    expect(ports[0].peer?.name).toBe("SW");
  });
});

describe("wifi — wireless association link", () => {
  beforeEach(() => resetState());

  function topo() {
    runConsoleScript(`
      add laptop LT1 at 0 0
      add access-point AP1 at 100 0
      add switch SW at 200 0
    `);
    return { lt: byName("LT1"), ap: byName("AP1"), sw: byName("SW") };
  }

  it("laptop ↔ AP is allowed and marked wireless", () => {
    const { lt, ap } = topo();
    expect(classifyLink(lt.id, ap.id).wireless).toBe(true);
    expect(linkBlockReason(lt.id, ap.id)).toBeNull();
    addLink(lt.id, ap.id);
    const link = state.links.find(l => l.from === lt.id || l.to === lt.id)!;
    expect(link.wireless).toBe(true);
  });

  it("a laptop cannot associate to a non-AP, or to another laptop", () => {
    const { lt, sw } = topo();
    expect(linkBlockReason(lt.id, sw.id)).toMatch(/wireless/i);
    expect(exec("link LT1 SW").ok).toBe(false); // surfaced via the console too
    runConsoleScript("add laptop LT2 at 0 100");
    expect(linkBlockReason(lt.id, byName("LT2").id)).toMatch(/laptop/i);
  });

  it("a laptop has a single NIC — one association only", () => {
    const { lt, ap } = topo();
    addLink(lt.id, ap.id);
    runConsoleScript("add access-point AP2 at 100 100");
    expect(linkBlockReason(lt.id, byName("AP2").id)).toMatch(/single NIC/i);
  });
});

describe("wifi — SSID and password", () => {
  beforeEach(() => resetState());

  it("a fresh laptop and AP share the default SSID, so they associate", () => {
    runConsoleScript("add laptop LT1 at 0 0\nadd access-point AP1 at 100 0");
    const { lt, ap } = { lt: byName("LT1"), ap: byName("AP1") };
    expect(lt.config.ssid).toBe(ap.config.ssid); // same out-of-box default
    expect(classifyLink(lt.id, ap.id).reject).toBeNull();
  });

  it("a mismatched SSID is refused, naming both networks", () => {
    runConsoleScript(`
      add laptop LT1 at 0 0
      add access-point AP1 at 100 0
      ssid AP1 OfficeNet
      ssid LT1 HomeNet
    `);
    const reason = linkBlockReason(byName("LT1").id, byName("AP1").id);
    expect(reason).toContain("HomeNet");
    expect(reason).toContain("OfficeNet");
  });

  it("a secured AP needs the matching password", () => {
    runConsoleScript(`
      add laptop LT1 at 0 0
      add access-point AP1 at 100 0
      ssid AP1 Secure hunter2
    `);
    const lt = byName("LT1"), ap = byName("AP1");
    expect(ap.config.wifiPassword).toBe("hunter2");
    // SSID matches but no/old password → wrong password
    runConsoleScript("ssid LT1 Secure");
    expect(linkBlockReason(lt.id, ap.id)).toMatch(/wrong password/i);
    // correct password → associates
    runConsoleScript("ssid LT1 Secure hunter2");
    expect(linkBlockReason(lt.id, ap.id)).toBeNull();
    expect(classifyLink(lt.id, ap.id).wireless).toBe(true);
  });

  it("the ssid command rejects a non-WiFi device", () => {
    runConsoleScript("add computer PC1 at 0 0");
    const res = exec("ssid PC1 Net");
    expect(res.ok).toBe(false);
    expect(res.output.join(" ")).toMatch(/not a WiFi device/i);
  });

  it("omitting the password opens the network (and clears any existing one)", () => {
    runConsoleScript("add access-point AP1 at 0 0\nssid AP1 Net secret");
    expect(byName("AP1").config.wifiPassword).toBe("secret");
    runConsoleScript("ssid AP1 Net");
    expect(byName("AP1").config.wifiPassword).toBe("");
  });
});

describe("wifi — forwarding through an access point", () => {
  beforeEach(() => resetState());

  it("a laptop reaches the wired LAN via its AP (bridged like a switch)", () => {
    runConsoleScript(`
      add laptop LT1 at 0 0
      add access-point AP1 at 100 0
      add switch SW at 200 0
      add router R1 at 300 0
      link LT1 AP1
      link AP1 SW
      link SW R1
      interface R1 SW ip 192.168.1.1
      ip LT1 192.168.1.10/24
      gateway LT1 192.168.1.1
    `);
    const lt = byName("LT1");
    const res = runSimulationHeadless(buildPingEvents(lt, "192.168.1.1") as any, lt.id, "192.168.1.1", "ping");
    expect(res.success).toBe(true);
  });

  it("two laptops on the same AP reach each other", () => {
    runConsoleScript(`
      add laptop LT1 at 0 0
      add laptop LT2 at 0 100
      add access-point AP1 at 100 0
      link LT1 AP1
      link LT2 AP1
      ip LT1 10.0.0.1/24
      ip LT2 10.0.0.2/24
    `);
    const lt1 = byName("LT1");
    const res = runSimulationHeadless(buildPingEvents(lt1, "10.0.0.2") as any, lt1.id, "10.0.0.2", "ping");
    expect(res.success).toBe(true);
  });
});

describe("wifi — serialisation round-trips", () => {
  beforeEach(() => resetState());

  it("laptop/AP and the wireless flag survive JSON export → import", () => {
    runConsoleScript(`
      add laptop LT1 at 0 0
      add access-point AP1 at 100 0
      link LT1 AP1
      ip LT1 10.0.0.5/24
    `);
    const json = JSON.stringify(buildConfigPayload());
    resetState();
    applyConfig(parseConfig(json));
    const lt = byName("LT1");
    expect(lt.type).toBe("laptop");
    expect(lt.config.ipv4Address).toBe("10.0.0.5");
    expect(byName("AP1").type).toBe("access-point");
    expect(state.links[0].wireless).toBe(true);
  });

  it("SSID + password survive JSON export → import on both ends", () => {
    runConsoleScript(`
      add laptop LT1 at 0 0
      add access-point AP1 at 100 0
      ssid AP1 OfficeNet s3cret
      ssid LT1 OfficeNet s3cret
    `);
    const json = JSON.stringify(buildConfigPayload());
    resetState();
    applyConfig(parseConfig(json));
    expect(byName("AP1").config.ssid).toBe("OfficeNet");
    expect(byName("AP1").config.wifiPassword).toBe("s3cret");
    expect(byName("LT1").config.ssid).toBe("OfficeNet");
    expect(byName("LT1").config.wifiPassword).toBe("s3cret");
  });

  it("a topology script re-derives the wireless association on replay", () => {
    runConsoleScript("add laptop LT1 at 0 0\nadd access-point AP1 at 100 0\nlink LT1 AP1");
    const script = exportTopologyScript();
    expect(script).toContain("add laptop LT1");
    expect(script).toContain("add access-point AP1");
    resetState();
    runConsoleScript(script);
    expect(state.links[0].wireless).toBe(true); // classifyLink re-marks it on the replayed `link`
  });

  it("a script round-trips a renamed, secured SSID and the association still forms", () => {
    runConsoleScript(`
      add laptop LT1 at 0 0
      add access-point AP1 at 100 0
      ssid AP1 Lab guestpass
      ssid LT1 Lab guestpass
      link LT1 AP1
    `);
    const script = exportTopologyScript();
    expect(script).toContain("ssid AP1 Lab guestpass");
    expect(script).toContain("ssid LT1 Lab guestpass");
    resetState();
    runConsoleScript(script);
    expect(byName("AP1").config.ssid).toBe("Lab");
    expect(byName("AP1").config.wifiPassword).toBe("guestpass");
    expect(state.links[0].wireless).toBe(true);
  });
});
