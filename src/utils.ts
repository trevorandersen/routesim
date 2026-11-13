import type { Cidr } from "./types";

// A mutator's result as one line of text — the status line and the console both
// show this: the reason it was refused, or what happened plus any warnings.
export function mutationText(result: { ok: boolean; error?: string; message?: string; warnings: string[] }): string {
  return result.ok ? [result.message, ...result.warnings].filter(Boolean).join(" ") : (result.error || "");
}

export function escapeHtml(value: any): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function isValidIpv4(value: string): boolean {
  return parseIpv4(value) !== null;
}

// Parse a dotted quad to its unsigned 32-bit value in one pass, or null when it
// isn't a valid address. The rules are exactly isValidIpv4's (which is defined
// by this): four 1–3 digit decimal octets, each ≤ 255, no leading zeros
// ("01.2.3.4" is rejected — some stacks read a leading zero as octal). No regex,
// no split, no allocation: the routing, RIP, and firewall hot paths parse each
// address once with this and then compare integers.
export function parseIpv4(value: string): number | null {
  if (typeof value !== "string") return null;
  const len = value.length;
  let result = 0, octet = 0, digits = 0, parts = 0;
  for (let i = 0; i <= len; i++) {
    const c = i < len ? value.charCodeAt(i) : 46;   // a virtual trailing "." closes the last octet
    if (c === 46) {                                  // "."
      if (digits === 0 || ++parts > 4) return null;
      result = result * 256 + octet;                 // stays a non-negative double < 2^32
      octet = 0; digits = 0;
    } else if (c >= 48 && c <= 57) {                 // "0"–"9"
      if (digits === 1 && octet === 0) return null;  // leading zero
      if (++digits > 3) return null;
      octet = octet * 10 + (c - 48);
      if (octet > 255) return null;
    } else {
      return null;
    }
  }
  return parts === 4 ? result : null;
}

export function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function intToIpv4(value: number): string {
  // Concatenation, not [..].join(".") — the routing table formats every
  // connected network with this, so it avoids a throwaway array per call.
  return ((value >>> 24) & 255) + "." + ((value >>> 16) & 255) + "." + ((value >>> 8) & 255) + "." + (value & 255);
}

// ─── Subnet prefix maths ──────────────────────────────────────────────────────

export const DEFAULT_PREFIX_LENGTH = 24;

// Clamp anything to a usable prefix length (integer 0–32, defaulting to /24).
export function clampPrefixLength(value: unknown, fallback = DEFAULT_PREFIX_LENGTH): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 32) return fallback;
  return n;
}

// The prefix length configured on a host config / router interface (default /24).
export function prefixOf(holder: { prefixLength?: number } | null | undefined): number {
  return clampPrefixLength(holder?.prefixLength);
}

export function maskOfPrefix(prefixLength: number): number {
  return prefixLength <= 0 ? 0 : (~0 << (32 - prefixLength)) >>> 0;
}

export function sameSubnet(a: string, b: string, prefixLength: number): boolean {
  if (!a || !b) return false;
  const ai = parseIpv4(a), bi = parseIpv4(b);
  if (ai === null || bi === null) return false;
  const mask = maskOfPrefix(clampPrefixLength(prefixLength));
  return (ai & mask) === (bi & mask);
}

