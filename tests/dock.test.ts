/**
 * The bottom dock + per-device terminal sessions.
 *
 * Sessions are the heart of the change: each device terminal keeps its own
 * scrollback, history, and CLI mode (the router mode machine survives
 * switching tabs), and the console's `cli` command attaches to the same
 * sessions. Dock chrome (tabs/panes) is DOM-rendered and exercised in the
 * preview; these tests cover the state model.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import {
  openTerminalFor, closeSession, ensureSession, sessionFor,
  openDock, closeDock, toggleDockTab, runTerminalCommand,
} from "../src/terminal";
import { deleteSelection } from "../src/devices";
import { loadDefaultConfig } from "../src/config";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());

function lanTopology() {
  runConsoleScript(`
    add computer PC1 at 0 0
    add router R1 at 200 0
    add switch SW at 400 0
    link PC1 R1
    ip PC1 192.168.1.10/24
    interface R1 PC1 ip 192.168.1.1
  `);
  return {
    pc1: state.devices.find(d => d.name === "PC1")!,
    r1: state.devices.find(d => d.name === "R1")!,
    sw: state.devices.find(d => d.name === "SW")!,
  };
}

describe("dock — terminal sessions", () => {
  beforeEach(() => resetState());

  it("opening a terminal creates a session and opens the dock on the terminal tab", () => {
    const { pc1 } = lanTopology();
    openTerminalFor(pc1);
    expect(state.dock.open).toBe(true);
    expect(state.dock.activeTab).toBe("terminal");
    expect(state.terminalSessions).toHaveLength(1);
    expect(state.terminal.deviceId).toBe(pc1.id);
    expect(state.terminal.lines[0].text).toContain("Connected to PC1");
  });

  it("each device keeps its own scrollback across switches", () => {
    const { pc1, r1 } = lanTopology();
    openTerminalFor(pc1);
    runTerminalCommand("ip addr");
    const pcLines = state.terminal.lines.length;
    openTerminalFor(r1);
    runTerminalCommand("show ip route");
    expect(state.terminalSessions).toHaveLength(2);
    // Back to PC1: scrollback intact, nothing leaked between sessions.
    openTerminalFor(pc1);
    expect(state.terminal.lines.length).toBe(pcLines);
    expect(state.terminal.lines.some(l => l.text.includes("show ip route"))).toBe(false);
  });

  it("the router CLI mode survives switching tabs", () => {
    const { pc1, r1 } = lanTopology();
    openTerminalFor(r1);
    runTerminalCommand("enable");
    runTerminalCommand("configure terminal");
    expect(state.terminal.mode).toBe("config");
    openTerminalFor(pc1);
    expect(state.terminal.mode).toBe("exec"); // the PC session, not the router's
    openTerminalFor(r1);
    expect(state.terminal.mode).toBe("config"); // resumed where we left off
  });

  it("re-opening an existing session does not duplicate the tab or the greeting", () => {
    const { pc1 } = lanTopology();
    openTerminalFor(pc1);
    openTerminalFor(pc1);
    expect(state.terminalSessions).toHaveLength(1);
    expect(state.terminal.lines.filter(l => l.text.includes("Connected to")).length).toBe(1);
  });

  it("closing a session falls back to the neighbouring tab; closing the last closes the dock", () => {
    const { pc1, r1 } = lanTopology();
    openTerminalFor(pc1);
    openTerminalFor(r1);
    closeSession(r1.id);
    expect(state.terminal.deviceId).toBe(pc1.id);
    expect(state.dock.open).toBe(true);
    closeSession(pc1.id);
    expect(state.terminalSessions).toHaveLength(0);
    expect(state.terminal.deviceId).toBeNull();
    expect(state.dock.open).toBe(false);
  });

  it("a failed open (unmanaged switch) shows the error without creating a session", () => {
    const { sw } = lanTopology();
    openTerminalFor(sw);
    expect(state.terminalSessions).toHaveLength(0);
    expect(state.terminal.deviceId).toBeNull();
    expect(state.terminal.lines[0].kind).toBe("error");
    expect(state.dock.open).toBe(true);
  });

  it("an exec-level `exit` on a router logs out and closes its session", () => {
    const { r1 } = lanTopology();
    openTerminalFor(r1);
    runTerminalCommand("exit");
    expect(sessionFor(r1.id)).toBeUndefined();
  });

  it("deleting a device drops its session", () => {
    const { pc1, r1 } = lanTopology();
    openTerminalFor(pc1);
    openTerminalFor(r1);
    state.selectedId = r1.id;
    deleteSelection();
    expect(sessionFor(r1.id)).toBeUndefined();
    expect(state.terminal.deviceId).toBe(pc1.id);
  });

  it("loading a topology clears all sessions", () => {
    const { pc1 } = lanTopology();
    openTerminalFor(pc1);
    loadDefaultConfig();
    expect(state.terminalSessions).toHaveLength(0);
    expect(state.dock.open).toBe(false);
  });
});

describe("dock — console `cli` shares the sessions", () => {
  beforeEach(() => resetState());

  it("cli attaches silently and preserves the mode across calls", () => {
    lanTopology();
    exec("cli R1 enable");
    exec("cli R1 configure terminal");
    const session = sessionFor(state.devices.find(d => d.name === "R1")!.id)!;
    expect(session.mode).toBe("config");
    expect(session.lines.some(l => l.text.includes("Connected to"))).toBe(false);
    // Interleaving another device's cli does not disturb the router session.
    exec("cli PC1 ip addr");
    expect(session.mode).toBe("config");
    exec("cli R1 ip route 10.9.9.0/24 192.168.1.10");
    expect(session.mode).toBe("config");
  });

  it("cli and the opened terminal see the same session", () => {
    const { pc1 } = lanTopology();
    openTerminalFor(pc1);
    exec("cli PC1 ip addr");
    expect(state.terminalSessions).toHaveLength(1);
    expect(state.terminal.lines.some(l => l.text.includes("link/ether"))).toBe(true);
  });
});

describe("dock — tabs and panes", () => {
  beforeEach(() => resetState());

  it("openDock/closeDock/toggleDockTab manage open state and the active pane", () => {
    openDock("console");
    expect(state.dock).toMatchObject({ open: true, activeTab: "console" });
    toggleDockTab("simlog");
    expect(state.dock.activeTab).toBe("simlog");
    toggleDockTab("simlog"); // toggling the active tab closes the dock
    expect(state.dock.open).toBe(false);
    closeDock();
    expect(state.dock.open).toBe(false);
  });

  it("an animated simulation opens the dock on the sim log when closed", () => {
    const { pc1 } = lanTopology();
    expect(state.dock.open).toBe(false);
    exec("ping PC1 192.168.1.1");
    expect(state.dock.open).toBe(true);
    expect(state.dock.activeTab).toBe("simlog");
    exec("stop");
  });

  it("a running sim leaves the user's tab alone when the dock is already open", () => {
    const { pc1 } = lanTopology();
    openTerminalFor(pc1);
    exec("ping PC1 192.168.1.1");
    expect(state.dock.activeTab).toBe("terminal");
    exec("stop");
  });
});
