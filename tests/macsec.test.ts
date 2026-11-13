/**
 * MACsec (802.1AE) link encryption: the per-peer CAK config, the live
 * `macsecState` (secured / failed / open), the must-secure data gate, the
 * encrypted-frame rendering in the packet list, config round-trip, and the
 * Phase 3 integration — keys derived from a successful 802.1X exchange (MKA).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { state } from "../src/state";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { startSimulation, stepOnce } from "../src/engine";
import { buildPingEvents } from "../src/simulation";
import { macsecState } from "../src/devices";
import { buildConfigPayload, parseConfig, applyConfig } from "../src/config";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());
const byName = (n: string) => state.devices.find(d => d.name === n)!;
const linkOf = (a: any, b: any) => state.links.find(l => (l.from === a.id && l.to === b.id) || (l.from === b.id && l.to === a.id))!;

function topology() {
  runConsoleScript(`
    clear
    add computer PC1 at 0 0
    add switch SW at 150 0
    add computer PC2 at 300 0
    link PC1 SW
    link SW PC2
    ip PC1 10.0.0.1/24
    ip PC2 10.0.0.2/24
  `);
  return { pc1: byName("PC1"), sw: byName("SW"), pc2: byName("PC2") };
}

describe("MACsec — 802.1AE link encryption", () => {
  beforeEach(() => resetState());

  it("a matching CAK secures the link; its frames show encrypted but still deliver", () => {
    const { pc1, sw } = topology();
    runConsoleScript("macsec PC1 SW key123\nmacsec SW PC1 key123 must");
    expect(macsecState(linkOf(pc1, sw))).toBe("secured");
    // Animated ping — every frame on the PC1↔SW wire is MACsec-protected.
    const realRaf = (globalThis as any).requestAnimationFrame;
    (globalThis as any).requestAnimationFrame = () => 0;
    const setup = buildPingEvents(pc1, "10.0.0.2");
    state.simulation.autoPlay = true;
    startSimulation(setup as any, pc1.id, "10.0.0.2", "ping");
    let g = 0; while (state.simulation.status !== "done" && g++ < 200) stepOnce();
    (globalThis as any).requestAnimationFrame = realRaf;
    const onWire = state.simulation.capture.filter(c => c.linkId === linkOf(pc1, sw).id);
    expect(onWire.length).toBeGreaterThan(0);
    expect(onWire.every(c => c.macsec)).toBe(true);
    // It still works — MACsec decrypts at the far end.
    expect(exec("run ping PC1 10.0.0.2").ok).toBe(true);
  });

  it("a must-secure key mismatch fails the link and blocks data", () => {
    const { pc1, sw } = topology();
    runConsoleScript("macsec PC1 SW keyAAA must\nmacsec SW PC1 keyBBB must");
    expect(macsecState(linkOf(pc1, sw))).toBe("failed");
    expect(exec("run ping PC1 10.0.0.2").ok).toBe(false);
  });

  it("a should-secure CAK mismatch falls back to plaintext; must-secure fails it (R47)", () => {
    const { pc1, sw } = topology();
    // Both ends key MACsec with a static CAK but the keys differ, and neither is
    // must-secure (the default): should-secure carries plaintext, not a dead link.
    runConsoleScript("macsec PC1 SW keyAAA should\nmacsec SW PC1 keyBBB should");
    expect(macsecState(linkOf(pc1, sw))).toBe("open");
    expect(exec("run ping PC1 10.0.0.2").ok).toBe(true);
    // Flip either end to must-secure and the same mismatch now fails the link.
    runConsoleScript("macsec SW PC1 keyBBB must");
    expect(macsecState(linkOf(pc1, sw))).toBe("failed");
    expect(exec("run ping PC1 10.0.0.2").ok).toBe(false);
  });

  it("should-secure falls back to plaintext against a bare peer; must-secure does not", () => {
    const { pc1, sw } = topology();
    runConsoleScript("macsec PC1 SW keyX should"); // only PC1 configured
    expect(macsecState(linkOf(pc1, sw))).toBe("open");
    expect(exec("run ping PC1 10.0.0.2").ok).toBe(true);
    runConsoleScript("macsec PC1 SW keyX must");
    expect(macsecState(linkOf(pc1, sw))).toBe("failed");
    expect(exec("run ping PC1 10.0.0.2").ok).toBe(false);
  });

  it("`macsec … off` clears the key (clearing one must-secure end fails the link; clearing both opens it)", () => {
    const { pc1, sw } = topology();
    runConsoleScript("macsec PC1 SW k must\nmacsec SW PC1 k must");
    expect(macsecState(linkOf(pc1, sw))).toBe("secured");
    runConsoleScript("macsec PC1 SW off");
    expect(macsecState(linkOf(pc1, sw))).toBe("failed"); // SW is still must-secure, now facing a bare peer
    runConsoleScript("macsec SW PC1 off");
    expect(macsecState(linkOf(pc1, sw))).toBe("open");   // both cleared → no MACsec
  });

  it("the MACsec config round-trips through JSON and the command script", () => {
    const { pc1, sw } = topology();
    runConsoleScript("macsec PC1 SW secretK must\nmacsec SW PC1 secretK must");
    const script = exec("export").output.join("\n");
    expect(script).toContain("macsec PC1 SW secretK must");
    expect(script).toContain("macsec SW PC1 secretK must");
    resetState();
    runConsoleScript(script);
    expect(macsecState(linkOf(byName("PC1"), byName("SW")))).toBe("secured");
  });
});

describe("MACsec — 802.1X-derived keys (MKA / Phase 3)", () => {
  const realRaf = (globalThis as any).requestAnimationFrame;
  beforeEach(() => resetState());
  afterEach(() => { (globalThis as any).requestAnimationFrame = realRaf; });

  // PC1 is a supplicant on an `auto` port of SW; RAD is the RADIUS server; R1 is
  // the target to reach. Both ends of PC1↔SW key MACsec from 802.1X (must-secure).
  function dot1xTopology() {
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
      supplicant PC1 alice secret123
      portauth SW Ethernet1 auto
      macsec PC1 SW dot1x must
      macsec SW PC1 dot1x must
    `);
    return { pc1: byName("PC1"), sw: byName("SW") };
  }

  it("a derived (802.1X-keyed) link can't secure until the port authenticates, then it does", () => {
    const { pc1, sw } = dot1xTopology();
    const link = linkOf(pc1, sw);
    // Before 802.1X there is no derived key — must-secure can't secure → data blocked.
    expect(macsecState(link)).toBe("failed");
    expect(exec("run ping PC1 10.0.0.1").ok).toBe(false);
    // Authenticate the port (headless) — sets link.dot1xAuthorized.
    expect(exec("run dot1x PC1").ok).toBe(true);
    // The link is now keyed from the EAP exchange → secured → data flows.
    expect(macsecState(link)).toBe("secured");
    expect(exec("run ping PC1 10.0.0.1").ok).toBe(true);
  });

  it("once authenticated, frames on the derived link render encrypted", () => {
    const { pc1, sw } = dot1xTopology();
    exec("run dot1x PC1"); // authenticate first (headless)
    (globalThis as any).requestAnimationFrame = () => 0;
    const setup = buildPingEvents(pc1, "10.0.0.1");
    state.simulation.autoPlay = true;
    startSimulation(setup as any, pc1.id, "10.0.0.1", "ping");
    let g = 0; while (state.simulation.status !== "done" && g++ < 200) stepOnce();
    const onWire = state.simulation.capture.filter(c => c.linkId === linkOf(pc1, sw).id);
    expect(onWire.length).toBeGreaterThan(0);
    expect(onWire.every(c => c.macsec)).toBe(true);
  });

  it("a derive end facing a static-PSK end is an incompatible method (must-secure fails)", () => {
    const { pc1, sw } = dot1xTopology();
    exec("run dot1x PC1");
    expect(macsecState(linkOf(pc1, sw))).toBe("secured");
    runConsoleScript("macsec SW PC1 staticKey must"); // SW switches to a static PSK
    expect(macsecState(linkOf(pc1, sw))).toBe("failed");
  });

  it("the derive config round-trips through JSON and the command script", () => {
    dot1xTopology();
    // JSON
    const json = JSON.stringify(buildConfigPayload());
    resetState();
    applyConfig(parseConfig(json));
    expect(byName("PC1").config.macsec![byName("SW").id]).toEqual({ derive: true, mode: "must" });
    // Script
    const script = exec("export").output.join("\n");
    expect(script).toContain("macsec PC1 SW dot1x must");
    expect(script).toContain("macsec SW PC1 dot1x must");
    resetState();
    runConsoleScript(script);
    // Fresh load: before re-auth the must-secure derive link is unsecured.
    expect(macsecState(linkOf(byName("PC1"), byName("SW")))).toBe("failed");
    expect(exec("run dot1x PC1").ok).toBe(true);
    expect(macsecState(linkOf(byName("PC1"), byName("SW")))).toBe("secured");
  });
});
