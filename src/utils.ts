export function escapeHtml(value: any): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every(part => {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (part.length > 1 && part.startsWith("0")) return false;
    const octet = Number(part);
    return octet >= 0 && octet <= 255;
  });
}

export function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function intToIpv4(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
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
  if (!a || !b || !isValidIpv4(a) || !isValidIpv4(b)) return false;
  const mask = maskOfPrefix(clampPrefixLength(prefixLength));
  return (ipv4ToInt(a) & mask) === (ipv4ToInt(b) & mask);
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
  const slash = String(cidr || "").indexOf("/");
  const net = slash >= 0 ? cidr.slice(0, slash) : cidr;
  if (!isValidIpv4(net) || !isValidIpv4(ip)) return false;
  return sameSubnet(net, ip, prefixLengthOfCidr(cidr));
}

export function normaliseMacAddress(value: string): string {
  return String(value || "").trim().replaceAll("-", ":").toUpperCase();
}

export function isValidMac(value: string): boolean {
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(value);
}

export function clampPortCount(value: any): number {
  const portCount = Number(value);
  if (!Number.isInteger(portCount)) return 8;
  return Math.min(24, Math.max(4, portCount));
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
  return String(value ?? "").trim().slice(0, 32);
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

// Generates a random locally-administered unicast MAC (02:..).
export function randomMac(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  bytes[0] = (bytes[0] & 0xfe) | 0x02; // locally administered, unicast
  return Array.from(bytes, b => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
}
