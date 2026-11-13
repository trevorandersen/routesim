/**
 * Snort — a small, faithful subset of the Snort rule language for the passive
 * IDS sensor. Parses rule text (the `local.rules` file), matches a rule against
 * an EthernetFrame, and formats a Snort "fast" alert line on a hit.
 *
 * Supported header: `action proto src_ip src_port dir dst_ip dst_port`.
 *   action  — alert | log | pass | drop | reject (passive sensor treats any
 *             non-`pass` action as an alert; it can't drop, it's not inline)
 *   proto   — ip | icmp | tcp | udp
 *   ip      — any | A.B.C.D | A.B.C.D/len   (no variables/negation)
 *   port    — any | <number> | a range (80:443, :1024, 1024:) | a list
 *             ([80,443,8000:8080]) | any of those negated with a leading !
 *   dir     — -> | <>  (<> matches either orientation)
 * Supported options: msg, sid, rev, gid, priority, itype (ICMP type),
 *   flags (TCP flag letters S/A/F/R; exact by default,
 *   `+` = these plus any others, `*` = any of these), content (substring, matched
 *   against the frame's content buffer: a DNS query name, or an HTTP request line
 *   (method/path/Host) or response (status/title)).
 *
 * Out of scope (documented): pcre, byte_test, flow, thresholds, rule variables.
 */
import type { EthernetFrame, Ipv4Payload, HttpInfo } from "./types";
import { cidrContains, isValidIpv4 } from "./utils";

export interface SnortRule {
  raw: string;
  action: string;
  proto: string;           // ip | icmp | tcp | udp
  srcIp: string;
  srcPort: string;
  dir: string;             // -> | <>
  dstIp: string;
  dstPort: string;
  msg: string;
  gid: number;
  sid: number;
  rev: number;
  priority?: number;
  itype?: number;
  flags?: string;          // required TCP flag letters, e.g. "S" or "SA" ("" for flags:0 = no flags set)
  flagsSet?: boolean;      // the flags option was present at all (so flags:0 constrains, not matches-all)
  flagsMode?: "exact" | "+" | "*";   // Snort: `S` = exactly these bits, `S+` = these plus any, `S*` = any of these
  content?: string;        // substring to find in the content buffer (a DNS query name or HTTP request/response)
}

const HEADER_RE = /^\s*(\w+)\s+(\w+)\s+(\S+)\s+(\S+)\s+(->|<>)\s+(\S+)\s+(\S+)\s*(?:\((.*)\)\s*)?$/;

const SNORT_ACTIONS = ["alert", "log", "pass", "drop", "reject"];
const SNORT_PROTOS = ["ip", "icmp", "tcp", "udp"];
// The options this sensor evaluates. An unknown one (flow, pcre, byte_test,
// threshold, …) is rejected rather than silently dropped — dropping it would
// make the rule fire more widely than written.
const SNORT_OPTIONS = ["msg", "sid", "rev", "gid", "priority", "itype", "flags", "content"];

