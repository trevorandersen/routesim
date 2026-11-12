/**
 * Shared iptables command engine — used by the transparent firewall device
 * (FORWARD chain only) and by routers (INPUT + FORWARD; netfilter is always
 * present on a Linux router, an empty ruleset is a pass-through).
 *
 * Operates on the device config's `rules` (FirewallRule[], tagged by chain)
 * and `policy` (chain → accept|drop). Evaluation lives in engine.ts
 * (`evaluateFirewall`).
 */
import type { Device, FirewallRule, MutationResult, RuleLang } from "../types";
import { state, sync, pushUndo } from "../state";
import { ensureConfig } from "../normalise";
import { isValidIpv4 } from "../utils";

// The rule language a device presents its one netfilter ruleset in (native
// view, add-rule form, script export). Both the `iptables` and `nft` shells
// always parse into the same model regardless; this only picks the dialect.
export function ruleLangOf(device: Device): RuleLang {
  return device.config?.ruleLang === "nftables" ? "nftables" : "iptables";
}

// An IPv4 address or CIDR, as iptables accepts for -s/-d. Anything else used to
// be stored verbatim — listed, persisted, and never matching any packet.
function isAddressOrCidr(v: string): boolean {
  const m = v.match(/^([^/]+)(?:\/(\d{1,2}))?$/);
  if (!m || !isValidIpv4(m[1])) return false;
  return m[2] == null || Number(m[2]) <= 32;
}
import { terminalLine } from "./core";

function parseChain(raw: string | undefined, allowed: string[]): string | null {
  const chain = (raw || "").toLowerCase();
  return allowed.includes(chain) ? chain : null;
}

/**
 * The inverse of the `-A` parser below: one FirewallRule as an `iptables -A …`
 * line that `runIptablesCommand` re-parses to the same rule. The script export
 * replays a device's netfilter state through this (like `iptables-save`), so
 * the formatter and the parser live together and stay in step.
 */
export function ruleToIptables(rule: FirewallRule): string {
  const a = [`-A ${String(rule.chain || "forward").toUpperCase()}`];
  if (rule.protocol && rule.protocol !== "all") a.push(`-p ${rule.protocol}`);
  if (rule.src) a.push(`-s ${rule.src}`);
  if (rule.dst) a.push(`-d ${rule.dst}`);
  if (rule.icmpType) a.push(`--icmp-type ${rule.icmpType}`);
  if (rule.dport != null) a.push(`--dport ${rule.dport}`);
  if (rule.states?.length) a.push(`-m state --state ${rule.states.map(s => String(s).toUpperCase()).join(",")}`);
  a.push(`-j ${String(rule.target).toUpperCase()}`);
  if (rule.rejectWith) a.push(`--reject-with ${rule.rejectWith}`);
  return `iptables ${a.join(" ")}`;
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
      const extra = [
        r.icmpType ? `icmp-type ${r.icmpType}` : "",
        r.dport ? `dpt:${r.dport}` : "",
        r.states?.length ? `state ${r.states.map(s => s.toUpperCase()).join(",")}` : "",
        r.rejectWith ? `reject-with ${r.rejectWith}` : "",
      ].filter(Boolean).join(" ");
      lines.push(
        num + r.target.toUpperCase().padEnd(11) + (r.protocol || "all").padEnd(7) +
        (r.src || "anywhere").padEnd(22) + (r.dst || "anywhere") + (extra ? "  " + extra : "")
      );
    });
    if (!rules.length) lines.push("(no rules)");
  }
  return lines.join("\n");
}

const CONN_STATES = ["new", "established", "related", "invalid"];
const REJECT_WITHS = ["tcp-reset", "icmp-port-unreachable", "icmp-host-unreachable", "icmp-net-unreachable", "icmp-proto-unreachable", "icmp-admin-prohibited"];

