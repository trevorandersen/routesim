/**
 * Wireshark-style display filtering for the sim-log packet list. Pure and
 * self-contained: it operates on `FilterRow`s (a capture entry enriched with
 * its wire endpoints) and a `LogFilter` (the three orthogonal filter
 * dimensions the toolbar exposes). All matching logic lives here so it can be
 * unit-tested without the DOM or the engine.
 *
 * The three dimensions are ANDed together:
 *   - `protocols` — the active protocol chips (OR within the set; empty = all).
 *   - `device`    — a device id; a frame shows only if it crossed a wire that
 *                   touches that device (empty = any).
 *   - `expr`      — a free-text display-filter expression (empty = no
 *                   constraint), the "aspiring to Wireshark" power tool:
 *                   `dns || icmp && !arp`, `ip.addr == 10.0.0.0/24`,
 *                   `tcp.port == 22 && device contains PC`.
 */
import { EthernetFrame, LogFilter } from "./types";
import { cidrContains } from "./utils";

// A captured frame plus the wire it crossed — everything a filter predicate
// needs. Built by the renderer from a CaptureEntry + the link/device lookup.
export interface FilterRow {
  frame: EthernetFrame;
  macsec: boolean;
  no: number;
  step: number;
  fromId: string;
  toId: string;
  fromName: string;
  toName: string;
  linkId: string;   // the wire it crossed (for the packet list's Link column)
}

// The protocol atoms a bare keyword in an expression (or a chip) matches.
// Faithful to Wireshark's protocol filter names where they exist; `dot1x`
// covers the whole 802.1X family (EAPOL/EAP/RADIUS), `wlan`/`dot11` the 802.11
// management + WPA2 handshake frames.
export const PROTOCOL_TOKENS = [
  "arp", "ip", "ipv4", "icmp", "tcp", "udp", "dns", "dhcp",
  "stp", "bpdu", "wlan", "dot11", "dot1x", "eapol", "eap", "radius", "macsec",
] as const;

const PROTOCOL_SET = new Set<string>(PROTOCOL_TOKENS);

// The protocol chips shown in the toolbar, in display order — each a quick
// toggle for one token (a friendlier label than the raw expression keyword).
export const PROTOCOL_CHIPS: { label: string; token: string }[] = [
  { label: "ARP", token: "arp" },
  { label: "ICMP", token: "icmp" },
  { label: "TCP", token: "tcp" },
  { label: "DNS", token: "dns" },
  { label: "DHCP", token: "dhcp" },
  { label: "STP", token: "stp" },
  { label: "802.1X", token: "dot1x" },
  { label: "802.11", token: "wlan" },
  { label: "MACsec", token: "macsec" },
];

// Does a frame match a single protocol token? (The chip and bare-keyword path.)
export function frameMatchesToken(row: FilterRow, token: string): boolean {
  const p = row.frame.payload;
  switch (token) {
    case "arp": return p.type === "arp";
    case "ip":
    case "ipv4": return p.type === "ipv4";
    case "macsec": return row.macsec === true;
    case "stp":
    case "bpdu": return p.type === "bpdu";
    case "wlan":
    case "dot11": return p.type === "dot11";
    case "dot1x": return p.type === "dot1x";
    case "eapol":
      return (p.type === "dot1x" && p.subtype.startsWith("eapol"))
        || (p.type === "dot11" && p.subtype.startsWith("eapol"));
    case "eap": return p.type === "dot1x" && p.subtype.startsWith("eap-");
    case "radius": return p.type === "dot1x" && p.subtype.startsWith("radius");
    case "icmp": return p.type === "ipv4" && p.payload.type === "icmp";
    case "tcp": return p.type === "ipv4" && p.payload.type === "tcp";
    case "dns": return p.type === "ipv4" && p.payload.type === "dns";
    case "dhcp": return p.type === "ipv4" && p.payload.type === "dhcp";
    case "udp": return p.type === "ipv4" && (p.payload.type === "dns" || p.payload.type === "dhcp");
    default: return false;
  }
}

