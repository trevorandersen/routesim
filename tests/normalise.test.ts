import { describe, it, expect } from "bun:test";
import {
  normaliseArpTable, normaliseMacTable, normaliseVlans,
  normalisePortVlans, normalisePortModes, normaliseTrunkAllowedVlans,
  normaliseRouterInterfaces, normaliseDeviceConfig, normaliseConfig,
  defaultDeviceConfig, normaliseConfigName, deviceSize, ensureConfig,
  memoPortModes, memoPortVlans, normaliseMirror, normaliseRipConfig,
} from "../src/normalise";

describe("normaliseMirror — canonical Ethernet spelling", () => {
  it("canonicalises a lowercase dest/source to the exact spelling the engine matches", () => {
    // The engine compares `Ethernet${idx+1}` === mirror.dest case-sensitively;
    // a lowercased dest that slipped past the /i regex would silently disable SPAN.
    const m = normaliseMirror({ name: "MON", dest: "ethernet2", sources: ["ethernet1", "  Ethernet3 "] });
    expect(m?.dest).toBe("Ethernet2");
    expect(m?.sources).toEqual(["Ethernet1", "Ethernet3"]);
  });
  it("rejects a non-port dest", () => {
    expect(normaliseMirror({ dest: "wlan0" })).toBeUndefined();
    expect(normaliseMirror(null)).toBeUndefined();
  });
});

describe("normaliseRipConfig — hostile import robustness", () => {
  it("survives a null entry in learnedRoutes instead of throwing", () => {
    const rip = normaliseRipConfig({ enabled: true, learnedRoutes: [null, { network: "10.0.0.0/8", nextHop: "10.0.0.1" }] });
    expect(rip.enabled).toBe(true);
    expect(rip.learnedRoutes).toEqual([{ network: "10.0.0.0/8", nextHop: "10.0.0.1", interface: undefined, metric: 2 }]);
  });
});

describe("memoPortModes / memoPortVlans (read-only render-path cache)", () => {
  it("returns the same shared empty object for null/undefined", () => {
    expect(memoPortModes(null)).toEqual({});
    expect(memoPortModes(undefined)).toBe(memoPortModes(null)); // shared EMPTY constant
    expect(memoPortVlans(undefined)).toBe(memoPortVlans(null));
  });

  it("caches by input-object identity and recomputes on replacement", () => {
    const stored = { Ethernet1: "trunk" };
    const first = memoPortModes(stored);
    expect(memoPortModes(stored)).toBe(first);       // same ref → === cache hit
    expect(first).toEqual({ Ethernet1: "trunk" });
    expect(memoPortModes({ ...stored })).not.toBe(first); // replaced object → recompute (a mutator replaces the ref)

    const vstored = { Ethernet1: 20 };
    const v = memoPortVlans(vstored);
    expect(memoPortVlans(vstored)).toBe(v);
    expect(v).toEqual({ Ethernet1: 20 });
  });
});

// ── ARP table ─────────────────────────────────────────────────────────────────

describe("normalisers — malformed-element resilience", () => {
  // Imported JSON can carry a null / primitive inside a table array; dereferencing
  // it raw threw a TypeError that aborted the whole import (and poisoned the
  // scenario registry). Every array normaliser must defend and drop the junk.
  it("drops null/primitive elements instead of throwing", () => {
    expect(() => normaliseArpTable([null, 5, "x"] as any)).not.toThrow();
    expect(normaliseArpTable([null] as any)).toEqual([]);
    expect(() => normaliseMacTable([null, undefined] as any)).not.toThrow();
    expect(() => normaliseVlans([null, 3] as any)).not.toThrow();
    expect(normaliseVlans([null, 3] as any).map(v => v.id)).toEqual([1, 3]); // bare-number id still works
    expect(() => normaliseRouterInterfaces([null, {}] as any, "r1")).not.toThrow();
  });

  it("a whole config with null table elements normalises cleanly", () => {
    const cfg = {
      devices: [
        { id: "a", type: "computer", x: 0, y: 0, config: { arpTable: [null] } },
        { id: "b", type: "switch", x: 0, y: 0, config: { managed: true, vlans: [null] } },
        { id: "c", type: "router", x: 0, y: 0, config: { interfaces: [null] } },
      ],
      links: [],
    };
    expect(() => normaliseConfig(cfg)).not.toThrow();
  });
});

