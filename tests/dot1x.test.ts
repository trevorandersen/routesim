/**
 * 802.1X port-based authentication: the EAPOL/EAP ↔ RADIUS exchange across the
 * supplicant (host), authenticator (switch port in `auto`) and RADIUS server;
 * the port-authorization data gate; and config serialisation.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { state } from "../src/state";
import { startSimulation, stepOnce } from "../src/engine";
import { buildDot1xEvents } from "../src/simulation";
import { dot1xPortAuthorized } from "../src/devices";
import { packetColumns } from "../src/frame";
import { runConsoleScript, runConsoleCommand as exec, exportTopologyScript } from "../src/commands";
import { buildConfigPayload, parseConfig, applyConfig } from "../src/config";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());
const byName = (n: string) => state.devices.find(d => d.name === n)!;

// PC1 on an `auto` port of SW; R1 is the thing to reach; RAD is the RADIUS
// server (adjacent to SW). `pw` is the password PC1 presents.
function topology(pw: string) {
  runConsoleScript(`
    clear
    add computer PC1 at 0 0
    add switch SW at 150 0
    add router R1 at 300 0
    add server RAD at 150 150
    link PC1 SW
    link SW R1
    link SW RAD
    ip PC1 10.0.0.10/24
    gateway PC1 10.0.0.1
    interface R1 SW ip 10.0.0.1
    ip RAD 10.0.0.2/24
    radius RAD alice secret123
    supplicant PC1 alice ${pw}
    portauth SW Ethernet1 auto
  `);
  return byName("PC1");
}

function authenticate(pc: any) {
  const realRaf = (globalThis as any).requestAnimationFrame;
  (globalThis as any).requestAnimationFrame = () => 0;
  const setup = buildDot1xEvents(pc);
  expect(typeof setup).not.toBe("string");
  state.simulation.autoPlay = true;
  startSimulation(setup as any, pc.id, "", "dot1x");
  let g = 0; while (state.simulation.status !== "done" && g++ < 200) stepOnce();
  (globalThis as any).requestAnimationFrame = realRaf;
  return state.simulation.capture.map(c => packetColumns(c.frame));
}

describe("802.1X — port authentication", () => {
  const realRaf = (globalThis as any).requestAnimationFrame;
  beforeEach(() => resetState());
  afterEach(() => { (globalThis as any).requestAnimationFrame = realRaf; });

  it("an `auto` port blocks data until the supplicant authenticates", () => {
    const pc = topology("secret123");
    expect(exec("run ping PC1 10.0.0.1").ok).toBe(false); // unauthorized → no data
    const seq = authenticate(pc);
    expect(state.simulation.dot1xAuthorized).toBe(true);
    // The full EAPOL → EAP-Identity → RADIUS → EAP-Success chain
    const protos = seq.map(c => c.protocol);
    expect(protos).toEqual(["EAPOL", "EAP", "EAP", "RADIUS", "RADIUS", "EAP"]);
    expect(seq.some(c => c.info === "Access-Accept")).toBe(true);
    expect(seq[seq.length - 1].info).toBe("Success");
    // …and now the port carries data.
    expect(exec("run ping PC1 10.0.0.1").ok).toBe(true);
  });

  it("a bad credential is rejected (Access-Reject → EAP-Failure) and stays blocked", () => {
    const pc = topology("WRONG");
    const seq = authenticate(pc);
    expect(state.simulation.dot1xAuthorized).toBe(false);
    expect(seq.some(c => c.info === "Access-Reject")).toBe(true);
    expect(seq.some(c => c.info === "Failure")).toBe(true);
    expect(exec("run ping PC1 10.0.0.1").ok).toBe(false);
  });

  it("force-authorized (the default) and force-unauthorized gate without any exchange", () => {
    topology("secret123");
    const sw = byName("SW"), link = state.links.find(l => {
      const a = byName("PC1").id; return l.from === a || l.to === a;
    })!;
    sw.config.portAuth!.Ethernet1 = "force-authorized";
    expect(dot1xPortAuthorized(link)).toBe(true);  // open — data flows with no 802.1X
    sw.config.portAuth!.Ethernet1 = "force-unauthorized";
    expect(dot1xPortAuthorized(link)).toBe(false); // closed — never authorises
  });

  it("`run dot1x` reports success/failure; an unconfigured supplicant errors", () => {
    topology("secret123");
    expect(exec("run dot1x PC1").ok).toBe(true);
    runConsoleScript("add computer PC9 at 0 200\nlink PC9 SW");
    expect(exec("run dot1x PC9").ok).toBe(false); // no identity / not on an auto port
  });

  it("the 802.1X config round-trips through JSON and the command script", () => {
    topology("secret123");
    // JSON
    const json = JSON.stringify(buildConfigPayload());
    resetState();
    applyConfig(parseConfig(json));
    expect(byName("PC1").config.dot1x).toEqual({ identity: "alice", password: "secret123" });
    expect(byName("SW").config.portAuth!.Ethernet1).toBe("auto");
    expect(byName("RAD").config.radius!.users[0]).toEqual({ identity: "alice", password: "secret123" });
    // Script
    const script = exportTopologyScript();
    expect(script).toContain("supplicant PC1 alice secret123");
    expect(script).toContain("portauth SW Ethernet1 auto");
    expect(script).toContain("radius RAD alice secret123");
    resetState();
    runConsoleScript(script);
    expect(exec("run dot1x PC1").ok).toBe(true); // the whole thing works after a script replay
  });
});

describe("802.1X correlates the exchange by the supplicant's MAC (F09)", () => {
  beforeEach(() => resetState());
  // Two supplicants on separate `auto` ports presenting the SAME identity —
  // PC1 with the right password, PC2 with a wrong one. Identity alone used to
  // validate PC1's password for PC2's attempt and authorise PC1's port.
  function twoSupplicants() {
    runConsoleScript(`
      clear
      add computer PC1 at 0 0
      add computer PC2 at 0 200
      add switch SW at 150 100
      add server RAD at 300 100
      link PC1 SW
      link PC2 SW
      link SW RAD
      ip PC1 10.0.0.10/24
      ip PC2 10.0.0.11/24
      ip RAD 10.0.0.2/24
      radius RAD alice secret123
      supplicant PC1 alice secret123
      supplicant PC2 alice WRONG
      portauth SW Ethernet1 auto
      portauth SW Ethernet2 auto
    `);
  }
  const linkOf = (name: string) => state.links.find(l => [l.from, l.to].includes(byName(name).id) && [l.from, l.to].includes(byName("SW").id))!;

  it("PC2's wrong password is rejected — and PC1's port is NOT authorised in its place", () => {
    twoSupplicants();
    authenticate(byName("PC2"));
    expect(linkOf("PC2").dot1xAuthorized).toBeFalsy();
    expect(linkOf("PC1").dot1xAuthorized).toBeFalsy();
  });
  it("PC1's correct password authorises PC1's port only", () => {
    twoSupplicants();
    authenticate(byName("PC1"));
    expect(linkOf("PC1").dot1xAuthorized).toBe(true);
    expect(linkOf("PC2").dot1xAuthorized).toBeFalsy();
  });
});

// R7: port control is a property of the SWITCH PORT, not of the peer type. It
// used to apply only when the peer was a computer/laptop/server, so a Kali PC,
// a Red Team host, a hub (and everything behind it) or a router on an
// `auto`/`force-unauthorized` port passed data as if the port were open.
describe("802.1X port control applies to whatever is plugged in (R7)", () => {
  beforeEach(() => resetState());

  // `peer` is cabled to SW Ethernet1, under the given port-control mode; R1
  // (10.0.0.1) is the thing to reach on Ethernet2; RAD is the RADIUS server.
  function lockedPort(peerType: string, mode: string) {
    runConsoleScript(`
      clear
      add ${peerType} K1 at 0 0
      add switch SW at 150 0
      add router R1 at 300 0
      add server RAD at 150 150
      link K1 SW
      link SW R1
      link SW RAD
      ip K1 10.0.0.66/24
      gateway K1 10.0.0.1
      interface R1 SW ip 10.0.0.1
      ip RAD 10.0.0.2/24
      radius RAD alice secret123
      portauth SW Ethernet1 ${mode}
    `);
    return byName("K1");
  }

  it("a Kali PC on a force-unauthorized port is blocked, like a PC", () => {
    lockedPort("kali", "force-unauthorized");
    const r = exec("run ping K1 10.0.0.1");
    expect(r.ok).toBe(false);
  });

  it("a Red Team host on an `auto` port is blocked until it authenticates", () => {
    const rt = lockedPort("attacker", "auto");
    expect(exec("run ping K1 10.0.0.1").ok).toBe(false);
    // With valid (stolen) credentials it can run the supplicant like any host.
    expect(exec("supplicant K1 alice secret123").ok).toBe(true);
    authenticate(rt);
    expect(state.simulation.dot1xAuthorized).toBe(true);
    expect(exec("run ping K1 10.0.0.1").ok).toBe(true);
  });

  it("a Kali PC can run the supplicant (the console and the exchange agree)", () => {
    const k = lockedPort("kali", "auto");
    expect(exec("supplicant K1 alice secret123").ok).toBe(true);
    expect(typeof buildDot1xEvents(k)).not.toBe("string");   // used to be "not a host"
    authenticate(k);
    expect(exec("run ping K1 10.0.0.1").ok).toBe(true);
  });

  it("a hub on an `auto` port does not open it for the hosts behind it", () => {
    runConsoleScript(`
      clear
      add hub HUB at 0 0
      add computer PC1 at -150 0
      add switch SW at 150 0
      add router R1 at 300 0
      link HUB SW
      link SW R1
      link PC1 HUB
      ip PC1 10.0.0.10/24
      gateway PC1 10.0.0.1
      interface R1 SW ip 10.0.0.1
      portauth SW Ethernet1 auto
    `);
    expect(exec("run ping PC1 10.0.0.1").ok).toBe(false);
    exec("portauth SW Ethernet1 force-authorized");
    expect(exec("run ping PC1 10.0.0.1").ok).toBe(true);    // the same path, port opened
  });

  it("a router on a force-unauthorized port is cut off", () => {
    runConsoleScript(`
      clear
      add computer PC1 at 0 0
      add switch SW at 150 0
      add router R1 at 300 0
      link PC1 SW
      link SW R1
      ip PC1 10.0.0.10/24
      gateway PC1 10.0.0.1
      interface R1 SW ip 10.0.0.1
      portauth SW Ethernet2 force-unauthorized
    `);
    expect(exec("run ping PC1 10.0.0.1").ok).toBe(false);
    const swR1 = state.links.find(l => [l.from, l.to].includes(byName("R1").id))!;
    expect(dot1xPortAuthorized(swR1)).toBe(false);
  });

  it("both ends of a switch↔switch link are checked", () => {
    runConsoleScript(`
      clear
      add switch SW1 at 0 0
      add switch SW2 at 200 0
      link SW1 SW2
      portauth SW1 Ethernet1 force-authorized
      portauth SW2 Ethernet1 force-unauthorized
    `);
    expect(dot1xPortAuthorized(state.links[0])).toBe(false);   // SW2's end holds it closed
  });
});

describe("a Red Team host's supplicant and ports round-trip through the script", () => {
  beforeEach(() => resetState());
  it("the attacker shares the host export lines", () => {
    runConsoleScript(`
      clear
      add attacker RT1 at 0 0
      ip RT1 10.0.0.66/24
      supplicant RT1 alice secret123
      ports RT1 22
    `);
    const script = exportTopologyScript();
    expect(script).toContain("ip RT1 10.0.0.66/24");
    expect(script).toContain("supplicant RT1 alice secret123");
    expect(script).toContain("ports RT1 22");
    expect(script).toContain("redteam RT1 attacks scan");
    resetState();
    runConsoleScript(script);
    expect(byName("RT1").config.dot1x).toEqual({ identity: "alice", password: "secret123" });
    expect(byName("RT1").config.openPorts).toEqual([22]);
  });
});