// Which protocol tokens actually occur in a set of rows — used to dim chips
// for protocols not present in the current capture.
export function presentTokens(rows: FilterRow[]): Set<string> {
  const present = new Set<string>();
  for (const row of rows) {
    for (const chip of PROTOCOL_CHIPS) {
      if (!present.has(chip.token) && frameMatchesToken(row, chip.token)) present.add(chip.token);
    }
  }
  return present;
}

// ─── Expression grammar ──────────────────────────────────────────────────────
// orExpr  := andExpr ( ("||"|"or") andExpr )*
// andExpr := notExpr ( ("&&"|"and") notExpr )*
// notExpr := ("!"|"not") notExpr | primary
// primary := "(" orExpr ")" | field comparator value | protocolToken

type Pred = (row: FilterRow) => boolean;
type Comparator = "==" | "!=" | "<" | ">" | "<=" | ">=" | "contains";

class FilterError extends Error {}
const fail = (message: string): never => { throw new FilterError(message); };

const NUMERIC_FIELDS = new Set(["tcp.port", "tcp.srcport", "tcp.dstport", "ip.ttl", "frame.no", "no", "frame.step", "step"]);
const IP_FIELDS = new Set(["ip.addr", "ip.src", "ip.dst"]);
const MAC_FIELDS = new Set(["eth.addr", "eth.src", "eth.dst"]);
const STR_FIELDS = new Set(["device", "dev"]);

function isField(word: string): boolean {
  return NUMERIC_FIELDS.has(word) || IP_FIELDS.has(word) || MAC_FIELDS.has(word) || STR_FIELDS.has(word);
}

type Tok =
  | { t: "lparen" } | { t: "rparen" }
  | { t: "and" } | { t: "or" } | { t: "not" }
  | { t: "op"; v: Comparator }
  | { t: "word"; v: string };

const WORD_CHAR = /[A-Za-z0-9_.:/-]/;

function lex(input: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c === "(") { toks.push({ t: "lparen" }); i++; continue; }
    if (c === ")") { toks.push({ t: "rparen" }); i++; continue; }
    if (c === "&") { if (input[i + 1] === "&") { toks.push({ t: "and" }); i += 2; continue; } fail('expected "&&"'); }
    if (c === "|") { if (input[i + 1] === "|") { toks.push({ t: "or" }); i += 2; continue; } fail('expected "||"'); }
    if (c === "!") { if (input[i + 1] === "=") { toks.push({ t: "op", v: "!=" }); i += 2; } else { toks.push({ t: "not" }); i++; } continue; }
    if (c === "=") { if (input[i + 1] === "=") { toks.push({ t: "op", v: "==" }); i += 2; continue; } fail('use "==" for equality'); }
    if (c === "<") { if (input[i + 1] === "=") { toks.push({ t: "op", v: "<=" }); i += 2; } else { toks.push({ t: "op", v: "<" }); i++; } continue; }
    if (c === ">") { if (input[i + 1] === "=") { toks.push({ t: "op", v: ">=" }); i += 2; } else { toks.push({ t: "op", v: ">" }); i++; } continue; }
    if (c === '"') {
      let j = i + 1, s = "";
      while (j < n && input[j] !== '"') { s += input[j]; j++; }
      if (j >= n) fail("unterminated string");
      toks.push({ t: "word", v: s }); i = j + 1; continue;
    }
    if (WORD_CHAR.test(c)) {
      let j = i, s = "";
      while (j < n && WORD_CHAR.test(input[j])) { s += input[j]; j++; }
      const lw = s.toLowerCase();
      if (lw === "and") toks.push({ t: "and" });
      else if (lw === "or") toks.push({ t: "or" });
      else if (lw === "not") toks.push({ t: "not" });
      else if (lw === "contains") toks.push({ t: "op", v: "contains" });
      else toks.push({ t: "word", v: s });
      i = j; continue;
    }
    fail(`unexpected character "${c}"`);
  }
  return toks;
}

