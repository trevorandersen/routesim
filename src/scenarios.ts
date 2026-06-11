/**
 * Scenarios — guided challenges. Each scenario provides an initial topology and
 * a goal (a set of checks). The learner edits the network to satisfy the goal,
 * then verifies it. Goal evaluation reuses the headless simulation runner and the
 * topology system. See docs/scenarios.md.
 */
import type { Device } from "./types";
import { state, sync } from "./state";
import { getDevice } from "./devices";
import { applyConfig } from "./config";
import { normaliseConfig, shiftToPositive } from "./normalise";
import { buildPingEvents, buildDhcpEvents, buildConnectEvents, buildResolveEvents } from "./simulation";
import { CURRICULUM } from "./scenario-library";
import { runSimulationHeadless } from "./engine";

export type ScenarioCheck =
  | { kind: "link"; a: string; b: string; label: string }
  | { kind: "config"; device: string; field: string; equals: unknown; label: string }
  | { kind: "ping"; from: string; to: string; label: string }
  | { kind: "ping-fail"; from: string; to: string; label: string }   // isolation: the ping must NOT succeed
  | { kind: "tcp"; from: string; to: string; port: number; label: string }
  | { kind: "tcp-fail"; from: string; to: string; port: number; label: string }
  | { kind: "dns"; from: string; name: string; ip?: string; label: string }   // name resolves (optionally to a given address)
  | { kind: "dhcp"; host: string; label: string };

export interface Scenario {
  id: string;
  name: string;
  objective: string;
  topology: any;            // { version, devices, links } — same shape as built-in topologies
  checks: ScenarioCheck[];
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
    !l.hidden && ((l.from === aId && l.to === bId) || (l.from === bId && l.to === aId)));
}

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
      : runSimulationHeadless(setup, from.id, to, "ping").success;
    return check.kind === "ping" ? success : !success;
  }
  if (check.kind === "tcp" || check.kind === "tcp-fail") {
    const from = resolve(check.from);
    if (!from) return false;
    const to = resolve(check.to)?.config?.ipv4Address || check.to;
    const setup = buildConnectEvents(from, to, check.port);
    const success = typeof setup === "string" ? false
      : runSimulationHeadless(setup, from.id, to, "tcp", check.port).success;
    return check.kind === "tcp" ? success : !success;
  }
  if (check.kind === "dns") {
    const from = resolve(check.from);
    if (!from) return false;
    const setup = buildResolveEvents(from, check.name, null, null);
    if (typeof setup === "string") return false;
    const r = runSimulationHeadless(setup, from.id, check.name, "dns");
    if (!r.resolvedIp) return false;
    return !check.ip || r.resolvedIp === check.ip;
  }
  if (check.kind === "dhcp") {
    const host = resolve(check.host);
    if (!host) return false;
    const setup = buildDhcpEvents(host);
    if (typeof setup === "string") return false;
    return runSimulationHeadless(setup, host.id, "", "dhcp").success;
  }
  return false;
}

export function checkScenario(scenario: Scenario): ScenarioResult {
  const checks = scenario.checks.map(c => ({ label: c.label, passed: evaluate(c) }));
  return { id: scenario.id, name: scenario.name, passed: checks.every(c => c.passed), checks };
}
