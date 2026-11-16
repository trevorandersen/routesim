/**
 * Scenarios — guided challenges. Each scenario provides an initial topology and
 * a goal (a set of checks). The learner edits the network to satisfy the goal,
 * then verifies it. Goal evaluation reuses the headless simulation runner and the
 * topology system. See docs/scenarios.md.
 */
import type { Device } from "./types";
import { state, sync } from "./state";
import { getDevice, isPhysicalLink } from "./devices";
import { applyConfig } from "./config";
import { normaliseConfig, shiftToPositive } from "./normalise";
import { buildPingEvents, buildDhcpEvents, buildConnectEvents, buildResolveEvents, buildHttpEvents } from "./simulation";
import { buildScanEvents } from "./security/offensive/attacks";
import { CURRICULUM } from "./scenario-library";
import { runSimulationHeadless } from "./engine";
import type { SimResult } from "./engine";
import { explainFailedRun } from "./explain";

export type ScenarioCheck =
  | { kind: "link"; a: string; b: string; label: string }
  | { kind: "config"; device: string; field: string; equals: unknown; label: string }
  | { kind: "ping"; from: string; to: string; label: string }
  // Isolation: the flow must NOT succeed. `blockedBy` names the device whose
  // policy must be the reason (a firewall's or router's netfilter rules, a
  // managed switch's VLANs): the check then also requires that the same flow
  // WOULD succeed with that policy removed. Without it any failure passes —
  // a closed port, a renumbered host — and the scenario can be "solved"
  // without the concept it teaches.
  | { kind: "ping-fail"; from: string; to: string; blockedBy?: string; label: string }
  | { kind: "tcp"; from: string; to: string; port: number; label: string }
  | { kind: "tcp-fail"; from: string; to: string; port: number; blockedBy?: string; label: string }
  | { kind: "http"; from: string; to: string; path?: string; status?: number; label: string }   // an HTTP GET returns 2xx (or the given status)
  | { kind: "dns"; from: string; name: string; ip?: string; label: string }   // name resolves (optionally to a given address)
  | { kind: "dhcp"; host: string; label: string }
  // An IDS sensor raises an alert containing `contains` for a flow from→to (TCP
  // when `port` is given, otherwise a ping). Used for the IDS/SPAN scenario.
  | { kind: "alert"; from: string; to: string; port?: number; contains: string; label: string };

export interface Scenario {
  id: string;
  name: string;
  objective: string;
  topology: any;            // { version, devices, links } — same shape as built-in topologies
  checks: ScenarioCheck[];
  group?: string;           // chooser category; built-ins are grouped via SCENARIO_GROUPS
}

// `note` explains a failed check whose label alone would mislead — an isolation
// goal that IS blocked, but not by the device the scenario asks for.
// `why` is the explanation of a failed check, composed from the failing run's
// own log (explain.ts) — the drops in order, then the post-mortem's diagnosis.
export interface CheckResult { label: string; passed: boolean; note?: string; why?: string[] }
export interface ScenarioResult { id: string; name: string; passed: boolean; checks: CheckResult[] }

// ── Registry ─────────────────────────────────────────────────────────────────

const connectLan: Scenario = {
  id: "connect-lan",
  name: "Connect a LAN",
  objective: "Link PC-A and PC-B to Switch-1, then ping PC-B from PC-A.",
  topology: {
    version: 1,
    devices: [
      { id: "s1-pc-a", type: "computer", name: "PC-A", x: -220, y: -110,
        config: { ipv4Address: "192.168.1.10", gatewayIpv4Address: "", macAddress: "02:00:00:00:00:0A", arpTable: [] } },
      { id: "s1-sw", type: "switch", name: "Switch-1", x: 0, y: 0,
        config: { managed: false, ethernetPorts: 8, macTable: [] } },
      { id: "s1-pc-b", type: "computer", name: "PC-B", x: -220, y: 110,
        config: { ipv4Address: "192.168.1.20", gatewayIpv4Address: "", macAddress: "02:00:00:00:00:0B", arpTable: [] } },
    ],
    links: [],
  },
  checks: [
    { kind: "link", a: "PC-A", b: "Switch-1", label: "PC-A linked to Switch-1" },
    { kind: "link", a: "PC-B", b: "Switch-1", label: "PC-B linked to Switch-1" },
    { kind: "ping", from: "PC-A", to: "PC-B", label: "PC-A can ping PC-B" },
  ],
};

