/**
 * Inspector render-helper tests. These functions return HTML strings built
 * from device config + topology state, so they can be asserted on directly.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { state, undo, registerCallbacks } from "../src/state";
import { runStpConvergence } from "../src/stp";
import { setDevicePower, setLinkShutdown, setSwitchManaged, toggleLinkShutdown } from "../src/devices";
import { renderSwitchPorts, renderSwitchVlans, renderRouterInterfaces, renderFramePanel, ipSourceInfo, syncPanel, INSPECTOR_SECTIONS, inspectorSectionsFor } from "../src/inspector";
import { DEVICE_SPECS, USER_ADDABLE_TYPES } from "../src/device-registry";
import { addDevice, collapseLan } from "../src/devices";
import { findTransitAt } from "../src/canvas";
import { createIcmpEchoRequest, createTcpSegment } from "../src/frame";
import { dom } from "../src/dom";
import { runConsoleScript, runConsoleCommand as exec, exportTopologyScript } from "../src/commands";
import { setDhcpRange, setDhcpRouterOption, setListeningPorts } from "../src/terminal";
import { buildConfigPayload, parseConfig } from "../src/config";
import { wiredPortCapacity } from "../src/devices";
import { clampFirewallPortCount } from "../src/utils";
import { registerNoopCallbacks, resetState } from "./helpers";
import { installMiniDom, typeInto, MiniEvent, type MiniElement } from "./mini-dom";
import { basicTopology, routedTopology, vlanTopology } from "./fixtures";

beforeAll(() => registerNoopCallbacks());

describe("ipSourceInfo — the address-source badge", () => {
  it("maps the source field (and bare IPs) to a label", () => {
    expect(ipSourceInfo({ ipv4Address: "" })).toMatchObject({ cls: "none", text: "unassigned" });
    expect(ipSourceInfo(undefined)).toMatchObject({ cls: "none" });
    // A configured IP with no recorded source reads as static.
    expect(ipSourceInfo({ ipv4Address: "10.0.0.5" })).toMatchObject({ cls: "static", text: "static" });
    expect(ipSourceInfo({ ipv4Address: "10.0.0.5", ipSource: "static" })).toMatchObject({ cls: "static" });
    expect(ipSourceInfo({ ipv4Address: "10.0.0.5", ipSource: "dhcp" })).toMatchObject({ cls: "dhcp", text: "DHCP" });
    expect(ipSourceInfo({ ipv4Address: "169.254.1.2", ipSource: "apipa" })).toMatchObject({ cls: "apipa", text: "APIPA" });
  });
});

describe("renderSwitchPorts", () => {
  beforeEach(() => resetState());

  it("renders mode + VLAN selects for a managed switch", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const msw = state.devices.find(d => d.id === "msw")!;
    const html = renderSwitchPorts(msw);
    expect(html).toContain("port-mode-select");
    // access ports use a VLAN select; the trunk port uses a native-VLAN select
    expect(html).toContain("port-vlan-select");
    expect(html).toContain("port-native-select");
  });

  it("renders no VLAN/mode controls for an unmanaged switch", () => {
    const topo = basicTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const sw = state.devices.find(d => d.id === "sw1")!;
    const html = renderSwitchPorts(sw);
    expect(html).not.toContain("port-mode-select");
    expect(html).not.toContain("port-vlan-select");
  });
});

describe("renderRouterInterfaces", () => {
  beforeEach(() => resetState());

  it("stacks each interface: name + peer in a head, the address/prefix input below", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const rtr = state.devices.find(d => d.id === "rtr")!;
    const html = renderRouterInterfaces(rtr);
    // The head wraps the name + peer so they share a line above the input.
    expect(html).toContain("interface-head");
    expect(html).toContain(`<span class="interface-name">Ethernet1</span>`);
    expect(html).toContain("SW-A"); // the connected peer's name
    // The editable IP carries its prefix and stays a separate full-width input.
    expect(html).toContain("router-interface-ip");
    expect(html).toContain("192.168.10.1/24");
  });

  it("a connected interface gets an unlink button; an empty one reads 'not connected'", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const rtr = state.devices.find(d => d.id === "rtr")!;
    const html = renderRouterInterfaces(rtr);
    // Ethernet1/2 are cabled → an unlink (×) keyed by peer; empty ports are not.
    expect(html).toContain("iface-unlink");
    expect(html).toContain('data-peer-id="sw-a"');
    // Empty ports (rtr has 4 Ethernet, 2 used) read "not connected".
    expect(html).toContain("not connected");
  });

  it("an unconnected port's IP input is enabled and keyed by interface name", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const rtr = state.devices.find(d => d.id === "rtr")!;
    const html = renderRouterInterfaces(rtr);
    // Empty ports carry data-iface-name (so an IP can persist) and are never disabled.
    expect(html).toContain('data-iface-name="Ethernet3"');
    expect(html).not.toContain("disabled");
  });
});

describe("renderSwitchVlans", () => {
  beforeEach(() => resetState());

  it("renders a chip per VLAN plus an add control", () => {
    const topo = vlanTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const msw = state.devices.find(d => d.id === "msw")!;
    const html = renderSwitchVlans(msw);
    expect(html).toContain("vlan-chip");
    expect(html).toContain("addVlanBtn");
    // VLAN 10 (Sales) and 20 (Engineering) defined in the fixture
    expect(html).toContain("Sales");
    expect(html).toContain("Engineering");
  });
});

describe("click-a-packet frame inspector", () => {
  beforeEach(() => resetState());

  it("findTransitAt hit-tests the interpolated dot position", () => {
    state.devices = [
      { id: "a", type: "computer", name: "A", x: 0, y: 0, width: 92, height: 68, config: {} },
      { id: "b", type: "computer", name: "B", x: 200, y: 0, width: 92, height: 68, config: {} },
    ] as any;
    const frame = createIcmpEchoRequest("02:00:00:00:00:01", "02:00:00:00:00:02", "10.0.0.1", "10.0.0.2", 64);
    state.simulation.transits = [{ frame, linkId: "l1", fromDeviceId: "a", toDeviceId: "b", progress: 0.5, startTime: 0 }];
    expect(findTransitAt({ x: 100, y: 0 })?.frame.id).toBe(frame.id);   // on the dot
    expect(findTransitAt({ x: 100, y: 10 })?.frame.id).toBe(frame.id);  // within radius
    expect(findTransitAt({ x: 150, y: 0 })).toBeNull();                 // off the dot
  });

  it("renderFramePanel shows the field breakdown for a TCP frame", () => {
    const frame = createTcpSegment("02:00:00:00:00:01", "02:00:00:00:00:02", "10.0.0.1", "10.0.0.2", 31000, 443, "syn");
    renderFramePanel(frame);
    const html = (dom.detailsPanel as any).innerHTML as string;
    expect(html).toContain("10.0.0.1");
    expect(html).toContain("443");
    expect(html).toContain("SYN");
    expect(html).toContain("6 (TCP)");
  });
});

// These drive the real syncPanel wiring over a parsed element tree
// (tests/mini-dom.ts): a port-count spinner re-renders only the interface /
// port rows, and the rows' controls must still work afterwards — exactly
// once each.
describe("inspector wiring survives a port-count re-render", () => {
  let mini: ReturnType<typeof installMiniDom>;
  beforeEach(() => {
    resetState();
    mini = installMiniDom();
  });
  afterEach(() => mini.uninstall());

  const load = (topo: { devices: unknown[]; links: unknown[] }, id: string) => {
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    state.selectedId = id;
    syncPanel();
    return state.devices.find(d => d.id === id)!;
  };
  const byId = (id: string): MiniElement => {
    const el = mini.panel.getElementById(id);
    if (!el) throw new Error(`#${id} not rendered`);
    return el;
  };
  const one = (selector: string): MiniElement => {
    const el = mini.panel.querySelector(selector);
    if (!el) throw new Error(`${selector} not rendered`);
    return el;
  };

  it("R6: an interface IP typed after raising the router's port count reaches the config", () => {
    const rtr = load(routedTopology(), "rtr");
    typeInto(byId("selectedRouterEthernetPorts"), "6");
    byId("selectedRouterEthernetPorts").blur();
    // The new port is rendered, and typing into it updates the router's config.
    const eth5 = one('.router-interface-ip[data-iface-name="Ethernet5"]');
    typeInto(eth5, "10.0.5.1/24");
    eth5.blur();
    const iface = rtr.config!.interfaces!.find((i: any) => i.name === "Ethernet5");
    expect(iface).toMatchObject({ ipv4Address: "10.0.5.1", prefixLength: 24 });
    expect(eth5.title).toBe("Subnet: 10.0.5.0/24");
    // A connected row re-rendered by the same spinner is live too.
    typeInto(one('.router-interface-ip[data-peer-id="sw-a"]'), "192.168.11.1/24");
    expect(rtr.config!.interfaces!.find((i: any) => i.peerId === "sw-a")!.ipv4Address).toBe("192.168.11.1");
  });

  it("R6: the delegated edit is one undo step, and an invalid entry is flagged, not stored", () => {
    const rtr = load(routedTopology(), "rtr");
    typeInto(byId("selectedRouterSerialPorts"), "3");
    byId("selectedRouterSerialPorts").blur();
    const before = state.undoStack.length;
    const eth1 = one('.router-interface-ip[data-peer-id="sw-a"]');
    typeInto(eth1, "10.9.9");
    expect(eth1.validationMessage).toContain("valid IPv4");
    expect(rtr.config!.interfaces!.find((i: any) => i.peerId === "sw-a")!.ipv4Address).toBe("192.168.10.1");
    eth1.value = "10.9.9.1/24";
    eth1.dispatchEvent(new MiniEvent("input"));
    expect(eth1.validationMessage).toBe("");
    eth1.blur();
    expect(state.undoStack.length).toBe(before + 1);
    undo();
    const restored = state.devices.find(d => d.id === "rtr")!;
    expect(restored.config!.interfaces!.find((i: any) => i.peerId === "sw-a")!.ipv4Address).toBe("192.168.10.1");
  });

  it("R6: the unlink button on a re-rendered row still removes that cable", () => {
    load(routedTopology(), "rtr");
    typeInto(byId("selectedRouterEthernetPorts"), "5");
    one('.iface-unlink[data-peer-id="sw-b"]').click();
    expect(state.links.some(l => l.id === "l4")).toBe(false);
    expect(state.selectedId).toBe("rtr");
  });

  it("R90: Add VLAN after a switch port-count change adds once, with one undo entry", () => {
    const msw = load(vlanTopology(), "msw");
    typeInto(byId("selectedPorts"), "10");
    typeInto(byId("selectedPorts"), "12"); // several spinner steps
    byId("selectedPorts").blur();
    const before = state.undoStack.length;
    byId("addVlanId").value = "30";
    byId("addVlanBtn").click();
    expect(msw.config!.vlans!.map((v: any) => v.id)).toContain(30);
    expect(state.undoStack.length).toBe(before + 1);
  });

  it("R90: the re-rendered port rows' mode select and remove button still work", () => {
    const msw = load(vlanTopology(), "msw");
    typeInto(byId("selectedPorts"), "10");
    const mode = one('.port-mode-select[data-port="Ethernet2"]');
    mode.value = "trunk";
    mode.dispatchEvent(new MiniEvent("change"));
    expect(msw.config!.portModes!.Ethernet2).toBe("trunk");
    // The remove button's click usually lands on its SVG child.
    const removeIcon = one(".port-remove").querySelector("path")!;
    const linkId = one(".port-remove").dataset.linkId!;
    removeIcon.click();
    expect(state.links.some(l => l.id === linkId)).toBe(false);
  });
});

// R57: the inspector wrote the DHCP range one field and one keystroke at a time
// with its own (weaker) check, so it could store an inverted range the dnsmasq
// shell refuses — the engine then reported "no addresses available", and the
// exported script would not replay. The ports field re-implemented `ports`.
describe("server fields commit through the shell's mutators (R57)", () => {
  let mini: ReturnType<typeof installMiniDom>;
  beforeEach(() => {
    resetState();
    mini = installMiniDom();
    runConsoleScript("add server SRV at 100 100\nadd switch SW at 300 100\nadd computer PC at 500 100\nlink SRV SW\nlink PC SW\nip SRV 192.168.1.2/24");
    state.selectedId = srv().id;
    state.configuringId = srv().id;
    syncPanel();
  });
  afterEach(() => mini.uninstall());

  const srv = () => state.devices.find(d => d.name === "SRV")!;
  const field = (id: string): MiniElement => {
    const el = mini.panel.getElementById(id);
    if (!el) throw new Error(`#${id} not rendered`);
    return el;
  };
  // What a user does: type, then leave the field (or press Enter).
  const commit = (id: string, text: string) => {
    const input = field(id);
    input.focus();
    input.value = text;
    input.dispatchEvent(new MiniEvent("input"));
    input.dispatchEvent(new MiniEvent("change"));
  };

  it("the range is stored only once both bounds are in, and in one undo step", () => {
    const undoPoints = state.undoStack.length;
    commit("dhcpRangeStart", "192.168.1.100");
    expect(srv().config!.dhcpRangeStart).toBeUndefined();        // half a range is not stored
    expect(state.undoStack.length).toBe(undoPoints);
    commit("dhcpRangeEnd", "192.168.1.200");
    expect(srv().config!.dhcpRangeStart).toBe("192.168.1.100");
    expect(srv().config!.dhcpRangeEnd).toBe("192.168.1.200");
    expect(state.undoStack.length).toBe(undoPoints + 1);
    undo();
    expect(srv().config!.dhcpRangeStart).toBeUndefined();
  });

  it("typing does not write the config; only committing does", () => {
    setDhcpRange(srv(), "192.168.1.100", "192.168.1.200"); syncPanel();
    typeInto(field("dhcpRangeEnd"), "192.168.1.1");               // input events only
    expect(srv().config!.dhcpRangeEnd).toBe("192.168.1.200");
  });

  it("the review's case: an inverted range is refused, with the shell's reason, and nothing is stored", () => {
    setDhcpRange(srv(), "192.168.1.100", "192.168.1.200"); syncPanel();
    const undoPoints = state.undoStack.length;
    commit("dhcpRangeEnd", "192.168.1.50");
    expect(srv().config!.dhcpRangeEnd).toBe("192.168.1.200");
    expect(field("dhcpRangeEnd").validationMessage).toBe("dhcp-range end 192.168.1.50 is before start 192.168.1.100");
    expect(dom.modeLabel.textContent).toContain("is before start");
    expect(state.undoStack.length).toBe(undoPoints);
  });

  it("a bad address is refused the same way", () => {
    setDhcpRange(srv(), "192.168.1.100", "192.168.1.200"); syncPanel();
    commit("dhcpRangeStart", "192.168.1.999");
    expect(srv().config!.dhcpRangeStart).toBe("192.168.1.100");
    expect(field("dhcpRangeStart").validationMessage).toContain("is not an IPv4 address");
  });

  it("emptying both fields turns DHCP off; emptying one of a stored range is refused", () => {
    setDhcpRange(srv(), "192.168.1.100", "192.168.1.200"); syncPanel();
    commit("dhcpRangeEnd", "");
    expect(srv().config!.dhcpRangeEnd).toBe("192.168.1.200");
    expect(field("dhcpRangeEnd").validationMessage).toContain("needs both a start and an end");
    field("dhcpRangeStart").value = "";
    commit("dhcpRangeEnd", "");
    expect(srv().config!.dhcpRangeStart).toBeUndefined();
    expect(srv().config!.dhcpRangeEnd).toBeUndefined();
  });

  it("a range set in the inspector leases, exports, and replays", () => {
    commit("dhcpRangeStart", "192.168.1.100");
    commit("dhcpRangeEnd", "192.168.1.200");
    expect(exec("run dhcp PC").ok).toBe(true);
    const script = exportTopologyScript();
    expect(script).toContain("dhcp-range=192.168.1.100,192.168.1.200");
    expect(runConsoleScript(script).filter(r => !r.ok)).toEqual([]);
  });

  it("the router option validates and clears through its mutator", () => {
    commit("dhcpRouterIp", "192.168.1.1");
    expect(srv().config!.dhcpRouterIp).toBe("192.168.1.1");
    commit("dhcpRouterIp", "gateway");
    expect(srv().config!.dhcpRouterIp).toBe("192.168.1.1");
    expect(field("dhcpRouterIp").validationMessage).toContain("is not an IPv4 address");
    commit("dhcpRouterIp", "");
    expect(srv().config!.dhcpRouterIp).toBeUndefined();
  });

  it("the ports field uses the `ports` command's mutator: list, de-duplicate, validate, clear", () => {
    commit("listenPorts", "80, 443, 80");
    expect(srv().config!.openPorts).toEqual([80, 443]);
    expect(dom.modeLabel.textContent).toBe("SRV listening on 80, 443.");
    commit("listenPorts", "80, 70000");
    expect(srv().config!.openPorts).toEqual([80, 443]);
    expect(field("listenPorts").validationMessage).toContain("1–65535");
    commit("listenPorts", "");
    expect(srv().config!.openPorts).toBeUndefined();              // cleared = accept on any port, not []
  });

  it("the shell and the console reach the same mutators", () => {
    expect(exec("cli SRV echo dhcp-range=192.168.1.200,192.168.1.100 >> /etc/dnsmasq.conf").output.join(" "))
      .toContain("dnsmasq: dhcp-range end 192.168.1.100 is before start 192.168.1.200");
    expect(exec("cli SRV echo dhcp-range=192.168.1.x,192.168.1.100 >> /etc/dnsmasq.conf").output.join(" ")).toContain("dnsmasq: bad dhcp-range");
    expect(exec("cli SRV echo dhcp-option=option:router,nope >> /etc/dnsmasq.conf").output.join(" ")).toContain("dnsmasq: bad dhcp-option");
    expect(exec("ports SRV 22 8080").output).toEqual(["SRV listening on 22, 8080."]);
    expect(exec("ports SRV closed").output).toEqual(["SRV: no listening ports (refuses every connection)."]);
    expect(srv().config!.openPorts).toEqual([]);
    expect(exec("ports SRV 0").ok).toBe(false);
    expect(exec("ports SW 80").output.join(" ")).toContain("not a host");
  });

  it("the mutators report through results, with no undo point for a refusal", () => {
    const undoPoints = state.undoStack.length;
    expect(setDhcpRange(srv(), "10.0.0.9", "10.0.0.1")).toMatchObject({ ok: false });
    expect(setDhcpRouterOption(srv(), "x")).toMatchObject({ ok: false });
    expect(setListeningPorts(srv(), [1.5])).toMatchObject({ ok: false });
    expect(setDhcpRange(srv(), "", "")).toMatchObject({ ok: true });     // already off: nothing to do
    expect(state.undoStack.length).toBe(undoPoints);
    expect(setDhcpRange(srv(), "10.0.0.1", "10.0.0.9")).toMatchObject({ ok: true, message: "SRV: DHCP range 10.0.0.1 – 10.0.0.9." });
  });
});

// R46: the inspector's Managed toggle and the power buttons changed the state by
// hand and skipped the spanning-tree recompute the console commands do, so stale
// "blocked" dashes, the root badge and port roles stayed on screen until the
// next run. Every front door now calls one mutator per action.
describe("shut, power and managed recompute the spanning tree from every front door (R46)", () => {
  let mini: ReturnType<typeof installMiniDom>;
  let seen: string[];
  const blocked = () => state.links.filter(l => l.stpBlocked).length;
  beforeEach(() => {
    resetState();
    mini = installMiniDom();
    seen = [];
    registerCallbacks({
      render() {}, syncTerminal() {}, resizeCanvas() {}, syncScenarioPanel() {}, syncCoordReadout() {}, syncOptionControls() {}, syncSimLog() {},
      recomputeStp: () => { runStpConvergence(); seen.push("stp"); },
      syncPanel: () => { seen.push(`panel:${blocked()}`); syncPanel(); },   // what the inspector draws from
    });
    // Three managed switches in a triangle: spanning tree blocks one cable.
    runConsoleScript("add switch S1 at 100 100\nadd switch S2 at 400 100\nadd switch S3 at 250 300\nmanaged S1 on\nmanaged S2 on\nmanaged S3 on\nlink S1 S2\nlink S2 S3\nlink S3 S1");
    seen.length = 0;
  });
  afterEach(() => { mini.uninstall(); registerNoopCallbacks(); });

  const dev = (name: string) => state.devices.find(d => d.name === name)!;
  const el = (id: string): MiniElement => {
    const found = mini.panel.getElementById(id);
    if (!found) throw new Error(`#${id} not rendered`);
    return found;
  };
  const configure = (name: string) => { state.selectedLinkId = null; state.selectedId = dev(name).id; state.configuringId = dev(name).id; syncPanel(); };
  const setChecked = (id: string, on: boolean) => { const input = el(id); input.checked = on; input.dispatchEvent(new MiniEvent("change")); };
  // The tree was recomputed, and before the panel was redrawn from it.
  const recomputedFirst = () => seen.includes("stp") && seen.indexOf("stp") < seen.findIndex(s => s.startsWith("panel:"));

  it("starts with one blocked cable", () => {
    expect(blocked()).toBe(1);
  });

  it("the inspector's Managed toggle recomputes: an unmanaged switch leaves the tree", () => {
    configure("S3");
    setChecked("selectedManaged", false);
    expect(dev("S3").config!.managed).toBe(false);
    expect(blocked()).toBe(0);                                    // no longer a loop of bridges
    expect(recomputedFirst()).toBe(true);
    seen.length = 0;
    configure("S3");
    setChecked("selectedManaged", true);
    expect(blocked()).toBe(1);
    expect(recomputedFirst()).toBe(true);
  });

  it("the inspector's power button recomputes: a powered-off switch leaves the tree", () => {
    configure("S3");
    el("togglePower").click();
    expect(dev("S3").poweredOff).toBe(true);
    expect(blocked()).toBe(0);
    expect(recomputedFirst()).toBe(true);
    expect(dom.modeLabel.textContent).toBe("S3 powered off.");
    configure("S3");
    el("togglePower").click();
    expect(dev("S3").poweredOff).toBeFalsy();
    expect(blocked()).toBe(1);
  });

  it("the link inspector's shut toggle recomputes before the panel redraws", () => {
    const open = state.links.find(l => !l.stpBlocked)!;
    state.selectedId = null; state.configuringId = null; state.selectedLinkId = open.id; syncPanel();
    seen.length = 0;
    setChecked("selectedLinkShutdown", true);
    expect(open.shutdown).toBe(true);
    expect(blocked()).toBe(0);                                    // the redundant path is now needed
    expect(recomputedFirst()).toBe(true);
    expect(seen.filter(s => s.startsWith("panel:"))[0]).toBe("panel:0");
  });

  it("the console commands and the canvas double-click are the same mutators", () => {
    const undoPoints = state.undoStack.length;
    expect(exec("power S3 off").output).toEqual(["S3 powered off."]);
    expect(blocked()).toBe(0);
    expect(exec("power S3 on").output).toEqual(["S3 powered on."]);
    expect(blocked()).toBe(1);
    expect(exec("managed S3 off").output).toEqual(["S3 is now unmanaged."]);
    expect(blocked()).toBe(0);
    expect(exec("managed S3 on").output).toEqual(["S3 is now managed."]);
    expect(exec("shut S1 S2").output).toEqual(["Link S1 ↔ S2 is now administratively down (shut)."]);
    expect(blocked()).toBe(0);
    expect(exec("noshut S1 S2").output).toEqual(["Link S1 ↔ S2 is now up (no shut)."]);
    expect(blocked()).toBe(1);
    expect(state.undoStack.length).toBe(undoPoints + 6);
    const link = state.links.find(l => !l.stpBlocked)!;
    expect(toggleLinkShutdown(link.id)!.shutdown).toBe(true);
    expect(state.selectedLinkId).toBe(link.id);
    expect(blocked()).toBe(0);
  });

  it("a change that changes nothing takes no undo point and says so", () => {
    const undoPoints = state.undoStack.length;
    expect(setDevicePower(dev("S1"), true)).toMatchObject({ ok: true, message: "S1 is already powered on." });
    expect(setSwitchManaged(dev("S1"), true)).toMatchObject({ ok: true, message: "S1 is already managed." });
    expect(setLinkShutdown(state.links[0], false).message).toContain("is already up");
    expect(exec("shut S1 S2").ok).toBe(true);
    expect(exec("shut S1 S2").output).toEqual(["Link S1 ↔ S2 is already administratively down (shut)."]);
    expect(state.undoStack.length).toBe(undoPoints + 1);
    expect(setSwitchManaged(dev("S1"), false).ok).toBe(true);
    runConsoleScript("add computer PC at 600 100");
    expect(setSwitchManaged(dev("PC"), true)).toMatchObject({ ok: false, error: "PC is not a switch." });
  });

  it("each change is one undo step that restores the tree", () => {
    exec("power S3 off");
    expect(blocked()).toBe(0);
    undo();
    expect(dev("S3").poweredOff).toBeFalsy();
    expect(blocked()).toBe(1);
  });
});

// R45: syncPanel replaces the panel's HTML. Firefox and Safari fire neither blur
// nor change on a focused field removed that way (the mini DOM models this), so
// an edit still being typed was discarded when the learner clicked another
// device or a run finished — and the undo snapshot taken on focus was orphaned.
describe("a panel rebuild commits the field still being edited (R45)", () => {
  let mini: ReturnType<typeof installMiniDom>;
  beforeEach(() => {
    resetState();
    mini = installMiniDom();
    runConsoleScript("add computer PC-A at 100 100\nadd computer PC-B at 100 300\nadd switch SW at 300 200\nadd router R1 at 500 200\nlink PC-A SW\nlink PC-B SW\nlink SW R1");
  });
  afterEach(() => mini.uninstall());

  const dev = (name: string) => state.devices.find(d => d.name === name)!;
  const el = (id: string): MiniElement => {
    const found = mini.panel.getElementById(id);
    if (!found) throw new Error(`#${id} not rendered`);
    return found;
  };
  const configure = (name: string) => { state.selectedLinkId = null; state.selectedId = dev(name).id; state.configuringId = dev(name).id; syncPanel(); };

  it("the review's case: an address typed into PC-A survives clicking PC-B", () => {
    configure("PC-A");
    typeInto(el("selectedIpv4"), "10.0.0.5/24");                 // typed, not yet committed
    expect(dev("PC-A").config!.ipv4Address || "").toBe("");
    configure("PC-B");                                           // what a canvas click does: select, rebuild
    expect(dev("PC-A").config!.ipv4Address).toBe("10.0.0.5");
    expect(dev("PC-B").config!.ipv4Address || "").toBe("");      // committed to the device it was typed for
    expect(mini.panel.getElementById("selectedIpv4")!.value).toBe("");   // and PC-B's own panel is what shows
  });

  it("it is one undo step, like a commit by Enter or Tab", () => {
    configure("PC-A");
    const undoPoints = state.undoStack.length;
    typeInto(el("selectedIpv4"), "10.0.0.5/24");
    configure("PC-B");
    expect(state.undoStack.length).toBe(undoPoints + 1);
    undo();
    expect(dev("PC-A").config!.ipv4Address || "").toBe("");
  });

  it("a rebuild from a finished run (no selection change) commits too", () => {
    configure("PC-A");
    typeInto(el("selectedGateway"), "10.0.0.1");
    syncPanel();                                                 // finishSimulation → syncPanel
    expect(dev("PC-A").config!.gatewayIpv4Address).toBe("10.0.0.1");
  });

  it("a field written per keystroke gets its undo point when the rebuild blurs it", () => {
    const link = state.links[0];
    state.selectedId = null; state.configuringId = null; state.selectedLinkId = link.id; syncPanel();
    const undoPoints = state.undoStack.length;
    typeInto(el("selectedLinkName"), "uplink");
    expect(link.name).toBe("uplink");                            // already written …
    expect(state.undoStack.length).toBe(undoPoints);             // … but its snapshot is still pending on the field
    configure("PC-B");
    expect(state.undoStack.length).toBe(undoPoints + 1);         // not orphaned
    undo();
    expect(state.links[0].name).toBeUndefined();
  });

  it("an untouched focused field commits nothing", () => {
    configure("PC-A");
    const undoPoints = state.undoStack.length;
    el("selectedIpv4").focus();
    configure("PC-B");
    expect(state.undoStack.length).toBe(undoPoints);
  });

  it("a refused value is reported, not stored, and does not stop the rebuild", () => {
    configure("PC-A");
    typeInto(el("selectedIpv4"), "10.0.0.999/24");
    configure("PC-B");
    expect(dev("PC-A").config!.ipv4Address || "").toBe("");
    expect(state.selectedId).toBe(dev("PC-B").id);
    expect(mini.panel.getElementById("selectedIpv4")).not.toBeNull();
  });

  it("focus outside the panel is left alone", () => {
    configure("PC-A");
    const outside = mini.document.createElement("input");
    mini.document.body.appendNode(outside);
    outside.focus();
    syncPanel();
    expect(mini.document.activeElement).toBe(outside);
  });
});

// R92: four inspector edits skipped the undo point or swallowed the mutator's
// error, and the firewall's port count had three different ranges.
describe("inspector edits take an undo point and surface their errors (R92)", () => {
  let mini: ReturnType<typeof installMiniDom>;
  beforeEach(() => { resetState(); mini = installMiniDom(); });
  afterEach(() => mini.uninstall());

  const dev = (name: string) => state.devices.find(d => d.name === name)!;
  const el = (id: string): MiniElement => {
    const found = mini.panel.getElementById(id);
    if (!found) throw new Error(`#${id} not rendered`);
    return found;
  };
  const configure = (name: string) => { state.selectedLinkId = null; state.selectedId = dev(name).id; state.configuringId = dev(name).id; syncPanel(); };
  const commit = (id: string, text: string) => { const input = el(id); input.focus(); input.value = text; input.dispatchEvent(new MiniEvent("input")); input.dispatchEvent(new MiniEvent("change")); };

  it("ticking a Red Team attack is undoable", () => {
    runConsoleScript("add attacker RT at 100 100");
    dev("RT").config!.attacks = ["scan"];
    configure("RT");
    const boxes = mini.panel.querySelectorAll(".attack-check");
    const sweep = boxes.find(b => b.dataset.attack === "sweep")!;
    const undoPoints = state.undoStack.length;
    sweep.checked = true;
    sweep.dispatchEvent(new MiniEvent("change"));
    expect([...dev("RT").config!.attacks!].sort()).toEqual(["scan", "sweep"]);
    expect(state.undoStack.length).toBe(undoPoints + 1);
    undo();
    expect(dev("RT").config!.attacks).toEqual(["scan"]);
  });

  it("Add VLAN reports an invalid id instead of doing nothing", () => {
    runConsoleScript("add switch SW at 100 100\nmanaged SW on");
    configure("SW");
    const undoPoints = state.undoStack.length;
    el("addVlanId").value = "5000";
    el("addVlanBtn").click();
    expect(dom.modeLabel.textContent).toBe("Invalid VLAN ID: 5000 — a VLAN id is a whole number from 1 to 4094.");
    expect(el("addVlanId").validationMessage).toContain("Invalid VLAN ID: 5000");
    expect(state.undoStack.length).toBe(undoPoints);
    el("addVlanId").value = "30";
    el("addVlanBtn").click();
    expect(dom.modeLabel.textContent).toBe("Added VLAN 30.");
    expect(dev("SW").config!.vlans!.some(v => v.id === 30)).toBe(true);
  });

  it("a bad STP priority stays in the field with its reason; a good one is applied and reported", () => {
    runConsoleScript("add switch SW at 100 100\nmanaged SW on");
    configure("SW");
    commit("selectedStpPriority", "5000");
    expect(dev("SW").config!.stp?.priority).toBeUndefined();
    expect(el("selectedStpPriority").value).toBe("5000");         // not silently reverted
    expect(el("selectedStpPriority").validationMessage).toBe("Bridge priority must be 0–61440 in steps of 4096 (got 5000).");
    expect(dom.modeLabel.textContent).toBe("Bridge priority must be 0–61440 in steps of 4096 (got 5000).");
    commit("selectedStpPriority", "4096");
    expect(dev("SW").config!.stp!.priority).toBe(4096);
    expect(dom.modeLabel.textContent).toBe("Bridge priority set to 4096.");
  });

  it("the console and the switch shell state the same priority rule", () => {
    runConsoleScript("add switch SW at 100 100\nmanaged SW on");
    expect(exec("stp SW priority 5000").output.join(" ")).toContain("Bridge priority must be 0–61440 in steps of 4096 (got 5000).");
    expect(exec("cli SW config spanning_tree priority 5000").output.join(" ")).toContain("% Bridge priority must be 0–61440 in steps of 4096 (got 5000).");
    expect(exec("stp SW priority 8192").ok).toBe(true);
  });

  it("the firewall's port count has one range everywhere: 2 to 8", () => {
    runConsoleScript("add firewall FW at 100 100");
    expect([1, 2, 5, 8, 9, 2.5, "x"].map(clampFirewallPortCount)).toEqual([2, 2, 5, 8, 8, 2, 2]);
    expect(wiredPortCapacity(dev("FW"))).toBe(2);
    expect(exec("portcount FW 1").ok).toBe(false);                 // the console used to accept 1
    expect(exec("portcount FW 9").ok).toBe(false);
    expect(exec("portcount FW 3").ok).toBe(true);
    configure("FW");
    expect(el("selectedFwPorts").getAttribute("min")).toBe("2");
    expect(el("selectedFwPorts").getAttribute("max")).toBe("8");
    typeInto(el("selectedFwPorts"), "1");
    expect(el("selectedFwPorts").validationMessage).toBe("Enter a port count from 2 to 8.");
    expect(dev("FW").config!.ethernetPorts).toBe(3);
    typeInto(el("selectedFwPorts"), "6");
    expect(dev("FW").config!.ethernetPorts).toBe(6);
  });

  it("a default two-port firewall keeps two ports through a save and load", () => {
    runConsoleScript("add firewall FW at 100 100");
    const loaded = parseConfig(JSON.stringify(buildConfigPayload()));
    expect(loaded.devices.find((d: any) => d.name === "FW")!.config.ethernetPorts).toBe(2);   // the normaliser used to make it 4
  });
});

// R108: the device panel was one 444-line render-and-bind function with a branch
// per device type in each half. It is now an ordered registry of sections.
describe("the device panel is a registry of sections (R108)", () => {
  let mini: ReturnType<typeof installMiniDom>;
  beforeEach(() => { resetState(); mini = installMiniDom(); });
  afterEach(() => mini.uninstall());

  const sectionIds = (type: (typeof USER_ADDABLE_TYPES)[number]) => inspectorSectionsFor(addDevice(type, 100, 100)).map(s => s.id);

  it("each device type is made of the sections it should be", () => {
    const expected: Record<string, string[]> = {
      computer: ["identity", "actions", "host", "summary"],
      laptop: ["identity", "actions", "host", "summary"],
      server: ["identity", "actions", "host", "summary"],
      kali: ["identity", "actions", "host", "summary"],
      attacker: ["identity", "actions", "host", "red-team", "summary"],
      switch: ["identity", "actions", "switch", "summary"],
      hub: ["identity", "actions", "hub", "summary"],
      "access-point": ["identity", "actions", "access-point", "summary"],
      router: ["identity", "actions", "router", "summary"],
      firewall: ["identity", "actions", "firewall", "summary"],
      ids: ["identity", "actions", "ids", "summary"],
      internet: ["identity", "actions", "summary"],
    };
    for (const type of USER_ADDABLE_TYPES) {
      expect(expected[type], `no expectation for ${type} — a new device type needs its sections listed here`).toBeDefined();
      expect(sectionIds(type), type).toEqual(expected[type]);
    }
  });

  it("section ids are unique, and the panel opens with identity and closes with the summary", () => {
    const ids = INSPECTOR_SECTIONS.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("identity");
    expect(ids[ids.length - 1]).toBe("summary");
  });

  it("every device type renders and binds, selected and configuring, with its own controls", () => {
    const marker: Record<string, string> = {
      computer: "selectedIpv4", laptop: "selectedSsid", server: "dhcpRangeStart", kali: "selectedIpv4", attacker: "selectedAttackTarget",
      switch: "selectedManaged", hub: "selectedPorts", "access-point": "selectedSsid", router: "routerInterfaceList",
      firewall: "selectedFwPorts", ids: "selectedIdsRules", internet: "selectedName",
    };
    for (const type of USER_ADDABLE_TYPES) {
      const device = addDevice(type, 100, 100);
      for (const configuring of [false, true]) {
        state.selectedLinkId = null; state.selectedId = device.id; state.configuringId = configuring ? device.id : null;
        expect(() => syncPanel(), `${type} ${configuring ? "configure" : "select"}`).not.toThrow();
        expect(mini.panel.getElementById("selectedName"), type).not.toBeNull();
        expect(mini.panel.getElementById(marker[type]), `${type} should render #${marker[type]}`).not.toBeNull();
        expect(mini.panel.querySelector(".pill-row"), type).not.toBeNull();
      }
    }
  });

  it("controls a type does not own are absent from its panel", () => {
    const pc = addDevice("computer", 100, 100);
    state.selectedId = pc.id; syncPanel();
    for (const id of ["selectedManaged", "routerInterfaceList", "selectedFwPorts", "selectedIdsRules", "selectedAttackTarget", "selectedSsid", "dhcpRangeStart"]) {
      expect(mini.panel.getElementById(id), id).toBeNull();
    }
    const hub = addDevice("hub", 300, 100);
    state.selectedId = hub.id; syncPanel();
    expect(mini.panel.getElementById("selectedManaged")).toBeNull();   // a hub shares the port field, not the switch's management
    expect(mini.panel.getElementById("switchPortList")).not.toBeNull();
  });

  it("a collapsed LAN shows only its name, the Expand action and the summary", () => {
    runConsoleScript("add switch SW at 100 100\nadd computer PC at 300 100\nlink SW PC");
    collapseLan(state.devices.find(d => d.name === "SW")!);
    const lan = state.devices.find(d => d.type === "lan")!;
    expect(inspectorSectionsFor(lan).map(s => s.id)).toEqual(["identity", "actions", "summary"]);
    state.selectedId = lan.id; syncPanel();
    expect(mini.panel.getElementById("expandSelectedLan")).not.toBeNull();
    expect(mini.panel.getElementById("togglePower")).toBeNull();
  });

  it("every type in the registry of device specs has a panel", () => {
    for (const type of Object.keys(DEVICE_SPECS)) {
      const ids = INSPECTOR_SECTIONS.filter(s => s.applies({ type } as any)).map(s => s.id);
      expect(ids.slice(0, 2), type).toEqual(["identity", "actions"]);
    }
  });
});
