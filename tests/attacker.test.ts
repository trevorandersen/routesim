/**
 * Red Team host — the simulated attacks (port scan, ping sweep, ARP spoof) and
 * how the IDS detects them. Builds small topologies, runs an attack headlessly,
 * and asserts the findings + side effects.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { state } from "../src/state";
import { runConsoleCommand as exec, runConsoleScript, exportTopologyScript } from "../src/commands";
import { buildScanEvents, buildSweepEvents, buildArpSpoofEvents, buildAttackEvents } from "../src/simulation";
import { runSimulationHeadless, startSimulation, stepOnce, launchRedTeam } from "../src/engine";
import { runAttackerTerminalCommand } from "../src/terminal/attacker";
import { buildConfigPayload } from "../src/config";
import { normaliseConfig } from "../src/normalise";
import { linkedPortsFor } from "../src/devices";
import { registerNoopCallbacks, resetState } from "./helpers";
import { freshNameCounters } from "../src/device-registry";
import { routedTopology } from "./fixtures";

beforeAll(() => registerNoopCallbacks());

function reset() {
  resetState();
  state.nameCounters = freshNameCounters();
  state.configStore = { version: 1, configs: {} } as any;
}

const dev = (name: string) => state.devices.find(d => d.name === name)!;

describe("Red Team — port scan", () => {
  beforeEach(reset);

  it("a SYN scan finds the target's open ports and marks the rest closed", () => {
    exec("add switch SW1 at 0 0");
    exec("add attacker RT1 at -150 0");
    exec("add server SRV at 150 0");
    exec("ip RT1 10.0.0.66/24");
    exec("ip SRV 10.0.0.10/24");
    dev("SRV").config.openPorts = [22, 80];      // only SSH + HTTP listen
    exec("link RT1 SW1");
    exec("link SRV SW1");

    const setup = buildScanEvents(dev("RT1"), "SRV");
    expect(typeof setup).not.toBe("string");
    runSimulationHeadless(setup as any, dev("RT1").id, "", "attack");
    expect([...state.simulation.scanOpen].sort((a, b) => a - b)).toEqual([22, 80]);
    expect(state.simulation.scanClosed).toContain(23);   // telnet closed
    expect(state.simulation.scanClosed).toContain(443);
  });

  it("the scan trips an IDS Telnet rule via the port-23 probe (red vs blue)", () => {
    exec("add switch SW1 at 0 0");
    exec("add attacker RT1 at -150 0");
    exec("add server SRV at 150 0");
    exec("add ids IDS1 at 0 150");
    dev("SW1").config.managed = true;
    exec("ip RT1 10.0.0.66/24");
    exec("ip SRV 10.0.0.10/24");
    exec("link RT1 SW1");
    exec("link SRV SW1");
    exec("link IDS1 SW1");
    const idsIdx = linkedPortsFor(dev("SW1").id).findIndex((p: any) => p?.peer?.id === dev("IDS1").id);
    dev("SW1").config.mirror = { name: "MON", dest: `Ethernet${idsIdx + 1}` };

    const setup = buildScanEvents(dev("RT1"), "SRV");
    runSimulationHeadless(setup as any, dev("RT1").id, "", "attack");
    expect((dev("IDS1").config.alerts || []).some(a => a.includes("Telnet"))).toBe(true);
  });
});

describe("Red Team — ping sweep + ARP spoof", () => {
  beforeEach(reset);

  it("a ping sweep discovers the live hosts in the subnet", () => {
    exec("add switch SW1 at 0 0");
    exec("add attacker RT1 at -200 0");
    exec("add computer PC1 at 0 -150");
    exec("add computer PC2 at 0 150");
    exec("ip RT1 10.0.0.66/24");
    exec("ip PC1 10.0.0.5/24");
    exec("ip PC2 10.0.0.6/24");
    exec("link RT1 SW1");
    exec("link PC1 SW1");
    exec("link PC2 SW1");

    const setup = buildSweepEvents(dev("RT1"), "");   // own subnet
    expect(typeof setup).not.toBe("string");
    runSimulationHeadless(setup as any, dev("RT1").id, "", "attack");
    expect(state.simulation.sweepLive).toContain("10.0.0.5");
    expect(state.simulation.sweepLive).toContain("10.0.0.6");
    expect(state.simulation.sweepLive).not.toContain("10.0.0.19");   // nothing there
  });

  // Every ICMP-echo destination a sweep setup emits (resolved frames + the
  // echoes queued behind an ARP).
  const sweepDests = (setup: any): string[] => {
    const out: string[] = [];
    const grab = (f: any) => { const p = f?.payload; if (p?.type === "ipv4" && p.payload?.type === "icmp") out.push(p.dstIp); };
    for (const e of setup.events || []) grab(e.frame);
    for (const arr of Object.values(setup.pendingArp || {})) for (const f of arr as any[]) grab(f);
    return out;
  };

  it("bounds the sweep to the subnet's usable hosts — no broadcast or next-subnet probe (R27)", () => {
    exec("add switch SW1 at 0 0");
    exec("add attacker RT1 at -200 0");
    exec("ip RT1 10.0.0.1/29");          // usable .1–.6, broadcast .7
    exec("link RT1 SW1");
    const setup = buildSweepEvents(dev("RT1"), "") as any;   // own subnet
    expect(typeof setup).not.toBe("string");
    const octets = sweepDests(setup).map(ip => Number(ip.split(".")[3]));
    expect(octets.length).toBeGreaterThan(0);
    expect(Math.max(...octets)).toBeLessThanOrEqual(6);   // never .7 (broadcast) or the next subnet
    expect(octets).not.toContain(7);
  });

  it("rejects a garbage sweep target instead of sweeping 0.0.0.x (R27)", () => {
    exec("add switch SW1 at 0 0");
    exec("add attacker RT1 at -200 0");
    exec("ip RT1 10.0.0.1/24");
    exec("link RT1 SW1");
    expect(buildSweepEvents(dev("RT1"), "foo/24")).toBe("nmap: invalid target");
  });

  it("an ARP spoof poisons a victim's ARP cache (gateway -> attacker MAC)", () => {
    exec("add switch SW1 at 0 0");
    exec("add attacker RT1 at -150 0");
    exec("add computer PC1 at 150 0");
    exec("ip RT1 10.0.0.66/24");
    exec("ip PC1 10.0.0.5/24");
    exec("link RT1 SW1");
    exec("link PC1 SW1");

    const setup = buildArpSpoofEvents(dev("RT1"), "10.0.0.1");   // impersonate the gateway
    runSimulationHeadless(setup as any, dev("RT1").id, "", "attack");
    const poisoned = (dev("PC1").config.arpTable || []).find((e: any) => e.ipv4Address === "10.0.0.1");
    expect(poisoned?.macAddress).toBe(dev("RT1").config.macAddress);   // gateway now points at the attacker
  });

  it("buildAttackEvents merges the enabled attacks; the attacker is a passive sink for replies (success flag)", () => {
    exec("add switch SW1 at 0 0");
    exec("add attacker RT1 at -150 0");
    exec("add server SRV at 150 0");
    exec("ip RT1 10.0.0.66/24");
    exec("ip SRV 10.0.0.10/24");
    dev("SRV").config.openPorts = [80];
    (dev("RT1").config as any).attacks = ["scan", "sweep"];
    (dev("RT1").config as any).attackTarget = "SRV";
    exec("link RT1 SW1");
    exec("link SRV SW1");

    const setup = buildAttackEvents(dev("RT1"));
    expect(typeof setup).not.toBe("string");
    const r = runSimulationHeadless(setup as any, dev("RT1").id, "", "attack");
    expect(state.simulation.scanOpen).toContain(80);
    expect(r.success).toBe(true);   // found something
  });
});

describe("Red Team — console + Kali terminal", () => {
  // The preload's synchronous requestAnimationFrame would recurse inside the
  // animation loop, so animated runs are pumped manually via stepOnce().
  const realRaf = (globalThis as any).requestAnimationFrame;
  beforeEach(() => {
    reset();
    (globalThis as any).requestAnimationFrame = () => 0;
  });
  afterEach(() => {
    (globalThis as any).requestAnimationFrame = realRaf;
  });

  function pump() {
    state.simulation.autoPlay = true;
    let guard = 0;
    while (state.simulation.status !== "done" && guard++ < 3000) stepOnce();
    expect(state.simulation.status).toBe("done");
  }

  function scanTopology() {
    exec("add switch SW1 at 0 0");
    exec("add attacker RT1 at -150 0");
    exec("add server SRV at 150 0");
    exec("ip RT1 10.0.0.66/24");
    exec("ip SRV 10.0.0.10/24");
    dev("SRV").config.openPorts = [22, 80];
    exec("link RT1 SW1");
    exec("link SRV SW1");
  }

  it("redteam configures the target, attacks, and spoof IP", () => {
    exec("add attacker RT1 at 0 0");
    exec("redteam RT1 target 10.0.0.10");
    expect(dev("RT1").config.attackTarget).toBe("10.0.0.10");
    exec("redteam RT1 attacks scan,arp-spoof,bogus");   // bogus is filtered out
    expect(dev("RT1").config.attacks).toEqual(["scan", "arp-spoof"]);
    exec("redteam RT1 spoof 10.0.0.1");
    expect(dev("RT1").config.spoofIp).toBe("10.0.0.1");
  });

  it("attack rejects a node that is neither a Kali PC nor a Red Team host", () => {
    exec("add computer PC1 at 0 0");
    const r = exec("attack PC1 scan");
    expect(r.ok).toBe(false);
    expect(r.output.join(" ")).toContain("not a Kali PC or Red Team host");
  });

  it("attack <node> scan <target> runs end to end and reports the open ports", () => {
    scanTopology();
    const r = exec("attack RT1 scan SRV");
    expect(r.ok).toBe(true);
    pump();
    expect([...state.simulation.scanOpen].sort((a, b) => a - b)).toEqual([22, 80]);
    // finishSimulation builds an nmap-style report and stashes it for the inspector.
    const report = (dev("RT1").config as any).attackLog as string[];
    expect(report.join("\n")).toContain("PORT");
    expect(report.join("\n")).toContain("22/tcp");
    expect(report.join("\n")).toContain("open");
  });

  it("the Kali terminal reports nmap's version, help, and renames the host", () => {
    exec("add attacker RT1 at 0 0");
    const rt = dev("RT1");
    state.terminal.lines = [];
    runAttackerTerminalCommand(rt, "nmap -V");
    expect(state.terminal.lines.at(-1)!.text).toContain("Nmap version");
    runAttackerTerminalCommand(rt, "?");
    expect(state.terminal.lines.at(-1)!.text).toContain("SYN port scan");
    runAttackerTerminalCommand(rt, "hostname kali");
    expect(dev("kali")).toBeTruthy();   // applyHostname renamed it
  });

  it("the Kali nmap -sS command launches a scan that finds the open ports", () => {
    scanTopology();
    state.terminal.lines = [];
    runAttackerTerminalCommand(dev("RT1"), "nmap -sS SRV");
    expect(state.simulation.status).not.toBe("idle");   // a run started
    pump();
    expect([...state.simulation.scanOpen].sort((a, b) => a - b)).toEqual([22, 80]);
  });

  it("the Kali nmap -sn command launches a ping sweep of the subnet", () => {
    exec("add switch SW1 at 0 0");
    exec("add attacker RT1 at -150 0");
    exec("add computer PC1 at 150 0");
    exec("ip RT1 10.0.0.66/24");
    exec("ip PC1 10.0.0.7/24");
    exec("link RT1 SW1");
    exec("link PC1 SW1");
    runAttackerTerminalCommand(dev("RT1"), "nmap -sn 10.0.0.0/24");
    pump();
    expect(state.simulation.sweepLive).toContain("10.0.0.7");
  });
});

describe("Red Team — persistence", () => {
  beforeEach(reset);

  function configured() {
    exec("add attacker RT1 at 0 0");
    exec("ip RT1 10.0.0.66/24");
    exec("redteam RT1 attacks scan,sweep,arp-spoof");
    exec("redteam RT1 target 10.0.0.10");
    exec("redteam RT1 spoof 10.0.0.1");
  }

  it("a JSON config round-trip preserves the attacks, target, and spoof IP", () => {
    configured();
    const re = normaliseConfig(buildConfigPayload() as any).devices.find((d: any) => d.name === "RT1")!;
    expect(re.config.attacks).toEqual(["scan", "sweep", "arp-spoof"]);
    expect(re.config.attackTarget).toBe("10.0.0.10");
    expect(re.config.spoofIp).toBe("10.0.0.1");
  });

  it("the script export replays the Red Team configuration", () => {
    configured();
    const script = exportTopologyScript();
    expect(script).toContain("redteam RT1 attacks scan,sweep,arp-spoof");
    expect(script).toContain("redteam RT1 target 10.0.0.10");
    expect(script).toContain("redteam RT1 spoof 10.0.0.1");
    reset();
    runConsoleScript(script);
    const rt = dev("RT1");
    expect(rt.config.attacks).toEqual(["scan", "sweep", "arp-spoof"]);
    expect(rt.config.attackTarget).toBe("10.0.0.10");
    expect(rt.config.spoofIp).toBe("10.0.0.1");
  });

  it("a non-/24 prefix survives the JSON and script round-trip (regression)", () => {
    exec("add attacker RT1 at 0 0");
    exec("ip RT1 10.0.0.66/16");                         // a /16, not the default /24
    const re = normaliseConfig(buildConfigPayload() as any).devices.find((d: any) => d.name === "RT1")!;
    expect(re.config.prefixLength).toBe(16);             // was silently dropped to /24 before the fix
    const script = exportTopologyScript();
    expect(script).toContain("ip RT1 10.0.0.66/16");
  });
});

describe("Kali PC vs Red Team actor", () => {
  beforeEach(reset);

  it("a Kali PC is an ordinary single-NIC host that gets a MAC on creation", () => {
    exec("add kali KALI1 at 0 0");
    const k = dev("KALI1");
    expect(k.type).toBe("kali");
    expect(k.config.macAddress).toMatch(/^[0-9A-F:]{17}$/);   // MAC-on-create
    // single NIC: a second cable is refused
    exec("add switch SW1 at 200 0");
    exec("add switch SW2 at -200 0");
    exec("link KALI1 SW1");
    const before = linkedPortsFor(k.id).length;
    exec("link KALI1 SW2");                               // should be refused (single NIC)
    expect(linkedPortsFor(k.id).length).toBe(before);
  });

  it("a Kali PC serialises as a plain host (no attack config in the script)", () => {
    exec("add kali KALI1 at 0 0");
    exec("ip KALI1 10.0.5.7/16");
    exec("gateway KALI1 10.0.5.1");
    const re = normaliseConfig(buildConfigPayload() as any).devices.find((d: any) => d.name === "KALI1")!;
    expect(re.config.ipv4Address).toBe("10.0.5.7");
    expect(re.config.prefixLength).toBe(16);
    expect(re.config.attacks).toBeUndefined();           // no autonomous attack config
    const script = exportTopologyScript();
    expect(script).toContain("ip KALI1 10.0.5.7/16");
    expect(script).not.toContain("redteam KALI1");       // never emits redteam lines
  });
});

describe("Kali PC — terminal + attacks (animated)", () => {
  const realRaf = (globalThis as any).requestAnimationFrame;
  beforeEach(() => {
    reset();
    (globalThis as any).requestAnimationFrame = () => 0;
  });
  afterEach(() => {
    (globalThis as any).requestAnimationFrame = realRaf;
  });

  function pump() {
    state.simulation.autoPlay = true;
    let guard = 0;
    while (state.simulation.status !== "done" && guard++ < 3000) stepOnce();
    expect(state.simulation.status).toBe("done");
  }

  it("Play's autonomous Red Team launch fires for an actor but NOT for a Kali PC", () => {
    exec("add switch SW1 at 0 0");
    exec("add kali KALI1 at -150 0");
    exec("ip KALI1 10.0.0.5/24");
    exec("link KALI1 SW1");
    (dev("KALI1").config as any).attacks = ["scan"];     // even if it carried attacks…
    (dev("KALI1").config as any).attackTarget = "10.0.0.9";
    expect(launchRedTeam()).toBe(false);                 // …a Kali PC is user-driven, never autonomous
    exec("add attacker RT1 at 150 0");
    exec("ip RT1 10.0.0.6/24");
    exec("link RT1 SW1");
    exec("redteam RT1 target 10.0.0.9");
    expect(launchRedTeam()).toBe(true);                  // the actor does auto-launch
  });

  it("the Kali terminal falls through to the host shell (ip addr / ping work)", () => {
    exec("add kali KALI1 at 0 0");
    const k = dev("KALI1");
    // An unrecognised (non-attack) command must run the real Linux host command,
    // not print 'command not found' — this is what drives the inspector fields.
    runAttackerTerminalCommand(k, "ip addr add 10.0.0.5/24 dev eth0");
    expect(k.config.ipv4Address).toBe("10.0.0.5");
    expect(k.config.prefixLength).toBe(24);
  });

  it("a Kali PC runs a hand-issued scan and finds the open ports", () => {
    exec("add switch SW1 at 0 0");
    exec("add kali KALI1 at -150 0");
    exec("add server SRV at 150 0");
    exec("ip KALI1 10.0.0.5/24");
    exec("ip SRV 10.0.0.10/24");
    dev("SRV").config.openPorts = [22, 443];
    exec("link KALI1 SW1");
    exec("link SRV SW1");
    const r = exec("attack KALI1 scan SRV");
    expect(r.ok).toBe(true);
    pump();
    expect([...state.simulation.scanOpen].sort((a, b) => a - b)).toEqual([22, 443]);
  });
});

describe("Red Team — cross-subnet sweep routing (regression)", () => {
  beforeEach(reset);

  it("a remote-subnet sweep ARPs the gateway once, not each host", () => {
    // The bug: buildSweepEvents ARP-resolved every remote host directly on the
    // local wire (nobody answers), so an off-subnet sweep found nothing. The fix
    // routes off-subnet probes via the gateway — one shared ARP, all echoes
    // buffered under the gateway's next-hop key (exactly like a cross-subnet ping).
    exec("add attacker RT1 at 0 0");
    exec("add switch SW1 at 150 0");
    exec("ip RT1 10.0.0.66/24");
    exec("gateway RT1 10.0.0.1");
    exec("link RT1 SW1");

    const setup = buildSweepEvents(dev("RT1"), "10.0.1.0/24");   // a different subnet
    expect(typeof setup).not.toBe("string");
    const s = setup as any;
    const arpEvents = s.events.filter((e: any) => e.frame.payload.type === "arp");
    expect(arpEvents.length).toBe(1);                            // ONE ARP (the gateway), not 20
    const keys = Object.keys(s.pendingArp);
    expect(keys).toEqual([`${dev("RT1").id}:10.0.0.1`]);         // all echoes wait on the gateway
    expect(s.pendingArp[keys[0]].length).toBeGreaterThan(1);
  });

  it("a remote-subnet sweep with no gateway set finds nothing to sweep", () => {
    exec("add attacker RT1 at 0 0");
    exec("add switch SW1 at 150 0");
    exec("ip RT1 10.0.0.66/24");          // no gateway
    exec("link RT1 SW1");
    const setup = buildSweepEvents(dev("RT1"), "10.0.9.0/24");
    expect(setup).toBe("nmap: nothing to sweep");                // unroutable, not a silent void
  });

  it("end to end: a cross-subnet sweep routes through the router and discovers the far host", () => {
    // routedTopology: PC-A 192.168.10.10 / SW-A / RTR-1 (.10.1 + .20.1) / SW-B / PC-B 192.168.20.10
    const topo = normaliseConfig(routedTopology() as any);
    state.devices = topo.devices as any;
    state.links = topo.links as any;
    // A Red Team host on the .10 subnet, gateway = the router's near interface.
    exec("add attacker RT1 at -500 0");
    exec("ip RT1 192.168.10.66/24");
    exec("gateway RT1 192.168.10.1");
    exec("link RT1 SW-A");

    const setup = buildSweepEvents(dev("RT1"), "192.168.20.0/24");   // the OTHER subnet
    expect(typeof setup).not.toBe("string");
    runSimulationHeadless(setup as any, dev("RT1").id, "", "attack");
    expect(state.simulation.sweepLive).toContain("192.168.20.10");   // PC-B, found across the router
  });
});

describe("Kali shell — paused run guard and unmodelled nmap options (LOW sweep)", () => {
  beforeEach(() => resetState());
  const out = () => JSON.stringify(state.terminal.lines);
  it("refuses to launch while a run is PAUSED, not only while running", () => {
    runConsoleScript("add kali K at 0 0\nadd computer T at 200 0\nlink K T\nip K 10.0.0.1/24\nip T 10.0.0.2/24");
    const k = state.devices.find(d => d.name === "K")!;
    state.simulation.status = "paused";
    runAttackerTerminalCommand(k, "nmap -sS 10.0.0.2");
    expect(out()).toContain("already running (or paused)");
    expect(state.simulation.status).toBe("paused");   // untouched
  });
  it("explains an unmodelled nmap option instead of treating it as an unknown shell command", () => {
    runConsoleScript("add kali K at 0 0");
    const k = state.devices.find(d => d.name === "K")!;
    runAttackerTerminalCommand(k, "nmap -sT 10.0.0.2");
    expect(out()).toContain("not");
    expect(out()).toContain("-sS");
  });
});