export const SCENARIOS: Scenario[] = [connectLan, ...CURRICULUM];

// Keep built-in scenario topologies in positive coordinate space.
for (const scenario of SCENARIOS) shiftToPositive(scenario.topology);

export function getScenario(id: string | null): Scenario | undefined {
  return SCENARIOS.find(s => s.id === id);
}

const CHECK_KINDS = new Set(["link", "config", "ping", "ping-fail", "tcp", "tcp-fail", "http", "dns", "dhcp", "alert"]);
const str = (v: unknown) => typeof v === "string" && v.length > 0;
const optStr = (v: unknown) => v === undefined || str(v);
const optInt = (v: unknown, lo: number, hi: number) => v === undefined || (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi);

/**
 * Structural validity of one goal check — the discriminant is known and every
 * field that kind's evaluator and the banner renderer read is present and of
 * the right type. Import runs this over every check BEFORE registering, so a
 * malformed scenario never reaches the registry (where re-selecting it would
 * throw in the banner on every load).
 */
export function isValidScenarioCheck(c: unknown): c is ScenarioCheck {
  if (!c || typeof c !== "object") return false;
  const k = c as any;
  if (!CHECK_KINDS.has(k.kind) || !str(k.label)) return false;
  switch (k.kind) {
    case "link":     return str(k.a) && str(k.b);
    case "config":   return str(k.device) && str(k.field);
    case "ping":     return str(k.from) && str(k.to);
    // The optional fields are typed too: a string `status: "200"` could never
    // equal the numeric status the run returns, so the check could never pass.
    case "http":     return str(k.from) && str(k.to) && optStr(k.path) && optInt(k.status, 100, 599);
    case "ping-fail": return str(k.from) && str(k.to) && optStr(k.blockedBy);
    case "tcp": case "tcp-fail":
      return str(k.from) && str(k.to) && Number.isInteger(k.port) && k.port >= 1 && k.port <= 65535
        && (k.kind === "tcp" || optStr(k.blockedBy));
    case "dns":      return str(k.from) && str(k.name) && optStr(k.ip);
    case "dhcp":     return str(k.host);
    case "alert":    return str(k.from) && str(k.to) && str(k.contains) && optInt(k.port, 1, 65535);
  }
  return false;
}

/**
 * Why an imported value is not a usable scenario, or null when it is. Covers
 * everything the registry's readers touch: the chooser reads `id`/`name`/
 * `group`, the banner and `scenario goal` print `objective` (a missing or
 * non-string one threw there), and every check is read field by field.
 * (The topology is normalised separately — that is the throw-prone step.)
 */
export function scenarioIssue(s: unknown): string | null {
  if (!s || typeof s !== "object" || Array.isArray(s)) return "it is not a scenario object";
  const k = s as any;
  if (!str(k.id)) return "it has no id";
  if (!str(k.name)) return `"${k.id}" has no name`;
  if (typeof k.objective !== "string") return `"${k.id}" needs an objective (text)`;
  if (k.group !== undefined && typeof k.group !== "string") return `"${k.id}" has a group that is not text`;
  if (!k.topology || typeof k.topology !== "object") return `"${k.id}" has no topology`;
  if (!Array.isArray(k.checks)) return `"${k.id}" has no checks list`;
  const bad = k.checks.findIndex((c: unknown) => !isValidScenarioCheck(c));
  if (bad >= 0) return `"${k.id}" check ${bad + 1} is malformed (a missing or mistyped field)`;
  return null;
}

// Removes a scenario from the runtime registry — import rolls back with this
// when a validated scenario still fails to load.
export function unregisterScenario(id: string): void {
  const idx = SCENARIOS.findIndex(s => s.id === id);
  if (idx >= 0) SCENARIOS.splice(idx, 1);
}

// Adds (or replaces) a scenario in the runtime registry — used by JSON import.
export function registerScenario(scenario: Scenario): void {
  const idx = SCENARIOS.findIndex(s => s.id === scenario.id);
  if (idx >= 0) SCENARIOS[idx] = scenario;
  else SCENARIOS.push(scenario);
}

// ── Loading & evaluation ─────────────────────────────────────────────────────

