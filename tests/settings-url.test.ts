/**
 * URL query-string settings: parseSettingsFromUrl (pure) and the
 * buildSettingsQuery inverse (reads live state). See src/settings-url.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { state, DEFAULT_THEME } from "../src/state";
import { parseSettingsFromUrl, buildSettingsQuery, SPEED_MIN, SPEED_MAX } from "../src/settings-url";

describe("parseSettingsFromUrl", () => {
  it("returns an empty patch for an empty / blank query", () => {
    for (const q of ["", "?", "   "]) {
      const r = parseSettingsFromUrl(q);
      expect(r.options).toEqual({});
      expect(r.theme).toBeUndefined();
      expect(r.speed).toBeUndefined();
      expect(r.applied).toEqual([]);
    }
  });

  it("maps boolean params to the right DisplayOptions keys", () => {
    const r = parseSettingsFromUrl("names=0&ips=1&macs=0&autodhcp=1&apipa=1");
    expect(r.options).toEqual({
      showDeviceNames: false,
      showIpAddresses: true,
      showMacAddresses: false,
      autoDhcp: true,
      apipaFallback: true,
    });
    expect(r.applied.sort()).toEqual(["apipa", "autodhcp", "ips", "macs", "names"]);
  });

  it("maps the silent-protocol params to their DisplayOptions keys", () => {
    const r = parseSettingsFromUrl("silentarp=1&silentdhcp=on&silentdns=true&silentwifi=yes");
    expect(r.options).toEqual({ silentArp: true, silentDhcp: true, silentDns: true, silentWifi: true });
    expect(r.applied.sort()).toEqual(["silentarp", "silentdhcp", "silentdns", "silentwifi"]);
  });

  it("accepts the usual truthy/falsy spellings, case-insensitively", () => {
    expect(parseSettingsFromUrl("names=true").options.showDeviceNames).toBe(true);
    expect(parseSettingsFromUrl("names=YES").options.showDeviceNames).toBe(true);
    expect(parseSettingsFromUrl("names=On").options.showDeviceNames).toBe(true);
    expect(parseSettingsFromUrl("names=false").options.showDeviceNames).toBe(false);
    expect(parseSettingsFromUrl("names=no").options.showDeviceNames).toBe(false);
    expect(parseSettingsFromUrl("NAMES=off").options.showDeviceNames).toBe(false); // key case-insensitive
  });

  it("strips a leading '?' (a full location.search)", () => {
    expect(parseSettingsFromUrl("?apipa=1").options.apipaFallback).toBe(true);
  });

  it("reports an unparseable boolean value as ignored, not false", () => {
    const r = parseSettingsFromUrl("names=maybe");
    expect(r.options.showDeviceNames).toBeUndefined();
    expect(r.ignored).toContain("names");
  });

  it("validates the theme, with 'light' as a back-compat alias", () => {
    expect(parseSettingsFromUrl("theme=dark").theme).toBe("dark");
    expect(parseSettingsFromUrl("theme=blueprint").theme).toBe("blueprint");
    expect(parseSettingsFromUrl("theme=light").theme).toBe("warm-light");
    const bad = parseSettingsFromUrl("theme=neon");
    expect(bad.theme).toBeUndefined();
    expect(bad.ignored).toContain("theme");
  });

  it("parses and clamps speed; rejects non-numeric", () => {
    expect(parseSettingsFromUrl("speed=500").speed).toBe(500);
    expect(parseSettingsFromUrl("speed=10").speed).toBe(SPEED_MIN); // clamped up
    expect(parseSettingsFromUrl("speed=99999").speed).toBe(SPEED_MAX); // clamped down
    const bad = parseSettingsFromUrl("speed=fast");
    expect(bad.speed).toBeUndefined();
    expect(bad.ignored).toContain("speed");
  });

  it("collects unknown params in `ignored`", () => {
    const r = parseSettingsFromUrl("names=1&bogus=1&topology=x");
    expect(r.ignored.sort()).toEqual(["bogus", "topology"]);
    expect(r.applied).toEqual(["names"]);
  });
});

describe("buildSettingsQuery", () => {
  // Pin the relevant slice of state to defaults, restore afterwards (bun shares
  // module state across files and resetState() does not touch options/theme).
  let saved: any;
  beforeEach(() => {
    saved = { options: { ...state.options }, theme: state.theme, speed: state.simulation.speed };
    state.options.showDeviceNames = true;
    state.options.showIpAddresses = true;
    state.options.showMacAddresses = true;
    state.options.autoDhcp = false;
    state.options.apipaFallback = false;
    state.options.silentArp = false;
    state.options.silentDhcp = false;
    state.options.silentDns = false;
    state.options.silentWifi = false;
    state.theme = DEFAULT_THEME;
    state.simulation.speed = 1000;
  });
  afterEach(() => {
    state.options = saved.options;
    state.theme = saved.theme;
    state.simulation.speed = saved.speed;
  });

  it("is empty when everything is at its default", () => {
    expect(buildSettingsQuery()).toBe("");
  });

  it("emits only the settings that differ from default", () => {
    state.options.showDeviceNames = false;
    state.options.autoDhcp = true;
    state.simulation.speed = 500;
    const q = new URLSearchParams(buildSettingsQuery());
    expect(q.get("names")).toBe("0");
    expect(q.get("autodhcp")).toBe("1");
    expect(q.get("speed")).toBe("500");
    expect(q.get("ips")).toBeNull(); // unchanged → omitted
    expect(q.get("theme")).toBeNull();
  });

  it("emits a non-default theme", () => {
    state.theme = "blueprint";
    expect(new URLSearchParams(buildSettingsQuery()).get("theme")).toBe("blueprint");
  });

  it("round-trips through the parser", () => {
    state.options.showIpAddresses = false;
    state.options.apipaFallback = true;
    state.options.silentDns = true;
    state.theme = "dark";
    state.simulation.speed = 250;
    const parsed = parseSettingsFromUrl(buildSettingsQuery());
    expect(parsed.options.showIpAddresses).toBe(false);
    expect(parsed.options.apipaFallback).toBe(true);
    expect(parsed.options.silentDns).toBe(true);
    expect(parsed.theme).toBe("dark");
    expect(parsed.speed).toBe(250);
  });
});