// Parse the match/target flags of an -A/-I rule into a FirewallRule (or an error).
function parseFirewallRule(chain: string, toks: string[]): FirewallRule | string {
  const rule: FirewallRule = { chain, target: "accept" };
  let hasTarget = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const val = toks[i + 1];
    if (t === "-s" || t === "--source") { if (!val) return "iptables: -s needs an address"; if (!isAddressOrCidr(val)) return `iptables: host/network "${val}" not found`; rule.src = val; i++; }
    else if (t === "-d" || t === "--destination") { if (!val) return "iptables: -d needs an address"; if (!isAddressOrCidr(val)) return `iptables: host/network "${val}" not found`; rule.dst = val; i++; }
    else if (t === "-p" || t === "--protocol") {
      const p = (val || "").toLowerCase();
      if (!["icmp", "udp", "tcp", "all"].includes(p)) return `iptables: unknown protocol "${val}"`;
      if (p !== "all") rule.protocol = p as any; i++;
    }
    else if (t === "--icmp-type") { if (!val) return "iptables: --icmp-type needs a value"; rule.icmpType = val.toLowerCase(); i++; }
    else if (t === "--dport") { if (!val || !/^\d+$/.test(val) || Number(val) < 1 || Number(val) > 65535) return "iptables: --dport needs a port number (1-65535)"; rule.dport = Number(val); i++; }
    // `-m <module>` loads a match extension; we infer behaviour from the flags,
    // so the module name (state / conntrack / tcp / udp) is accepted and skipped.
    else if (t === "-m") { if (!val) return "iptables: -m needs a module"; i++; }
    else if (t === "--state" || t === "--ctstate") {
      if (!val) return `iptables: ${t} needs a state list`;
      const states = val.toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
      for (const s of states) if (!CONN_STATES.includes(s)) return `iptables: unknown state "${s}" (NEW|ESTABLISHED|RELATED|INVALID)`;
      rule.states = states as any; i++;
    }
    else if (t === "--reject-with") {
      const rw = (val || "").toLowerCase();
      if (!REJECT_WITHS.includes(rw)) return `iptables: unknown --reject-with "${val}"`;
      rule.rejectWith = rw; i++;
    }
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
  if (rule.icmpType && rule.protocol !== "icmp") return "iptables: --icmp-type requires -p icmp";
  if (rule.rejectWith && rule.target !== "reject") return "iptables: --reject-with only applies to -j REJECT";
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
    "           -m state --state NEW,ESTABLISHED  (or -m conntrack --ctstate ...)",
    "  targets: ACCEPT  DROP  REJECT [--reject-with tcp-reset|icmp-port-unreachable]",
    `  chains: ${C}`,
  ];
}

/**
 * Handle an `iptables ...` command line against `device`'s rules/policy.
 * Returns true when the line was an iptables command (handled, success or
 * error); false when it isn't iptables at all (caller may dispatch further).
 */
// Append a rule given as iptables match/target flags (`-p tcp --dport 22 -j
// ACCEPT`) — the body of `iptables -A <chain> …`, shared with the inspector's
// Add rule form so the two front doors have ONE parser and ONE set of checks.
// The form used to validate for itself, and disagreed: it took `1e2` as a port
// and addresses the shell rejects. Returns the shell's own error on refusal.
export function appendFirewallRule(device: Device, chainName: string, flags: string[], allowed: string[]): MutationResult {
  const chain = parseChain(chainName, allowed);
  if (!chain) return { ok: false, error: `iptables: chain must be ${allowed.map(c => c.toUpperCase()).join("|")}.`, warnings: [] };
  const parsed = parseFirewallRule(chain, flags);
  if (typeof parsed === "string") return { ok: false, error: parsed, warnings: [] };
  pushUndo();
  ensureConfig(device);
  device.config!.rules = [...(device.config!.rules || []), parsed];
  sync().syncPanel();
  return { ok: true, message: `Appended ${chain.toUpperCase()} rule (${parsed.target.toUpperCase()}).`, warnings: [] };
}

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
  // Reads (-L) must not write: defaulting every chain's policy into config on
  // every command persisted `policy:{…:"accept"}` noise into the JSON payload.
  // Mutating operations materialise the fields they touch.
  const rulesOf = (): FirewallRule[] => (cfg.rules = cfg.rules || []);
  const policyOf = (): Record<string, any> => (cfg.policy = cfg.policy || {});
  const chainRules = (chain: string): FirewallRule[] => (cfg.rules || []).filter(r => (r.chain || "forward") === chain);
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
    cfg.rules = rulesOf().filter(r => !victims.includes(r.chain || "forward"));
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
    policyOf()[chain] = pol;
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
    cfg.rules = rulesOf().filter(r => r !== victim);
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
    if (!inserting) {
      const result = appendFirewallRule(device, chain, rest, allowed);
      terminalLine(result.ok ? "" : "error", result.ok ? result.message! : result.error!);
      return true;
    }
    const parsed = parseFirewallRule(chain, rest);
    if (typeof parsed === "string") { terminalLine("error", parsed); return true; }
    pushUndo();
    const all = rulesOf();
    if (inserting) {
      const existing = chainRules(chain);
      const insertAt = pos >= 1 ? Math.min(pos - 1, existing.length) : 0;
      const anchor = existing[insertAt];
      const idx = anchor ? all.indexOf(anchor) : all.length;
      all.splice(idx, 0, parsed);
    } else {
      all.push(parsed);
    }
    sync().syncPanel();
    terminalLine("", `${inserting ? "Inserted" : "Appended"} ${chain.toUpperCase()} rule (${parsed.target.toUpperCase()}).`);
    return true;
  }
  terminalLine("error", `iptables: unknown operation "${args[0] || ""}". Try "iptables -h".`);
  return true;
}
