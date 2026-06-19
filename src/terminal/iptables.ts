/**
 * Shared iptables command engine — used by the transparent firewall device
 * (FORWARD chain only) and by routers (INPUT + FORWARD; netfilter is always
 * present on a Linux router, an empty ruleset is a pass-through).
 *
 * Operates on the device config's `rules` (FirewallRule[], tagged by chain)
 * and `policy` (chain → accept|drop). Evaluation lives in engine.ts
 * (`evaluateFirewall`).
 */
import type { Device, FirewallRule } from "../types";
import { state, sync, pushUndo } from "../state";
import { ensureConfig } from "../normalise";
import { terminalLine } from "./core";

function parseChain(raw: string | undefined, allowed: string[]): string | null {
  const chain = (raw || "").toLowerCase();
  return allowed.includes(chain) ? chain : null;
}

export function showFirewallRules(device: Device, lineNumbers: boolean, chains: string[] = ["forward"]): string {
  const lines: string[] = [];
  for (const chain of chains) {
    const policy = (device.config?.policy || {})[chain] || "accept";
    const rules = (device.config?.rules || []).filter((r: FirewallRule) => (r.chain || "forward") === chain);
    if (lines.length) lines.push("");
    lines.push(
      `Chain ${chain.toUpperCase()} (policy ${policy.toUpperCase()})`,
      `${lineNumbers ? "num  " : ""}target     prot   source                destination`,
    );
    rules.forEach((r: FirewallRule, i: number) => {
      const num = lineNumbers ? String(i + 1).padEnd(5) : "";
      const extra = [r.icmpType ? `icmp-type ${r.icmpType}` : "", r.dport ? `dpt:${r.dport}` : ""].filter(Boolean).join(" ");
      lines.push(
        num + r.target.toUpperCase().padEnd(11) + (r.protocol || "all").padEnd(7) +
        (r.src || "anywhere").padEnd(22) + (r.dst || "anywhere") + (extra ? "  " + extra : "")
      );
    });
    if (!rules.length) lines.push("(no rules)");
  }
  return lines.join("\n");
}

// Parse the match/target flags of an -A/-I rule into a FirewallRule (or an error).
function parseFirewallRule(chain: string, toks: string[]): FirewallRule | string {
  const rule: FirewallRule = { chain, target: "accept" };
  let hasTarget = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const val = toks[i + 1];
    if (t === "-s" || t === "--source") { if (!val) return "iptables: -s needs an address"; rule.src = val; i++; }
    else if (t === "-d" || t === "--destination") { if (!val) return "iptables: -d needs an address"; rule.dst = val; i++; }
    else if (t === "-p" || t === "--protocol") {
      const p = (val || "").toLowerCase();
      if (!["icmp", "udp", "tcp", "all"].includes(p)) return `iptables: unknown protocol "${val}"`;
      if (p !== "all") rule.protocol = p as any; i++;
    }
    else if (t === "--icmp-type") { if (!val) return "iptables: --icmp-type needs a value"; rule.icmpType = val.toLowerCase(); i++; }
    else if (t === "--dport") { if (!val || !/^\d+$/.test(val) || Number(val) > 65535) return "iptables: --dport needs a port number (1-65535)"; rule.dport = Number(val); i++; }
    else if (t === "-j" || t === "--jump") {
      const tgt = (val || "").toLowerCase();
      if (!["accept", "drop", "reject"].includes(tgt)) return `iptables: unknown target "${val}"`;
      rule.target = tgt as any; hasTarget = true; i++;
    }
    else return `iptables: unknown option "${t}"`;
  }
  // Only TCP carries a port in the model, so a --dport rule must be -p tcp —
  // otherwise it would be accepted and listed but never match (real iptables
  // likewise rejects --dport without a port-bearing protocol).
  if (rule.dport != null && rule.protocol !== "tcp") return "iptables: --dport requires -p tcp";
  if (!hasTarget) return "iptables: rule needs -j ACCEPT|DROP|REJECT";
  return rule;
}

export function iptablesHelpLines(allowed: string[]): string[] {
  const C = allowed.map(c => c.toUpperCase()).join("|");
  return [
    `iptables -L [${C}] [--line-numbers]       list rules + policy`,
    `iptables -A <chain> [match...] -j TARGET   append a rule`,
    `iptables -I <chain> [pos] [match...] -j TARGET   insert a rule`,
    `iptables -D <chain> <rulenum>              delete rule N`,
    `iptables -P <chain> ACCEPT|DROP            set the default policy`,
    `iptables -F [chain]                        flush a chain (or all)`,
    "  matches: -s <ip/cidr>  -d <ip/cidr>  -p icmp|tcp|udp|all  --icmp-type <t>  --dport <port>",
    "  targets: ACCEPT  DROP  REJECT",
    `  chains: ${C}`,
  ];
}

