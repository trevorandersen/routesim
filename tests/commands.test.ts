/**
 * Command engine tests — the text-command interface (commands.ts).
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state, undo } from "../src/state";
import { runConsoleCommand as exec, runConsoleScript, exportTopologyScript } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";
import { routedTopology } from "./fixtures";
import { freshNameCounters } from "../src/device-registry";

beforeAll(() => registerNoopCallbacks());

function reset() {
  resetState();
  state.nameCounters = freshNameCounters();
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

  it("loading a topology clears references from the previous simulation", () => {
    state.simulation.status = "done";
    state.simulation.headless = true;
    state.simulation.originDeviceId = "old-device";
    state.simulation.pingTargetIp = "192.0.2.1";

    expect(exec("topology basic").ok).toBe(true);
    expect(state.simulation.status).toBe("idle");
    expect(state.simulation.headless).toBe(false);
    expect(state.simulation.originDeviceId).toBeNull();
    expect(state.simulation.pingTargetIp).toBeNull();
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
    expect(sw.config.vlans!.some((v: any) => v.id === 30)).toBe(true);
    expect(sw.config.portVlans!.Ethernet2).toBe(30);
  });

  it("ports sets a host's listening TCP ports, clears them, and round-trips through export", () => {
    exec("add server SRV1");
    expect(exec("ports SRV1 80, 443").ok).toBe(true);
    const srv = state.devices.find(d => d.name === "SRV1")!;
    expect(srv.config.openPorts).toEqual([80, 443]);
    expect(exec("ports SRV1 not-a-port").ok).toBe(false);   // validation
    expect(exec("ports SRV-switch 80").ok).toBe(false);     // unknown device
    // Export reproduces the listening ports (the script completeness guarantee).
    expect(exportTopologyScript()).toContain("ports SRV1 80,443");
    exec("ports SRV1 none");
    expect(srv.config.openPorts).toBeUndefined();
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

describe("commands — input validation", () => {
  beforeEach(reset);

  it("vlan reports ok:false on an invalid VLAN id (not a silent success)", () => {
    exec("add switch SW1 at 0 0");
    const r = exec("vlan SW1 add notanumber");
    expect(r.ok).toBe(false);
    expect(r.output.join("")).toContain("Invalid VLAN ID");
  });

  it("port reports ok:false on an unknown interface", () => {
    exec("add switch SW1 at 0 0");
    const r = exec("port SW1 Ethernet99 vlan 5");
    expect(r.ok).toBe(false);
    expect(r.output.join("")).toContain("Unknown interface");
  });

  it("port mode rejects a non-access/trunk value", () => {
    exec("add switch SW1 at 0 0");
    expect(exec("port SW1 Ethernet1 mode trnuk").ok).toBe(false);
  });

  it("interface vlan tag must be a number, not NaN", () => {
    runConsoleScript("add router R1 at 0 0\nadd switch SW1 at 100 0\nlink R1 SW1");
    expect(exec("interface R1 SW1 ip 10.0.0.1 vlan notanumber").ok).toBe(false);
  });

  it("link rejects non-numeric ports instead of storing NaN", () => {
    exec("add computer A at 0 0");
    exec("add switch B at 100 0");
    const r = exec("link A B foo bar");
    expect(r.ok).toBe(false);
    expect(state.links).toHaveLength(0);
  });

  it("link with a duplicate explicit port falls back instead of orphaning the first", () => {
    exec("add switch SW at 0 0");
    exec("add computer PC1 at 100 0");
    exec("add computer PC2 at 100 100");
    const swId = state.devices.find(d => d.name === "SW")!.id;
    exec("link PC1 SW 1 1");
    exec("link PC2 SW 2 1"); // SW port 1 is already taken → must fall back, not overwrite
    expect(state.links).toHaveLength(2);
    const swPorts = state.links.map(l => (l.from === swId ? l.fromPort : l.toPort));
    expect(new Set(swPorts).size).toBe(2); // both links keep a distinct SW port
  });
});

describe("commands — speed clamp and interface confirmation", () => {
  beforeEach(reset);

  it("speed clamps to the 200-3000 ms slider range", () => {
    expect(exec("speed 50").output.join("")).toContain("200");
    expect(state.simulation.speed).toBe(200);
    exec("speed 999999");
    expect(state.simulation.speed).toBe(3000);
    exec("speed 800");
    expect(state.simulation.speed).toBe(800);
  });

  it("interface returns a confirmation rather than a blank line", () => {
    runConsoleScript("add router R1 at 0 0\nadd switch SW1 at 100 0\nlink R1 SW1");
    const r = exec("interface R1 SW1 ip 10.0.0.1/24");
    expect(r.ok).toBe(true);
    expect(r.output.join("").trim().length).toBeGreaterThan(0);
  });
});

describe("commands — linkset and export round-trip", () => {
  beforeEach(reset);

  it("link attributes round-trip through export (linkset)", () => {
    runConsoleScript("add computer A at 0 0\nadd switch B at 100 0\nlink A B");
    exec("linkset A B name Uplink");
    exec("linkset A B latency 100");
    exec("linkset A B loss 5");
    exec("linkset A B bandwidth 1000");
    const script = exportTopologyScript();
    expect(script).toContain("linkset A B name Uplink");
    expect(script).toContain("linkset A B latency 100");

    reset(); // replay into a fresh state
    runConsoleScript(script);
    const link = state.links[0];
    expect(link.name).toBe("Uplink");
    expect(link.latency).toBe(100);
    expect(link.loss).toBe(5);
    expect(link.bandwidth).toBe(1000);
  });

  it("linkset 0 clears a numeric attribute; rejects negatives", () => {
    runConsoleScript("add computer A at 0 0\nadd switch B at 100 0\nlink A B");
    exec("linkset A B latency 50");
    expect(state.links[0].latency).toBe(50);
    exec("linkset A B latency 0");
    expect(state.links[0].latency).toBeUndefined();
    expect(exec("linkset A B latency -5").ok).toBe(false);
  });
});

describe("commands — state-changing commands are undoable", () => {
  beforeEach(reset);

  const dev = (name: string) => state.devices.find(d => d.name === name)!;

  it("unlink is undoable and recomputes spanning tree (not a bare state.links filter)", () => {
    runConsoleScript(`
      add switch SW1 at 0 0
      add switch SW2 at 200 0
      link SW1 SW2
    `);
    const linkId = state.links[0].id;
    expect(exec("unlink SW1 SW2").ok).toBe(true);
    expect(state.links.length).toBe(0);
    undo();
    expect(state.links.some(l => l.id === linkId)).toBe(true);   // the link came back
  });

  it("rename is undoable (though permissive — no hostname validation)", () => {
    runConsoleScript(`add computer PC-A at 0 0`);
    const id = dev("PC-A").id;
    expect(exec("rename PC-A EDGE").ok).toBe(true);
    expect(state.devices.find(d => d.id === id)!.name).toBe("EDGE");
    undo();
    expect(state.devices.find(d => d.id === id)!.name).toBe("PC-A");
  });

  it("move is undoable", () => {
    runConsoleScript(`add computer PC-A at 10 20`);
    const id = dev("PC-A").id;
    exec("move PC-A 400 500");
    expect(state.devices.find(d => d.id === id)!.x).toBe(400);
    undo();
    expect(state.devices.find(d => d.id === id)!.x).toBe(10);
  });

  it("a config verb (mac) is undoable", () => {
    runConsoleScript(`add computer PC-A at 0 0`);
    const id = dev("PC-A").id;
    exec("mac PC-A 02:AA:BB:CC:DD:EE");
    expect(state.devices.find(d => d.id === id)!.config!.macAddress).toBe("02:AA:BB:CC:DD:EE");
    undo();
    expect(state.devices.find(d => d.id === id)!.config!.macAddress).not.toBe("02:AA:BB:CC:DD:EE");
  });

  it("a malformed sub-command does not push a spurious undo entry", () => {
    runConsoleScript(`
      add switch SW1 at 0 0
      managed SW1 on
    `);
    // A managed switch exists; rename it, then issue an invalid stp sub-command.
    exec("rename SW1 CORE");
    expect(exec("stp CORE bogus").ok).toBe(false);   // rejected before any mutation
    undo();                                           // should undo the rename, not the no-op stp
    expect(dev("SW1")).toBeTruthy();
  });
});

describe("commands — a rejected command pushes no spurious undo entry", () => {
  beforeEach(reset);

  it("rejected linkset / ports / idsrule leave the undo stack untouched", () => {
    runConsoleScript(`
      add computer PC-A at 0 0
      add switch SW at 100 0
      add ids IDS at 200 0
      link PC-A SW
    `);
    const id = state.devices.find(d => d.name === "PC-A")!.id;
    exec("rename PC-A EDGE");                                    // one real, undoable edit
    expect(exec("linkset PC-A SW bogus 5").ok).toBe(false);      // rejected — no mutation
    expect(exec("linkset PC-A SW latency abc").ok).toBe(false);  // rejected value
    expect(exec("ports PC-A 99999").ok).toBe(false);             // rejected value
    expect(exec("idsrule IDS not a valid rule").ok).toBe(false); // rejected rule
    undo();                                                      // must revert the rename, not a no-op
    expect(state.devices.find(d => d.id === id)!.name).toBe("PC-A");
  });
});

describe("commands — quoted values with spaces survive the script round-trip", () => {
  beforeEach(() => resetState());

  it("parses a quoted device name, SSID, password, and link name", () => {
    runConsoleScript(`
      add computer "My PC" at 0 0
      add access-point AP1 at 100 0
      ip "My PC" 10.0.0.5/24
      ssid AP1 "Guest WiFi" "pass phrase"
      link "My PC" AP1
      linkset "My PC" AP1 name "Back haul"
    `);
    const ap = state.devices.find(d => d.name === "AP1")!;
    expect(state.devices.map(d => d.name)).toContain("My PC");
    expect(ap.config.ssid).toBe("Guest WiFi");
    expect(ap.config.wifiPassword).toBe("pass phrase");   // args[2], not a trailing join
    expect(state.links[0].name).toBe("Back haul");
  });

  it("exports them quoted, so replaying the script rebuilds the same topology", () => {
    runConsoleScript(`
      add computer "My PC" at 0 0
      add access-point AP1 at 100 0
      ssid AP1 "Guest WiFi" "pass phrase"
      link "My PC" AP1
      linkset "My PC" AP1 name "Back haul"
    `);
    const script = exportTopologyScript();
    expect(script).toContain('add computer "My PC" at 0 0');
    expect(script).toContain('ssid AP1 "Guest WiFi" "pass phrase"');

    resetState();
    runConsoleScript(script);
    const ap = state.devices.find(d => d.name === "AP1")!;
    expect(state.devices.map(d => d.name).sort()).toEqual(["AP1", "My PC"]);
    expect(ap.config.ssid).toBe("Guest WiFi");
    expect(ap.config.wifiPassword).toBe("pass phrase");
    expect(state.links[0].name).toBe("Back haul");
  });

  it("delivers a free-text tail verbatim even when the device is quoted", () => {
    runConsoleScript(`add ids "My IDS" at 0 0`);
    const rule = 'alert tcp any any -> any 80 (msg:"web hit"; sid:100;)';
    expect(exec(`idsrule "My IDS" ${rule}`).ok).toBe(true);
    const ids = state.devices.find(d => d.name === "My IDS")!;
    expect((ids.config as any).idsRules).toContain(rule);   // quotes inside the rule survive
  });

  it("rejects an unterminated quote instead of guessing", () => {
    const r = exec('add computer "My PC');
    expect(r.ok).toBe(false);
    expect(r.output.join(" ")).toContain("Unterminated");
    expect(state.devices).toHaveLength(0);
  });
});
