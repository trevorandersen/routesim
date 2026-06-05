export function escapeHtml(value: any): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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

export function ipv4Network24(value: string): string {
  const parts = String(value || "").split(".");
  if (parts.length !== 4) return value;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

export function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function sameSubnet24(a: string, b: string): boolean {
  if (!a || !b || !isValidIpv4(a) || !isValidIpv4(b)) return false;
  return (ipv4ToInt(a) >>> 8) === (ipv4ToInt(b) >>> 8);
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

export function parseIpv4Token(value: any): { address: string; prefixLength: number | null } | null {
  const match = String(value || "").trim().match(/^([^/]+)(?:\/(\d{1,2}))?$/);
  if (!match) return null;
  const address = match[1];
  const prefixLength = match[2] == null ? null : Number(match[2]);
  if (!isValidIpv4(address)) return null;
  if (prefixLength != null && (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32)) return null;
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
