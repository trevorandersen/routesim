/**
 * Port occupancy — one answer to "which numbered ports of this device are in
 * use?" (review roadmap step 6). Three checks used to disagree:
 *   R28 — the `link` command counted only PINNED cables, so an explicit port
 *         landed on the slot an implicit cable held, shifted that host along
 *         and handed its VLAN to the newcomer;
 *   R29 — a router kept one number space for both media, so with Ethernet3
 *         pinned the picker still offered Serial3 and choosing it gave Serial1;
 *   R32 — the script export invented port 1 for an unpinned end, so ports
 *         swapped on replay.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state, defaultConfig, vlanRoasConfig, routerMeshConfig, wifiVlanConfig } from "../src/state";
import {
  addDevice, addLink, buildPortList, getDevice, linkedPortsFor, linkPortName, occupiedPorts, portBlockReason,
  portMediaFor, routerInterfacesWithNames, switchInterfacesWithNames, collapseLan, expandLan,
} from "../src/devices";
import { openPortSelectionModal, confirmPortSelection } from "../src/port-picker";
import { dom } from "../src/dom";
import { runConsoleScript, runConsoleCommand as exec, exportTopologyScript } from "../src/commands";
import { applyConfigWithoutUndo, buildConfigPayload, parseConfig } from "../src/config";
import { normaliseConfig } from "../src/normalise";
import { SCENARIOS } from "../src/scenarios";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());
beforeEach(() => resetState());

const dev = (name: string) => state.devices.find(d => d.name === name)!;
const linkOf = (a: string, b: string) => state.links.find(l => [l.from, l.to].includes(dev(a).id) && [l.from, l.to].includes(dev(b).id))!;
const portOf = (device: string, peer: string) => linkPortName(linkOf(device, peer), dev(device).id);
const switchPorts = (name: string) => switchInterfacesWithNames(dev(name)).filter(p => p.peer).map(p => `${p.name}→${p.peer?.name}`);
const routerPorts = (name: string) => routerInterfacesWithNames(dev(name), true).map(i => `${i.name}→${i.peer!.name}`);

describe("an explicit port never lands on a cabled port (R28)", () => {
  // PC1 and PC2 cabled implicitly (Ethernet1, Ethernet2); PC1's port is in VLAN 10.
  function lan(): void {
    runConsoleScript(`
      add switch SW1 at 300 100
      managed SW1 on
      add computer PC1 at 100 0
      add computer PC2 at 100 200
      add computer PC3 at 500 100
      link SW1 PC1
      link SW1 PC2
      vlan SW1 add 10
      port SW1 Ethernet1 access 10
    `);
  }

  it("the review's case: `link SW1 PC3 1` does not take PC1's implicit Ethernet1", () => {
    lan();
    const r = exec("link SW1 PC3 1");
    expect(r.ok).toBe(true);
    expect(switchPorts("SW1")).toEqual(["Ethernet1→PC1", "Ethernet2→PC2", "Ethernet3→PC3"]);
    expect(linkOf("SW1", "PC3").fromPort).toBeUndefined();        // not honoured, so not pinned
    expect(switchInterfacesWithNames(dev("SW1")).find(p => p.name === "Ethernet1")!.peer?.name).toBe("PC1");   // VLAN 10 stays PC1's
  });

  it("the command says which port was refused, why, and where the cable went", () => {
    lan();
    const out = exec("link SW1 PC3 1").output.join(" ");
    expect(out).toContain("Linked SW1 ↔ PC3.");
    expect(out).toContain("SW1 Ethernet1 is already cabled to PC1");
    expect(out).toContain("the cable went to SW1 Ethernet3 instead");
  });

  it("a free explicit port is honoured, pinned, and reported plainly", () => {
    lan();
    const r = exec("link SW1 PC3 5");
    expect(r.output).toEqual(["Linked SW1 ↔ PC3."]);
    expect(linkOf("SW1", "PC3").fromPort).toBe(5);
    expect(switchPorts("SW1")).toEqual(["Ethernet1→PC1", "Ethernet2→PC2", "Ethernet5→PC3"]);
  });

  it("a port in the middle of the implicit run is refused too (it would shift the cables after it)", () => {
    lan();
    exec("link SW1 PC3 2");
    expect(switchPorts("SW1")).toEqual(["Ethernet1→PC1", "Ethernet2→PC2", "Ethernet3→PC3"]);
  });

  it("a port the device does not have is refused with its capacity", () => {
    lan();
    const out = exec("link SW1 PC3 12").output.join(" ");
    expect(out).toContain("SW1 has 8 ports, so there is no Ethernet12");
    expect(linkOf("SW1", "PC3").fromPort).toBeUndefined();
    expect(switchPorts("SW1")).toContain("Ethernet3→PC3");
  });

  it("a host has one NIC: port 1 is honoured, any other is refused", () => {
    lan();
    const out = exec("link PC3 SW1 2 6").output.join(" ");
    expect(out).toContain("PC3 has a single NIC (eth0), so it has no port 2");
    expect(linkOf("PC3", "SW1").fromPort).toBeUndefined();
    expect(linkOf("PC3", "SW1").toPort).toBe(6);                  // the switch end was free and is pinned
    expect(portOf("PC3", "SW1")).toBe("eth0");
  });

  it("a pinned port is refused to a second cable, as before", () => {
    lan();
    exec("link SW1 PC3 5");
    runConsoleScript("add computer PC4 at 500 300");
    expect(exec("link SW1 PC4 5").output.join(" ")).toContain("SW1 Ethernet5 is already cabled to PC3");
    expect(portOf("SW1", "PC4")).toBe("Ethernet3");
  });

  it("re-linking an existing cable is a no-op that says so (no false refusal)", () => {
    lan();
    const r = exec("link SW1 PC1 1");                            // PC1 already sits on Ethernet1
    expect(r.ok).toBe(true);
    expect(r.output).toEqual(["SW1 ↔ PC1 are already linked."]);
    expect(state.links.length).toBe(2);
  });

  it("the refused cable is one undo step, like any link", () => {
    lan();
    const before = state.links.length;
    exec("link SW1 PC3 1");
    exec("undo");
    expect(state.links.length).toBe(before);
  });

  it("occupiedPorts counts every cable, pinned or not, and ignores wireless associations", () => {
    lan();
    exec("link SW1 PC3 5");
    expect([...occupiedPorts(dev("SW1").id).keys()]).toEqual([1, 2, 5]);
    expect(occupiedPorts(dev("SW1").id).get(5)!.name).toBe("PC3");
    runConsoleScript("add access-point AP at 700 100\nadd laptop LT at 900 100\nlink LT AP\nlink AP SW1");
    expect([...occupiedPorts(dev("AP").id).keys()]).toEqual([1]);   // the uplink; the association is not a wired port
    expect(occupiedPorts(dev("AP").id).get(1)!.name).toBe("SW1");
  });

  it("addLink (the API under the picker) applies the same rule", () => {
    lan();
    addLink(dev("SW1").id, dev("PC3").id, 1, undefined);
    expect(linkOf("SW1", "PC3").fromPort).toBeUndefined();
    expect(switchPorts("SW1")[0]).toBe("Ethernet1→PC1");
  });
});

describe("a router numbers Ethernet and serial ports separately (R29)", () => {
  // R1 with Ethernet3 pinned to a switch, and a second router to cable.
  function edge(): void {
    runConsoleScript(`
      add router R1 at 300 100
      add router R2 at 600 100
      add switch SW at 100 100
      link R1 SW 3
    `);
  }

  it("the review's case: Serial3 is honoured while Ethernet3 is taken", () => {
    edge();
    expect(portBlockReason(dev("R1").id, dev("R2").id, 3)).toBeNull();
    expect(exec("link R1 R2 3 1").output).toEqual(["Linked R1 ↔ R2."]);
    expect(routerPorts("R1").sort()).toEqual(["Ethernet3→SW", "Serial3→R2"]);
    expect(routerPorts("R2")).toEqual(["Serial1→R1"]);
    expect(linkOf("R1", "R2").fromPort).toBe(3);
  });

  it("an address pre-assigned to Serial3 by name is the one the cable picks up", () => {
    edge();
    exec("cli R1 enable"); exec("cli R1 configure terminal");
    const named = routerInterfacesWithNames(dev("R1")).find(i => i.name === "Serial3")!;
    expect(named.peer).toBeNull();
    exec("link R1 R2 3 1");
    expect(routerPorts("R1")).toContain("Serial3→R2");
  });

  it("both cables survive in linkedPortsFor (the same number no longer overwrites a slot)", () => {
    edge();
    exec("link R1 R2 3 1");
    expect(linkedPortsFor(dev("R1").id).filter(p => p).map(p => p?.peer.name).sort()).toEqual(["R2", "SW"]);
  });

  it("the same media still collides: a second Ethernet3 is refused", () => {
    edge();
    runConsoleScript("add switch SW2 at 100 300");
    const out = exec("link R1 SW2 3").output.join(" ");
    expect(out).toContain("R1 Ethernet3 is already cabled to SW");
    expect(routerPorts("R1").sort()).toEqual(["Ethernet1→SW2", "Ethernet3→SW"]);
  });

  it("an implicit serial cable occupies Serial1 for a later explicit request", () => {
    edge();
    runConsoleScript("add router R3 at 600 300\nlink R1 R2");
    expect(exec("link R1 R3 1 1").output.join(" ")).toContain("R1 Serial1 is already cabled to R2");
    expect(routerPorts("R1").sort()).toEqual(["Ethernet3→SW", "Serial1→R2", "Serial2→R3"]);
  });

  it("capacity is per media", () => {
    edge();
    dev("R1").config!.serialPorts = 2;
    expect(portBlockReason(dev("R1").id, dev("R2").id, 3)).toBe("R1 has 2 serial ports, so there is no Serial3");
    expect(portMediaFor(dev("R1").id, dev("R2").id)).toBe("serial");
    expect(portMediaFor(dev("R1").id, dev("SW").id)).toBe("ethernet");
    expect(portMediaFor(dev("SW").id, dev("R1").id)).toBe("ethernet");
  });

  it("the picker offers only the kind of port the cable will use", () => {
    edge();
    const toRouter = buildPortList(dev("R1").id, dev("R2").id);
    expect(toRouter.every(p => p.name.startsWith("Serial"))).toBe(true);
    expect(toRouter.find(p => p.name === "Serial3")).toMatchObject({ port: 3, available: true });
    const toSwitch = buildPortList(dev("R1").id, getDevice(dev("SW").id)!.id);
    expect(toSwitch.every(p => p.name.startsWith("Ethernet"))).toBe(true);
    expect(toSwitch.find(p => p.name === "Ethernet3")).toMatchObject({ available: false, connectedTo: "SW" });
    expect(buildPortList(dev("R1").id).some(p => p.name.startsWith("Serial"))).toBe(true);   // no peer: every port
  });

  it("the picker modal is built with each end's peer", () => {
    edge();
    openPortSelectionModal(dev("R1").id, dev("R2").id);
    expect(state.portSelection!.fromPorts.every(p => p.name.startsWith("Serial"))).toBe(true);
    expect(state.portSelection!.toPorts.every(p => p.name.startsWith("Serial"))).toBe(true);
    state.portSelection = null;
  });

  it("every port the picker offers as free is one addLink honours, under that name", () => {
    edge();
    for (const option of buildPortList(dev("R1").id, dev("R2").id).filter(p => p.available)) {
      expect(portBlockReason(dev("R1").id, dev("R2").id, option.port)).toBeNull();
    }
    addLink(dev("R1").id, dev("R2").id, 4, 2);
    expect(routerPorts("R1")).toContain("Serial4→R2");
    expect(routerPorts("R2")).toEqual(["Serial2→R1"]);
  });

  it("a JSON import keeps Ethernet3 and Serial3 both pinned", () => {
    edge();
    exec("link R1 R2 3 1");
    const before = routerPorts("R1").sort();
    applyConfigWithoutUndo(parseConfig(JSON.stringify(buildConfigPayload())));
    expect(routerPorts("R1").sort()).toEqual(before);
    expect(state.links.filter(l => l.fromPort === 3).length).toBe(2);
  });
});

describe("the script export never invents a port (R32)", () => {
  it("an unpinned end is written `auto`", () => {
    runConsoleScript("add switch SW at 100 100\nadd computer PC at 300 100\nadd computer PC2 at 300 300\nlink SW PC 4\nlink SW PC2");
    const script = exportTopologyScript();
    expect(script).toContain("link SW PC 4 auto");                 // PC's end was never pinned: auto, not a made-up 1
    expect(script).toContain("link SW PC2 1 auto");                // SW uses pins, so PC2's actual port is stated
    expect(script).not.toMatch(/^link SW PC 4 1$/m);
  });

  it("`auto` and `-` leave an end unpinned; anything else must be a whole number", () => {
    runConsoleScript("add switch SW at 100 100\nadd router R1 at 300 100\nadd switch SW2 at 500 100");
    expect(exec("link R1 SW auto 4").ok).toBe(true);
    expect(linkOf("R1", "SW").fromPort).toBeUndefined();
    expect(linkOf("R1", "SW").toPort).toBe(4);
    expect(exec("link R1 SW2 2 -").ok).toBe(true);
    expect(linkOf("R1", "SW2").fromPort).toBe(2);
    expect(linkOf("R1", "SW2").toPort).toBeUndefined();
    runConsoleScript("add computer PC at 700 100");
    expect(exec("link PC SW2 first 1").ok).toBe(false);
    expect(exec("link PC SW2 1.5 1").ok).toBe(false);
  });

  it("the review's case: a one-sided pin keeps its port, and the lines after it, on replay", () => {
    // As a scenario's JSON has it: PC-A's cable first and unpinned, then PC-B's
    // pinned to SW's port 1 at the SW end only — so PC-B holds Ethernet1.
    applyConfigWithoutUndo(normaliseConfig({
      devices: [
        { id: "sw", type: "switch", name: "SW", x: 300, y: 100, config: { managed: true, ethernetPorts: 8, macTable: [], vlans: [{ id: 20, name: "VLAN20" }], portVlans: { Ethernet1: 20 }, portModes: {} } },
        { id: "a", type: "computer", name: "PC-A", x: 100, y: 0, config: { ipv4Address: "10.0.0.1", macAddress: "02:00:00:00:00:0a" } },
        { id: "b", type: "computer", name: "PC-B", x: 100, y: 200, config: { ipv4Address: "10.0.0.2", macAddress: "02:00:00:00:00:0b" } },
      ],
      links: [{ from: "a", to: "sw" }, { from: "b", to: "sw", toPort: 1 }],
    } as any));
    const vlan20 = () => switchInterfacesWithNames(dev("SW")).find(p => p.vlan === 20)!.peer?.name;
    expect(switchPorts("SW")).toEqual(["Ethernet1→PC-B", "Ethernet2→PC-A"]);
    expect(vlan20()).toBe("PC-B");
    const script = exportTopologyScript();
    expect(script).toContain("link PC-A SW auto 2");               // SW uses pins, so its layout is written out
    expect(script).toContain("link PC-B SW auto 1");
    const results = runConsoleScript(script);
    expect(results.every(r => r.ok)).toBe(true);
    expect(switchPorts("SW")).toEqual(["Ethernet1→PC-B", "Ethernet2→PC-A"]);
    expect(vlan20()).toBe("PC-B");                                 // the VLAN line landed on the same host
    expect(exportTopologyScript()).toBe(script);                   // a fixed point
  });

  it("a device with no pinned cable exports no port numbers at all", () => {
    runConsoleScript("add switch SW at 100 100\nadd computer PC1 at 300 0\nadd computer PC2 at 300 200\nlink SW PC1\nlink SW PC2");
    expect(exportTopologyScript().split("\n").filter(l => l.startsWith("link "))).toEqual(["link SW PC1", "link SW PC2"]);
  });

  // Every cable of every built-in network must sit on the same named port at
  // both ends after an export → replay, with nothing refused on the way.
  const networks: [string, any][] = [
    ["topology:basic", defaultConfig], ["topology:vlan-roas", vlanRoasConfig],
    ["topology:router-mesh", routerMeshConfig], ["topology:wifi-vlan", wifiVlanConfig],
    ...SCENARIOS.map(s => [`scenario:${s.id}`, s.topology] as [string, any]),
  ];
  const cabling = () => state.links
    .map(l => {
      const a = getDevice(l.from)!, b = getDevice(l.to)!;
      const ends = [`${a.name}:${linkPortName(l, a.id)}`, `${b.name}:${linkPortName(l, b.id)}`].sort();
      return ends.join(" ↔ ");
    })
    .sort();
  for (const [name, topology] of networks) {
    it(`${name}: ports survive export → replay`, () => {
      applyConfigWithoutUndo(normaliseConfig(topology));
      const before = cabling();
      const script = exportTopologyScript();
      expect(script).not.toContain("undefined");
      const result = runConsoleScript(script);
      expect(result.filter(r => /instead\.$/.test(r.output.join(" ")))).toEqual([]);   // no port was refused
      expect(cabling()).toEqual(before);
    });
  }
});

// R60 / R80: the model-layer mutators returned void and wrote the status line
// themselves, so console, script and API callers saw a bare "Linked" (or
// "Collapsed") whatever had actually happened.
describe("mutators return what happened (R60, R80)", () => {
  function lan(): void {
    runConsoleScript(`
      add switch SW1 at 300 100
      add computer PC1 at 100 0
      add computer PC2 at 100 200
      add router R1 at 600 100
      link SW1 PC1
    `);
  }

  it("addLink reports a new cable, with the link it made", () => {
    lan();
    const r = addLink(dev("SW1").id, dev("PC2").id);
    expect(r).toMatchObject({ ok: true, created: true, message: "Linked SW1 ↔ PC2.", warnings: [] });
    expect(r.link).toBe(linkOf("SW1", "PC2"));
  });

  it("addLink returns the refusal instead of writing it to the status line", () => {
    lan();
    dom.modeLabel.textContent = "untouched";
    const single = addLink(dev("PC1").id, dev("R1").id);
    expect(single).toMatchObject({ ok: false, created: false });
    expect(single.error).toContain("PC1 has a single NIC");
    expect(addLink(dev("SW1").id, dev("SW1").id).error).toBe("Cannot link a device to itself.");
    expect(dom.modeLabel.textContent).toBe("untouched");
    expect(state.undoStack.length).toBe(5);                     // the five build lines; a refusal adds none
  });

  it("a port that cannot be honoured is a warning on the result, for every caller", () => {
    lan();
    const r = addLink(dev("SW1").id, dev("PC2").id, 1, undefined);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual(["SW1 Ethernet1 is already cabled to PC1, so the cable went to SW1 Ethernet2 instead."]);
  });

  it("a WiFi association with the wrong password is a warning the console sees too", () => {
    runConsoleScript("add access-point AP at 100 100\nadd laptop LT at 300 100\nssid AP Office secret123\nssid LT Office wrongpass");
    const r = exec("link LT AP");
    expect(r.ok).toBe(true);
    expect(r.output.join(" ")).toContain("Linked LT ↔ AP.");
    expect(r.output.join(" ")).toContain("LT associated but not authenticated — wrong WiFi password.");
  });

  it("re-linking with ports the cable is not on says they were not applied", () => {
    lan();
    const r = exec("link SW1 PC1 5");
    expect(r.ok).toBe(true);
    expect(r.output.join(" ")).toContain("already linked");
    expect(r.output.join(" ")).toContain("The requested ports were not applied: the cable stays on SW1 Ethernet1 ↔ PC1 eth0");
    expect(linkOf("SW1", "PC1").fromPort).toBeUndefined();
    const quiet = addLink(dev("SW1").id, dev("PC1").id);
    expect(quiet).toMatchObject({ ok: true, created: false, warnings: [] });
  });

  it("the `link` command's refusals come from addLink (one validation, not two)", () => {
    lan();
    const r = exec("link PC1 R1");
    expect(r.ok).toBe(false);
    expect(r.output.join(" ")).toContain("single NIC");
  });

  it("the Connect tool and the port picker show the same text the console returns", () => {
    lan();
    openPortSelectionModal(dev("PC1").id, dev("R1").id);         // PC1's one NIC is taken
    state.portSelection!.selectedTo = 1;
    confirmPortSelection();
    expect(dom.modeLabel.textContent).toContain("PC1 has a single NIC");
    expect(state.portSelection).toBeNull();
    openPortSelectionModal(dev("SW1").id, dev("R1").id);
    state.portSelection!.selectedFrom = 4; state.portSelection!.selectedTo = 2;
    confirmPortSelection();
    expect(dom.modeLabel.textContent).toBe("Linked SW1 ↔ R1.");
    expect(portOf("SW1", "R1")).toBe("Ethernet4");
    expect(portOf("R1", "SW1")).toBe("Ethernet2");
  });

  it("collapse reports what it did, and refuses each no-op with its reason (R80)", () => {
    lan();
    exec("link SW1 PC2"); exec("link SW1 R1");
    expect(exec("collapse PC1")).toMatchObject({ ok: false });
    expect(exec("collapse PC1").output.join(" ")).toContain("PC1 is not a switch");
    runConsoleScript("add switch LONELY at 900 100");
    expect(exec("collapse LONELY").output.join(" ")).toContain("LONELY has none");
    const undoPoints = state.undoStack.length;
    expect(exec("collapse LONELY").ok).toBe(false);
    expect(state.undoStack.length).toBe(undoPoints);             // a refused collapse is no undo point
    const done = exec("collapse SW1");
    expect(done.ok).toBe(true);
    expect(done.output).toEqual(["Collapsed 3 devices into SW1 LAN."]);
    expect(collapseLan(dev("SW1")).error).toContain("already inside a collapsed LAN");
  });

  it("expand reports what it did, and refuses a target that is not a collapsed LAN (R80)", () => {
    lan();
    exec("link SW1 PC2");
    expect(exec("expand SW1")).toMatchObject({ ok: false });
    expect(exec("expand SW1").output.join(" ")).toContain("SW1 is not a collapsed LAN");
    exec("collapse SW1");
    const r = expandLan(dev("SW1 LAN"));
    expect(r).toMatchObject({ ok: true, message: "Expanded SW1 LAN.", warnings: [] });
    expect(state.devices.some(d => d.type === "lan")).toBe(false);
  });
});