// Candidate values a field reads from a row (a frame can hold two — a src and a
// dst — so each comparison is "some side matches").
function ipValues(row: FilterRow, field: string): string[] {
  const p = row.frame.payload;
  if (p.type !== "ipv4") return [];
  if (field === "ip.src") return [p.srcIp];
  if (field === "ip.dst") return [p.dstIp];
  return [p.srcIp, p.dstIp];
}

function macValues(row: FilterRow, field: string): string[] {
  if (field === "eth.src") return [row.frame.srcMac];
  if (field === "eth.dst") return [row.frame.dstMac];
  return [row.frame.srcMac, row.frame.dstMac];
}

function numValues(row: FilterRow, field: string): number[] {
  if (field === "frame.no" || field === "no") return [row.no];
  if (field === "frame.step" || field === "step") return [row.step];
  const p = row.frame.payload;
  if (field === "ip.ttl") return p.type === "ipv4" ? [p.ttl] : [];
  // tcp ports
  if (p.type !== "ipv4" || p.payload.type !== "tcp") return [];
  if (field === "tcp.srcport") return [p.payload.srcPort];
  if (field === "tcp.dstport") return [p.payload.dstPort];
  return [p.payload.srcPort, p.payload.dstPort];
}

function strValues(row: FilterRow): string[] {
  return [row.fromName, row.toName];
}

function matchNums(cands: number[], cmp: Comparator, target: number): boolean {
  if (cmp === "!=") return cands.length > 0 && cands.every(c => c !== target);
  return cands.some(c => {
    switch (cmp) {
      case "==": return c === target;
      case "<": return c < target;
      case ">": return c > target;
      case "<=": return c <= target;
      case ">=": return c >= target;
      default: return false;
    }
  });
}

function matchStrs(cands: string[], cmp: Comparator, target: string): boolean {
  const t = target.toLowerCase();
  const cs = cands.map(c => c.toLowerCase());
  if (cmp === "!=") return cs.length > 0 && cs.every(c => c !== t);
  if (cmp === "contains") return cs.some(c => c.includes(t));
  return cs.some(c => c === t);   // "=="; relational ops are rejected at compile time
}

// String-valued fields (IP/MAC/device) accept only equality/membership operators.
// Validated at COMPILE time so a relational op surfaces as a parse error (caught
// by compileFilter) rather than throwing from inside the predicate at render time.
function assertStringCmp(field: string, cmp: Comparator): void {
  if (cmp !== "==" && cmp !== "!=" && cmp !== "contains") {
    fail(`operator "${cmp}" is not valid for "${field}" (use ==, != or contains)`);
  }
}

function buildFieldPred(field: string, cmp: Comparator, value: string): Pred {
  if (NUMERIC_FIELDS.has(field)) {
    // These fields (ports, ttl, frame no/step) are non-negative integers — reject
    // hex/exponent/whitespace forms that Number() would otherwise coerce.
    if (!/^\d+$/.test(value)) fail(`"${field}" expects a whole number, got "${value}"`);
    const target = Number(value);
    return row => matchNums(numValues(row, field), cmp, target);
  }
  if (IP_FIELDS.has(field)) {
    if (value.includes("/")) {
      if (cmp !== "==" && cmp !== "!=") fail(`CIDR works only with == or != ("${field}")`);
      return row => {
        const cands = ipValues(row, field);
        const inCidr = (ip: string) => cidrContains(value, ip);
        return cmp === "==" ? cands.some(inCidr) : (cands.length > 0 && cands.every(c => !inCidr(c)));
      };
    }
    assertStringCmp(field, cmp);
    return row => matchStrs(ipValues(row, field), cmp, value);
  }
  if (MAC_FIELDS.has(field)) {
    assertStringCmp(field, cmp);
    return row => matchStrs(macValues(row, field), cmp, value);
  }
  // device / dev
  assertStringCmp(field, cmp);
  return row => matchStrs(strValues(row), cmp, value);
}

class Parser {
  private pos = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private next(): Tok | undefined { return this.toks[this.pos++]; }
  private eof(): boolean { return this.pos >= this.toks.length; }