export function loadScenario(id: string): boolean {
  const scenario = getScenario(id);
  if (!scenario) return false;
  applyConfig(normaliseConfig(scenario.topology));
  state.activeScenarioId = id;
  // Scenarios default to realistic resolution: a device name needs DNS (goal
  // checks resolve by IP themselves, so this only shapes the learner's terminal).
  state.options.instantDns = false;
  sync().syncOptionControls();
  sync().syncScenarioPanel();
  return true;
}

function resolve(ref: string): Device | undefined {
  const byId = getDevice(ref);
  if (byId) return byId;
  const lower = ref.toLowerCase();
  return state.devices.find(d => d.name.toLowerCase() === lower);
}

function linkExists(aId: string, bId: string): boolean {
  return state.links.some(l =>
    isPhysicalLink(l) && ((l.from === aId && l.to === bId) || (l.from === bId && l.to === aId)));
}

// Names a Check in the note left if it stops an animated run (engine beginRun).
const CHECK_PURPOSE = "the scenario Check";

// Why the check being evaluated came out the way it did — set by whichever
// step decided it (a builder's refusal, the headless run, a missing device or
// cable), read by evaluateCheck when the check fails. A grade that only says
// "✗" scores; one that says why teaches.
let checkWhy: string[] = [];
const because = (...reasons: string[]): false => { checkWhy = reasons; return false; };
// Run a flow headlessly, keeping the explanation of a failure.
function run(...args: Parameters<typeof runSimulationHeadless>): SimResult {
  const result = runSimulationHeadless(...args);
  checkWhy = explainFailedRun(result);
  return result;
}
const missing = (ref: string) => `There is no device called ${ref}.`;

function evaluate(check: ScenarioCheck): boolean {
  if (check.kind === "link") {
    const a = resolve(check.a); const b = resolve(check.b);
    if (!a) return because(missing(check.a));
    if (!b) return because(missing(check.b));
    return linkExists(a.id, b.id) || because(`No cable joins ${a.name} and ${b.name}.`);
  }
  if (check.kind === "config") {
    const d = resolve(check.device);
    if (!d) return because(missing(check.device));
    const actual = (d.config as any)?.[check.field];
    return actual === check.equals
      || because(`${d.name}'s ${check.field} is ${actual == null || actual === "" ? "not set" : JSON.stringify(actual)}; the goal needs ${JSON.stringify(check.equals)}.`);
  }
  if (check.kind === "ping") return pingSucceeds(check.from, check.to);
  if (check.kind === "tcp") return tcpSucceeds(check.from, check.to, check.port);
  if (check.kind === "http") {
    const from = resolve(check.from);
    if (!from) return because(missing(check.from));
    const to = resolve(check.to)?.config?.ipv4Address || check.to;
    const setup = buildHttpEvents(from, to, 80, check.path || "/");
    if (typeof setup === "string") return because(setup);
    const r = run(setup, from.id, to, "http", 80, CHECK_PURPOSE);
    const good = check.status != null ? r.httpStatus === check.status : (r.httpStatus != null && r.httpStatus >= 200 && r.httpStatus < 300);
    if (!good && !checkWhy.length) {
      checkWhy = [r.httpStatus != null ? `The server answered ${r.httpStatus}${check.status != null ? `; the goal needs ${check.status}` : ""}.`
        : `${from.name} reached port 80 but no web service answered the GET.`];
    }
    return good;
  }
  if (check.kind === "dns") {
    const from = resolve(check.from);
    if (!from) return because(missing(check.from));
    const setup = buildResolveEvents(from, check.name, null, null);
    if (typeof setup === "string") return because(setup);
    const r = run(setup, from.id, check.name, "dns", null, CHECK_PURPOSE);
    if (!r.resolvedIp) return false;
    return !check.ip || r.resolvedIp === check.ip || because(`${check.name} resolves to ${r.resolvedIp}; the goal needs ${check.ip}.`);
  }
  if (check.kind === "dhcp") {
    const host = resolve(check.host);
    if (!host) return because(missing(check.host));
    const setup = buildDhcpEvents(host);
    if (typeof setup === "string") return because(setup);
    const leased = run(setup, host.id, "", "dhcp", null, CHECK_PURPOSE).success;
    // A Discover nobody serves is ignored, not dropped — no device logs a
    // reason — so say what silence means here.
    if (!leased && !checkWhy.length) {
      checkWhy = [`No DHCP server answered ${host.name}'s Discover: nothing on its segment is handing out addresses (a server needs a dhcp-range in dnsmasq.conf and a running dnsmasq; a router needs an address on that interface).`];
    }
    return leased;
  }
  if (check.kind === "alert") {
    const from = resolve(check.from);
    if (!from) return false;
    const to = resolve(check.to)?.config?.ipv4Address || check.to;
    // Clear prior alerts so the check only sees this flow's detections.
    for (const d of state.devices) if (d.type === "ids") (d.config).alerts = [];
    // A Red Team source launches its port scan against the target — the burst of
    // SYN probes is what an IDS rule matches. Any other source uses a TCP connect
    // (when a port is given) or a ping.
    if (from.type === "attacker") {
      const setup = buildScanEvents(from, check.to);
      if (typeof setup === "string") return because(setup);
      runSimulationHeadless(setup, from.id, "", "attack", null, CHECK_PURPOSE);
    } else {
      const setup = check.port != null ? buildConnectEvents(from, to, check.port) : buildPingEvents(from, to);
      if (typeof setup === "string") return because(setup);
      runSimulationHeadless(setup, from.id, to, check.port != null ? "tcp" : "ping", check.port ?? null, CHECK_PURPOSE);
    }
    const needle = check.contains.toLowerCase();
    const sensors = state.devices.filter(d => d.type === "ids");
    if (sensors.some(d => (d.config?.alerts || []).some((a: string) => a.toLowerCase().includes(needle)))) return true;
    return because(sensors.length
      ? `No sensor raised an alert containing "${check.contains}" for this flow — check that a rule matches it and that the traffic reaches the sensor.`
      : "There is no IDS sensor in the network to raise the alert.");
  }
  return false;
}