// The address the Internet cloud presents as the gateway on a router's WAN
// subnet: the subnet's highest usable host address (e.g. .254 of a /24, or the
// other usable address of a /30), avoiding the router's own address. The router
// reaches the rest of the world by default-routing to this. Returns null for a
// subnet with no spare host (a /31 point-to-point or /32 host route).
export function internetGatewayIp(routerIp: string, prefixLength: number): string | null {
  const ipInt = parseIpv4(routerIp);   // validates and converts in one pass
  if (ipInt === null) return null;
  const len = clampPrefixLength(prefixLength);
  if (len >= 31) return null;
  const mask = maskOfPrefix(len);
  const network = (ipInt & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  let gw = (broadcast - 1) >>> 0;          // highest host address in the subnet
  if (gw === ipInt) gw = (gw - 1) >>> 0;   // never collide with the router itself
  if (gw <= network) return null;          // subnet too small to spare an address
  return intToIpv4(gw);
}

// Normalised CIDR network for an address, e.g. networkOf("10.1.2.3", 16) → "10.1.0.0/16".
export function networkOf(ip: string, prefixLength: number): string {
  const len = clampPrefixLength(prefixLength);
  if (!isValidIpv4(ip)) return `${ip}/${len}`;
  return `${intToIpv4(ipv4ToInt(ip) & maskOfPrefix(len))}/${len}`;
}

// Prefix length of a CIDR string ("10.0.0.0/16" → 16; bare IPs fall back to /24).
export function prefixLengthOfCidr(cidr: string, fallback = DEFAULT_PREFIX_LENGTH): number {
  const slash = String(cidr || "").indexOf("/");
  if (slash < 0) return fallback;
  return clampPrefixLength(Number(cidr.slice(slash + 1)), fallback);
}

// Does the CIDR (or bare-IP-as-/24) contain the address?
export function cidrContains(cidr: string, ip: string): boolean {
  const parsed = cachedCidr(cidr);
  if (parsed === null) return false;
  const addr = parseIpv4(ip);
  return addr !== null && cidrHas(parsed, addr);
}

// ─── Integer CIDR (hot path) ──────────────────────────────────────────────────
//
// A CIDR parsed once into integers (`Cidr` in types.ts: the masked network,
// the mask, and the prefix length). Routing tables, RIP convergence, and
// firewall rules hold these so a per-frame decision is an AND and a compare
// rather than a re-validation and re-split of the same strings. Treat a Cidr as
// immutable — cachedCidr hands the same object to every caller.

// Build a Cidr from an address integer and a prefix length.
export function cidrOf(ip: number, prefixLength: number): Cidr {
  const prefix = clampPrefixLength(prefixLength);
  const mask = maskOfPrefix(prefix);
  return { net: (ip & mask) >>> 0, mask, prefix };
}

// Parse "a.b.c.d/len" (or a bare address, read as /24 — cidrContains's rule) to
// a Cidr, or null if the address part is invalid. An unparseable length falls
// back to /24 exactly as prefixLengthOfCidr does, so the integer path and the
// string path agree on every input.
export function parseCidr(cidr: string): Cidr | null {
  const text = String(cidr || "");
  const slash = text.indexOf("/");
  const ip = parseIpv4(slash >= 0 ? text.slice(0, slash) : text);
  if (ip === null) return null;
  return cidrOf(ip, slash >= 0 ? clampPrefixLength(Number(text.slice(slash + 1))) : DEFAULT_PREFIX_LENGTH);
}

// Memoised parseCidr, keyed by the CIDR text. Route networks and RIP `network`
// statements are a small, stable set of strings, so after the first frame every
// lookup is a Map hit with no allocation. Keyed by value (not by the route or
// rule object), so an edited config can never read a stale parse. Bounded: the
// cache is simply dropped if a pathological config ever fills it.
const CIDR_CACHE_LIMIT = 4096;
const cidrCache = new Map<string, Cidr | null>();
export function cachedCidr(cidr: string): Cidr | null {
  let parsed = cidrCache.get(cidr);
  if (parsed === undefined) {
    parsed = parseCidr(cidr);
    if (cidrCache.size >= CIDR_CACHE_LIMIT) cidrCache.clear();
    cidrCache.set(cidr, parsed);
  }
  return parsed;
}

// Does the parsed CIDR contain the address integer?
export function cidrHas(cidr: Cidr, ip: number): boolean {
  return ((ip & cidr.mask) >>> 0) === cidr.net;
}

// The canonical "network/len" text of a Cidr (networkOf's output format).
export function cidrText(cidr: Cidr): string {
  return `${intToIpv4(cidr.net)}/${cidr.prefix}`;
}

export function normaliseMacAddress(value: string): string {
  return String(value || "").trim().replaceAll("-", ":").toUpperCase();
}

export function isValidMac(value: string): boolean {
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(value);
}

// A single DNS label (RFC 1123): letters/digits/hyphens, not starting or ending
// with a hyphen, 1–63 chars. This is what a hostname must be to be a valid name
// on the wire — the canvas name of a CLI device is its hostname, so it's held to
// the same rule. (Case is preserved for display; resolution is case-insensitive.)
export function isValidHostname(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(value);
}

/**
 * Hard sanity ceiling on any physical port NUMBER (not count) accepted from
 * config JSON or a command. The largest device cap is 24 ports; this is a
 * generous bound above every real cap. Without it, `linkedPortsFor` grows a
 * sparse array up to the requested index — an imported `"fromPort":"Infinity"`
 * (which `Number()` happily accepts) never terminates, and a large finite value
 * exhausts memory. A port outside [1, MAX] is treated as "no explicit port".
 */
export const MAX_PHYSICAL_PORT = 64;

/** A finite positive integer within [1, MAX_PHYSICAL_PORT], else undefined. */
export function normalisePortNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_PHYSICAL_PORT ? n : undefined;
}

export function clampPortCount(value: any): number {
  const portCount = Number(value);
  if (!Number.isInteger(portCount)) return 8;
  return Math.min(24, Math.max(4, portCount));
}

// A firewall is a bump in the wire: two ports by default (inside, outside), up
// to eight. The ONE clamp for it — the inspector allowed 2–8, the console 1–8,
// and the normaliser applied the switch's 4–24, so a default two-port firewall
// came back from a save with four ports.
export const FIREWALL_PORT_RANGE = { min: 2, max: 8 } as const;
export function clampFirewallPortCount(value: any): number {
  const portCount = Number(value);
  if (!Number.isInteger(portCount)) return FIREWALL_PORT_RANGE.min;
  return Math.min(FIREWALL_PORT_RANGE.max, Math.max(FIREWALL_PORT_RANGE.min, portCount));
}