  parse(): Pred {
    if (this.eof()) return () => true;
    const pred = this.parseOr();
    if (!this.eof()) fail("unexpected text at end of filter");
    return pred;
  }

  private parseOr(): Pred {
    let left = this.parseAnd();
    while (this.peek()?.t === "or") {
      this.next();
      const right = this.parseAnd();
      const l = left;
      left = row => l(row) || right(row);
    }
    return left;
  }

  private parseAnd(): Pred {
    let left = this.parseNot();
    while (this.peek()?.t === "and") {
      this.next();
      const right = this.parseNot();
      const l = left;
      left = row => l(row) && right(row);
    }
    return left;
  }

  private parseNot(): Pred {
    if (this.peek()?.t === "not") {
      this.next();
      const inner = this.parseNot();
      return row => !inner(row);
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Pred {
    const tk = this.peek();
    if (!tk) return fail("unexpected end of filter");
    if (tk.t === "lparen") {
      this.next();
      const pred = this.parseOr();
      if (this.next()?.t !== "rparen") fail('missing ")"');
      return pred;
    }
    if (tk.t !== "word") return fail("expected a protocol or field name");
    this.next();
    const lw = tk.v.toLowerCase();
    if (isField(lw)) {
      const opTok = this.next();
      if (!opTok || opTok.t !== "op") return fail(`expected a comparison operator after "${tk.v}"`);
      const valTok = this.next();
      if (!valTok || valTok.t !== "word") return fail(`expected a value after "${tk.v} ${opTok.v}"`);
      return buildFieldPred(lw, opTok.v, valTok.v);
    }
    if (PROTOCOL_SET.has(lw)) return row => frameMatchesToken(row, lw);
    return fail(`unknown filter term "${tk.v}"`);
  }
}

export type CompiledFilter =
  | { ok: true; test: Pred }
  | { ok: false; error: string };

let cacheExpr: string | null = null;
let cacheResult: CompiledFilter | null = null;

// Compile a display-filter expression to a predicate (cached by source text, so
// re-rendering the list per sim step doesn't re-parse). An empty expression
// matches everything; a parse error returns { ok: false }.
export function compileFilter(expr: string): CompiledFilter {
  const src = (expr || "").trim();
  if (cacheExpr === src && cacheResult) return cacheResult;
  let result: CompiledFilter;
  try {
    const pred = new Parser(lex(src)).parse();
    result = { ok: true, test: pred };
  } catch (e) {
    result = { ok: false, error: e instanceof FilterError ? e.message : "invalid filter" };
  }
  cacheExpr = src;
  cacheResult = result;
  return result;
}

// Apply all three filter dimensions to a list of rows, returning the survivors
// plus any expression parse error (an invalid expression is treated as no
// constraint, like Wireshark keeps the list rather than emptying it).
export function applyLogFilter(rows: FilterRow[], filter: LogFilter): { rows: FilterRow[]; error: string | null } {
  const compiled = compileFilter(filter.expr);
  const exprTest = compiled.ok ? compiled.test : null;
  const protocols = filter.protocols;
  const device = filter.device;
  try {
    const out = rows.filter(row => {
      if (protocols.length && !protocols.some(t => frameMatchesToken(row, t))) return false;
      if (device && row.fromId !== device && row.toId !== device) return false;
      if (exprTest && !exprTest(row)) return false;
      return true;
    });
    return { rows: out, error: compiled.ok ? null : compiled.error };
  } catch (e) {
    // Defence in depth: comparators are validated at compile time, so a predicate
    // should never throw — but if one ever did, degrade to "no constraint" with the
    // message rather than crashing the packet-list render.
    return { rows, error: e instanceof Error ? e.message : "invalid filter" };
  }
}

// Is any dimension of a filter active? (Drives the "Showing N of M" line and
// the Clear button's enabled state.)
export function isFilterActive(filter: LogFilter): boolean {
  return filter.protocols.length > 0 || filter.device !== "" || filter.expr.trim() !== "";
}