describe("normaliseArpTable", () => {
  it("returns empty array for empty input", () => {
    expect(normaliseArpTable([])).toEqual([]);
    expect(normaliseArpTable(null as any)).toEqual([]);
    expect(normaliseArpTable(undefined as any)).toEqual([]);
  });

  it("preserves valid entries (normalises field names)", () => {
    const entries = [{ ip: "192.168.1.1", mac: "02:00:00:00:01:01" }];
    const result = normaliseArpTable(entries);
    expect(result).toHaveLength(1);
    expect(result[0].ipv4Address).toBe("192.168.1.1");
    expect(result[0].macAddress).toBe("02:00:00:00:01:01");
  });

  it("drops entries with all empty fields", () => {
    const entries = [{ ip: "", mac: "" }, { ip: "1.2.3.4", mac: "AA:BB:CC:DD:EE:FF" }];
    const result = normaliseArpTable(entries);
    expect(result).toHaveLength(1);
    expect(result[0].ipv4Address).toBe("1.2.3.4");
  });
});

// ── MAC table ─────────────────────────────────────────────────────────────────

describe("normaliseMacTable", () => {
  it("returns empty array for empty input", () => {
    expect(normaliseMacTable([])).toEqual([]);
  });

  it("preserves valid entries with trimmed port", () => {
    const entries = [{ mac: "02:00:00:00:01:01", port: " Ethernet1 ", vlan: 10 }];
    const result = normaliseMacTable(entries);
    expect(result).toHaveLength(1);
    expect(result[0].port).toBe("Ethernet1");
    expect(result[0].vlan).toBe("10");
  });

  it("drops entries with all empty fields", () => {
    const entries = [{ mac: "", port: "", vlan: "" }];
    const result = normaliseMacTable(entries);
    // Entry has no meaningful data → filtered out
    expect(result).toHaveLength(0);
  });
});

// ── VLANs ─────────────────────────────────────────────────────────────────────

describe("normaliseVlans", () => {
  it("always includes VLAN 1 default", () => {
    const result = normaliseVlans(null as any);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ id: 1, name: "default" });
  });

  it("preserves valid VLANs alongside default", () => {
    const vlans = [{ id: 10, name: "Sales" }, { id: 20, name: "Engineering" }];
    const result = normaliseVlans(vlans);
    expect(result).toHaveLength(3); // VLAN 1 + 10 + 20
    expect(result[0]).toEqual({ id: 1, name: "default" });
    expect(result[1]).toEqual({ id: 10, name: "Sales" });
    expect(result[2]).toEqual({ id: 20, name: "Engineering" });
  });

  it("drops out-of-range VLAN IDs", () => {
    const vlans = [{ id: 0, name: "bad" }, { id: 10, name: "ok" }, { id: 5000, name: "bad" }];
    const result = normaliseVlans(vlans);
    expect(result).toHaveLength(2); // VLAN 1 default + 10
    expect(result[1].id).toBe(10);
  });

  it("deduplicates VLAN IDs", () => {
    const vlans = [{ id: 10, name: "first" }, { id: 10, name: "second" }];
    const result = normaliseVlans(vlans);
    expect(result).toHaveLength(2); // VLAN 1 default + one 10
  });

  it("does not duplicate VLAN 1 if passed in input", () => {
    const vlans = [{ id: 1, name: "default" }, { id: 10, name: "Sales" }];
    const result = normaliseVlans(vlans);
    expect(result.filter(v => v.id === 1)).toHaveLength(1);
  });
});

// ── Port VLANs ────────────────────────────────────────────────────────────────

