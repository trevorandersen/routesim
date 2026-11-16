/**
 * "Why?" — the causal chain behind a captured frame, and the explanation of a
 * failed scenario check (src/explain.ts). The engine tags each captured frame
 * with what its sender logged (`why`), what its receiver logged (`outcome`)
 * and the row that caused it (`cause`); explain.ts only composes those.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { state } from "../src/state";
import { dom } from "../src/dom";
import { startSimulation, animationTick, stepOnce } from "../src/engine";
import { buildPingEvents } from "../src/simulation";
import { explainCapture, explanationText, explainFailedRun, originReason, CHAIN_LIMIT } from "../src/explain";
import { createArpRequest, createIcmpEchoRequest, createDhcpDiscover } from "../src/frame";
import { renderWhy, renderFramePanel } from "../src/inspector";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { checkScenario, loadScenario, SCENARIOS } from "../src/scenarios";
import { syncScenarioPanel, runActiveScenarioCheck } from "../src/scenario-ui";
import type { CaptureEntry } from "../src/types";
import { registerNoopCallbacks, resetState } from "./helpers";

let raf: any;
beforeAll(() => {
  registerNoopCallbacks();
  raf = (globalThis as any).requestAnimationFrame;
  (globalThis as any).requestAnimationFrame = () => 0;
});
afterAll(() => { (globalThis as any).requestAnimationFrame = raf; });
beforeEach(() => resetState());

const A = "02:00:00:00:00:0a", B = "02:00:00:00:00:0b";
const name = (id: string) => ({ a: "PC-A", r: "R1", b: "PC-B" } as Record<string, string>)[id] ?? "a removed device";
const row = (no: number, from: string, to: string, extra: Partial<CaptureEntry> = {}): CaptureEntry =>
  ({ no, step: no, frame: createIcmpEchoRequest(A, B, "10.0.0.1", "10.0.0.2", 64), fromDeviceId: from, toDeviceId: to, linkId: "l", ...extra });

describe("explainCapture — composing the chain", () => {
  it("walks `cause` back to the frame the command sent, oldest first", () => {
    const entries = [
      row(1, "a", "r", { why: [{ device: "PC-A", kind: "sim-forward", text: "starts" }] }),
      row(2, "r", "b", { cause: 1, why: [{ device: "R1", kind: "sim-forward", text: "Route via Ethernet2" }], outcome: [{ device: "PC-B", kind: "sim-icmp", text: "sending Reply" }] }),
      row(3, "b", "r", { cause: 2 }),
    ];
    const explanation = explainCapture(entries[1], entries, name);
    expect(explanation.hops.map(h => `${h.no} ${h.from}→${h.to}`)).toEqual(["1 PC-A→R1", "2 R1→PC-B"]);
    expect(explanation.hops[1].why[0].text).toBe("Route via Ethernet2");
    expect(explanation.receiver).toBe("PC-B");
    expect(explanation.outcome.map(l => l.text)).toEqual(["sending Reply"]);
    expect(explanation.truncated).toBe(false);
  });

  it("leaves MAC-learning bookkeeping out of a reason unless it is all the device said", () => {
    const learn = { device: "SW", kind: "sim-learn", text: "MAC learn" }, flood = { device: "SW", kind: "sim-forward", text: "Flood" };
    expect(explainCapture(row(1, "a", "r", { why: [learn, flood] }), [], name).hops[0].why).toEqual([flood]);
    expect(explainCapture(row(1, "a", "r", { why: [learn] }), [], name).hops[0].why).toEqual([learn]);
  });

  it("stops at a cause that scrolled out of the capture, at a cycle, and at the length limit", () => {
    expect(explainCapture(row(5, "a", "r", { cause: 2 }), [row(5, "a", "r", { cause: 2 })], name).hops.length).toBe(1);
    const loop = [row(1, "a", "r", { cause: 2 }), row(2, "r", "a", { cause: 1 })];
    expect(explainCapture(loop[1], loop, name).hops.map(h => h.no)).toEqual([1, 2]);
    const long = Array.from({ length: 40 }, (_, i) => row(i + 1, "a", "r", i ? { cause: i } : {}));
    const explanation = explainCapture(long[39], long, name);
    expect(explanation.hops.length).toBe(CHAIN_LIMIT);
    expect(explanation.hops[explanation.hops.length - 1].no).toBe(40);
    expect(explanation.truncated).toBe(true);
    expect(explanationText(explanation)[0]).toContain("earlier steps omitted");
  });

  it("explains a frame still in flight (no row number yet)", () => {
    const transit = { frame: createArpRequest(A, "10.0.0.1", "10.0.0.2"), fromDeviceId: "a", toDeviceId: "r", cause: undefined, why: [{ device: "PC-A", kind: "sim-forward", text: "asks" }] };
    const explanation = explainCapture(transit, [], name);
    expect(explanation.hops[0].no).toBeNull();
    expect(explanationText(explanation)[0]).toBe("→ (in flight) PC-A → R1: ARP Who has 10.0.0.2? Tell 10.0.0.1");
  });
});

describe("originReason — the first frame of a run", () => {
  it("says what the origin was doing, and what it is holding back", () => {
    const arp = createArpRequest(A, "10.0.0.1", "10.0.0.254");
    expect(originReason(arp)).toBe("No ARP entry for 10.0.0.254, so it must learn that MAC address — broadcasting an ARP request");
    expect(originReason(arp, createIcmpEchoRequest(A, B, "10.0.0.1", "10.0.9.9", 64))).toContain("before it can send its ICMP Echo (ping)");
    expect(originReason(createIcmpEchoRequest(A, B, "10.0.0.1", "10.0.0.2", 64))).toContain("Already knows the next hop's MAC address");
    expect(originReason(createDhcpDiscover(A, "dhcp-1"))).toContain("No address yet");
  });
});

describe("explainFailedRun — a failed headless run in its own words", () => {
  const log = (deviceName: string, kind: string, action: string) => ({ step: 1, deviceId: deviceName, deviceName, kind, action, summary: "" });
  it("lists the drops in order, then the diagnosis, without repeating itself", () => {
    const why = explainFailedRun({ success: false, diagnosis: ["R1: No route to 10.9.9.9 — dropping", "PC-A never got an answer"], log: [
      log("PC-A", "sim-forward", "sent"), log("R1", "sim-drop", "No route to 10.9.9.9 — dropping"), log("R1", "sim-drop", "No route to 10.9.9.9 — dropping"),
    ] });
    expect(why).toEqual(["R1: No route to 10.9.9.9 — dropping", "PC-A never got an answer"]);
  });
  it("is empty for a success, and capped", () => {
    expect(explainFailedRun({ success: true, diagnosis: ["x"], log: [log("R1", "sim-drop", "y")] })).toEqual([]);
    const many = Array.from({ length: 9 }, (_, i) => log(`D${i}`, "sim-drop", `drop ${i}`));
    expect(explainFailedRun({ success: false, diagnosis: [], log: many }).length).toBe(4);
  });
});

// ── The engine fills the data in as an animated run goes ─────────────────────

function routed() {
  expect(runConsoleScript(`
    add computer PC-A at 0 0
    add router R1 at 200 0
    add computer PC-B at 400 0
    link PC-A R1
    link R1 PC-B
    ip PC-A 10.0.1.10/24
    gateway PC-A 10.0.1.1
    ip PC-B 10.0.2.10/24
    gateway PC-B 10.0.2.1
    interface R1 PC-A ip 10.0.1.1/24
    interface R1 PC-B ip 10.0.2.1/24
  `).filter(r => !r.ok)).toEqual([]);
  const pc = state.devices.find(d => d.name === "PC-A")!;
  startSimulation(buildPingEvents(pc, "10.0.2.10") as any, pc.id, "10.0.2.10");
  for (let i = 0; i < 60 && state.simulation.status === "running"; i++) animationTick(performance.now() + 1e9);
  expect(state.simulation.pingSuccess).toBe(true);
  return state.savedCaptures[state.savedCaptures.length - 1].entries;
}
const words = (entry: CaptureEntry) => `${name2(entry.fromDeviceId)}→${name2(entry.toDeviceId)}`;
const name2 = (id: string) => state.devices.find(d => d.id === id)?.name ?? "?";

describe("a routed ping with cold ARP caches explains itself (animated run)", () => {
  it("every frame but the first knows which frame caused it, and why it was sent", () => {
    const entries = routed();
    expect(entries.length).toBeGreaterThanOrEqual(8);          // ARP ×2 on each side, echo ×2, reply ×2
    expect(entries[0].cause).toBeUndefined();
    expect(entries[0].why![0]).toMatchObject({ device: "PC-A" });
    expect(entries[0].why![0].text).toContain("No ARP entry for 10.0.1.1");
    expect(entries[0].why![0].text).toContain("before it can send its ICMP Echo (ping)");
    for (const entry of entries.slice(1)) {
      expect({ no: entry.no, hasCause: entry.cause != null && entry.cause < entry.no }).toEqual({ no: entry.no, hasCause: true });
      expect(entry.why!.length).toBeGreaterThan(0);
    }
    // The receiver's handling is filed on the row it arrived on.
    const echoIntoRouter = entries.find(e => words(e) === "PC-A→R1" && e.frame.payload.type === "ipv4")!;
    expect(echoIntoRouter.outcome!.some(l => l.text.includes("ARP miss for 10.0.2.10"))).toBe(true);
  });

  it("the echo reply's chain reads back to the very first ARP request", () => {
    const entries = routed();
    const last = entries[entries.length - 1];
    expect(words(last)).toBe("R1→PC-A");
    const explanation = explainCapture(last, entries, name2);
    expect(explanation.hops[0].no).toBe(1);
    expect(explanation.hops.map(h => h.no)).toEqual([...explanation.hops.map(h => h.no)].sort((a, b) => a! - b!));
    const text = explanationText(explanation).join("\n");
    expect(text).toContain("PC-A: No ARP entry for 10.0.1.1");
    expect(text).toContain("ARP miss for 10.0.2.10");            // why R1 had to ask before forwarding
    expect(text).toContain("Forward deferred");                  // …and then did
    expect(text).toContain("Then, at PC-A:");
    expect(text).toContain("Echo Reply");
  });

  it("`why <no>` prints it; with no number it explains the inspected packet; errors say what to do", () => {
    expect(exec("why 3").output.join(" ")).toContain("no packets captured yet");
    const entries = routed();
    const out = exec(`why ${entries.length}`).output;
    expect(out[0]).toBe(`Why packet ${entries.length}?`);
    expect(out.some(l => l.startsWith(`→ #${entries.length} R1 → PC-A:`))).toBe(true);
    expect(exec("why").output.join(" ")).toContain("which packet?");
    expect(exec("why 999").ok).toBe(false);
    state.inspectedCapture = entries[1];
    expect(exec("why").output[0]).toBe("Why packet 2?");
  });

  it("the frame panel shows the chain, with a jump button for each earlier packet", () => {
    const entries = routed();
    const picked = entries[3];
    state.inspectedCapture = picked;
    state.inspectedFrame = picked.frame;
    renderFramePanel(picked.frame);
    const html = (dom.detailsPanel as any).innerHTML as string;
    expect(html).toContain(`<h4 class="why-title">Why?</h4>`);
    expect(html).toContain(`aria-current="true">#${picked.no}</span>`);
    const jumps = [...html.matchAll(/data-why-no="(\d+)" type="button" aria-label="Show packet \d+"/g)].map(m => Number(m[1]));
    expect(jumps.length).toBeGreaterThan(0);
    expect(jumps.every(n => n < picked.no)).toBe(true);
    expect(html).toContain("Then, at ");
    // A frame the panel has no capture for (hand-built) simply has no section.
    expect(renderWhy(createArpRequest(A, "1.1.1.1", "2.2.2.2"))).toBe("");
  });

  it("a dot still in flight explains itself too, and says it has not arrived", () => {
    expect(runConsoleScript("add computer PC1 at 0 0\nadd computer PC2 at 200 0\nlink PC1 PC2\nip PC1 10.0.0.1/24\nip PC2 10.0.0.2/24").filter(r => !r.ok)).toEqual([]);
    const pc = state.devices.find(d => d.name === "PC1")!;
    startSimulation(buildPingEvents(pc, "10.0.0.2") as any, pc.id, "10.0.0.2");
    const transit = state.simulation.transits[0];
    const html = renderWhy(transit.frame);
    expect(html).toContain("in flight");
    expect(html).toContain("No ARP entry for 10.0.0.2");
    expect(html).toContain("Still on its way to PC2.");
    stepOnce();                                                  // deliver it, PC2 handles it
    const arrived = renderWhy(state.simulation.capture[0].frame);
    expect(arrived).toContain("Then, at PC2:");
  });

  it("a drop on the way is the outcome of the frame that was dropped", () => {
    expect(runConsoleScript("add computer PC1 at 0 0\nadd router R1 at 200 0\nlink PC1 R1\nip PC1 10.0.0.2/24\ngateway PC1 10.0.0.1\ninterface R1 PC1 ip 10.0.0.1/24").filter(r => !r.ok)).toEqual([]);
    const pc = state.devices.find(d => d.name === "PC1")!;
    startSimulation(buildPingEvents(pc, "10.9.9.9") as any, pc.id, "10.9.9.9");
    for (let i = 0; i < 40 && state.simulation.status === "running"; i++) animationTick(performance.now() + 1e9);
    const entries = state.savedCaptures[state.savedCaptures.length - 1].entries;
    const echo = entries.find(e => e.frame.payload.type === "ipv4" && words(e) === "PC1→R1")!;
    expect(echo.outcome!.some(l => l.kind === "sim-drop" && l.text.includes("No route to 10.9.9.9"))).toBe(true);
    state.inspectedCapture = echo;
    expect(renderWhy(echo.frame)).toContain("✕ No route to 10.9.9.9");   // marked, not only coloured
  });
});

// ── A failed goal check says why ─────────────────────────────────────────────

describe("a failed scenario check carries the reason from its own run", () => {
  it("every built-in scenario: each check that fails at the start says why, and a passed one says nothing", () => {
    const unexplained: string[] = [];
    let failing = 0;
    for (const scenario of SCENARIOS) {
      loadScenario(scenario.id);
      for (const check of checkScenario(scenario).checks) {
        if (check.passed) { if (check.why) unexplained.push(`${scenario.id}: "${check.label}" passed but carries a why`); continue; }
        failing++;
        if (!check.why?.length) unexplained.push(`${scenario.id}: "${check.label}"`);
      }
    }
    expect(failing).toBeGreaterThan(20);
    expect(unexplained).toEqual([]);
  });

  it("names a missing cable, a wrong field, an unreachable network and a dropped packet", () => {
    runConsoleScript("add computer PC1 at 0 0\nadd router R1 at 200 0\nadd computer PC2 at 400 0\nip PC1 10.0.0.2/24");
    const grade = (check: any) => checkScenario({ id: "t", name: "t", objective: "", topology: {}, checks: [{ label: "l", ...check }] }).checks[0];
    expect(grade({ kind: "link", a: "PC1", b: "R1" }).why).toEqual(["No cable joins PC1 and R1."]);
    expect(grade({ kind: "link", a: "PC1", b: "NOPE" }).why).toEqual(["There is no device called NOPE."]);
    expect(grade({ kind: "config", device: "PC1", field: "gatewayIpv4Address", equals: "10.0.0.1" }).why![0]).toBe(`PC1's gatewayIpv4Address is not set; the goal needs "10.0.0.1".`);
    expect(grade({ kind: "ping", from: "PC1", to: "10.0.0.9" }).why![0]).toContain("Network is unreachable");
    runConsoleScript("link PC1 R1\ninterface R1 PC1 ip 10.0.0.1/24\ngateway PC1 10.0.0.1");
    expect(grade({ kind: "ping", from: "PC1", to: "10.9.9.9" }).why!.join(" ")).toContain("No route to 10.9.9.9");
    expect(grade({ kind: "ping", from: "PC1", to: "10.0.0.1" }).why).toBeUndefined();        // it passes
    expect(grade({ kind: "ping-fail", from: "PC1", to: "10.0.0.1" }).why).toEqual(["The flow got through: nothing on its path drops it yet."]);
    expect(grade({ kind: "tcp", from: "PC1", to: "10.0.0.1", port: 80 }).why!.join(" ")).toMatch(/RST|no service listens/);
  });

  it("the console's `scenario check` and the goal banner print the reasons under each failed check", () => {
    registerNoopCallbacks({ syncScenarioPanel });
    exec("scenario load static-routes");
    const out = exec("scenario check").output;
    expect(out.some(l => l.startsWith("✗ "))).toBe(true);
    expect(out.some(l => l.startsWith("    why: "))).toBe(true);
    runActiveScenarioCheck();
    const banner = dom.scenarioChecks.innerHTML;
    expect(banner).toContain(`<span class="scenario-why-title">Why:</span>`);
    expect(banner).toContain(`<span class="scenario-why-line">`);
    registerNoopCallbacks();
  });
});