export function clampRouterPortCount(value: any): number {
  const portCount = Number(value);
  if (!Number.isInteger(portCount)) return 4;
  return Math.min(12, Math.max(0, portCount));
}

// An access point has a single wired uplink (some carry a couple of LAN ports);
// its wireless clients are associations, not ports. Allow 1–4, default 1.
export function clampApPortCount(value: any): number {
  const portCount = Number(value);
  if (!Number.isInteger(portCount)) return 1;
  return Math.min(4, Math.max(1, portCount));
}

// A stable, locally-administered unicast MAC derived from a seed string (e.g. a
// device id) — used as an access point's BSSID for the 802.11 management frames
// when it has no explicit MAC. Deterministic, so it survives reloads and tests.
export function deriveMac(seed: string): string {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const bytes = [0, 0, 0, 0, 0, 0].map((_, i) => { h = Math.imul(h ^ (i + 1), 2654435761) >>> 0; return (h >>> 16) & 0xff; });
  bytes[0] = (bytes[0] & 0xfe) | 0x02; // locally administered, unicast
  return bytes.map(b => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

// A WiFi network name: a single trimmed token, capped at the 802.11 limit of 32
// octets. SSIDs are case-sensitive; whitespace-only collapses to "" (no SSID).
export function normaliseSsid(value: any): string {
  // 802.11 caps an SSID at 32 OCTETS, not 32 UTF-16 code units — a 32-character
  // CJK or emoji name is up to 128 bytes. Keep whole code points up to the cap.
  return truncateOctets(String(value ?? "").trim(), 32);
}

/** Longest prefix of `s` (whole code points) whose UTF-8 encoding is ≤ `max` bytes. */
export function truncateOctets(s: string, max: number): string {
  let bytes = 0;
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + n > max) break;
    bytes += n;
    out += ch;
  }
  return out;
}

// A WPA2 pre-shared key is 8–63 printable characters; we only cap the length and
// trim — an empty result means an open network (no password).
export function normaliseWifiPassword(value: any): string {
  return String(value ?? "").trim().slice(0, 63);
}

export function parseIpv4Token(value: any): { address: string; prefixLength: number | null } | null {
  const match = String(value || "").trim().match(/^([^/]+)(?:\/(\d{1,2}))?$/);
  if (!match) return null;
  const address = match[1];
  const prefixStr = match[2];
  const prefixLength = prefixStr == null ? null : Number(prefixStr);
  if (!isValidIpv4(address)) return null;
  // The `\d{1,2}` capture already guarantees a non-negative integer, so only the
  // upper bound and a leading-zero check (e.g. "/01") remain.
  if (prefixLength != null && (prefixStr !== String(prefixLength) || prefixLength > 32)) return null;
  return { address, prefixLength };
}

export function normaliseVlanId(value: any): number | null {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1 || id > 4094) return null;
  return id;
}

// cssColor is called many times per device/link/frame in the render loop, and
// getComputedStyle forces a style recalc. Cache resolved values and clear the
// cache when the theme changes (see clearCssColorCache, called from setTheme).
const cssColorCache = new Map<string, string>();

export function cssColor(name: string): string {
  let value = cssColorCache.get(name);
  if (value === undefined) {
    value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    cssColorCache.set(name, value);
  }
  return value;
}

export function clearCssColorCache(): void {
  cssColorCache.clear();
}

// The ICMP types the frame model carries, and their iptables `--icmp-type`
// names. The single source of truth for both the firewall parser
// (`canonicalIcmpType`) and the matcher (`icmpTypeName`).
export const ICMP_TYPE_NAMES: Record<number, string> = {
  0: "echo-reply",
  3: "destination-unreachable",
  8: "echo-request",
  11: "time-exceeded",
};

// The iptables name for an ICMP type number (`echo-request`, …), or `type-N`.
export function icmpTypeName(t: number): string {
  return ICMP_TYPE_NAMES[t] ?? `type-${t}`;
}

// Canonicalise an iptables `--icmp-type` value to the name the matcher compares
// against, or null if it names no type this model can ever match. Accepts a
// canonical name, a numeric type (optionally `type/code` — the code is dropped,
// the model has none), and `any` (matches every ICMP type). Rejecting the rest
// stops a rule that could never fire from being silently accepted (review R21).
export function canonicalIcmpType(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (v === "any") return "any";
  const num = /^(\d+)(?:\/\d+)?$/.exec(v);
  if (num) return ICMP_TYPE_NAMES[Number(num[1])] ?? null;
  return Object.values(ICMP_TYPE_NAMES).includes(v) ? v : null;
}

// Generates a random locally-administered unicast MAC (02:..).
export function randomMac(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  bytes[0] = (bytes[0] & 0xfe) | 0x02; // locally administered, unicast
  return Array.from(bytes, b => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
}
