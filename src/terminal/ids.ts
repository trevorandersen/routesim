/**
 * IDS sensor terminal — modelled on Snort 3 on a Linux host. Snort isn't an
 * interactive CLI; you edit rule files and run the sensor. So this is a small
 * Linux-ish shell over the Snort files: view/append `local.rules`, read the
 * alert log, test the config, and `snort -V`. The same rules + alerts back the
 * inspector and the engine's detection.
 */
import type { Device } from "../types";
import { state, pushUndo } from "../state";
import { ensureConfig } from "../normalise";
import { applyHostname } from "../devices";
import { parseSnortRule } from "../snort";
import { terminalLine } from "./core";

const RULES_FILE = "/etc/snort/rules/local.rules";
const ALERT_FILE = "/var/log/snort/alert";

const SNORT_VERSION = [
  "   ,,_     -*> Snort++ <*-",
  '  o"  )~   Version 3.1.82.0',
  "   ''''    By Martin Roesch & The Snort Team",
  "           http://snort.org/contact#team",
  "           Copyright (C) 2014-2024 Cisco and/or its affiliates. All rights reserved.",
  "           Copyright (C) 1998-2013 Sourcefire, Inc., et al.",
].join("\n");

export function showIdsRules(device: Device): string {
  const rules = device.config?.idsRules || [];
  return rules.length ? rules.join("\n") : "# local.rules is empty — add a rule with: echo 'alert ...' >> " + RULES_FILE;
}

export function showIdsAlerts(device: Device): string {
  const alerts = device.config?.alerts || [];
  return alerts.length ? alerts.join("\n") : "(no alerts — run a simulation past the monitored switch)";
}

// Append a Snort rule to local.rules (validated). Shared with the console.
export function addIdsRule(device: Device, ruleText: string): string {
  const rule = parseSnortRule(ruleText);
  if (!rule) return `ERROR: bad rule (expected: alert proto src sport -> dst dport (msg:"..."; sid:N;))`;
  pushUndo();   // after validation, before the mutation — the undo contract every other shell keeps
  ensureConfig(device);
  const cfg: any = device.config;
  // Replace the array (don't push) so snort.ts's parse-by-array-identity memo
  // invalidates — a mutated-in-place array would return stale parsed rules.
  cfg.idsRules = [...(Array.isArray(cfg.idsRules) ? cfg.idsRules : []), rule.raw];
  return `Loaded rule sid:${rule.sid} (${cfg.idsRules.length} rule${cfg.idsRules.length === 1 ? "" : "s"} in ${RULES_FILE}).`;
}

export function runIdsTerminalCommand(device: Device, command: string): void {
  const lower = command.toLowerCase().trim();
  if (lower === "?" || lower === "help") {
    terminalLine("muted", [
      "snort -V                                    (version)",
      "snort -T                                    (test the configuration)",
      `cat ${RULES_FILE}                           (list rules)`,
      `echo 'alert ...' >> ${RULES_FILE}           (add a rule)`,
      `echo -n > ${RULES_FILE}                     (clear rules)`,
      `cat ${ALERT_FILE}                           (read the alert log)`,
      `echo -n > ${ALERT_FILE}                     (clear alerts)`,
      "hostname [<name>]",
      "clear",
    ].join("\n"));
    return;
  }
  if (lower === "clear") { state.terminal.lines = []; return; }
  if (lower === "snort -v" || lower === "snort --version") { terminalLine("", SNORT_VERSION); return; }
  if (lower === "snort -t" || lower === "snort -t -c /etc/snort/snort.lua") {
    const rules = device.config?.idsRules || [];
    const bad = rules.filter(r => !parseSnortRule(r)).length;
    terminalLine(bad ? "error" : "", `Loaded ${rules.length - bad} rules${bad ? `, ${bad} with errors` : ""}.\nSnort successfully validated the configuration${bad ? " (with errors)" : "."}`);
    return;
  }
  if (/^cat\s+\/etc\/snort\/rules\/local\.rules$/i.test(command)) { terminalLine("", showIdsRules(device)); return; }
  if (/^cat\s+\/var\/log\/snort\/alert(\.fast)?$/i.test(command)) { terminalLine("", showIdsAlerts(device)); return; }

  // echo 'rule' >> /etc/snort/rules/local.rules
  const appendMatch = command.match(/^echo\s+(?:-e\s+)?['"]?(.+?)['"]?\s*>>\s*\/etc\/snort\/rules\/local\.rules$/i);
  if (appendMatch) {
    const result = addIdsRule(device, appendMatch[1]);
    terminalLine(result.startsWith("ERROR") ? "error" : "", result);
    return;
  }
  // echo -n > <file>  (truncate rules or alerts)
  const clearMatch = command.match(/^echo\s+(?:-n\s+)?>\s*(\/etc\/snort\/rules\/local\.rules|\/var\/log\/snort\/alert)$/i);
  if (clearMatch) {
    ensureConfig(device);
    if (clearMatch[1].includes("local.rules")) { pushUndo(); (device.config as any).idsRules = []; terminalLine("", "Cleared local.rules."); }
    else { (device.config as any).alerts = []; terminalLine("", "Cleared the alert log."); }
    return;
  }

  if (lower === "hostname") { terminalLine("", device.name); return; }
  const hostnameMatch = command.match(/^(?:sudo\s+)?hostname\s+(\S+)$/i);
  if (hostnameMatch) {
    const error = applyHostname(device, hostnameMatch[1]);
    if (error) terminalLine("error", error);
    return;
  }
  terminalLine("error", `${command.split(/\s+/)[0]}: command not found`);
}
