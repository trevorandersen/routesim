import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { addDevice, addLink, deleteSelection, findDeviceAt, getDevice } from "../src/devices";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => {
  registerNoopCallbacks();
});

describe("addDevice", () => {
  beforeEach(() => {
    resetState();
    // Reset auto-naming counters so tests are independent of run order
    (state as any).nextComputer = 1;
    (state as any).nextSwitch = 1;
    (state as any).nextRouter = 1;
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
