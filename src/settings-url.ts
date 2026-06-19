// Reading (and writing) app settings via the URL query string, e.g.
//   rs-web.html?names=0&ips=1&autodhcp=on&apipa=1&theme=dark&speed=500
//
// This is the single source of truth for which settings are URL-controllable.
// Add a row to SETTINGS below and it is parsed on load (app.ts applies it) and
// emitted by buildSettingsQuery() (the shareable-link inverse). The parser is
// pure — it mutates nothing — so it is trivially testable; all DOM/state writes
// happen in the caller.

import { state, THEMES, DEFAULT_THEME } from "./state";
import type { DisplayOptions } from "./types";

export const SPEED_MIN = 200;
export const SPEED_MAX = 3000;
export const SPEED_DEFAULT = 1000;

// The boolean DisplayOptions that a query param maps to, plus the default each
// holds in a fresh state.options (so buildSettingsQuery only emits differences).
// Param keys are lowercase; matching is case-insensitive.
const BOOL_PARAMS: { param: string; key: keyof DisplayOptions; def: boolean }[] = [
  { param: "names", key: "showDeviceNames", def: true },
  { param: "ips", key: "showIpAddresses", def: true },
  { param: "macs", key: "showMacAddresses", def: true },
  { param: "autodhcp", key: "autoDhcp", def: false },
  { param: "apipa", key: "apipaFallback", def: false },
];

export interface ParsedSettings {
  options: Partial<DisplayOptions>; // recognised boolean toggles
  theme?: string; // validated theme id
  speed?: number; // clamped ms/hop
  applied: string[]; // param names recognised and parsed
  ignored: string[]; // params present but unknown or unparseable
}

// Accepts the usual truthy/falsy spellings; returns undefined for anything else
// so a typo is reported rather than silently treated as false.
function parseBool(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

// "light" stays a back-compat alias for warm-light (matches setTheme).
function resolveTheme(raw: string): string | undefined {
  const v = raw.trim().toLowerCase();
  const id = v === "light" ? "warm-light" : v;
  return THEMES.some(t => t.id === id) ? id : undefined;
}

function clampSpeed(n: number): number {
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(n)));
}

// Parse a query string (e.g. window.location.search) into a settings patch.
// Pure. Unknown/unparseable params land in `ignored` so the caller can warn.
export function parseSettingsFromUrl(search: string): ParsedSettings {
  const out: ParsedSettings = { options: {}, applied: [], ignored: [] };
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search || "");
  } catch {
    return out;
  }
  for (const [rawKey, value] of params) {
    const key = rawKey.trim().toLowerCase();
    const boolSpec = BOOL_PARAMS.find(b => b.param === key);
    if (boolSpec) {
      const parsed = parseBool(value);
      if (parsed === undefined) { out.ignored.push(rawKey); continue; }
      out.options[boolSpec.key] = parsed;
      out.applied.push(key);
    } else if (key === "theme") {
      const id = resolveTheme(value);
      if (!id) { out.ignored.push(rawKey); continue; }
      out.theme = id;
      out.applied.push(key);
    } else if (key === "speed") {
      const n = Number(value);
      if (!Number.isFinite(n)) { out.ignored.push(rawKey); continue; }
      out.speed = clampSpeed(n);
      out.applied.push(key);
    } else {
      out.ignored.push(rawKey);
    }
  }
  return out;
}

// The inverse: a query string capturing only settings that differ from the
// defaults — a shareable link's tail (no leading "?"). Empty when everything is
// at its default.
export function buildSettingsQuery(): string {
  const params = new URLSearchParams();
  for (const { param, key, def } of BOOL_PARAMS) {
    if (state.options[key] !== def) params.set(param, state.options[key] ? "1" : "0");
  }
  if (state.theme !== DEFAULT_THEME) params.set("theme", state.theme);
  if (state.simulation.speed !== SPEED_DEFAULT) params.set("speed", String(state.simulation.speed));
  return params.toString();
}
