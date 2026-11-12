/**
 * Shared nftables command engine — the second front door onto the one netfilter
 * ruleset the firewall device and routers already keep (`config.rules` /
 * `config.policy`, evaluated in engine.ts). nftables has replaced iptables on
 * current Linux and is the cleaner syntax to learn first.
 *
 * There is exactly one rule model. An `nft` match clause is translated to the
 * equivalent iptables match flags and parsed by the SAME `parseFirewallRule`
 * the `iptables` shell uses, so a rule written in either language yields an
 * identical `FirewallRule` and the two native views can never disagree — a
 * ruleset written with `nft` reads back correctly under `iptables-save`, and
 * vice versa. The printer below is the inverse: one FirewallRule as the nft
 * statement that re-parses to it.
 *
 * First cut (matching the engine's reach): family `inet`, table `filter`, the
 * `forward`/`input` chains, matches on address (`ip saddr`/`ip daddr`),
 * protocol (`ip protocol`, `tcp dport`, `icmp type`), `ct state`, the
 * accept/drop/reject verdicts, and per-chain policy. Sets, maps, named tables,
 * and other families come later.
 */
import type { Device, FirewallRule, MutationResult } from "../types";
import { sync, pushUndo } from "../state";
import { ensureConfig } from "../normalise";
import { terminalLine } from "./core";
import { appendFirewallRule } from "./iptables";

const TABLE = "inet filter";                 // the one table this cut models
const CHAIN_HOOK: Record<string, string> = { forward: "forward", input: "input", output: "output" };

// nft reject spellings ⇄ the model's iptables `--reject-with` tokens.
const NFT_REJECT_TO_IPT: Record<string, string> = {
  "tcp reset": "tcp-reset",
  "icmp type port-unreachable": "icmp-port-unreachable",
  "icmp type host-unreachable": "icmp-host-unreachable",
  "icmp type net-unreachable": "icmp-net-unreachable",
  "icmp type prot-unreachable": "icmp-proto-unreachable",
  "icmp type admin-prohibited": "icmp-admin-prohibited",
};
const IPT_REJECT_TO_NFT: Record<string, string> = Object.fromEntries(
  Object.entries(NFT_REJECT_TO_IPT).map(([nft, ipt]) => [ipt, nft]),
);

/**
 * Translate an nft match/verdict clause (the tokens after `… <chain>`) into the
 * iptables flag tokens `parseFirewallRule` understands. Returns the flags, or an
 * `nft: …` error string. The caller feeds the flags to the shared parser, so
 * all field validation (dport needs tcp, icmp-type needs icmp, port range, …)
 * stays in one place.
 */
function nftClauseToFlags(toks: string[]): string[] | string {
  const flags: string[] = [];
  let verdict: string | null = null;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const next = toks[i + 1];
    if (t === "ip" && next === "saddr") { if (!toks[i + 2]) return "nft: ip saddr needs an address"; flags.push("-s", toks[i + 2]); i += 2; }
    else if (t === "ip" && next === "daddr") { if (!toks[i + 2]) return "nft: ip daddr needs an address"; flags.push("-d", toks[i + 2]); i += 2; }
    else if (t === "ip" && next === "protocol") { if (!toks[i + 2]) return "nft: ip protocol needs a value"; flags.push("-p", toks[i + 2]); i += 2; }
    else if (t === "tcp" && next === "dport") { if (!toks[i + 2]) return "nft: tcp dport needs a port"; flags.push("-p", "tcp", "--dport", toks[i + 2]); i += 2; }
    else if (t === "udp" && next === "dport") { if (!toks[i + 2]) return "nft: udp dport needs a port"; flags.push("-p", "udp", "--dport", toks[i + 2]); i += 2; }
    else if (t === "icmp" && next === "type") { if (!toks[i + 2]) return "nft: icmp type needs a value"; flags.push("-p", "icmp", "--icmp-type", toks[i + 2]); i += 2; }
    else if (t === "ct" && next === "state") { if (!toks[i + 2]) return "nft: ct state needs a state list"; flags.push("-m", "state", "--state", toks[i + 2]); i += 2; }
    else if (t === "accept" || t === "drop") { verdict = t; }
    else if (t === "reject") {
      verdict = "reject";
      // Optional `reject with <spelling>` — consume the whole spelling greedily.
      if (next === "with") {
        const spelling = toks.slice(i + 2).join(" ");
        const ipt = NFT_REJECT_TO_IPT[spelling];
        if (!ipt) return `nft: unknown reject spelling "${spelling}"`;
        flags.push("--reject-with", ipt);
        i = toks.length;   // the rest of the line was the spelling
      }
    }
    else return `nft: unexpected token "${t}"`;
  }
  if (!verdict) return "nft: rule needs a verdict (accept | drop | reject)";
  flags.push("-j", verdict.toUpperCase());
  // `--reject-with` must come after `-j` for the shared parser's ordering check
  // (it rejects a reject-with on a non-REJECT rule); move it to the end.
  const rwAt = flags.indexOf("--reject-with");
  if (rwAt !== -1 && rwAt < flags.indexOf("-j")) {
    const rw = flags.splice(rwAt, 2);
    flags.push(...rw);
  }
  return flags;
}

