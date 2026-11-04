import type { AppState, Device } from "./types";
import { mulberry32 } from "./prng";
import { isHost } from "./device-registry";

export const DEFAULT_STRESS_SEED = 20260706;
export const DEFAULT_STRESS_STEPS = 250;
export const MAX_STRESS_STEPS = 5000;

export interface StressCommandResult {
  ok: boolean;
  output: string[];
}

export interface StressAction {
  step: number;
  command: string;
  accepted: boolean;
  output: string[];
}

export interface StressReport {
  ok: boolean;
  seed: number;
  requestedSteps: number;
  completedSteps: number;
  rejectedCommands: number;
  actions: StressAction[];
  issues: string[];
}

type ExecuteCommand = (command: string) => StressCommandResult;

function pick<T>(values: readonly T[], random: () => number): T {
  return values[Math.floor(random() * values.length)];
}

function integer(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

function ref(device: Device): string {
  return /^\S+$/.test(device.name) ? device.name : device.id;
}

function differentPair(devices: Device[], random: () => number): [Device, Device] | null {
  if (devices.length < 2) return null;
  const firstIndex = integer(random, 0, devices.length - 1);
  const offset = integer(random, 1, devices.length - 1);
  return [devices[firstIndex], devices[(firstIndex + offset) % devices.length]];
}

function nextCommand(app: AppState, step: number, random: () => number): string {
  const devices = app.devices.filter(device => device.type !== "lan");
  const hosts = devices.filter(device => isHost(device.type));
  const switches = devices.filter(device => device.type === "switch");
  const visibleLinks = app.links.filter(link => !link.hidden);
  const roll = integer(random, 0, 13);

  if (roll === 0 && devices.length < 18) {
    const type = pick(["computer", "server", "switch", "router", "firewall", "hub"] as const, random);
    return `add ${type} Stress-${step} at ${integer(random, 20, 900)} ${integer(random, 20, 650)}`;
  }
  if (roll === 1 && devices.length) {
    return `move ${ref(pick(devices, random))} ${integer(random, -200, 1200)} ${integer(random, -200, 900)}`;
  }
  if (roll === 2) {
    const pair = differentPair(devices, random);
    if (pair) return `link ${ref(pair[0])} ${ref(pair[1])}`;
  }
  if (roll === 3 && visibleLinks.length) {
    const link = pick(visibleLinks, random);
    const from = app.devices.find(device => device.id === link.from);
    const to = app.devices.find(device => device.id === link.to);
    if (from && to) return `unlink ${ref(from)} ${ref(to)}`;
  }
  if (roll === 4 && devices.length > 4) return `remove ${ref(pick(devices, random))}`;
  if (roll === 5 && hosts.length) {
    const host = pick(hosts, random);
    return `ip ${ref(host)} 10.${integer(random, 1, 220)}.${integer(random, 0, 254)}.${integer(random, 1, 254)}/24`;
  }
  if (roll === 6 && switches.length) return `managed ${ref(pick(switches, random))} on`;
  if (roll === 7 && visibleLinks.length) {
    const link = pick(visibleLinks, random);
    const from = app.devices.find(device => device.id === link.from);
    const to = app.devices.find(device => device.id === link.to);
    if (from && to) return `linkset ${ref(from)} ${ref(to)} latency ${integer(random, 0, 250)}`;
  }
  if (roll === 8) return random() < 0.55 ? "undo" : "redo";
  if (roll === 9) return `theme ${pick(["warm-light", "dark", "blueprint"] as const, random)}`;
  if (roll === 10) return `zoom ${(integer(random, 25, 250) / 100).toFixed(2)}`;
  if (roll === 11) return `topology ${pick(["basic", "vlan-roas", "router-mesh", "wifi-vlan"] as const, random)}`;
  if (roll === 12 && devices.length) return `select ${ref(pick(devices, random))}`;
  if (hosts.length >= 2) {
    const pair = differentPair(hosts, random)!;
    return `run ping ${ref(pair[0])} ${ref(pair[1])}`;
  }
  return "topology basic";
}

/** Runs repeatable command mutations and checks state after every action. */
export function runStressTest(
  seed: number,
  steps: number,
  execute: ExecuteCommand,
  getState: () => AppState,
  diagnose: (app: AppState) => string[],
): StressReport {
  const random = mulberry32(seed);   // its own stream — the sim reseeds the shared one mid-run
  const actions: StressAction[] = [];
  const issues: string[] = [];
  let rejectedCommands = 0;

  for (let index = 0; index < steps; index++) {
    const command = index === 0 ? "topology basic" : nextCommand(getState(), index + 1, random);
    const result = execute(command);
    if (!result.ok) rejectedCommands++;
    actions.push({ step: index + 1, command, accepted: result.ok, output: [...result.output] });

    const thrown = result.output.find(line => line.startsWith("Error:"));
    if (thrown) issues.push(`Action ${index + 1} (${command}) threw: ${thrown.slice(6).trim()}`);
    for (const issue of diagnose(getState())) issues.push(`After action ${index + 1} (${command}): ${issue}`);
    if (issues.length) break;
  }

  return {
    ok: issues.length === 0,
    seed: seed >>> 0,
    requestedSteps: steps,
    completedSteps: actions.length,
    rejectedCommands,
    actions,
    issues: [...new Set(issues)],
  };
}
