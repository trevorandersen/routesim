/**
 * WiFi — the laptop (WiFi-only host) and access point (L2 bridge) devices, the
 * wireless association link, and forwarding through an AP onto the wired LAN.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { state } from "../src/state";
import { addLink, classifyLink, linkBlockReason, switchInterfacesWithNames, wifiLinkAuthenticated, wifiLinkBlockReason } from "../src/devices";
import { runSimulationHeadless, startSimulation, stepOnce } from "../src/engine";
import { buildPingEvents, buildAssociationEvents } from "../src/simulation";
import { packetColumns } from "../src/frame";
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

  it("a wrong password still associates (link forms) but is not authenticated", () => {
    runConsoleScript(`
      add laptop LT1 at 0 0
      add access-point AP1 at 100 0
      ssid AP1 Secure hunter2
      ssid LT1 Secure wrongpw
    `);
    const lt = byName("LT1"), ap = byName("AP1");
    // SSID matches → the association is allowed to form (the join fails later, at auth)
    expect(linkBlockReason(lt.id, ap.id)).toBeNull();
    expect(classifyLink(lt.id, ap.id).wireless).toBe(true);
    addLink(lt.id, ap.id);
    const link = state.links.find(l => l.wireless)!;
    expect(wifiLinkAuthenticated(link)).toBe(false); // wrong password → unauthenticated
    // Fix the password → it authenticates live (no re-link needed)
    runConsoleScript("ssid LT1 Secure hunter2");
    expect(wifiLinkAuthenticated(link)).toBe(true);
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

describe("wifi — 802.11 association handshake", () => {
  const realRaf = (globalThis as any).requestAnimationFrame;
  beforeEach(() => { resetState(); (globalThis as any).requestAnimationFrame = () => 0; });
  afterEach(() => {
    (globalThis as any).requestAnimationFrame = realRaf;
    state.options.silentWifi = false;
  });

  function associate(scriptExtra = "") {
    runConsoleScript(`add laptop LT1 at 0 0\nadd access-point AP1 at 100 0${scriptExtra}\nlink LT1 AP1`);
    const lt = byName("LT1");
    const setup = buildAssociationEvents(lt);
    expect(typeof setup).not.toBe("string");
    state.simulation.autoPlay = true;
    startSimulation(setup as any, lt.id, "", "associate");
    let g = 0; while (state.simulation.status !== "done" && g++ < 200) stepOnce();
    return state.simulation.capture.map(c => packetColumns(c.frame).info);
  }

  it("an open network does probe → auth → association (no WPA2)", () => {
    const seq = associate();
    expect(state.simulation.wifiAssociated).toBe(true);
    expect(seq.some(s => s.startsWith("Probe Request"))).toBe(true);
    expect(seq.some(s => s.includes("Authentication, Open System (seq 1)"))).toBe(true);
    expect(seq.some(s => s.startsWith("Association Response"))).toBe(true);
    expect(seq.some(s => s.includes("Message 1 of 4"))).toBe(false);
  });

  it("a secured network adds the WPA2 4-way handshake (M1–M4)", () => {
    const seq = associate("\nssid AP1 Secure pass1234\nssid LT1 Secure pass1234");
    expect(state.simulation.wifiAssociated).toBe(true);
    for (const m of [1, 2, 3, 4]) expect(seq.some(s => s.includes(`Message ${m} of 4`))).toBe(true);
  });

  it("the management frames are EAPOL/802.11, not Ethernet data", () => {
    associate();
    const protocols = new Set(state.simulation.capture.map(c => packetColumns(c.frame).protocol));
    expect(protocols.has("802.11")).toBe(true);
    expect(protocols.has("ICMP")).toBe(false);
  });

  it("`run associate` is headless and reports success; an unlinked laptop errors", () => {
    runConsoleScript("add laptop LT1 at 0 0\nadd access-point AP1 at 100 0\nlink LT1 AP1");
    expect(runConsoleScript("run associate LT1")[0].ok).toBe(true);
    runConsoleScript("add laptop LT9 at 0 200"); // no AP link
    const r = runConsoleScript("run associate LT9")[0];
    expect(r.ok).toBe(false);
    expect(r.output.join(" ")).toMatch(/not associated/i);
  });

  it("a wrong password fails the join: deauth at the WPA2 handshake, no connectivity", () => {
    const seq = associate("\nssid AP1 Secure right123\nssid LT1 Secure wrong999");
    expect(state.simulation.wifiAssociated).toBe(false);             // the join failed
    expect(seq.some(s => s.includes("Association Response"))).toBe(true); // assoc succeeded…
    expect(seq.some(s => s.includes("Message 2 of 4"))).toBe(true);       // …M1/M2 exchanged…
    expect(seq.some(s => s.includes("Deauthentication"))).toBe(true);     // …then deauth
    expect(seq.some(s => s.includes("Message 3 of 4"))).toBe(false);      // never reached M3
    // The unauthenticated association carries no data.
    runConsoleScript("add switch SW at 200 0\nadd router R1 at 300 0\nlink AP1 SW\nlink SW R1\ninterface R1 SW ip 10.9.0.1\nip LT1 10.9.0.10/24\ngateway LT1 10.9.0.1");
    expect(runConsoleScript("run ping LT1 10.9.0.1")[0].ok).toBe(false);
  });

  it("Silent WiFi association resolves but keeps the frames out of the packet list", () => {
    state.options.silentWifi = true;
    const seq = associate();
    expect(state.simulation.wifiAssociated).toBe(true); // still handled
    expect(seq.length).toBe(0);                          // …just not shown
  });

  // R15: the SSID was enforced only at link creation. Re-pointing the laptop at
  // another network after associating must fail the join at runtime, not sail
  // through probe → auth → assoc and carry data.
  it("re-pointing the laptop's SSID after associating stalls the handshake at the probe (R15)", () => {
    runConsoleScript("add laptop LT1 at 0 0\nadd access-point AP1 at 100 0\nlink LT1 AP1\nssid LT1 OtherNet");
    const lt = byName("LT1");
    const setup = buildAssociationEvents(lt);
    expect(typeof setup).not.toBe("string");
    state.simulation.autoPlay = true;
    startSimulation(setup as any, lt.id, "", "associate");
    let g = 0; while (state.simulation.status !== "done" && g++ < 200) stepOnce();
    expect(state.simulation.wifiAssociated).toBe(false);                 // the join failed
    const seq = state.simulation.capture.map(c => packetColumns(c.frame).info);
    expect(seq.some(s => s.startsWith("Probe Request"))).toBe(true);     // it did probe…
    expect(seq.some(s => s.includes("Association Response"))).toBe(false); // …but the AP ignored it
    expect(state.simulation.wifiFailure || "").toMatch(/broadcasts .*not/);
  });

  it("a desynced-SSID association carries no data; the reason names the SSID, not the password (R15)", () => {
    runConsoleScript("add laptop LT1 at 0 0\nadd access-point AP1 at 100 0\nlink LT1 AP1\nadd switch SW at 200 0\nadd router R1 at 300 0\nlink AP1 SW\nlink SW R1\ninterface R1 SW ip 10.9.0.1\nip LT1 10.9.0.10/24\ngateway LT1 10.9.0.1\nssid LT1 OtherNet");
    const r = runConsoleScript("run ping LT1 10.9.0.1")[0];
    expect(r.ok).toBe(false);
    expect(r.output.join(" ")).toMatch(/OtherNet/);              // the SSID mismatch, not a password
  });

  it("the live gate distinguishes a wrong SSID from a wrong password (R15)", () => {
    runConsoleScript("add laptop LT1 at 0 0\nadd access-point AP1 at 100 0\nssid AP1 Secure pw123456\nssid LT1 Secure pw123456\nlink LT1 AP1");
    const link = state.links.find(l => l.wireless)!;
    expect(wifiLinkBlockReason(link)).toBeNull();                // SSID + password match
    runConsoleScript("ssid LT1 Secure wrongpass");               // password differs, SSID matches
    expect(wifiLinkBlockReason(link)).toMatch(/password/);
    runConsoleScript("ssid LT1 OtherNet");                       // now the SSID differs
    expect(wifiLinkBlockReason(link)).toMatch(/is set to join "OtherNet"/);
  });

  it("`run associate` on a desynced laptop fails and names the SSID mismatch (R15)", () => {
    runConsoleScript("add laptop LT1 at 0 0\nadd access-point AP1 at 100 0\nlink LT1 AP1\nssid LT1 OtherNet");
    const r = runConsoleScript("run associate LT1")[0];
    expect(r.ok).toBe(false);
    expect(r.output.join(" ")).toMatch(/broadcasts|OtherNet/);   // the diagnosis surfaced
  });
});

describe("wifi — staff/guest VLAN built-in topology", () => {
  beforeEach(() => resetState());

  const ping = (src: string, ip: string) => runConsoleScript(`run ping ${src} ${ip}`)[0].ok;

  it("intra-VLAN traffic and the per-VLAN gateways are reachable", () => {
    runConsoleScript("topology wifi-vlan");
    expect(ping("Staff-LT1", "10.0.10.1")).toBe(true);   // staff → its gateway
    expect(ping("Staff-LT1", "10.0.10.12")).toBe(true);  // staff ↔ staff (same SSID/VLAN, via the AP)
    expect(ping("Guest-LT", "10.0.20.1")).toBe(true);    // guest → its gateway
  });

  it("guests are isolated from the staff subnet (FORWARD drop on the gateway)", () => {
    runConsoleScript("topology wifi-vlan");
    expect(ping("Guest-LT", "10.0.10.11")).toBe(false);  // guest → staff is dropped by the router
  });

  it("the shared server (VLAN 30) is reachable from every VLAN", () => {
    runConsoleScript("topology wifi-vlan");
    expect(ping("Staff-LT1", "10.0.30.10")).toBe(true);  // staff → server
    expect(ping("Guest-LT", "10.0.30.10")).toBe(true);   // guest → server (isolation is only guest→staff)
    // …and both VLANs resolve names via that server
    expect(runConsoleScript("run resolve Staff-LT1 server.lan")[0].ok).toBe(true);
    expect(runConsoleScript("run resolve Guest-LT server.lan")[0].ok).toBe(true);
  });

  it("the two SSIDs live on different VLANs", () => {
    runConsoleScript("topology wifi-vlan");
    expect(byName("Staff-AP").config.ssid).toBe("Staff");
    expect(byName("Staff-AP").config.wifiPassword).toBe("staff1234"); // secured
    expect(byName("Guest-AP").config.ssid).toBe("Guest");
    expect(byName("Guest-AP").config.wifiPassword).toBeFalsy();        // open
    const core = byName("Core-SW");
    expect(core.config.portVlans!.Ethernet2).toBe(10); // staff AP uplink
    expect(core.config.portVlans!.Ethernet3).toBe(20); // guest AP uplink
  });
});
