import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { addDevice, addLink, deleteSelection, clearNetwork, findDeviceAt, getDevice, connectedIds, linkedPortsFor, routerInterfaceForName, routerInterfacesWithNames } from "../src/devices";
import { freshNameCounters } from "../src/device-registry";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => {
  registerNoopCallbacks();
});

describe("routerInterfaceForName — IP on an unconnected port", () => {
  beforeEach(() => { resetState(); state.nameCounters = freshNameCounters(); });

  it("persists an address assigned to an empty port across re-enumeration", () => {
    const rtr = addDevice("router", 0, 0);
    // No cable on Ethernet3 — assign an address by name.
    const iface = routerInterfaceForName(rtr, "Ethernet3");
    iface.ipv4Address = "10.0.0.1";
    iface.prefixLength = 30;
    // Re-enumerating must surface that saved address on the same empty port.
    const rows = routerInterfacesWithNames(rtr);
    const eth3 = rows.find((r: any) => r.name === "Ethernet3");
    expect(eth3.peer).toBeNull();
    expect(eth3.config.ipv4Address).toBe("10.0.0.1");
    // A second call returns the same stored entry, not a duplicate.
    expect(routerInterfaceForName(rtr, "Ethernet3").ipv4Address).toBe("10.0.0.1");
    expect(rtr.config.interfaces.filter((i: any) => i.name === "Ethernet3")).toHaveLength(1);
  });
});

describe("addDevice", () => {
  beforeEach(() => {
    resetState();
    // Reset auto-naming counters so tests are independent of run order
    state.nameCounters = freshNameCounters();
  });

  it("creates a device in state.devices", () => {
    addDevice("computer", 100, 200);
    expect(state.devices).toHaveLength(1);
    expect(state.devices[0].type).toBe("computer");
  });

  it("auto-generates sequential names", () => {
    addDevice("computer", 100, 200);
    addDevice("computer", 200, 200);
    expect(state.devices[0].name).toBe("PC-1");
    expect(state.devices[1].name).toBe("PC-2");
  });

  it("generates correct names per device type", () => {
    addDevice("computer", 100, 200);
    addDevice("switch", 200, 200);
    addDevice("router", 300, 200);
    expect(state.devices[0].name).toBe("PC-1");
    expect(state.devices[1].name).toBe("SW-1");
    expect(state.devices[2].name).toBe("RTR-1");
  });

  it("sets selectedId to the new device", () => {
    const dev = addDevice("computer", 100, 200);
    expect(state.selectedId).toBe(dev.id);
  });

  it("positions device at specified coordinates", () => {
    const dev = addDevice("computer", 150, 250);
    expect(dev.x).toBe(150);
    expect(dev.y).toBe(250);
  });
});

describe("addLink", () => {
  beforeEach(() => resetState());

  it("creates a link between two devices", () => {
    addDevice("computer", 100, 200);
    addDevice("switch", 200, 200);
    const fromId = state.devices[0].id;
    const toId = state.devices[1].id;
    addLink(fromId, toId);
    expect(state.links).toHaveLength(1);
    expect(state.links[0].from).toBe(fromId);
    expect(state.links[0].to).toBe(toId);
  });

  it("prevents duplicate links", () => {
    addDevice("computer", 100, 200);
    addDevice("switch", 200, 200);
    const fromId = state.devices[0].id;
    const toId = state.devices[1].id;
    addLink(fromId, toId);
    addLink(fromId, toId);
    expect(state.links).toHaveLength(1);
  });

  it("prevents reverse duplicate links", () => {
    addDevice("computer", 100, 200);
    addDevice("switch", 200, 200);
    const fromId = state.devices[0].id;
    const toId = state.devices[1].id;
    addLink(fromId, toId);
    addLink(toId, fromId);
    expect(state.links).toHaveLength(1);
  });
});

describe("deleteSelection", () => {
  beforeEach(() => resetState());

  it("removes selected device and its links", () => {
    const pc = addDevice("computer", 100, 200);
    const sw = addDevice("switch", 200, 200);
    addLink(pc.id, sw.id);
    state.selectedId = pc.id;
    deleteSelection();
    expect(state.devices).toHaveLength(1);
    expect(state.devices[0].id).toBe(sw.id);
    expect(state.links).toHaveLength(0);
  });

  it("clears selection after deletion", () => {
    const pc = addDevice("computer", 100, 200);
    state.selectedId = pc.id;
    deleteSelection();
    expect(state.selectedId).toBeNull();
  });
});

