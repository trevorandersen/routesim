import { describe, it, expect } from "bun:test";
import {
  isValidIpv4, ipv4Network24, ipv4ToInt, sameSubnet24,
  normaliseMacAddress, isValidMac,
  clampPortCount, clampRouterPortCount,
  parseIpv4Token, normaliseVlanId,
  escapeHtml,
} from "../src/utils";

// ── IPv4 ──────────────────────────────────────────────────────────────────────

describe("isValidIpv4", () => {
  it("accepts valid addresses", () => {
    expect(isValidIpv4("192.168.1.1")).toBe(true);
    expect(isValidIpv4("10.0.0.1")).toBe(true);
    expect(isValidIpv4("0.0.0.0")).toBe(true);
    expect(isValidIpv4("255.255.255.255")).toBe(true);
  });

  it("rejects invalid formats", () => {
    expect(isValidIpv4("")).toBe(false);
    expect(isValidIpv4("abc")).toBe(false);
    expect(isValidIpv4("1.2.3")).toBe(false);
    expect(isValidIpv4("1.2.3.4.5")).toBe(false);
  });

  it("rejects out-of-range octets", () => {
    expect(isValidIpv4("256.0.0.1")).toBe(false);
    expect(isValidIpv4("1.2.3.999")).toBe(false);
  });

  it("rejects leading zeros", () => {
    expect(isValidIpv4("01.2.3.4")).toBe(false);
  });
});

describe("ipv4Network24", () => {
  it("extracts /24 network address with CIDR notation", () => {
    expect(ipv4Network24("192.168.1.42")).toBe("192.168.1.0/24");
    expect(ipv4Network24("10.0.0.1")).toBe("10.0.0.0/24");
  });
});

describe("sameSubnet24", () => {
  it("returns true for same /24", () => {
    expect(sameSubnet24("192.168.1.10", "192.168.1.20")).toBe(true);
  });

  it("returns false for different /24", () => {
    expect(sameSubnet24("192.168.1.10", "192.168.2.10")).toBe(false);
    expect(sameSubnet24("10.0.0.1", "192.168.0.1")).toBe(false);
  });

  it("returns false for invalid IPs", () => {
    expect(sameSubnet24("", "192.168.1.1")).toBe(false);
    expect(sameSubnet24("192.168.1.1", "")).toBe(false);
  });
});

describe("ipv4ToInt", () => {
  it("converts IP to unsigned integer", () => {
    expect(ipv4ToInt("0.0.0.0")).toBe(0);
    expect(ipv4ToInt("0.0.0.1")).toBe(1);
    // Uses >>> 0 for unsigned, so high-bit IPs are positive
    expect(ipv4ToInt("192.168.1.1")).toBe(3232235777);
    expect(ipv4ToInt("255.255.255.255")).toBe(4294967295);
  });
});

// ── MAC ───────────────────────────────────────────────────────────────────────

describe("normaliseMacAddress", () => {
  it("uppercases a valid MAC", () => {
    expect(normaliseMacAddress("aa:bb:cc:dd:ee:ff")).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("passes through already-uppercase MAC", () => {
    expect(normaliseMacAddress("02:00:00:00:01:10")).toBe("02:00:00:00:01:10");
  });

  it("replaces dashes with colons", () => {
    expect(normaliseMacAddress("AA-BB-CC-DD-EE-FF")).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("returns empty string for empty input", () => {
    expect(normaliseMacAddress("")).toBe("");
  });
});

describe("isValidMac", () => {
  it("accepts valid MACs", () => {
    expect(isValidMac("02:00:00:00:01:10")).toBe(true);
    expect(isValidMac("FF:FF:FF:FF:FF:FF")).toBe(true);
  });

  it("rejects invalid MACs", () => {
    expect(isValidMac("")).toBe(false);
    expect(isValidMac("02:00:00")).toBe(false);
    expect(isValidMac("02:00:00:00:01:10:99")).toBe(false);
    expect(isValidMac("ZZ:ZZ:ZZ:ZZ:ZZ:ZZ")).toBe(false);
  });
});

// ── Port counts ───────────────────────────────────────────────────────────────

describe("clampPortCount", () => {
  it("returns value when in range", () => {
    expect(clampPortCount(8)).toBe(8);
    expect(clampPortCount(4)).toBe(4);
    expect(clampPortCount(24)).toBe(24);
  });

  it("clamps below minimum to 4", () => {
    expect(clampPortCount(1)).toBe(4);
    expect(clampPortCount(0)).toBe(4);
  });

  it("clamps above maximum to 24", () => {
    expect(clampPortCount(100)).toBe(24);
  });
});

describe("clampRouterPortCount", () => {
  it("allows zero ports", () => {
    expect(clampRouterPortCount(0)).toBe(0);
  });

  it("clamps above maximum to 12", () => {
    expect(clampRouterPortCount(20)).toBe(12);
  });
});

// ── VLAN ──────────────────────────────────────────────────────────────────────

describe("normaliseVlanId", () => {
  it("accepts valid VLAN IDs", () => {
    expect(normaliseVlanId(1)).toBe(1);
    expect(normaliseVlanId(10)).toBe(10);
    expect(normaliseVlanId(4094)).toBe(4094);
  });

  it("returns null for out-of-range", () => {
    expect(normaliseVlanId(0)).toBeNull();
    expect(normaliseVlanId(4095)).toBeNull();
    expect(normaliseVlanId(-1)).toBeNull();
  });

  it("returns null for non-numbers", () => {
    expect(normaliseVlanId("abc" as any)).toBeNull();
    expect(normaliseVlanId(undefined as any)).toBeNull();
  });
});

// ── parseIpv4Token ────────────────────────────────────────────────────────────

describe("parseIpv4Token", () => {
  it("parses IP/prefix format", () => {
    const result = parseIpv4Token("192.168.1.1/24");
    expect(result).not.toBeNull();
    expect(result!.address).toBe("192.168.1.1");
    expect(result!.prefixLength).toBe(24);
  });

  it("parses bare IP", () => {
    const result = parseIpv4Token("10.0.0.1");
    expect(result).not.toBeNull();
    expect(result!.address).toBe("10.0.0.1");
    expect(result!.prefixLength).toBeNull();
  });

  it("returns null for invalid", () => {
    expect(parseIpv4Token("garbage")).toBeNull();
    expect(parseIpv4Token("")).toBeNull();
  });
});

// ── escapeHtml ────────────────────────────────────────────────────────────────

describe("escapeHtml", () => {
  it("escapes HTML special characters", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml('"hello"')).toBe("&quot;hello&quot;");
  });

  it("returns plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});
