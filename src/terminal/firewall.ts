/**
 * Firewall terminal — an iptables-style CLI for the transparent inline packet
 * filter (FORWARD chain): -L/-A/-I/-D/-P/-F with -s/-d/-p/--icmp-type matches.
 */
import type { Device, FirewallRule } from "../types";
import { state, sync, pushUndo } from "../state";
import { ensureConfig } from "../normalise";
import { terminalLine } from "./core";

// ─── Firewall — iptables-style packet filter (transparent inline) ─────────────

function fwChain(raw: string): string | null {
  return (raw || "").toLowerCase() === "forward" ? "forward" : null; // v1: only FORWARD
}

export function showFirewallRules(device: Device, lineNumbers: boolean): string {
  const policy = (device.config?.policy || {}).forward || "accept";
  const rules = (device.config?.rules || []).filter((r: FirewallRule) => (r.chain || "forward") === "forward");
  const lines = [
    `Chain FORWARD (policy ${policy.toUpperCase()})`,
    `${lineNumbers ? "num  " : ""}target     prot   source                destination`,
  ];
  rules.forEach((r: FirewallRule, i: number) => {
    const num = lineNumbers ? String(i + 1).padEnd(5) : "";
    const extra = [r.icmpType ? `icmp-type ${r.icmpType}` : "", r.dport ? `dpt:${r.dport}` : ""].filter(Boolean).join(" ");
    lines.push(
      num + r.target.toUpperCase().padEnd(11) + (r.protocol || "all").padEnd(7) +
      (r.src || "anywhere").padEnd(22) + (r.dst || "anywhere") + (extra ? "  " + extra : "")
    );
  });
  if (!rules.length) lines.push("(no rules)");
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
    else if (t === "--dport") { rule.dport = Number(val); i++; }
    else if (t === "-j" || t === "--jump") {
      const tgt = (val || "").toLowerCase();
      if (!["accept", "drop", "reject"].includes(tgt)) return `iptables: unknown target "${val}"`;
      rule.target = tgt as any; hasTarget = true; i++;
    }
    else return `iptables: unknown option "${t}"`;
  }
  if (!hasTarget) return "iptables: rule needs -j ACCEPT|DROP|REJECT";
  return rule;
}

export function runFirewallTerminalCommand(device: Device, command: string): void {
  const lower = command.toLowerCase().trim();
  if (lower === "clear") { state.terminal.lines = []; return; }
  if (lower === "help" || lower === "?" || lower === "iptables -h" || lower === "iptables --help") {
    terminalLine("muted", [
      "iptables -L [FORWARD] [--line-numbers]           list rules + policy",
      "iptables -A FORWARD [match...] -j TARGET         append a rule",
      "iptables -I FORWARD [pos] [match...] -j TARGET   insert a rule",
      "iptables -D FORWARD <rulenum>                    delete rule N",
      "iptables -P FORWARD ACCEPT|DROP                  set the default policy",
      "iptables -F [FORWARD]                            flush all rules",
      "  matches: -s <ip/cidr>  -d <ip/cidr>  -p icmp|udp|all  --icmp-type <t>",
      "  targets: ACCEPT  DROP  REJECT",
      "  Note: only FORWARD + L3 matches act today; -p tcp / --dport parse but never match (no L4 traffic yet).",
      "clear",
    ].join("\n"));
    return;
  }
  const tokens = command.trim().split(/\s+/);
  if (tokens[0].toLowerCase() !== "iptables") {
    terminalLine("error", `${command}: command not found (try "iptables ..." or "help")`);
    return;
  }
  const args = tokens.slice(1);
  const op = (args[0] || "").toLowerCase();
  ensureConfig(device);
  const cfg = device.config!;
  cfg.rules = cfg.rules || [];
  cfg.policy = cfg.policy || { forward: "accept" };
  const fwdRules = (): FirewallRule[] => cfg.rules!.filter(r => (r.chain || "forward") === "forward");
  const onlyForward = "iptables: only the FORWARD chain is supported in transparent mode.";

  if (op === "-l" || op === "--list") {
    if (args[1] && !args[1].startsWith("-") && fwChain(args[1]) === null) { terminalLine("error", onlyForward); return; }
    terminalLine("", showFirewallRules(device, args.includes("--line-numbers")));
    return;
  }
  if (op === "-f" || op === "--flush") {
    if (args[1] && !args[1].startsWith("-") && fwChain(args[1]) === null) { terminalLine("error", onlyForward); return; }
    pushUndo();
    cfg.rules = cfg.rules!.filter(r => (r.chain || "forward") !== "forward");
    sync().syncPanel();
    terminalLine("", "Flushed FORWARD rules.");
    return;
  }
  if (op === "-p" || op === "--policy") {
    if (fwChain(args[1]) === null) { terminalLine("error", onlyForward); return; }
    const pol = (args[2] || "").toLowerCase();
    if (pol !== "accept" && pol !== "drop") { terminalLine("error", "iptables: policy must be ACCEPT or DROP."); return; }
    pushUndo();
    cfg.policy!.forward = pol;
    sync().syncPanel();
    terminalLine("", `Set FORWARD policy to ${pol.toUpperCase()}.`);
    return;
  }
  if (op === "-d" || op === "--delete") {
    if (fwChain(args[1]) === null) { terminalLine("error", onlyForward); return; }
    const rules = fwdRules();
    const n = parseInt(args[2], 10);
    if (!Number.isInteger(n) || n < 1 || n > rules.length) { terminalLine("error", `iptables: no rule ${args[2]} in FORWARD.`); return; }
    pushUndo();
    const victim = rules[n - 1];
    cfg.rules = cfg.rules!.filter(r => r !== victim);
    sync().syncPanel();
    terminalLine("", `Deleted FORWARD rule ${n}.`);
    return;
  }
  if (op === "-a" || op === "--append" || op === "-i" || op === "--insert") {
    if (fwChain(args[1]) === null) { terminalLine("error", onlyForward); return; }
    const inserting = op === "-i" || op === "--insert";
    let rest = args.slice(2);
    let pos = -1;
    if (inserting && rest[0] && /^\d+$/.test(rest[0])) { pos = parseInt(rest[0], 10); rest = rest.slice(1); }
    const parsed = parseFirewallRule("forward", rest);
    if (typeof parsed === "string") { terminalLine("error", parsed); return; }
    pushUndo();
    if (inserting) {
      const fwd = fwdRules();
      const insertAt = pos >= 1 ? Math.min(pos - 1, fwd.length) : 0;
      const anchor = fwd[insertAt];
      const idx = anchor ? cfg.rules!.indexOf(anchor) : cfg.rules!.length;
      cfg.rules!.splice(idx, 0, parsed);
    } else {
      cfg.rules!.push(parsed);
    }
    sync().syncPanel();
    terminalLine("", `${inserting ? "Inserted" : "Appended"} FORWARD rule (${parsed.target.toUpperCase()}).`);
    return;
  }
  terminalLine("error", `iptables: unknown operation "${args[0] || ""}". Try "help".`);
}
