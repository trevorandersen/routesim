/**
 * Inspector render-helper tests. These functions return HTML strings built
 * from device config + topology state, so they can be asserted on directly.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { renderSwitchPorts, renderSwitchVlans, renderFramePanel } from "../src/inspector";
import { findTransitAt } from "../src/canvas";
import { createIcmpEchoRequest, createTcpSegment } from "../src/frame";
import { dom } from "../src/dom";
import { registerNoopCallbacks, resetState } from "./helpers";
import { basicTopology, vlanTopology } from "./fixtures";

beforeAll(() => registerNoopCallbacks());

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
