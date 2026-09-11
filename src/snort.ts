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
 *   port    — any | <number>
 *   dir     — -> | <>  (<> matches either orientation)
 * Supported options: msg, sid, rev, gid, priority, itype (ICMP type),
 *   flags (TCP flag letters S/A/F/R), content (substring, matched against a DNS
 *   query name — the one payload "content" the frame model carries).
 *
 * Out of scope (documented): pcre, byte_test, flow, thresholds, rule variables.
 */
import type { EthernetFrame, Ipv4Payload } from "./types";
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
  flags?: string;          // required TCP flag letters, e.g. "S" or "SA"
  flagsMode?: "exact" | "+" | "*";   // Snort: `S` = exactly these bits, `S+` = these plus any, `S*` = any of these
  content?: string;        // substring to find in a DNS query name
}

const HEADER_RE = /^\s*(\w+)\s+(\w+)\s+(\S+)\s+(\S+)\s+(->|<>)\s+(\S+)\s+(\S+)\s*(?:\((.*)\)\s*)?$/;

function unquote(s: string): string {
  const t = s.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

// Parse one Snort rule line. Returns null for blank/comment/malformed lines.
export function parseSnortRule(line: string): SnortRule | null {
  const text = (line || "").trim();
  if (!text || text.startsWith("#")) return null;
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
  dnsName?: string;
}

const TCP_FLAG_LETTERS: Record<string, string> = { "syn": "S", "syn-ack": "SA", "ack": "A", "rst": "R" };

function frameCtx(frame: EthernetFrame): FrameCtx | null {
  const p = frame.payload;
  if (p.type !== "ipv4") return null;   // ARP / 802.11 / EAPOL / BPDU: no IP — IP/TCP/UDP/ICMP rules can't match
  const ipv4 = p as Ipv4Payload;
  const inner = ipv4.payload;
  const ctx: FrameCtx = {
    proto: ipv4.protocol === 1 ? "icmp" : ipv4.protocol === 6 ? "tcp" : ipv4.protocol === 17 ? "udp" : "ip",
    srcIp: ipv4.srcIp, dstIp: ipv4.dstIp, srcPort: null, dstPort: null,
  };
  if (inner.type === "tcp") { ctx.srcPort = inner.srcPort; ctx.dstPort = inner.dstPort; ctx.flags = TCP_FLAG_LETTERS[inner.flags] || ""; }
  else if (inner.type === "icmp") { ctx.icmpType = inner.icmpType; }
  else if (inner.type === "dns") { ctx.srcPort = 53; ctx.dstPort = 53; ctx.dnsName = inner.name; }   // DNS over UDP/53
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
  if (rule.flags) {
    // Snort's `flags:S` means EXACTLY S (a SYN-ACK does not match); `S+` is a
    // superset match, `S*` any-of. The old subset match fired `flags:S` on SYN-ACKs.
    const have = [...(ctx.flags || "")].sort().join("");
    const want = [...rule.flags].sort().join("");
    const mode = rule.flagsMode || "exact";
    if (mode === "exact" && have !== want) return false;
    if (mode === "+" && ![...want].every(f => have.includes(f))) return false;
    if (mode === "*" && ![...want].some(f => have.includes(f))) return false;
  }
  if (rule.content && !(ctx.dnsName || "").toLowerCase().includes(rule.content.toLowerCase())) return false;
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