describe("getDevice", () => {
  beforeEach(() => resetState());

  it("returns device by ID", () => {
    const pc = addDevice("computer", 100, 200);
    expect(getDevice(pc.id)).toBeDefined();
    expect(getDevice(pc.id)!.id).toBe(pc.id);
  });

  it("returns undefined for invalid ID", () => {
    expect(getDevice("nonexistent")).toBeUndefined();
  });

  it("returns undefined for null ID", () => {
    expect(getDevice(null)).toBeUndefined();
  });
});

describe("connectedIds", () => {
  beforeEach(() => resetState());

  it("returns the peers a device is linked to", () => {
    const sw = addDevice("switch", 0, 0);
    const pc1 = addDevice("computer", 100, 0);
    const pc2 = addDevice("computer", 200, 0);
    addLink(sw.id, pc1.id);
    addLink(sw.id, pc2.id);
    expect(connectedIds(sw.id).sort()).toEqual([pc1.id, pc2.id].sort());
    expect(connectedIds(pc1.id)).toEqual([sw.id]);
  });

  it("excludes hidden links", () => {
    const sw = addDevice("switch", 0, 0);
    const pc = addDevice("computer", 100, 0);
    addLink(sw.id, pc.id);
    state.links[0].hidden = true;
    expect(connectedIds(sw.id)).toEqual([]);
  });
});

describe("linkedPortsFor", () => {
  beforeEach(() => resetState());

  it("assigns implicit ports in link order", () => {
    const sw = addDevice("switch", 0, 0);
    const pc1 = addDevice("computer", 100, 0);
    const pc2 = addDevice("computer", 200, 0);
    addLink(sw.id, pc1.id);
    addLink(sw.id, pc2.id);
    const ports = linkedPortsFor(sw.id);
    expect(ports[0].peer.id).toBe(pc1.id);
    expect(ports[1].peer.id).toBe(pc2.id);
  });

  it("places an explicit port at its index", () => {
    const sw = addDevice("switch", 0, 0);
    const pc = addDevice("computer", 100, 0);
    addLink(sw.id, pc.id, 4, 1); // fromPort 4 → index 3
    const ports = linkedPortsFor(sw.id);
    expect(ports[3].peer.id).toBe(pc.id);
  });
});

// The lazy device/link indexes (deviceIndex / linksFor) rebuild on an array
// identity+length change. These exercise that invalidation across mutations.
describe("index invalidation", () => {
  beforeEach(() => resetState());

  it("getDevice reflects add → delete → clear → add", () => {
    const a = addDevice("computer", 0, 0);
    expect(getDevice(a.id)).toBeDefined();           // built from a push
    const b = addDevice("computer", 100, 0);
    expect(getDevice(b.id)).toBeDefined();            // length changed → rebuilt
    state.selectedId = b.id;
    deleteSelection();                                // reassigns state.devices
    expect(getDevice(b.id)).toBeUndefined();
    expect(getDevice(a.id)).toBeDefined();
    clearNetwork();                                   // reassigns to []
    expect(getDevice(a.id)).toBeUndefined();
    const c = addDevice("router", 0, 0);              // new array, same length as before clear
    expect(getDevice(c.id)).toBeDefined();
  });

  it("link adjacency reflects addLink then deleteSelection", () => {
    const sw = addDevice("switch", 0, 0);
    const pc = addDevice("computer", 100, 0);
    addLink(sw.id, pc.id);
    expect(linkedPortsFor(sw.id)).toHaveLength(1);    // adjacency built
    state.selectedId = pc.id;
    deleteSelection();                                // removes pc and its link
    expect(connectedIds(sw.id)).toEqual([]);          // adjacency rebuilt
    expect(linkedPortsFor(sw.id)).toHaveLength(0);
  });
});

describe("findDeviceAt", () => {
  beforeEach(() => resetState());

  it("returns device at coordinates within its bounds", () => {
    const pc = addDevice("computer", 100, 200);
    // findDeviceAt checks if point is within device rect (x, y, width, height)
    const found = findDeviceAt({ x: 100, y: 200 });
    expect(found).not.toBeNull();
    expect(found!.id).toBe(pc.id);
  });

  it("returns null for empty space", () => {
    addDevice("computer", 100, 200);
    // Far away from the device
    const found = findDeviceAt({ x: 9999, y: 9999 });
    expect(found).toBeNull();
  });
});