/**
 * One FirewallRule as the nft statement that re-parses to it — the inverse of
 * `nftClauseToFlags` ∘ `parseFirewallRule`. Used by the native ruleset view and
 * the script export, kept beside the parser so the two stay in step.
 */
export function ruleToNft(rule: FirewallRule): string {
  const parts: string[] = [];
  if (rule.src) parts.push(`ip saddr ${rule.src}`);
  if (rule.dst) parts.push(`ip daddr ${rule.dst}`);
  if (rule.protocol === "tcp" && rule.dport != null) parts.push(`tcp dport ${rule.dport}`);
  else if (rule.protocol === "icmp" && rule.icmpType) parts.push(`icmp type ${rule.icmpType}`);
  else if (rule.protocol && rule.protocol !== "all") parts.push(`ip protocol ${rule.protocol}`);
  if (rule.states?.length) parts.push(`ct state ${rule.states.join(",")}`);
  if (rule.target === "reject" && rule.rejectWith) {
    parts.push(`reject with ${IPT_REJECT_TO_NFT[rule.rejectWith] ?? "icmp type port-unreachable"}`);
  } else {
    parts.push(rule.target);
  }
  return parts.join(" ");
}

/**
 * The device's whole ruleset exactly as `nft list ruleset` prints it: one
 * `table inet filter { … }` with a chain block per allowed chain, each opening
 * with its `type filter hook <chain> priority 0; policy <p>;` line.
 */
export function showNftRuleset(device: Device, chains: string[] = ["forward"]): string {
  const lines = ["table inet filter {"];
  for (const chain of chains) {
    const policy = (device.config?.policy || {})[chain] || "accept";
    const rules = (device.config?.rules || []).filter((r: FirewallRule) => (r.chain || "forward") === chain);
    lines.push(`\tchain ${chain} {`);
    lines.push(`\t\ttype filter hook ${CHAIN_HOOK[chain] ?? chain} priority 0; policy ${policy};`);
    for (const r of rules) lines.push(`\t\t${ruleToNft(r)}`);
    lines.push("\t}");
  }
  lines.push("}");
  return lines.join("\n");
}

export function nftHelpLines(allowed: string[]): string[] {
  const C = allowed.join(" | ");
  return [
    `nft list ruleset                                  show the ${TABLE} table`,
    `nft add rule inet filter <chain> <match...> <verdict>     append a rule`,
    `nft insert rule inet filter <chain> [index N] <match...> <verdict>   insert`,
    `nft delete rule inet filter <chain> handle N      delete rule N (1-based)`,
    `nft add chain inet filter <chain> { policy accept | drop ; }   set the policy`,
    `nft flush chain inet filter <chain>               flush a chain`,
    `nft flush ruleset                                 flush everything`,
    "  matches: ip saddr <ip/cidr>  ip daddr <ip/cidr>  ip protocol icmp|tcp|udp",
    "           tcp dport <port>  icmp type <t>  ct state established,related",
    "  verdicts: accept  drop  reject [with tcp reset | icmp type port-unreachable]",
    `  chains: ${C}`,
  ];
}

// Parse `inet filter <chain>` after an add/insert/delete/list/flush verb, when
// present. Returns { chain, rest } or an error; chain is null for ruleset-wide.
function takeTableChain(args: string[], allowed: string[]): { chain: string | null; rest: string[] } | string {
  // Accept an explicit `inet filter` prefix (the only table this cut models).
  let a = args;
  if (a[0] === "inet" && a[1] === "filter") a = a.slice(2);
  else if (a[0] === "ip" && a[1] === "filter") a = a.slice(2);  // tolerate the ip family too
  const chainName = (a[0] || "").toLowerCase();
  if (!allowed.includes(chainName)) {
    return `nft: chain must be ${allowed.join(" | ")} (in table ${TABLE}).`;
  }
  return { chain: chainName, rest: a.slice(1) };
}

/**
 * Handle an `nft …` command against `device`'s rules/policy. Returns true when
 * the line was an nft command (handled, success or error); false when it is not
 * nft at all (the caller may dispatch further).
 */
