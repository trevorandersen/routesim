/**
 * LAN collapse is presentation (review R4). Collapsing a switch and its hosts
 * into a LAN cloud hides their cables from the canvas, but the cables are still
 * plugged in: routing, forwarding, L2 reachability, port numbering, the spanning
 * tree and DHCP allocation must all see the structural topology, not the drawn
 * one. Before the fix the router's cable to a collapsed LAN read as unplugged —
 * its interface lost its address, the connected route vanished, and a ping
 * across it died with a false "No route".
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { runSimulationHeadless, allocateDhcpIp } from "../src/engine";
import { buildRoutingTable } from "../src/routing";
import { buildPingEvents, l2Reachable } from "../src/simulation";
import { addDevice, addLink, collapseLan, expandLan, getDevice, isPhysicalLink, linkedPortsFor, occupiedPorts, portBlockReason, routerInterfacesWithNames } from "../src/devices";
import { runStpConvergence } from "../src/stp";
import { checkScenario } from "../src/scenarios";
import { runConsoleCommand } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";
import { routedTopology } from "./fixtures";

beforeAll(() => registerNoopCallbacks());

function loadRouted(): void {
  const t = routedTopology();
  state.devices = t.devices as any;
  state.links = t.links as any;
}

const dev = (id: string) => getDevice(id)!;
const lanOf = (anchorId: string) => state.devices.find(d => d.type === "lan" && d.config?.anchorId === anchorId)!;

function pingAcross(from = "pc-a", to = "192.168.20.10") {
  const setup = buildPingEvents(dev(from), to);
  if (typeof setup === "string") throw new Error(setup);
  return runSimulationHeadless(setup, from, to, "ping");
}

describe("collapse is a view — routing keeps the physical topology (R4)", () => {
  beforeEach(() => { resetState(); loadRouted(); });

  it("a ping across a collapsed LAN succeeds, and still does after expanding", () => {
    expect(pingAcross().success).toBe(true);                       // baseline
    collapseLan(dev("sw-b"));
    expect(dev("pc-b").hidden).toBe(true);                         // collapse really happened
    const collapsed = pingAcross();
    expect(collapsed.success).toBe(true);
    expect(state.simulation.log.some(l => /No route/.test(l.summary))).toBe(false);
    expandLan(lanOf("sw-b"));
    expect(pingAcross().success).toBe(true);
  });

  it("a ping FROM a host inside a collapsed LAN succeeds", () => {
    collapseLan(dev("sw-a"));
    expect(pingAcross("pc-a", "192.168.20.10").success).toBe(true);
    expect(pingAcross("pc-b", "192.168.10.10").success).toBe(true);
  });

  it("the router keeps its address, its connected route and its interface names", () => {
    const names = () => routerInterfacesWithNames(dev("rtr"), true).map(i => `${i.name}=${i.config.ipv4Address}`);
    const before = names();
    collapseLan(dev("sw-b"));
    expect(names()).toEqual(before);
    expect(buildRoutingTable(dev("rtr")).some(r => r.type === "C" && r.network.startsWith("192.168.20.0"))).toBe(true);
  });

  it("port numbering, L2 reachability and a scenario's link goal ignore collapse", () => {
    const ports = () => linkedPortsFor("rtr").map(p => p?.peer?.id);
    const before = ports();
    collapseLan(dev("sw-b"));
    expect(ports()).toEqual(before);                               // the proxy link is not a port
    expect(l2Reachable("pc-b", "rtr", null)).toBe(true);
    const goal = { id: "t", name: "t", description: "", topology: { devices: [], links: [] },
      checks: [{ kind: "link" as const, a: "PC-B", b: "SW-B", label: "PC-B cabled" }] };
    expect(checkScenario(goal as any).passed).toBe(true);          // still cabled, just not drawn
  });

  it("a cable pinned to a port still occupies it while its LAN is collapsed", () => {
    state.links.find(l => l.id === "l3")!.fromPort = 1;            // SW-B Ethernet1 → PC-B, chosen
    const before = [...occupiedPorts("sw-b").keys()].sort();
    expect(before).toContain(1);
    collapseLan(dev("sw-b"));
    expect([...occupiedPorts("sw-b").keys()].sort()).toEqual(before);   // every cable still fills its port
    expect(portBlockReason("sw-b", "rtr", 1)).toContain("already cabled");   // not offered to a new cable
  });

  it("proxy links are not physical; collapse-hidden cables are", () => {
    collapseLan(dev("sw-b"));
    const proxy = state.links.find(l => l.proxy)!;
    const hidden = state.links.find(l => l.hidden)!;
    expect(isPhysicalLink(proxy)).toBe(false);
    expect(isPhysicalLink(hidden)).toBe(true);
  });

  it("a shut cable inside a collapsed LAN still breaks the path, by name", () => {
    collapseLan(dev("sw-b"));
    expect(runConsoleCommand("shut PC-B SW-B").ok).toBe(true);     // the real cable, though hidden
    const r = pingAcross();
    expect(r.success).toBe(false);
    // …and says why, naming the hidden cable — not a false "No route".
    expect(r.diagnosis.join(" ")).toContain("SW-B ↔ PC-B is administratively down");
  });

  it("DHCP allocation never hands out a collapsed host's address", () => {
    dev("pc-b").config.ipv4Address = "192.168.20.100";             // the first address in the pool
    collapseLan(dev("sw-b"));
    const iface = dev("rtr").config.interfaces!.find((i: any) => i.peerId === "sw-b");
    expect(allocateDhcpIp(iface, dev("rtr"))).toBe("192.168.20.101");
  });
});

describe("collapse is a view — the spanning tree keeps collapsed switches (R4)", () => {
  beforeEach(() => resetState());

  it("a looped triangle of managed switches stays blocked after collapse", () => {
    const [a, b, c] = [0, 1, 2].map(i => { const s = addDevice("switch", i * 200, 0); s.config.managed = true; return s; });
    const pc = addDevice("computer", 0, 200);
    addLink(a.id, b.id);
    addLink(b.id, c.id);
    addLink(c.id, a.id);
    addLink(a.id, pc.id);
    runStpConvergence();
    expect(state.links.filter(l => l.stpBlocked).length).toBe(1);
    collapseLan(a);
    runStpConvergence();
    expect(state.links.filter(l => l.stpBlocked).length).toBe(1); // the loop is still broken
  });
});