// ── Isolation checks ─────────────────────────────────────────────────────────

function pingSucceeds(fromRef: string, toRef: string): boolean {
  const from = resolve(fromRef);
  if (!from) return because(missing(fromRef));
  const to = resolve(toRef)?.config?.ipv4Address || toRef;
  const setup = buildPingEvents(from, to);
  if (typeof setup === "string") return because(setup);
  return run(setup, from.id, to, "ping", null, CHECK_PURPOSE).success;
}

function tcpSucceeds(fromRef: string, toRef: string, port: number): boolean {
  const from = resolve(fromRef);
  if (!from) return because(missing(fromRef));
  const to = resolve(toRef)?.config?.ipv4Address || toRef;
  const setup = buildConnectEvents(from, to, port);
  if (typeof setup === "string") return because(setup);
  const r = run(setup, from.id, to, "tcp", port, CHECK_PURPOSE);
  if (!r.success && r.refused && !checkWhy.length) checkWhy = [`${to} refused the connection: nothing listens on port ${port} there (it answered RST).`];
  return r.success;
}

// Take a device's traffic policy out of the way, in place, and name what was
// removed (for the note). null = this device type has no policy to remove.
function removePolicy(guard: Device): string | null {
  const config = guard.config;
  if (!config) return null;
  if (guard.type === "firewall" || guard.type === "router") {
    config.rules = [];
    config.policy = {};          // every chain falls back to ACCEPT
    return "rules";
  }
  if (guard.type === "switch") {
    config.managed = false;      // an unmanaged switch is one flat broadcast domain
    return "VLANs";
  }
  return null;
}

// Run `flow` in a what-if copy of the network with `guard`'s policy removed.
// Every device's config is swapped for a deep copy first and the originals put
// back afterwards, so nothing the what-if run learns (ARP caches, MAC tables,
// conntrack-visible NAT entries, IDS alerts) or changes (the removed policy)
// survives it. The link flags a run can set are restored too.
function wouldSucceedWithout(guard: Device, flow: () => boolean): { succeeds: boolean; removed: string | null } {
  const savedConfigs = state.devices.map(d => d.config);
  const savedLinks = state.links.map(l => ({ stpBlocked: l.stpBlocked, dot1xAuthorized: l.dot1xAuthorized }));
  for (const d of state.devices) if (d.config) d.config = JSON.parse(JSON.stringify(d.config));
  try {
    const removed = removePolicy(guard);
    return { succeeds: removed !== null && flow(), removed };
  } finally {
    state.devices.forEach((d, i) => { d.config = savedConfigs[i]; });
    state.links.forEach((l, i) => { l.stpBlocked = savedLinks[i].stpBlocked; l.dot1xAuthorized = savedLinks[i].dot1xAuthorized; });
  }
}

