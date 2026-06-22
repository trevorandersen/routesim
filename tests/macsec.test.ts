/**
 * MACsec (802.1AE) link encryption: the per-peer CAK config, the live
 * `macsecState` (secured / failed / open), the must-secure data gate, the
 * encrypted-frame rendering in the packet list, and config round-trip.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { startSimulation, stepOnce } from "../src/engine";
import { buildPingEvents } from "../src/simulation";
import { macsecState } from "../src/devices";
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