export function runNftCommand(device: Device, command: string, allowed: string[]): boolean {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0]?.toLowerCase() !== "nft") return false;
  const lower = command.toLowerCase().trim();
  if (lower === "nft -h" || lower === "nft --help" || lower === "nft help") {
    terminalLine("muted", nftHelpLines(allowed).join("\n"));
    return true;
  }

  ensureConfig(device);
  const cfg = device.config!;
  const rulesOf = (): FirewallRule[] => (cfg.rules = cfg.rules || []);
  const policyOf = (): Record<string, any> => (cfg.policy = cfg.policy || {});
  const chainRules = (chain: string): FirewallRule[] => (cfg.rules || []).filter(r => (r.chain || "forward") === chain);

  const verb = (tokens[1] || "").toLowerCase();
  const object = (tokens[2] || "").toLowerCase();   // rule | chain | table | ruleset
  const rest = tokens.slice(3);

  // nft list ruleset | list table inet filter | list chain inet filter <chain>
  if (verb === "list") {
    if (object === "ruleset" || object === "table") { terminalLine("", showNftRuleset(device, allowed)); return true; }
    if (object === "chain") {
      const tc = takeTableChain(rest, allowed);
      if (typeof tc === "string") { terminalLine("error", tc); return true; }
      terminalLine("", showNftRuleset(device, [tc.chain!]));
      return true;
    }
    terminalLine("error", `nft: list what? Try "nft list ruleset".`);
    return true;
  }

  // nft flush ruleset | flush chain inet filter <chain> | flush table inet filter
  if (verb === "flush") {
    if (object === "ruleset" || object === "table") {
      pushUndo();
      cfg.rules = rulesOf().filter(r => !allowed.includes(r.chain || "forward"));
      sync().syncPanel();
      terminalLine("", object === "ruleset" ? "Flushed the ruleset." : `Flushed table ${TABLE}.`);
      return true;
    }
    if (object === "chain") {
      const tc = takeTableChain(rest, allowed);
      if (typeof tc === "string") { terminalLine("error", tc); return true; }
      pushUndo();
      cfg.rules = rulesOf().filter(r => (r.chain || "forward") !== tc.chain);
      sync().syncPanel();
      terminalLine("", `Flushed chain ${tc.chain}.`);
      return true;
    }
    terminalLine("error", `nft: flush what? Try "nft flush ruleset".`);
    return true;
  }

  // nft add chain inet filter <chain> { policy accept|drop ; }  — set the policy
  if ((verb === "add" || verb === "create") && object === "chain") {
    const tc = takeTableChain(rest, allowed);
    if (typeof tc === "string") { terminalLine("error", tc); return true; }
    const body = command.slice(command.indexOf("{") + 1, command.lastIndexOf("}"));
    const m = command.includes("{") ? body.match(/policy\s+(accept|drop)/i) : null;
    if (!m) { terminalLine("error", `nft: add chain needs a { policy accept|drop ; } body.`); return true; }
    pushUndo();
    policyOf()[tc.chain!] = m[1].toLowerCase();
    sync().syncPanel();
    terminalLine("", `Set chain ${tc.chain} policy to ${m[1].toLowerCase()}.`);
    return true;
  }

  // nft add rule inet filter <chain> <match...> <verdict>
  // nft insert rule inet filter <chain> [index N] <match...> <verdict>
  if ((verb === "add" || verb === "insert") && object === "rule") {
    const tc = takeTableChain(rest, allowed);
    if (typeof tc === "string") { terminalLine("error", tc); return true; }
    let clause = tc.rest;
    let pos = -1;
    const inserting = verb === "insert";
    if (inserting && (clause[0] === "index" || clause[0] === "position") && /^\d+$/.test(clause[1] || "")) {
      pos = parseInt(clause[1], 10); clause = clause.slice(2);
    }
    const flags = nftClauseToFlags(clause);
    if (typeof flags === "string") { terminalLine("error", flags); return true; }
    if (!inserting) {
      const result: MutationResult = appendFirewallRule(device, tc.chain!, flags, allowed);
      terminalLine(result.ok ? "" : "error", result.ok ? result.message! : result.error!);
      return true;
    }
    // Insert: parse via the same path as append, then splice at the position.
    const probe = appendFirewallRule(device, tc.chain!, flags, allowed);
    if (!probe.ok) { terminalLine("error", probe.error!); return true; }
    // appendFirewallRule already appended + pushed undo; move the new rule into
    // place so one code path validates and the position is honoured.
    const all = rulesOf();
    const parsed = all[all.length - 1];
    all.pop();
    const existing = chainRules(tc.chain!);
    const insertAt = pos >= 1 ? Math.min(pos - 1, existing.length) : 0;
    const anchor = existing[insertAt];
    const idx = anchor ? all.indexOf(anchor) : all.length;
    all.splice(idx, 0, parsed);
    sync().syncPanel();
    terminalLine("", `Inserted ${tc.chain} rule (${parsed.target}).`);
    return true;
  }

  // nft delete rule inet filter <chain> handle N  (handle = 1-based position here)
  if (verb === "delete" && object === "rule") {
    const tc = takeTableChain(rest, allowed);
    if (typeof tc === "string") { terminalLine("error", tc); return true; }
    let clause = tc.rest;
    if (clause[0] === "handle") clause = clause.slice(1);
    const n = parseInt(clause[0], 10);
    const rules = chainRules(tc.chain!);
    if (!Number.isInteger(n) || n < 1 || n > rules.length) { terminalLine("error", `nft: no rule with handle ${clause[0] ?? ""} in chain ${tc.chain}.`); return true; }
    pushUndo();
    const victim = rules[n - 1];
    cfg.rules = rulesOf().filter(r => r !== victim);
    sync().syncPanel();
    terminalLine("", `Deleted ${tc.chain} rule ${n}.`);
    return true;
  }

  terminalLine("error", `nft: unsupported command. Try "nft -h".`);
  return true;
}