describe("normalisePortVlans", () => {
  it("returns empty object for null", () => {
    expect(normalisePortVlans(null as any)).toEqual({});
  });

  it("preserves valid port→VLAN mappings (filters VLAN 1)", () => {
    const result = normalisePortVlans({ Ethernet1: 10, Ethernet2: 20 });
    expect(result).toEqual({ Ethernet1: 10, Ethernet2: 20 });
  });

  it("filters out VLAN 1 (default)", () => {
    const result = normalisePortVlans({ Ethernet1: 1, Ethernet2: 10 });
    expect(Object.keys(result)).toHaveLength(1);
    expect(result.Ethernet2).toBe(10);
  });

  it("filters non-valid VLAN IDs", () => {
    const result = normalisePortVlans({ Ethernet1: "abc" });
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("filters empty keys", () => {
    const result = normalisePortVlans({ "": 10, Ethernet1: 20 });
    expect(Object.keys(result)).toHaveLength(1);
    expect(result.Ethernet1).toBe(20);
  });
});

// ── Port modes ────────────────────────────────────────────────────────────────

describe("normalisePortModes", () => {
  it("returns empty object for null", () => {
    expect(normalisePortModes(null as any)).toEqual({});
  });

  it("preserves access and trunk modes", () => {
    const result = normalisePortModes({ Ethernet1: "trunk", Ethernet2: "access" });
    expect(result.Ethernet1).toBe("trunk");
    expect(result.Ethernet2).toBe("access");
  });

  it("defaults invalid modes to access", () => {
    const result = normalisePortModes({ Ethernet1: "bogus" });
    expect(result.Ethernet1).toBe("access");
  });
});

// ── Trunk allowed VLANs ───────────────────────────────────────────────────────

describe("normaliseTrunkAllowedVlans", () => {
  it("returns empty object for null", () => {
    expect(normaliseTrunkAllowedVlans(null as any)).toEqual({});
  });

  it("preserves valid allowed VLAN lists", () => {
    const result = normaliseTrunkAllowedVlans({ Ethernet1: [10, 20, 30] });
    expect(result.Ethernet1).toEqual([10, 20, 30]);
  });

  it("filters out-of-range VLAN IDs", () => {
    const result = normaliseTrunkAllowedVlans({ Ethernet1: [0, 10, 5000] });
    expect(result.Ethernet1).toEqual([10]);
  });

  it("drops ports with empty resulting lists", () => {
    const result = normaliseTrunkAllowedVlans({ Ethernet1: [0, 5000] });
    expect(Object.keys(result)).toHaveLength(0);
  });
});

// ── Router interfaces ─────────────────────────────────────────────────────────

describe("normaliseRouterInterfaces", () => {
  it("returns empty array for null", () => {
    expect(normaliseRouterInterfaces(null as any)).toEqual([]);
  });

  it("generates deterministic MAC addresses", () => {
    const interfaces = [
      { peerId: "sw-1", type: "ethernet", ipv4Address: "192.168.1.1" },
      { peerId: "sw-2", type: "ethernet", ipv4Address: "192.168.2.1" },
    ];
    const result = normaliseRouterInterfaces(interfaces, "rtr-1");
    expect(result).toHaveLength(2);
    // MAC format: 02:RR:HH:HH:II:01 (locally-administered; 24 hash bits + iface index)
    expect(result[0].macAddress).toMatch(/^02(:[0-9a-fA-F]{2}){3}:[0-9a-fA-F]{2}:01$/);
    expect(result[1].macAddress).toMatch(/^02(:[0-9a-fA-F]{2}){3}:[0-9a-fA-F]{2}:01$/);
    expect(result[0].macAddress).not.toBe(result[1].macAddress); // distinct per interface
  });

  it("preserves vlanTag when set", () => {
    const interfaces = [
      { peerId: "sw-1", type: "ethernet", ipv4Address: "192.168.10.1", vlanTag: 10 },
    ];
    const result = normaliseRouterInterfaces(interfaces);
    expect(result[0].vlanTag).toBe(10);
  });

  it("sets vlanTag to null when not present", () => {
    const interfaces = [
      { peerId: "sw-1", type: "ethernet", ipv4Address: "192.168.1.1" },
    ];
    const result = normaliseRouterInterfaces(interfaces);
    expect(result[0].vlanTag).toBeNull();
  });

  it("preserves entries with ipv4Address even if peerId is empty", () => {
    const interfaces = [
      { peerId: "", type: "ethernet", ipv4Address: "192.168.1.1" },
      { peerId: "sw-1", type: "ethernet", ipv4Address: "192.168.2.1" },
    ];
    const result = normaliseRouterInterfaces(interfaces);
    // Both entries have ipv4Address, so both are kept
    expect(result).toHaveLength(2);
  });
});

// ── Device config normalisation ───────────────────────────────────────────────

describe("normaliseDeviceConfig", () => {
  it("normalises computer config", () => {
    const device = { type: "computer", config: { ipv4Address: "10.0.0.1", macAddress: "aa:bb:cc:dd:ee:ff" } };
    const result = normaliseDeviceConfig(device as any);
    expect(result.ipv4Address).toBe("10.0.0.1");
    // MAC should be uppercased
    expect(result.macAddress).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("defaults a bare IP's source to static and preserves dhcp/apipa", () => {
    // A configured IP with no recorded source reads as static.
    expect(normaliseDeviceConfig({ type: "computer", config: { ipv4Address: "10.0.0.1" } } as any).ipSource).toBe("static");
    // Explicit dhcp/apipa round-trip.
    expect(normaliseDeviceConfig({ type: "computer", config: { ipv4Address: "10.0.0.1", ipSource: "dhcp" } } as any).ipSource).toBe("dhcp");
    expect(normaliseDeviceConfig({ type: "computer", config: { ipv4Address: "169.254.1.2", ipSource: "apipa" } } as any).ipSource).toBe("apipa");
    // No address → no source.
    expect(normaliseDeviceConfig({ type: "computer", config: {} } as any).ipSource).toBeUndefined();
  });

  it("normalises managed switch config with VLAN fields", () => {
    const device = {
      type: "switch",
      config: {
        managed: true, ethernetPorts: 8,
        vlans: [{ id: 10, name: "Sales" }],
        portVlans: { Ethernet1: 10 },
        portModes: { Ethernet1: "trunk" },
      },
    };
    const result = normaliseDeviceConfig(device as any);
    expect(result.managed).toBe(true);
    // normaliseVlans always includes VLAN 1 default + the passed VLANs
    expect(result.vlans).toHaveLength(2);
    expect(result.portModes!).toBeDefined();
    expect(result.portModes!.Ethernet1).toBe("trunk");
    expect(result.trunkAllowedVlans).toBeDefined();
    expect(result.trunkNativeVlans).toBeDefined();
  });

  it("normalises unmanaged switch config without VLAN fields", () => {
    const device = { type: "switch", config: { managed: false, ethernetPorts: 8 } };
    const result = normaliseDeviceConfig(device as any);
    expect(result.managed).toBe(false);
    expect(result.vlans).toBeUndefined();
    expect(result.portModes!).toBeUndefined();
  });

  it("normalises router config with interfaces", () => {
    const device = {
      type: "router",
      config: {
        ethernetPorts: 4, serialPorts: 2,
        interfaces: [{ peerId: "sw-1", type: "ethernet", ipv4Address: "192.168.1.1", vlanTag: 10 }],
      },
    };
    const result = normaliseDeviceConfig(device as any);
    expect(result.interfaces!).toHaveLength(1);
    expect(result.interfaces![0].vlanTag).toBe(10);
  });
});

// ── Full config normalisation ─────────────────────────────────────────────────

describe("normaliseConfig", () => {
  it("normalises a complete config", () => {
    const config = {
      version: 1,
      devices: [
        { id: "pc1", type: "computer", name: "PC-1", x: 0, y: 0, config: { ipv4Address: "10.0.0.1" } },
        { id: "sw1", type: "switch", name: "SW-1", x: 100, y: 0, config: { ethernetPorts: 8 } },
      ],
      links: [{ from: "pc1", to: "sw1" }],
    };
    const result = normaliseConfig(config);
    expect(result.devices).toHaveLength(2);
    expect(result.devices[0].id).toBe("pc1");
    expect(result.devices[0].width).toBeDefined();
    expect(result.devices[0].height).toBeDefined();
    expect(result.links).toHaveLength(1);
  });

  it("throws for empty config without arrays", () => {
    expect(() => normaliseConfig({})).toThrow();
  });

  it("throws when link references missing device", () => {
    const config = {
      devices: [{ id: "pc1", type: "computer", name: "PC-1", x: 0, y: 0 }],
      links: [{ from: "pc1", to: "nonexistent" }],
    };
    expect(() => normaliseConfig(config)).toThrow();
  });
});

// ── Defaults ──────────────────────────────────────────────────────────────────

describe("defaultDeviceConfig", () => {
  it("returns computer config shape", () => {
    const config = defaultDeviceConfig("computer");
    expect(config).toHaveProperty("ipv4Address");
    expect(config).toHaveProperty("macAddress");
    expect(config).toHaveProperty("arpTable");
  });

  it("returns switch config shape", () => {
    const config = defaultDeviceConfig("switch");
    expect(config).toHaveProperty("managed");
    expect(config).toHaveProperty("ethernetPorts");
    expect(config).toHaveProperty("macTable");
    expect(config).toHaveProperty("portModes");
    expect(config).toHaveProperty("trunkAllowedVlans");
  });

  it("returns router config shape", () => {
    const config = defaultDeviceConfig("router");
    expect(config).toHaveProperty("ethernetPorts");
    expect(config).toHaveProperty("serialPorts");
    expect(config).toHaveProperty("interfaces");
  });
});

// ── Device size ───────────────────────────────────────────────────────────────

describe("deviceSize", () => {
  it("returns correct sizes for each type", () => {
    expect(deviceSize("computer")).toEqual({ width: 92, height: 68 });
    expect(deviceSize("router")).toEqual({ width: 92, height: 70 });
    expect(deviceSize("switch")).toEqual({ width: 104, height: 58 });
  });
});

// ── Config name ───────────────────────────────────────────────────────────────

describe("normaliseConfigName", () => {
  it("trims whitespace", () => {
    expect(normaliseConfigName("  MyConfig  ")).toBe("MyConfig");
  });

  it("replaces special characters with dashes", () => {
    expect(normaliseConfigName("my<config>")).toBe("my-config-");
  });

  it("returns empty string for null", () => {
    expect(normaliseConfigName(null as any)).toBe("");
  });
});

describe("ensureConfig", () => {
  it("creates the type-appropriate default when config is absent", () => {
    for (const type of ["computer", "switch", "router", "lan"] as const) {
      const device = { id: "d", type, name: "D", x: 0, y: 0, width: 0, height: 0, config: undefined } as any;
      ensureConfig(device);
      expect(device.config).toEqual(defaultDeviceConfig(type));
    }
  });

  it("is idempotent — does not overwrite an existing config", () => {
    const device = { id: "d", type: "computer", name: "D", x: 0, y: 0, width: 0, height: 0,
      config: { ipv4Address: "10.0.0.1", gatewayIpv4Address: "", macAddress: "", arpTable: [] } } as any;
    const same = ensureConfig(device);
    expect(same).toBe(device.config);
    expect(device.config.ipv4Address).toBe("10.0.0.1");
  });
});

describe("normaliseConfig — link port numbers are bounded and unique (F01)", () => {
  const two = (fromPort: unknown, toPort?: unknown) => normaliseConfig({
    devices: [
      { id: "a", type: "switch", name: "A", x: 0, y: 0, config: {} },
      { id: "b", type: "switch", name: "B", x: 100, y: 0, config: {} },
    ],
    links: [{ from: "a", to: "b", fromPort, toPort }],
  } as any).links[0];

  it("drops a non-finite, fractional, non-positive, or oversized port to auto-assign", () => {
    // "Infinity" survived Number() and sent linkedPortsFor into an unbounded
    // allocation loop; a huge finite value exhausted memory the same way.
    for (const bad of ["Infinity", Infinity, NaN, 1.5, 0, -3, 1e9, "abc"]) {
      expect(two(bad).fromPort).toBeUndefined();
    }
  });

  it("keeps a valid in-range port", () => {
    expect(two(4, "2")).toMatchObject({ fromPort: 4, toPort: 2 });
  });

  it("rejects a second claim on the same physical port of one device", () => {
    const cfg = normaliseConfig({
      devices: [
        { id: "sw", type: "switch", name: "SW", x: 0, y: 0, config: {} },
        { id: "p1", type: "computer", name: "P1", x: 0, y: 100, config: {} },
        { id: "p2", type: "computer", name: "P2", x: 0, y: 200, config: {} },
      ],
      links: [{ from: "sw", to: "p1", fromPort: 3 }, { from: "sw", to: "p2", fromPort: 3 }],
    } as any);
    expect(cfg.links[0].fromPort).toBe(3);
    expect(cfg.links[1].fromPort).toBeUndefined();   // later claim auto-assigns instead of overwriting
  });
});

describe("normalise — LOW sweep", () => {
  it("trunk allow-lists keep only integer VLAN ids in range", () => {
    expect(normaliseTrunkAllowedVlans({ Ethernet1: [10, 1.5, "20", 5000, "x"] })).toEqual({ Ethernet1: [10, 20] });
  });
  it("a wireless association survives the config round-trip (SerialisedLink.wireless)", () => {
    const cfg = normaliseConfig({
      devices: [{ id: "l", type: "laptop", name: "L", x: 0, y: 0, config: {} }, { id: "ap", type: "access-point", name: "AP", x: 100, y: 0, config: {} }],
      links: [{ from: "l", to: "ap", wireless: true }],
    } as any);
    expect(cfg.links[0].wireless).toBe(true);
  });
});

// R77: the generated MAC's ordinal was the entry's array index alone. A reload
// compacts the array (empty entries are dropped), so a new interface could be
// given the ordinal a kept interface was created with — two interfaces of one
// router with the same MAC, one stored upper-case and one generated lower-case.
describe("router interface MACs stay unique after the array is compacted (R77)", () => {
  const macs = (ifaces: any[]) => ifaces.map(i => i.macAddress);

  it("a new interface never repeats a MAC a kept interface already carries", () => {
    // Three interfaces as first built: ordinals 1, 2, 3.
    const built = normaliseRouterInterfaces([{ peerId: "a" }, { peerId: "" }, { peerId: "c" }], "rtr-1");
    expect(built.map(i => i.peerId)).toEqual(["a", "c"]);            // the empty middle entry is dropped
    const kept = built.map(i => ({ ...i }));                          // "c" keeps the MAC with ordinal 3
    // A reload, then a new cable: the new entry lands at index 2 — ordinal 3 again.
    const after = normaliseRouterInterfaces([...kept, { peerId: "d" }], "rtr-1");
    expect(new Set(macs(after)).size).toBe(3);
    expect(macs(after).slice(0, 2)).toEqual(macs(kept));              // kept MACs are untouched
  });

  it("generated MACs are upper-case, like every stored MAC", () => {
    const result = normaliseRouterInterfaces([{ peerId: "a" }, { peerId: "b" }], "router-with-letters-abcdef");
    for (const mac of macs(result)) expect(mac).toBe(mac.toUpperCase());
    expect(macs(result).every(m => /^02(:[0-9A-F]{2}){5}$/.test(m))).toBe(true);
  });

  it("a supplied lower-case MAC is recognised as taken", () => {
    const first = normaliseRouterInterfaces([{ peerId: "a" }, { peerId: "b" }], "rtr-1");
    const lower = first[1].macAddress.toLowerCase();
    // Entry 0 has lost its MAC; entry 1 still carries its own, typed in lower case.
    const result = normaliseRouterInterfaces([{ peerId: "x" }, { peerId: "b", macAddress: lower }, { peerId: "y" }], "rtr-1");
    expect(new Set(macs(result)).size).toBe(3);
    expect(result[1].macAddress).toBe(first[1].macAddress);
  });

  it("a freshly built router still numbers its interfaces in order", () => {
    const result = normaliseRouterInterfaces([{ peerId: "a" }, { peerId: "b" }, { peerId: "c" }], "rtr-1");
    expect(macs(result).map(m => m.split(":")[4])).toEqual(["01", "02", "03"]);
    expect(normaliseRouterInterfaces(result, "rtr-1").map(i => i.macAddress)).toEqual(macs(result));   // stable on re-normalise
  });
});
