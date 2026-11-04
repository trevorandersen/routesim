/**
 * Inspector render-helper tests. These functions return HTML strings built
 * from device config + topology state, so they can be asserted on directly.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { state, undo } from "../src/state";
import { renderSwitchPorts, renderSwitchVlans, renderRouterInterfaces, renderFramePanel, ipSourceInfo, syncPanel } from "../src/inspector";
import { findTransitAt } from "../src/canvas";
import { createIcmpEchoRequest, createTcpSegment } from "../src/frame";
import { dom } from "../src/dom";
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