// An isolation goal: the flow must fail — and, when the check names who must
// block it, fail BECAUSE of that device. The test for "because" is a what-if:
// the same flow, re-run with only that device's policy removed, must get
// through. A flow that is dead for some other reason (a closed port, a host
// moved to another subnet, an address that no longer exists) stays dead in the
// what-if, so it does not pass — and the note says so, since the label alone
// ("Telnet is blocked") would read as satisfied.
function evaluateIsolation(blockedBy: string | undefined, flow: () => boolean): { passed: boolean; note?: string; why?: string[] } {
  if (flow()) return { passed: false, why: ["The flow got through: nothing on its path drops it yet."] };
  if (!blockedBy) return { passed: true };
  const guard = resolve(blockedBy);
  if (!guard) return { passed: false, note: `${blockedBy} is missing — the goal is to block this at ${blockedBy}.` };
  const whatIf = wouldSucceedWithout(guard, flow);
  if (whatIf.succeeds) return { passed: true };
  const policy = whatIf.removed ?? "configuration";
  return {
    passed: false,
    note: `It is blocked, but not by ${guard.name}: with ${guard.name}'s ${policy} out of the way it still fails, so something else is stopping it. The goal is to block it at ${guard.name}.`,
  };
}

function evaluateCheck(check: ScenarioCheck): CheckResult {
  if (check.kind === "ping-fail") {
    return { label: check.label, ...evaluateIsolation(check.blockedBy, () => pingSucceeds(check.from, check.to)) };
  }
  if (check.kind === "tcp-fail") {
    return { label: check.label, ...evaluateIsolation(check.blockedBy, () => tcpSucceeds(check.from, check.to, check.port)) };
  }
  checkWhy = [];
  const passed = evaluate(check);
  return { label: check.label, passed, ...(!passed && checkWhy.length ? { why: checkWhy } : {}) };
}

// Grading runs real headless simulations against live state (DHCP, ping, TCP,
// DNS, HTTP, scans), so a check can mutate the very network it grades — most
// visibly a `dhcp` check re-addresses the learner's host through a real lease,
// and every check appends to the wires' frame history. None of that should
// outlive the grade (review R34). We clone the mutable state, run the whole
// check set against it — so one check still sees another's side effects, e.g. a
// `dns` check reading the address a `dhcp` check just assigned — then restore.
interface GradingState {
  configs: Array<{ device: Device; data: string }>;
  frameHistories: Array<{ link: any; copy: any[] | undefined }>;
}

function saveGradingState(): GradingState {
  return {
    // Serialise each config: a check mutates it in place (e.g. DHCP sets the
    // address), so a shallow copy of the object would still be the mutated one.
    configs: state.devices.map(d => ({ device: d, data: JSON.stringify(d.config ?? {}) })),
    // A headless run appends to link.frameHistory (pushes onto the same array),
    // so keep a copy of the array as it stood, not the live reference.
    frameHistories: state.links.map(l => ({ link: l, copy: l.frameHistory ? [...l.frameHistory] : undefined })),
  };
}

function restoreGradingState(saved: GradingState): void {
  for (const { device, data } of saved.configs) {
    const cfg = device.config as any;
    const restored = JSON.parse(data);
    if (!cfg) { device.config = restored; continue; }
    // Rewrite the existing config object in place so its identity survives — the
    // per-frame port-mode/VLAN memoisation keys on it (normalise.ts).
    for (const k of Object.keys(cfg)) delete cfg[k];
    Object.assign(cfg, restored);
  }
  for (const { link, copy } of saved.frameHistories) {
    if (copy === undefined) delete link.frameHistory;
    else link.frameHistory = copy;
  }
}

export function checkScenario(scenario: Scenario): ScenarioResult {
  const saved = saveGradingState();
  try {
    const checks = scenario.checks.map(evaluateCheck);
    return { id: scenario.id, name: scenario.name, passed: checks.every(c => c.passed), checks };
  } finally {
    restoreGradingState(saved);
  }
}