/**
 * Handle an `iptables ...` command line against `device`'s rules/policy.
 * Returns true when the line was an iptables command (handled, success or
 * error); false when it isn't iptables at all (caller may dispatch further).
 */
export function runIptablesCommand(device: Device, command: string, allowed: string[]): boolean {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0]?.toLowerCase() !== "iptables") return false;
  const lower = command.toLowerCase().trim();
  if (lower === "iptables -h" || lower === "iptables --help") {
    terminalLine("muted", iptablesHelpLines(allowed).join("\n"));
    return true;
  }

  const args = tokens.slice(1);
  const op = (args[0] || "").toLowerCase();
  ensureConfig(device);
  const cfg = device.config!;
  cfg.rules = cfg.rules || [];
  cfg.policy = cfg.policy || {};
  for (const c of allowed) if (!cfg.policy[c]) cfg.policy[c] = "accept";
  const chainRules = (chain: string): FirewallRule[] => cfg.rules!.filter(r => (r.chain || "forward") === chain);
  const badChain = `iptables: chain must be ${allowed.map(c => c.toUpperCase()).join("|")}.`;

  if (op === "-l" || op === "--list") {
    const named = args[1] && !args[1].startsWith("-") ? parseChain(args[1], allowed) : null;
    if (args[1] && !args[1].startsWith("-") && !named) { terminalLine("error", badChain); return true; }
    terminalLine("", showFirewallRules(device, args.includes("--line-numbers"), named ? [named] : allowed));
    return true;
  }
  if (op === "-f" || op === "--flush") {
    const named = args[1] && !args[1].startsWith("-") ? parseChain(args[1], allowed) : null;
    if (args[1] && !args[1].startsWith("-") && !named) { terminalLine("error", badChain); return true; }
    const victims = named ? [named] : allowed;
    pushUndo();
    cfg.rules = cfg.rules!.filter(r => !victims.includes(r.chain || "forward"));
    sync().syncPanel();
    terminalLine("", `Flushed ${victims.map(c => c.toUpperCase()).join(" + ")} rules.`);
    return true;
  }
  if (op === "-p" || op === "--policy") {
    const chain = parseChain(args[1], allowed);
    if (!chain) { terminalLine("error", badChain); return true; }
    const pol = (args[2] || "").toLowerCase();
    if (pol !== "accept" && pol !== "drop") { terminalLine("error", "iptables: policy must be ACCEPT or DROP."); return true; }
    pushUndo();
    cfg.policy![chain] = pol;
    sync().syncPanel();
    terminalLine("", `Set ${chain.toUpperCase()} policy to ${pol.toUpperCase()}.`);
    return true;
  }
  if (op === "-d" || op === "--delete") {
    const chain = parseChain(args[1], allowed);
    if (!chain) { terminalLine("error", badChain); return true; }
    const rules = chainRules(chain);
    const n = parseInt(args[2], 10);
    if (!Number.isInteger(n) || n < 1 || n > rules.length) { terminalLine("error", `iptables: no rule ${args[2]} in ${chain.toUpperCase()}.`); return true; }
    pushUndo();
    const victim = rules[n - 1];
    cfg.rules = cfg.rules!.filter(r => r !== victim);
    sync().syncPanel();
    terminalLine("", `Deleted ${chain.toUpperCase()} rule ${n}.`);
    return true;
  }
  if (op === "-a" || op === "--append" || op === "-i" || op === "--insert") {
    const chain = parseChain(args[1], allowed);
    if (!chain) { terminalLine("error", badChain); return true; }
    const inserting = op === "-i" || op === "--insert";
    let rest = args.slice(2);
    let pos = -1;
    if (inserting && rest[0] && /^\d+$/.test(rest[0])) { pos = parseInt(rest[0], 10); rest = rest.slice(1); }
    const parsed = parseFirewallRule(chain, rest);
    if (typeof parsed === "string") { terminalLine("error", parsed); return true; }
    pushUndo();
    if (inserting) {
      const existing = chainRules(chain);
      const insertAt = pos >= 1 ? Math.min(pos - 1, existing.length) : 0;
      const anchor = existing[insertAt];
      const idx = anchor ? cfg.rules!.indexOf(anchor) : cfg.rules!.length;
      cfg.rules!.splice(idx, 0, parsed);
    } else {
      cfg.rules!.push(parsed);
    }
    sync().syncPanel();
    terminalLine("", `${inserting ? "Inserted" : "Appended"} ${chain.toUpperCase()} rule (${parsed.target.toUpperCase()}).`);
    return true;
  }
  terminalLine("error", `iptables: unknown operation "${args[0] || ""}". Try "iptables -h".`);
  return true;
}
