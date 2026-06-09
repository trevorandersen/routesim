/**
 * Command engine tests — the text-command interface (commands.ts).
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { runConsoleCommand as exec, runConsoleScript, exportTopologyScript } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";
import { routedTopology } from "./fixtures";

beforeAll(() => registerNoopCallbacks());

function reset() {
  resetState();
  (state as any).nextComputer = 1;
  (state as any).nextSwitch = 1;
  (state as any).nextRouter = 1;
  state.configStore = { version: 1, configs: {} } as any;
}

describe("commands — topology", () => {
  beforeEach(reset);

  it("adds devices with name + position", () => {
    const r = exec("add computer PC1 at 100 200");
    expect(r.ok).toBe(true);
    const pc = state.devices.find(d => d.name === "PC1")!;
    expect(pc.type).toBe("computer");
    expect(pc.x).toBe(100);
    expect(pc.y).toBe(200);
  });

  it("links and unlinks by name", () => {
    exec("add computer PC1");
    exec("add switch SW1");
    expect(exec("link PC1 SW1").ok).toBe(true);
    expect(state.links).toHaveLength(1);
    expect(exec("unlink PC1 SW1").ok).toBe(true);
    expect(state.links).toHaveLength(0);
  });

  it("moves, renames, and removes", () => {
    exec("add router R1");
    exec("move R1 50 60");
    expect(state.devices[0].x).toBe(50);
    exec("rename R1 Core");
    expect(state.devices[0].name).toBe("Core");
    exec("remove Core");
    expect(state.devices).toHaveLength(0);
  });

  it("errors on unknown device / command", () => {
    expect(exec("move Ghost 1 2").ok).toBe(false);
    expect(exec("frobnicate").ok).toBe(false);
  });
});

describe("commands — config verbs", () => {
  beforeEach(reset);

  it("sets host ip / gateway / mac", () => {
    exec("add computer PC1");
    exec("ip PC1 192.168.1.10/24");
    exec("gateway PC1 192.168.1.1");
    exec("mac PC1 02:00:00:00:00:09");
    const pc = state.devices.find(d => d.name === "PC1")!;
    expect(pc.config.ipv4Address).toBe("192.168.1.10");
    expect(pc.config.gatewayIpv4Address).toBe("192.168.1.1");
    expect(pc.config.macAddress).toBe("02:00:00:00:00:09");
  });

  it("configures switch VLANs and ports", () => {
    exec("add switch SW1");
    const sw = state.devices.find(d => d.name === "SW1")!;
    sw.config.managed = true;
    exec("vlan SW1 add 30");
    exec("port SW1 Ethernet2 vlan 30");
    expect(sw.config.vlans.some((v: any) => v.id === 30)).toBe(true);
    expect(sw.config.portVlans.Ethernet2).toBe(30);
  });
});

describe("commands — headless simulation", () => {
  beforeEach(reset);

  it("run ping reports reachability + ok flag", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      add computer PC2 at 200 0
      add switch SW1 at 100 0
      link SW1 PC1
      link SW1 PC2
      ip PC1 192.168.1.10/24
      ip PC2 192.168.1.20/24
    `);
    const r = exec("run ping PC1 PC2");
    expect(r.ok).toBe(true);
    expect((r.data as any).success).toBe(true);
    expect(r.output[0]).toContain("reachable");
  });

  it("run ping fails (ok:false) when target is unconfigured/unreachable", () => {
    runConsoleScript(`
      add computer PC1 at 0 0
      add computer PC2 at 200 0
      ip PC1 192.168.1.10/24
    `);
    const r = exec("run ping PC1 PC2");
    expect(r.ok).toBe(false);
  });

  it("traceroute returns a hop list ending at the destination", () => {
    const topo = routedTopology();
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    const r = exec("traceroute pc-a 192.168.20.10");
    expect(r.ok).toBe(true);
    expect(r.output[0]).toContain("traceroute to 192.168.20.10");
    expect((r.data as any).hops.length).toBeGreaterThanOrEqual(2);
    expect((r.data as any).reached).toBe(true);
  });
});

describe("commands — export round-trip", () => {
  beforeEach(reset);

  it("export then re-run reproduces the topology", () => {
    runConsoleScript(`
      add computer PC1 at 100 100
      add computer PC2 at 300 100
      add switch SW1 at 200 100
      link SW1 PC1
      link SW1 PC2
      ip PC1 192.168.1.10/24
      ip PC2 192.168.1.20/24
      gateway PC1 192.168.1.1
    `);
    const before = {
      devices: state.devices.map(d => `${d.name}:${d.type}`).sort(),
      links: state.links.length,
      pc1ip: state.devices.find(d => d.name === "PC1")!.config.ipv4Address,
    };
    const script = exportTopologyScript();
    exec("clear");
    expect(state.devices).toHaveLength(0);
    runConsoleScript(script);
    const after = {
      devices: state.devices.map(d => `${d.name}:${d.type}`).sort(),
      links: state.links.length,
      pc1ip: state.devices.find(d => d.name === "PC1")!.config.ipv4Address,
    };
    expect(after).toEqual(before);
  });
});

describe("commands — query & view", () => {
  beforeEach(reset);

  it("list and show return output", () => {
    exec("add router R1");
    expect(exec("list").output.join("\n")).toContain("R1");
    expect(exec("show R1").output.join("\n")).toContain("router");
  });

  it("select and tool mutate state", () => {
    exec("add computer PC1");
    exec("select PC1");
    expect(state.selectedId).toBe(state.devices[0].id);
    exec("tool router");
    expect(state.tool).toBe("router");
  });

  it("theme accepts each registered id (and the light alias) and rejects others", () => {
    expect(exec("theme blueprint").ok).toBe(true);
    expect(state.theme).toBe("blueprint");
    expect(exec("theme dark").ok).toBe(true);
    expect(state.theme).toBe("dark");
    expect(exec("theme light").ok).toBe(true); // back-compat alias
    expect(state.theme).toBe("warm-light");
    expect(exec("theme chartreuse").ok).toBe(false);
  });
});
