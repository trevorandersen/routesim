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
import { buildPingEvents, buildDhcpEvents, buildConnectEvents, buildResolveEvents, buildHttpEvents, buildScanEvents } from "./simulation";
import { CURRICULUM } from "./scenario-library";
import { runSimulationHeadless } from "./engine";

export type ScenarioCheck =
  | { kind: "link"; a: string; b: string; label: string }
  | { kind: "config"; device: string; field: string; equals: unknown; label: string }
  | { kind: "ping"; from: string; to: string; label: string }
  | { kind: "ping-fail"; from: string; to: string; label: string }   // isolation: the ping must NOT succeed
  | { kind: "tcp"; from: string; to: string; port: number; label: string }
  | { kind: "tcp-fail"; from: string; to: string; port: number; label: string }
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

export interface CheckResult { label: string; passed: boolean }
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
    case "ping": case "ping-fail": case "http": return str(k.from) && str(k.to);
    case "tcp": case "tcp-fail":   return str(k.from) && str(k.to) && Number.isInteger(k.port) && k.port >= 1 && k.port <= 65535;
    case "dns":      return str(k.from) && str(k.name);
    case "dhcp":     return str(k.host);
    case "alert":    return str(k.from) && str(k.to) && str(k.contains);
  }
  return false;
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

function evaluate(check: ScenarioCheck): boolean {
  if (check.kind === "link") {
    const a = resolve(check.a); const b = resolve(check.b);
    return !!a && !!b && linkExists(a.id, b.id);
  }
  if (check.kind === "config") {
    const d = resolve(check.device);
    return !!d && (d.config as any)?.[check.field] === check.equals;
  }
  if (check.kind === "ping" || check.kind === "ping-fail") {
    const from = resolve(check.from);
    if (!from) return false;
    const to = resolve(check.to)?.config?.ipv4Address || check.to;
    const setup = buildPingEvents(from, to);
    const success = typeof setup === "string" ? false
      : runSimulationHeadless(setup, from.id, to, "ping", null, CHECK_PURPOSE).success;
    return check.kind === "ping" ? success : !success;
  }
  if (check.kind === "tcp" || check.kind === "tcp-fail") {
    const from = resolve(check.from);
    if (!from) return false;
    const to = resolve(check.to)?.config?.ipv4Address || check.to;
    const setup = buildConnectEvents(from, to, check.port);
    const success = typeof setup === "string" ? false
      : runSimulationHeadless(setup, from.id, to, "tcp", check.port, CHECK_PURPOSE).success;
    return check.kind === "tcp" ? success : !success;
  }
  if (check.kind === "http") {
    const from = resolve(check.from);
    if (!from) return false;
    const to = resolve(check.to)?.config?.ipv4Address || check.to;
    const setup = buildHttpEvents(from, to, 80, check.path || "/");
    if (typeof setup === "string") return false;
    const r = runSimulationHeadless(setup, from.id, to, "http", 80, CHECK_PURPOSE);
    return check.status != null ? r.httpStatus === check.status : (r.httpStatus != null && r.httpStatus >= 200 && r.httpStatus < 300);
  }
  if (check.kind === "dns") {
    const from = resolve(check.from);
    if (!from) return false;
    const setup = buildResolveEvents(from, check.name, null, null);
    if (typeof setup === "string") return false;
    const r = runSimulationHeadless(setup, from.id, check.name, "dns", null, CHECK_PURPOSE);
    if (!r.resolvedIp) return false;
    return !check.ip || r.resolvedIp === check.ip;
  }
  if (check.kind === "dhcp") {
    const host = resolve(check.host);
    if (!host) return false;
    const setup = buildDhcpEvents(host);
    if (typeof setup === "string") return false;
    return runSimulationHeadless(setup, host.id, "", "dhcp", null, CHECK_PURPOSE).success;
  }
  if (check.kind === "alert") {
    const from = resolve(check.from);
    if (!from) return false;
    const to = resolve(check.to)?.config?.ipv4Address || check.to;
    // Clear prior alerts so the check only sees this flow's detections.
    for (const d of state.devices) if (d.type === "ids") (d.config as any).alerts = [];
    // A Red Team source launches its port scan against the target — the burst of
    // SYN probes is what an IDS rule matches. Any other source uses a TCP connect
    // (when a port is given) or a ping.
    if (from.type === "attacker") {
      const setup = buildScanEvents(from, check.to);
      if (typeof setup === "string") return false;
      runSimulationHeadless(setup, from.id, "", "attack", null, CHECK_PURPOSE);
    } else {
      const setup = check.port != null ? buildConnectEvents(from, to, check.port) : buildPingEvents(from, to);
      if (typeof setup === "string") return false;
      runSimulationHeadless(setup, from.id, to, check.port != null ? "tcp" : "ping", check.port ?? null, CHECK_PURPOSE);
    }
    const needle = check.contains.toLowerCase();
    return state.devices.some(d => d.type === "ids" && (d.config?.alerts || []).some((a: string) => a.toLowerCase().includes(needle)));
  }
  return false;
}

export function checkScenario(scenario: Scenario): ScenarioResult {
  const checks = scenario.checks.map(c => ({ label: c.label, passed: evaluate(c) }));
  return { id: scenario.id, name: scenario.name, passed: checks.every(c => c.passed), checks };
}