function unquote(s: string): string {
  const t = s.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

// An IP spec this sensor can match: `any`, an address, or an address/len CIDR.
// No rule variables ($HOME_NET), negation (!x) or lists ([a,b]) — matching the
// grammar `ipMatches` actually evaluates.
function isIpSpec(spec: string): boolean {
  if (spec === "any") return true;
  if (spec.includes("/")) {
    const [ip, len] = spec.split("/");
    return isValidIpv4(ip) && /^\d+$/.test(len) && Number(len) <= 32;
  }
  return isValidIpv4(spec);
}

// A port spec `portMatches` can evaluate: `any`, a port, a range (`80:443`,
// `:1024`, `1024:`), a list (`[80,443,8000:8080]`), or any of those negated with
// a leading `!`. Each port must be 0–65535 and a range must have a bound.
function isPortSpec(spec: string): boolean {
  const s = spec.trim();
  if (s === "any") return true;
  const body = s.startsWith("!") ? s.slice(1).trim() : s;
  const items = body.startsWith("[") && body.endsWith("]") ? body.slice(1, -1).split(",") : [body];
  if (!items.length || items.some(i => i.trim() === "")) return false;
  return items.every(item => {
    const t = item.trim();
    const range = t.match(/^(\d*):(\d*)$/);
    if (range) {
      if (range[1] === "" && range[2] === "") return false;   // ":" names no range
      const lo = range[1] === "" ? 0 : Number(range[1]);
      const hi = range[2] === "" ? 65535 : Number(range[2]);
      return lo <= 65535 && hi <= 65535 && lo <= hi;
    }
    return /^\d+$/.test(t) && Number(t) <= 65535;
  });
}

// Why a header-shaped rule can never match (or would match more widely than
// written), or null when it is a blank/comment line or a rule this sensor can
// faithfully evaluate. Surfaced by `addIdsRule`, `snort -T` and the inspector,
// and used by `parseSnortRule` to refuse loading a rule that can't work (R26).
export function snortRuleIssue(line: string): string | null {
  const text = (line || "").trim();
  if (!text || text.startsWith("#")) return null;
  const m = text.match(HEADER_RE);
  if (!m) return `not a valid Snort rule — expected "action proto src sport -> dst dport (options)"`;
  const [, action, proto, srcIp, srcPort, , dstIp, dstPort, optsRaw] = m;
  if (!SNORT_ACTIONS.includes(action.toLowerCase())) return `unknown action "${action}" (use alert, log, pass, drop or reject)`;
  if (!SNORT_PROTOS.includes(proto.toLowerCase())) return `unknown protocol "${proto}" (use ip, icmp, tcp or udp)`;
  if (!isIpSpec(srcIp)) return `invalid source IP "${srcIp}" — use any, an address or a CIDR (no variables, negation or lists)`;
  if (!isIpSpec(dstIp)) return `invalid destination IP "${dstIp}" — use any, an address or a CIDR (no variables, negation or lists)`;
  if (!isPortSpec(srcPort)) return `invalid source port "${srcPort}"`;
  if (!isPortSpec(dstPort)) return `invalid destination port "${dstPort}"`;
  for (const opt of (optsRaw || "").split(";")) {
    const o = opt.trim();
    if (!o) continue;
    const ci = o.indexOf(":");
    const key = (ci < 0 ? o : o.slice(0, ci)).trim().toLowerCase();
    if (!SNORT_OPTIONS.includes(key)) return `unsupported option "${key}" — this sensor supports ${SNORT_OPTIONS.join(", ")} (pcre, flow, byte_test, thresholds and rule variables are out of scope)`;
  }
  return null;
}

// Parse one Snort rule line. Returns null for blank/comment/malformed lines.
export function parseSnortRule(line: string): SnortRule | null {
  const text = (line || "").trim();
  if (!text || text.startsWith("#")) return null;
  if (snortRuleIssue(text)) return null;   // header-shaped but invalid — don't load a rule that can't work as written
  const m = text.match(HEADER_RE);
  if (!m) return null;
  const [, action, proto, srcIp, srcPort, dir, dstIp, dstPort, optsRaw] = m;

  const rule: SnortRule = {
    raw: text,
    action: action.toLowerCase(),
    proto: proto.toLowerCase(),
    srcIp, srcPort, dir,
    dstIp, dstPort,
    msg: "", gid: 1, sid: 0, rev: 0,
  };

  for (const opt of (optsRaw || "").split(";")) {
    const o = opt.trim();
    if (!o) continue;
    const ci = o.indexOf(":");
    const key = (ci < 0 ? o : o.slice(0, ci)).trim().toLowerCase();
    const val = ci < 0 ? "" : o.slice(ci + 1).trim();
    switch (key) {
      case "msg": rule.msg = unquote(val); break;
      case "sid": rule.sid = Number(val) || 0; break;
      case "rev": rule.rev = Number(val) || 0; break;
      case "gid": rule.gid = Number(val) || 1; break;
      case "priority": rule.priority = Number(val) || undefined; break;
      case "itype": { const n = Number(val); if (Number.isFinite(n)) rule.itype = n; break; }   // keep itype:0 (echo reply); ignore non-numeric
      case "flags": {
        const raw = unquote(val).trim();
        rule.flagsMode = raw.endsWith("+") ? "+" : raw.endsWith("*") ? "*" : "exact";
        rule.flags = raw.replace(/[^SAFRPU]/gi, "").toUpperCase();
        rule.flagsSet = true;   // mark presence: flags:0 strips to "" but must still constrain (match no flags), not match every TCP segment (R75)
        break;
      }
      case "content": rule.content = unquote(val); break;
    }
  }
  return rule;
}

// ── Frame → match context ────────────────────────────────────────────────────
interface FrameCtx {
  proto: "icmp" | "tcp" | "udp" | "ip" | "other";
  srcIp: string; dstIp: string;
  srcPort: number | null; dstPort: number | null;
  icmpType?: number;
  flags?: string;     // TCP flag letters present, e.g. "SA"
  content?: string;   // the buffer a `content:` option matches — a DNS query name or the HTTP request line / response
}

const TCP_FLAG_LETTERS: Record<string, string> = { "syn": "S", "syn-ack": "SA", "ack": "A", "rst": "R" };

// The text a `content:` rule matches against an HTTP segment: the request line
// plus Host for a GET, or the status and served title for a response. Optional
// fields fall back to "" so no literal "undefined" leaks into the buffer.
function httpContentBuffer(http: HttpInfo): string {
  return http.kind === "request"
    ? `${http.method ?? "GET"} ${http.path ?? ""} Host: ${http.host ?? ""}`
    : `${http.status ?? ""} ${http.statusText ?? ""} ${http.title ?? ""}`;
}

function frameCtx(frame: EthernetFrame): FrameCtx | null {
  const p = frame.payload;
  if (p.type !== "ipv4") return null;   // ARP / 802.11 / EAPOL / BPDU: no IP — IP/TCP/UDP/ICMP rules can't match
  const ipv4 = p as Ipv4Payload;
  const inner = ipv4.payload;
  const ctx: FrameCtx = {
    proto: ipv4.protocol === 1 ? "icmp" : ipv4.protocol === 6 ? "tcp" : ipv4.protocol === 17 ? "udp" : "ip",
    srcIp: ipv4.srcIp, dstIp: ipv4.dstIp, srcPort: null, dstPort: null,
  };
  if (inner.type === "tcp") { ctx.srcPort = inner.srcPort; ctx.dstPort = inner.dstPort; ctx.flags = TCP_FLAG_LETTERS[inner.flags] || ""; if (inner.http) ctx.content = httpContentBuffer(inner.http); }
  else if (inner.type === "icmp") { ctx.icmpType = inner.icmpType; }
  else if (inner.type === "dns") { ctx.srcPort = 53; ctx.dstPort = 53; ctx.content = inner.name; }   // DNS over UDP/53
  else if (inner.type === "dhcp") { ctx.srcPort = inner.messageType === "offer" || inner.messageType === "ack" ? 67 : 68; ctx.dstPort = inner.messageType === "offer" || inner.messageType === "ack" ? 68 : 67; }
  return ctx;
}

function ipMatches(spec: string, ip: string): boolean {
  if (spec === "any") return true;
  if (!ip) return false;
  if (spec.includes("/")) return cidrContains(spec, ip);
  return isValidIpv4(spec) ? spec === ip : false;
}

// A Snort port spec: `any`, a port, a range (`80:443`, `:1024`, `1024:`), a
// list (`[80,443,8000:8080]`), or any of those negated with a leading `!`.
function portMatches(spec: string, port: number | null): boolean {
  const s = spec.trim();
  if (s === "any") return true;
  if (s.startsWith("!")) return !portMatches(s.slice(1), port);
  if (port == null) return false;
  const items = s.startsWith("[") && s.endsWith("]") ? s.slice(1, -1).split(",") : [s];
  return items.some(item => {
    const t = item.trim();
    const range = t.match(/^(\d*):(\d*)$/);
    if (range) {
      const lo = range[1] ? Number(range[1]) : 0;
      const hi = range[2] ? Number(range[2]) : 65535;
      return port >= lo && port <= hi;
    }
    const n = Number(t);
    return Number.isFinite(n) && port === n;
  });
}

function protoMatches(rule: SnortRule, ctx: FrameCtx): boolean {
  if (rule.proto === "ip") return ctx.proto !== "other";
  return rule.proto === ctx.proto;
}

function optionsMatch(rule: SnortRule, ctx: FrameCtx): boolean {
  if (rule.itype != null && ctx.icmpType !== rule.itype) return false;
  if (rule.flagsSet) {
    // Snort's `flags:S` means EXACTLY S (a SYN-ACK does not match); `S+` is a
    // superset match, `S*` any-of. The old subset match fired `flags:S` on SYN-ACKs.
    const have = [...(ctx.flags || "")].sort().join("");
    const want = [...(rule.flags || "")].sort().join("");
    // flags:0 names no bits (want === "") — a NULL-scan rule that fires only on a
    // segment with no flags set, never on every TCP segment. The +/* modifiers are
    // meaningless with no bits, so an empty want always matches exactly (R75).
    const mode = want === "" ? "exact" : (rule.flagsMode || "exact");
    if (mode === "exact" && have !== want) return false;
    if (mode === "+" && ![...want].every(f => have.includes(f))) return false;
    if (mode === "*" && ![...want].some(f => have.includes(f))) return false;
  }
  if (rule.content && !(ctx.content || "").toLowerCase().includes(rule.content.toLowerCase())) return false;
  return true;
}

// Does this rule fire on this frame? (`<>` matches either orientation.)
export function matchSnortRule(rule: SnortRule, frame: EthernetFrame): boolean {
  if (rule.action === "pass") return false;
  const ctx = frameCtx(frame);
  if (!ctx) return false;
  if (!protoMatches(rule, ctx)) return false;
  if (!optionsMatch(rule, ctx)) return false;
  const forward = ipMatches(rule.srcIp, ctx.srcIp) && portMatches(rule.srcPort, ctx.srcPort)
    && ipMatches(rule.dstIp, ctx.dstIp) && portMatches(rule.dstPort, ctx.dstPort);
  if (forward) return true;
  if (rule.dir === "<>") {
    return ipMatches(rule.srcIp, ctx.dstIp) && portMatches(rule.srcPort, ctx.dstPort)
      && ipMatches(rule.dstIp, ctx.srcIp) && portMatches(rule.dstPort, ctx.srcPort);
  }
  return false;
}

// A Snort "fast" alert line (timestamp omitted so alerts stay deterministic for
// tests): [**] [gid:sid:rev] msg [**] [Priority: N] {PROTO} src(:port) -> dst(:port)
export function formatAlert(rule: SnortRule, frame: EthernetFrame): string {
  const ctx = frameCtx(frame);
  if (!ctx) return `[**] [${rule.gid}:${rule.sid}:${rule.rev}] ${rule.msg} [**] [Priority: ${rule.priority ?? 3}] {NON-IP}`;
  const proto = ctx.proto.toUpperCase();
  const src = ctx.srcPort != null ? `${ctx.srcIp}:${ctx.srcPort}` : ctx.srcIp;
  const dst = ctx.dstPort != null ? `${ctx.dstIp}:${ctx.dstPort}` : ctx.dstIp;
  return `[**] [${rule.gid}:${rule.sid}:${rule.rev}] ${rule.msg} [**] [Priority: ${rule.priority ?? 3}] {${proto}} ${src} -> ${dst}`;
}

// Parsed rules, memoised by the identity of the raw-lines array (recomputed when
// the user edits local.rules, which replaces the array).
const _parsed = new WeakMap<object, SnortRule[]>();
export function parseRules(lines: string[]): SnortRule[] {
  if (!Array.isArray(lines)) return [];
  let hit = _parsed.get(lines as object);
  if (!hit) {
    hit = lines.map(parseSnortRule).filter((r): r is SnortRule => r !== null);
    _parsed.set(lines as object, hit);
  }
  return hit;
}

// Evaluate a sensor's rules against one mirrored frame; returns a fast-alert
// line for every rule that fires (usually 0 or 1).
export function runIdsRules(idsRules: string[] | undefined, frame: EthernetFrame): { rule: SnortRule; alert: string }[] {
  const out: { rule: SnortRule; alert: string }[] = [];
  for (const rule of parseRules(idsRules || [])) {
    if (matchSnortRule(rule, frame)) out.push({ rule, alert: formatAlert(rule, frame) });
  }
  return out;
}
