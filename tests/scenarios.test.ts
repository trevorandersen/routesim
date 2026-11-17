/**
 * Scenario framework tests — loading, goal evaluation, and console parity.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { state, defaultConfig, vlanRoasConfig, routerMeshConfig, wifiVlanConfig, undo, redo, networkSnapshot, restoreSnapshot, registerCallbacks } from "../src/state";
import { SCENARIOS, getScenario, loadScenario, checkScenario, registerScenario, isValidScenarioCheck, unregisterScenario, scenarioIssue } from "../src/scenarios";
import { SCENARIO_GROUPS } from "../src/scenario-library";
import { addLink, clearNetwork } from "../src/devices";
import { runConsoleCommand as exec, runConsoleScript } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";
import type { SerialisedTopology } from "../src/types";

describe("built-in topologies & scenarios — positive coordinates", () => {
  const configs: [string, any][] = [
    ["default", defaultConfig], ["vlan-roas", vlanRoasConfig], ["router-mesh", routerMeshConfig],
    ["wifi-vlan", wifiVlanConfig],
    ...SCENARIOS.map(s => [`scenario:${s.id}`, s.topology] as [string, any]),
  ];
  for (const [name, cfg] of configs) {
    it(`${name} has all device coordinates >= 0`, () => {
      for (const d of cfg.devices) {
        expect(d.x, `${name} ${d.name || d.id} x`).toBeGreaterThanOrEqual(0);
        expect(d.y, `${name} ${d.name || d.id} y`).toBeGreaterThanOrEqual(0);
      }
    });
  }
});

beforeAll(() => registerNoopCallbacks());

describe("scenarios — chooser grouping", () => {
  const grouped = SCENARIO_GROUPS.flatMap(g => g.ids);

  it("every scenario id in a group exists", () => {
    const ids = new Set(SCENARIOS.map(s => s.id));
    for (const id of grouped) expect(ids.has(id)).toBe(true);
  });

  it("every scenario belongs to exactly one group (no orphans, no duplicates)", () => {
    const seen = new Set<string>();
    for (const id of grouped) {
      expect(seen.has(id)).toBe(false);   // no scenario listed in two groups
      seen.add(id);
    }
    const ungrouped = SCENARIOS.filter(s => !seen.has(s.id)).map(s => s.id);
    expect(ungrouped).toEqual([]);         // every built-in scenario is grouped
  });
});

describe("scenarios — Connect a LAN", () => {
  beforeEach(() => resetState());

  it("loads the initial topology (unlinked) and sets the active scenario", () => {
    expect(loadScenario("connect-lan")).toBe(true);
    expect(state.activeScenarioId).toBe("connect-lan");
    expect(state.devices.map(d => d.name).sort()).toEqual(["PC-A", "PC-B", "Switch-1"]);
    expect(state.links).toHaveLength(0);
  });

  it("rejects an unknown scenario id", () => {
    expect(loadScenario("nope")).toBe(false);
  });

  it("fails the goal before linking, passes after linking", () => {
    loadScenario("connect-lan");
    const scenario = getScenario("connect-lan")!;

    const before = checkScenario(scenario);
    expect(before.passed).toBe(false);
    expect(before.checks.every(c => !c.passed)).toBe(true);

    // Wire PC-A and PC-B to the switch.
    addLink("s1-pc-a", "s1-sw");
    addLink("s1-pc-b", "s1-sw");

    const after = checkScenario(scenario);
    expect(after.passed).toBe(true);
    expect(after.checks.find(c => c.label.includes("ping"))!.passed).toBe(true);
  });
});

describe("scenarios — console parity", () => {
  beforeEach(() => resetState());

  it("scenario list / load / check via the command engine", () => {
    expect(exec("scenario list").output.join("\n")).toContain("connect-lan");
    expect(exec("scenario load connect-lan").ok).toBe(true);

    const before = exec("scenario check");
    expect(before.ok).toBe(false);
    expect((before.data as any).passed).toBe(false);

    addLink("s1-pc-a", "s1-sw");
    addLink("s1-pc-b", "s1-sw");

    const after = exec("scenario check");
    expect(after.ok).toBe(true);
    expect((after.data as any).passed).toBe(true);
  });
});

// ─── Curriculum solvability ────────────────────────────────────────────────────
// The reference solutions live as runnable console scripts in scenario-solutions/
// — the single source of truth (a learner runs the very same files). Each script
// loads its scenario, applies the fix, and checks the goal (`#` comments and blank
// lines are ignored by the runner). This proves every entry starts unsolved and
// passes after its script, so the scripts can never drift from the curriculum.

const SOLUTION_DIR = join(import.meta.dir, "..", "scenario-solutions");
const readSolution = (id: string) => readFileSync(join(SOLUTION_DIR, `${id}.routesim.txt`), "utf8");

describe("scenarios — every curriculum entry is solvable", () => {
  beforeEach(() => resetState());

  for (const scenario of SCENARIOS) {
    it(`${scenario.id}: fails fresh, passes after its solution script`, () => {
      let script: string;
      try { script = readSolution(scenario.id); }
      catch { throw new Error(`missing solution script scenario-solutions/${scenario.id}.routesim.txt`); }
      expect(loadScenario(scenario.id)).toBe(true);

      const before = checkScenario(scenario);
      expect(before.passed, `${scenario.id} must not be pre-solved`).toBe(false);

      // The script re-loads the scenario, applies the solution, then runs `scenario
      // check` — every line must succeed (a failing command or unmet goal shows here).
      const results = runConsoleScript(script);
      const failed = results.filter(r => !r.ok);
      expect(failed.map(f => f.output.join(" ")), `${scenario.id} solution commands all succeed`).toEqual([]);

      const after = checkScenario(scenario);
      expect(after.checks.filter(c => !c.passed).map(c => c.label), `${scenario.id} checks after solving`).toEqual([]);
      expect(after.passed).toBe(true);
    });
  }
});

describe("scenario import validates every check before registering (F12)", () => {
  it("accepts every well-formed kind", () => {
    const ok = [
      { kind: "link", a: "A", b: "B", label: "l" },
      { kind: "config", device: "A", field: "ipv4Address", equals: "x", label: "l" },
      { kind: "ping", from: "A", to: "B", label: "l" },
      { kind: "ping-fail", from: "A", to: "B", label: "l" },
      { kind: "tcp", from: "A", to: "B", port: 80, label: "l" },
      { kind: "tcp-fail", from: "A", to: "B", port: 22, label: "l" },
      { kind: "ping-fail", from: "A", to: "B", blockedBy: "FW", label: "l" },
      { kind: "tcp-fail", from: "A", to: "B", port: 22, blockedBy: "FW", label: "l" },
      { kind: "http", from: "A", to: "B", label: "l" },
      { kind: "dns", from: "A", name: "web", label: "l" },
      { kind: "dhcp", host: "A", label: "l" },
      { kind: "alert", from: "A", to: "B", contains: "scan", label: "l" },
    ];
    for (const c of ok) expect(isValidScenarioCheck(c)).toBe(true);
  });

  it("rejects null, primitives, unknown kinds, missing fields, and bad ports", () => {
    // `checks: [null]` used to register, then throw `c.label` in the banner on
    // every re-select — a permanently broken dropdown entry.
    const bad = [null, 7, "ping", {}, { kind: "teleport", label: "l" },
      { kind: "ping", from: "A", label: "l" },               // missing `to`
      { kind: "ping", from: "A", to: "B" },                  // missing label
      { kind: "tcp", from: "A", to: "B", port: "80", label: "l" },
      { kind: "tcp", from: "A", to: "B", port: 70000, label: "l" },
      { kind: "alert", from: "A", to: "B", label: "l" }];    // missing `contains`
    for (const c of bad) expect(isValidScenarioCheck(c)).toBe(false);
  });

  // R83: `objective` and the optional check fields were not validated — a
  // scenario with no objective made `scenario goal` throw, and a string
  // `status: "200"` could never pass.
  it("types the optional fields of http, dns and alert checks", () => {
    const ok = [
      { kind: "http", from: "A", to: "B", path: "/index.html", status: 404, label: "l" },
      { kind: "dns", from: "A", name: "web", ip: "10.0.0.80", label: "l" },
      { kind: "alert", from: "A", to: "B", port: 22, contains: "scan", label: "l" },
    ];
    for (const c of ok) expect(isValidScenarioCheck(c)).toBe(true);
    const bad = [
      { kind: "http", from: "A", to: "B", status: "200", label: "l" },
      { kind: "http", from: "A", to: "B", status: 99, label: "l" },
      { kind: "http", from: "A", to: "B", path: 7, label: "l" },
      { kind: "dns", from: "A", name: "web", ip: 167772240, label: "l" },
      { kind: "alert", from: "A", to: "B", port: "22", contains: "scan", label: "l" },
      { kind: "alert", from: "A", to: "B", port: 0, contains: "scan", label: "l" },
    ];
    for (const c of bad) expect({ c, valid: isValidScenarioCheck(c) }).toEqual({ c, valid: false });
  });

  it("scenarioIssue names what is wrong with an imported scenario, and passes every built-in", () => {
    const good = { id: "x", name: "X", objective: "Do it.", topology: { version: 1, devices: [], links: [] }, checks: [{ kind: "ping", from: "A", to: "B", label: "l" }] };
    expect(scenarioIssue(good)).toBeNull();
    expect(scenarioIssue({ ...good, objective: "" })).toBeNull();          // empty text is still text
    expect(scenarioIssue({ ...good, group: "Mine" })).toBeNull();
    const { objective, ...noObjective } = good;
    expect(scenarioIssue(noObjective)).toBe('"x" needs an objective (text)');
    expect(scenarioIssue({ ...good, objective: 42 })).toBe('"x" needs an objective (text)');
    expect(scenarioIssue({ ...good, group: 3 })).toContain("group");
    expect(scenarioIssue({ ...good, name: "" })).toContain("no name");
    expect(scenarioIssue({ ...good, checks: [good.checks[0], { kind: "http", from: "A", to: "B", status: "200", label: "l" }] })).toBe('"x" check 2 is malformed (a missing or mistyped field)');
    expect(scenarioIssue(null)).toContain("not a scenario object");
    for (const s of SCENARIOS) expect({ id: s.id, issue: scenarioIssue(s) }).toEqual({ id: s.id, issue: null });
  });

  it("unregisterScenario removes an entry the import rolled back", () => {
    registerScenario({ id: "__tmp", name: "T", objective: "", topology: { devices: [], links: [] }, checks: [] } as any);
    expect(getScenario("__tmp")).toBeDefined();
    unregisterScenario("__tmp");
    expect(getScenario("__tmp")).toBeUndefined();
  });
});

// R34: grading runs real headless simulations against live state. A `dhcp`
// check used to leave the learner's host permanently re-addressed by the lease
// it obtained during the grade, with no undo; later checks silently depended on
// that side effect. Grading must now leave the network exactly as it found it.
describe("checkScenario leaves the graded network untouched (R34)", () => {
  beforeEach(() => resetState());

  const pcA = () => state.devices.find(d => d.name === "PC-A")!;

  it("a dhcp check does not re-address the host it grades", () => {
    loadScenario("dhcp-service");
    exec("link PC-A SW-1");
    exec("link SW-1 R1");
    const host = pcA();
    // The learner never statically addresses PC-A — it relies on DHCP.
    expect(host.config!.ipv4Address || "").toBe("");
    const before = JSON.stringify(host.config);

    const result = checkScenario(getScenario("dhcp-service")!);
    expect(result.passed).toBe(true);                  // the dependency still works mid-grade
    expect(host.config!.ipv4Address || "").toBe("");   // but the lease did not stick
    expect(JSON.stringify(host.config)).toBe(before);  // nothing else moved either
  });

  it("grading twice gives the same verdict and no accumulated state", () => {
    loadScenario("dhcp-service");
    exec("link PC-A SW-1");
    exec("link SW-1 R1");
    const snapshot = networkSnapshot();
    const first = checkScenario(getScenario("dhcp-service")!);
    const second = checkScenario(getScenario("dhcp-service")!);
    expect(first.passed).toBe(true);
    expect(second.passed).toBe(true);
    // The whole network — every device config and the cabling — is unchanged.
    expect(networkSnapshot()).toBe(snapshot);
  });
});

// R35: an isolation check used to pass on ANY failure, so three scenarios could
// be "solved" without the concept they teach. A fail-check can now name the
// device that must do the blocking (`blockedBy`), and passes only if the same
// flow would get through with that device's policy removed.
describe("isolation checks pass only for the taught reason (blockedBy)", () => {
  beforeEach(() => resetState());

  const run = (script: string) => runConsoleScript(script).filter(r => !r.ok).map(r => r.output.join(" "));
  const check = (id: string) => checkScenario(getScenario(id)!);
  const failed = (id: string) => check(id).checks.filter(c => !c.passed);

  it("firewall-guard: closing the server's Telnet port is not a firewall rule", () => {
    loadScenario("firewall-guard");
    expect(run("ports SRV-1 22")).toEqual([]);
    const r = check("firewall-guard");
    expect(r.passed).toBe(false);
    const telnet = r.checks.find(c => c.label.includes("Telnet"))!;
    expect(telnet.passed).toBe(false);
    expect(telnet.note).toContain("not by FW-1");
    expect(telnet.note).toContain("rules");
    // Everything else about that network is fine — only the cause is wrong.
    expect(r.checks.filter(c => !c.passed).length).toBe(1);
  });

  it("vlan-segmentation: re-subnetting the hosts is not VLAN isolation", () => {
    loadScenario("vlan-segmentation");
    expect(run("ip PC-E1 192.168.2.21/24\nip PC-E2 192.168.2.22/24")).toEqual([]);
    const r = check("vlan-segmentation");
    expect(r.passed).toBe(false);
    const notes = r.checks.filter(c => !c.passed).map(c => c.note);
    expect(notes.length).toBe(2);
    for (const note of notes) { expect(note).toContain("not by MSW-1"); expect(note).toContain("VLANs"); }
  });

  it("harden-gateway: renumbering the router is not an INPUT rule", () => {
    loadScenario("harden-gateway");
    expect(run(`
      cli R1 enable
      cli R1 configure terminal
      cli R1 interface Ethernet1
      cli R1 ip address 192.168.1.254/24
      cli R1 end
      gateway PC-A 192.168.1.254
    `)).toEqual([]);
    const r = check("harden-gateway");
    expect(r.checks.find(c => c.label.includes("still flows"))!.passed).toBe(true);   // the shortcut keeps traffic flowing
    const ping = r.checks.find(c => c.label.includes("no longer answers"))!;
    expect(ping.passed).toBe(false);
    expect(ping.note).toContain("not by R1");
  });

  it("the real solutions pass, and carry no note", () => {
    for (const [id, fix] of [
      ["firewall-guard", "cli FW-1 iptables -A FORWARD -p tcp --dport 23 -j DROP"],
      ["harden-gateway", "cli R1 enable\ncli R1 iptables -A INPUT -p icmp -j DROP"],
      ["vlan-segmentation", [10, 10, 20, 20].map((v, i) => `cli MSW-1 config vlan member add ${v} Ethernet${i + 1}`).join("\n")],
    ] as const) {
      loadScenario(id);
      if (id === "vlan-segmentation") run("cli MSW-1 config vlan add 10\ncli MSW-1 config vlan add 20");
      expect(run(fix)).toEqual([]);
      const r = check(id);
      expect(r.passed, id).toBe(true);
      expect(r.checks.every(c => c.note === undefined), id).toBe(true);
    }
  });

  it("an unsolved scenario fails without a note (the flow simply gets through)", () => {
    loadScenario("firewall-guard");
    const telnet = check("firewall-guard").checks.find(c => c.label.includes("Telnet"))!;
    expect(telnet.passed).toBe(false);
    expect(telnet.note).toBeUndefined();
  });

  it("the what-if run leaves no trace on the live network", () => {
    loadScenario("firewall-guard");
    run("cli FW-1 iptables -A FORWARD -p tcp --dport 23 -j DROP");
    check("firewall-guard");                                   // warm the ARP/MAC tables the real runs learn
    const fw = state.devices.find(d => d.name === "FW-1")!;
    const configObjects = state.devices.map(d => d.config);
    const before = JSON.stringify(state.devices) + JSON.stringify(state.links.map(l => ({ ...l, frameHistory: undefined })));
    expect(check("firewall-guard").passed).toBe(true);
    // The policy the what-if removed is still there, on the same config objects.
    expect(fw.config!.rules!.length).toBe(1);
    state.devices.forEach((d, i) => expect(d.config).toBe(configObjects[i]));
    expect(JSON.stringify(state.devices) + JSON.stringify(state.links.map(l => ({ ...l, frameHistory: undefined })))).toBe(before);

    loadScenario("vlan-segmentation");
    run("ip PC-E1 192.168.2.21/24");
    check("vlan-segmentation");
    expect(state.devices.find(d => d.name === "MSW-1")!.config!.managed).toBe(true);
  });

  it("a blockedBy naming a missing or policy-less device fails with a reason", () => {
    registerScenario({
      id: "t-blockedby", name: "t", objective: "o",
      topology: getScenario("firewall-guard")!.topology,
      checks: [
        { kind: "tcp-fail", from: "PC-A", to: "SRV-1", port: 9, blockedBy: "NOPE", label: "missing guard" },
        { kind: "tcp-fail", from: "PC-A", to: "SRV-1", port: 9, blockedBy: "SW-1", label: "unmanaged switch has no policy to remove... but is a switch" },
        { kind: "tcp-fail", from: "PC-A", to: "SRV-1", port: 9, blockedBy: "PC-A", label: "a host has no policy" },
        { kind: "tcp-fail", from: "PC-A", to: "SRV-1", port: 9, label: "no blockedBy: any failure passes" },
      ],
    });
    try {
      loadScenario("t-blockedby");
      const r = check("t-blockedby").checks;       // port 9 is closed on SRV-1 (it listens on 22 and 23)
      expect(r[0].passed).toBe(false);
      expect(r[0].note).toContain("NOPE is missing");
      expect(r[1].passed).toBe(false);
      expect(r[2].passed).toBe(false);
      expect(r[2].note).toContain("not by PC-A");
      expect(r[3].passed).toBe(true);
    } finally { unregisterScenario("t-blockedby"); }
  });

  it("the console's scenario check prints the note under the failed goal", () => {
    loadScenario("firewall-guard");
    run("ports SRV-1 22");
    const out = exec("scenario check").output;
    const i = out.findIndex(l => l.includes("Telnet"));
    expect(out[i].startsWith("✗")).toBe(true);
    expect(out[i + 1]).toContain("not by FW-1");
  });

  it("every built-in isolation check names a device that has a policy to remove", () => {
    const POLICY_TYPES = new Set(["firewall", "router", "switch"]);
    let seen = 0;
    for (const scenario of SCENARIOS) {
      for (const c of scenario.checks) {
        if (c.kind !== "ping-fail" && c.kind !== "tcp-fail") continue;
        seen++;
        expect(c.blockedBy, `${scenario.id}: "${c.label}" has no blockedBy`).toBeTruthy();
        // A built-in's topology is a serialised one (an imported one is raw until normalised).
        const guard = (scenario.topology as SerialisedTopology).devices.find(d => d.name === c.blockedBy || d.id === c.blockedBy);
        expect(guard, `${scenario.id}: blockedBy ${c.blockedBy} is not in the topology`).toBeTruthy();
        expect(POLICY_TYPES.has(guard!.type), `${scenario.id}: ${c.blockedBy} (${guard!.type}) has no policy`).toBe(true);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(6);   // vlan x2, firewall-guard, troubleshoot-firewall, harden-gateway, stateful-firewall
  });

  it("rejects a non-string blockedBy on import", () => {
    expect(isValidScenarioCheck({ kind: "ping-fail", from: "A", to: "B", blockedBy: 7, label: "l" })).toBe(false);
    expect(isValidScenarioCheck({ kind: "tcp-fail", from: "A", to: "B", port: 22, blockedBy: "", label: "l" })).toBe(false);
  });
});

// R78: the active scenario and the name-resolution mode a load forces were not
// part of the undo snapshot, so undoing a scenario load put the learner's own
// network back under the scenario's goal banner, with realistic DNS still on.
describe("undo across a load restores the scenario and name-resolution mode (R78)", () => {
  beforeEach(() => { resetState(); registerNoopCallbacks(); });

  const [first, second] = SCENARIOS;
  const own = () => runConsoleScript("add computer MINE at 100 100\nadd switch MY-SW at 300 100\nlink MINE MY-SW");
  const names = () => state.devices.map(d => d.name).sort().join(",");

  it("undoing a scenario load deactivates the scenario and brings Instant DNS back", () => {
    own();
    expect(state.options.instantDns).toBe(true);
    loadScenario(first.id);
    expect(state.activeScenarioId).toBe(first.id);
    expect(state.options.instantDns).toBe(false);
    undo();
    expect(names()).toBe("MINE,MY-SW");
    expect(state.activeScenarioId).toBeNull();
    expect(state.options.instantDns).toBe(true);
  });

  it("redo brings the scenario and its realistic DNS back with its network", () => {
    own();
    loadScenario(first.id);
    const scenarioNames = names();
    undo();
    redo();
    expect(names()).toBe(scenarioNames);
    expect(state.activeScenarioId).toBe(first.id);
    expect(state.options.instantDns).toBe(false);
  });

  it("undoing a switch from one scenario to another returns to the first", () => {
    loadScenario(first.id);
    loadScenario(second.id);
    expect(state.activeScenarioId).toBe(second.id);
    undo();
    expect(state.activeScenarioId).toBe(first.id);
    expect(checkScenario(getScenario(first.id)!).checks.length).toBe(first.checks.length);
  });

  it("undoing a topology load made inside a scenario returns to the scenario", () => {
    loadScenario(first.id);
    exec("topology basic");
    expect(state.activeScenarioId).toBeNull();
    expect(state.options.instantDns).toBe(true);
    undo();
    expect(state.activeScenarioId).toBe(first.id);
    expect(state.options.instantDns).toBe(false);
  });

  it("undoing a topology load brings back an Instant DNS the learner had turned off", () => {
    own();
    state.options.instantDns = false;          // the learner's own choice, on their own network
    exec("topology basic");
    expect(state.options.instantDns).toBe(true);
    undo();
    expect(names()).toBe("MINE,MY-SW");
    expect(state.options.instantDns).toBe(false);
  });

  it("an ordinary edit inside a scenario keeps the scenario through undo and redo", () => {
    loadScenario(first.id);
    exec("add computer EXTRA at 50 50");
    undo();
    expect(state.activeScenarioId).toBe(first.id);
    redo();
    expect(state.activeScenarioId).toBe(first.id);
    expect(state.options.instantDns).toBe(false);
  });

  it("the goal banner and the settings checkbox are refreshed by the restore", () => {
    const calls: string[] = [];
    own();
    loadScenario(first.id);
    registerCallbacks({
      render() {}, syncPanel() {}, syncTerminal() {}, resizeCanvas() {}, syncCoordReadout() {}, recomputeStp() {}, syncSimLog() {},
      syncScenarioPanel: () => { calls.push(`scenario:${state.activeScenarioId}`); },
      syncOptionControls: () => { calls.push(`dns:${state.options.instantDns}`); },
    });
    undo();
    expect(calls).toContain("scenario:null");
    expect(calls).toContain("dns:true");
  });

  it("a snapshot without the two fields leaves them alone", () => {
    loadScenario(first.id);
    const { activeScenarioId, instantDns, ...bare } = JSON.parse(networkSnapshot());
    restoreSnapshot(JSON.stringify(bare));
    expect(state.activeScenarioId).toBe(first.id);
    expect(state.options.instantDns).toBe(false);
  });
});

// A scenario is its network. Clear used to leave the goal banner standing over
// an empty canvas — a goal with nothing to check — and an autosave then
// restored that orphan. Every other replacement of the network (a topology
// load, an import) already ended the scenario; Clear now does too.
describe("Clear ends the scenario along with its network", () => {
  beforeEach(() => { resetState(); registerNoopCallbacks(); });
  const [first] = SCENARIOS;

  it("the scenario ends, the console says so, and one Undo brings back both", () => {
    loadScenario(first.id);
    const before = state.devices.map(d => d.name).sort().join(",");
    const result = exec("clear");
    expect(state.activeScenarioId).toBeNull();
    expect(state.devices.length).toBe(0);
    expect(result.output).toEqual([`Cleared network — the scenario "${first.name}" ended with it. Undo brings both back.`]);
    expect(exec("scenario check").ok).toBe(false);                 // nothing is active to check
    undo();
    expect(state.activeScenarioId).toBe(first.id);
    expect(state.devices.map(d => d.name).sort().join(",")).toBe(before);
    redo();
    expect(state.activeScenarioId).toBeNull();
    expect(state.devices.length).toBe(0);
  });

  it("the goal banner is redrawn, not left standing", () => {
    let banner = 0;
    registerNoopCallbacks({ syncScenarioPanel: () => { banner++; } });
    loadScenario(first.id);
    banner = 0;
    exec("clear");
    expect(banner).toBeGreaterThan(0);
    registerNoopCallbacks();
  });

  it("a scenario whose devices were all deleted by hand still ends — as an undo point", () => {
    loadScenario(first.id);
    state.devices = [];
    state.links = [];
    const depth = state.undoStack.length;
    expect(clearNetwork()).toBe(first.id);
    expect(state.activeScenarioId).toBeNull();
    expect(state.undoStack.length).toBe(depth + 1);
    undo();
    expect(state.activeScenarioId).toBe(first.id);
  });

  it("with no scenario active Clear is as it was: no mention of one, no undo point for an empty canvas", () => {
    expect(clearNetwork()).toBeNull();
    expect(state.undoStack.length).toBe(0);
    exec("add computer PC1 at 0 0");
    expect(exec("clear").output).toEqual(["Cleared network."]);
  });
});
