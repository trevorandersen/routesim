/**
 * Place mode (GitHub issue #3): the translucent preview under the cursor, and
 * which presses place.
 *
 * The ghost itself is drawn on the canvas, which the test DOM has no 2D context
 * for, so what is tested here is what decides the drawing — placementPreview —
 * and that it can never disagree with what the click then drops, because both
 * read one table. The press handling is driven through the same exported
 * handlers setupUI registers.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { dom } from "../src/dom";
import { PLACEMENT_TOOLS, placementPreview, placeToolDevice } from "../src/devices";
import { handleCanvasPointerDown, handleCanvasContextMenu, handleGlobalKeydown, isSecondaryPress, setTool, PLACEMENT_HINT } from "../src/ui";
import { runConsoleCommand as exec } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());
beforeEach(() => resetState());

/** A press at canvas point (x, y); the stub canvas sits at the page origin. */
const press = (x: number, y: number, extra: Record<string, unknown> = {}) =>
  ({ clientX: x, clientY: y, button: 0, pointerId: 1, ...extra } as any);

/** A contextmenu event that records whether the browser menu was suppressed. */
function contextEvent(x: number, y: number) {
  const event = { clientX: x, clientY: y, prevented: false, preventDefault() { this.prevented = true; } };
  return event as any;
}

describe("placementPreview — what the ghost shows", () => {
  it("previews exactly the device the click then places, for every placement tool", () => {
    for (const tool of PLACEMENT_TOOLS) {
      const preview = placementPreview(tool, 120, 80)!;
      const placed = placeToolDevice(tool, 120, 80);
      expect({ tool, type: preview.type, name: preview.name, x: preview.x, y: preview.y, width: preview.width, height: preview.height })
        .toEqual({ tool, type: placed.type, name: placed.name, x: placed.x, y: placed.y, width: placed.width, height: placed.height });
      // The flags the canvas turns into badges.
      expect(!!(preview.config as any).managed).toBe(!!(placed.config as any).managed);
      expect((preview.config as any).role).toBe((placed.config as any).role);
    }
  });

  it("keeps previewing the right name as devices are added", () => {
    expect(placementPreview("computer", 0, 0)!.name).toBe(placeToolDevice("computer", 0, 0).name);
    expect(placementPreview("computer", 0, 0)!.name).toBe(placeToolDevice("computer", 0, 0).name);
    expect(placementPreview("dns-server", 0, 0)!.name).toBe("DNS-1");
    placeToolDevice("dns-server", 0, 0);
    expect(placementPreview("dns-server", 0, 0)!.name).toBe("DNS-2");
  });

  it("marks the variants the canvas badges: managed switch and border router", () => {
    expect(placementPreview("managed-switch", 0, 0)).toMatchObject({ type: "switch", config: { managed: true } });
    expect((placementPreview("switch", 0, 0)!.config as any).managed).toBeUndefined();
    expect(placementPreview("border-router", 0, 0)).toMatchObject({ type: "router", config: { role: "border" } });
    expect((placementPreview("router", 0, 0)!.config as any).role).toBeUndefined();
  });

  it("changes nothing: no device, no name counter, no undo step", () => {
    const counters = JSON.stringify(state.nameCounters);
    for (const tool of PLACEMENT_TOOLS) placementPreview(tool, 10, 10);
    expect(state.devices).toHaveLength(0);
    expect(JSON.stringify(state.nameCounters)).toBe(counters);
    expect(state.undoStack).toHaveLength(0);
  });

  it("is null for the tools that place nothing", () => {
    for (const tool of ["select", "connect", "configure", "nonsense"]) {
      expect(placementPreview(tool, 0, 0)).toBeNull();
    }
  });
});

describe("place mode — which presses place", () => {
  it("left-click places at the cursor and stays armed for the next one", () => {
    setTool("computer");
    handleCanvasPointerDown(press(200, 150));
    handleCanvasPointerDown(press(400, 150));
    expect(state.devices.map(d => [d.type, d.x, d.y])).toEqual([["computer", 200, 150], ["computer", 400, 150]]);
    expect(state.tool).toBe("computer");
  });

  it("a press moves the tracked cursor, so the ghost is never left where it was", () => {
    state.pointer = { x: 10, y: 10 }; // where the cursor last moved
    setTool("computer");
    handleCanvasPointerDown(press(200, 150)); // a touch or scripted click: no move first
    expect(state.pointer).toEqual({ x: 200, y: 150 });
  });

  it("places where the cursor is in the world, under pan and zoom", () => {
    state.pan = { x: 100, y: 50 };
    state.scale = 2;
    setTool("switch");
    handleCanvasPointerDown(press(300, 250));
    expect(state.devices[0]).toMatchObject({ type: "switch", x: 100, y: 100 });
  });

  it("right-click and middle-click place nothing", () => {
    setTool("router");
    handleCanvasPointerDown(press(200, 150, { button: 2 }));
    handleCanvasPointerDown(press(200, 150, { button: 1 }));
    expect(state.devices).toHaveLength(0);
    expect(state.undoStack).toHaveLength(0);
  });

  it("counts Ctrl+click as a secondary click on a Mac only", () => {
    expect(isSecondaryPress({ button: 0, ctrlKey: true }, "MacIntel")).toBe(true);
    expect(isSecondaryPress({ button: 0, ctrlKey: true }, "Win32")).toBe(false);
    expect(isSecondaryPress({ button: 0, ctrlKey: true }, "Linux x86_64")).toBe(false);
    expect(isSecondaryPress({ button: 0 }, "MacIntel")).toBe(false);
    expect(isSecondaryPress({ button: 2 }, "Win32")).toBe(true);
    expect(isSecondaryPress({ button: 1 }, "Win32")).toBe(true);
    expect(isSecondaryPress({}, "MacIntel")).toBe(false); // a touch or synthetic press
  });

  it("right-click cancels place mode and opens no menu, even over a device", () => {
    exec("add computer PC1 at 200 150");
    state.selectedId = null;
    setTool("router");
    const event = contextEvent(200, 150);
    handleCanvasPointerDown(press(200, 150, { button: 2 })); // the press that precedes contextmenu
    handleCanvasContextMenu(event);
    expect(state.tool).toBe("select");
    expect(event.prevented).toBe(true);
    expect(dom.contextMenu.hidden).toBe(true);
    expect(state.selectedId).toBeNull();
    expect(state.devices).toHaveLength(1);
  });

  it("Escape cancels place mode", () => {
    setTool("firewall");
    handleGlobalKeydown({ key: "Escape", target: {} } as any);
    expect(state.tool).toBe("select");
    handleCanvasPointerDown(press(200, 150));
    expect(state.devices).toHaveLength(0);
  });

  it("outside place mode a right-click still opens the device menu", () => {
    exec("add computer PC1 at 200 150");
    state.selectedId = null;
    setTool("select");
    const event = contextEvent(200, 150);
    handleCanvasContextMenu(event);
    expect(event.prevented).toBe(true);
    expect(dom.contextMenu.hidden).toBe(false);
    expect(state.selectedId).toBe(state.devices[0].id);
  });
});

describe("place mode — the status line says how to leave", () => {
  it("adds the hint for every placement tool and for no other", () => {
    for (const tool of PLACEMENT_TOOLS) {
      setTool(tool);
      expect(dom.modeLabel.textContent).toContain(PLACEMENT_HINT);
    }
    for (const tool of ["select", "connect", "configure"]) {
      setTool(tool);
      expect(dom.modeLabel.textContent).not.toContain(PLACEMENT_HINT);
    }
  });
});
