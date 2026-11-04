import { describe, it, expect } from "bun:test";
import {
  isValidIpv4, ipv4ToInt, intToIpv4,
  sameSubnet, networkOf, cidrContains, prefixLengthOfCidr, clampPrefixLength, prefixOf,
  parseIpv4, parseCidr, cachedCidr, cidrHas, cidrOf, cidrText,
  internetGatewayIp,
  normaliseMacAddress, isValidMac,
  clampPortCount, clampRouterPortCount, clampApPortCount,
  parseIpv4Token, normaliseVlanId,
  escapeHtml, isValidHostname, normaliseSsid, truncateOctets } from "../src/utils";

// ── Hostnames ─────────────────────────────────────────────────────────────────

describe("isValidHostname", () => {
  it("accepts RFC-1123 labels", () => {
    for (const h of ["pc1", "web-01", "PC-A", "Core-SW", "a", "host123"]) expect(isValidHostname(h)).toBe(true);
  });
  it("rejects empty, spaces, underscores, dots, and leading/trailing hyphens", () => {
    for (const h of ["", "bad name", "_nope", "a.b", "-x", "x-", "pc!"]) expect(isValidHostname(h)).toBe(false);
  });
  it("rejects labels longer than 63 characters", () => {
    expect(isValidHostname("a".repeat(63))).toBe(true);
    expect(isValidHostname("a".repeat(64))).toBe(false);
  });
});

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

describe("subnet prefix maths", () => {
  it("networkOf normalises an address to its CIDR network", () => {
    expect(networkOf("192.168.1.42", 24)).toBe("192.168.1.0/24");
    expect(networkOf("10.1.2.3", 16)).toBe("10.1.0.0/16");
    expect(networkOf("192.168.1.6", 30)).toBe("192.168.1.4/30");
    expect(networkOf("10.0.0.1", 8)).toBe("10.0.0.0/8");
  });

  it("sameSubnet honours the prefix length", () => {
    expect(sameSubnet("192.168.1.10", "192.168.1.20", 24)).toBe(true);
    expect(sameSubnet("192.168.1.10", "192.168.2.10", 24)).toBe(false);
    expect(sameSubnet("10.0.1.5", "10.0.2.5", 16)).toBe(true);   // same /16, different /24
    expect(sameSubnet("192.168.1.1", "192.168.1.5", 30)).toBe(false); // different /30 blocks
    expect(sameSubnet("1.2.3.4", "200.1.1.1", 0)).toBe(true);    // /0 matches everything
  });

  it("sameSubnet returns false for invalid IPs", () => {
    expect(sameSubnet("", "192.168.1.1", 24)).toBe(false);
    expect(sameSubnet("192.168.1.1", "", 24)).toBe(false);
  });

  it("cidrContains and prefixLengthOfCidr parse CIDR strings", () => {
    expect(cidrContains("192.168.1.0/24", "192.168.1.99")).toBe(true);
    expect(cidrContains("192.168.1.0/24", "192.168.2.1")).toBe(false);
    expect(cidrContains("10.0.0.0/8", "10.200.1.1")).toBe(true);
    expect(cidrContains("192.168.1.10", "192.168.1.99")).toBe(true); // bare IP → /24
    expect(prefixLengthOfCidr("10.0.0.0/16")).toBe(16);
    expect(prefixLengthOfCidr("10.0.0.0")).toBe(24);
  });

  it("clampPrefixLength and prefixOf default to /24", () => {
    expect(clampPrefixLength(undefined)).toBe(24);
    expect(clampPrefixLength(33)).toBe(24);
    expect(clampPrefixLength(-1)).toBe(24);
    expect(clampPrefixLength(16)).toBe(16);
    expect(prefixOf({ prefixLength: 30 })).toBe(30);
    expect(prefixOf({})).toBe(24);
    expect(prefixOf(null)).toBe(24);
  });

  it("intToIpv4 round-trips with ipv4ToInt", () => {
    expect(intToIpv4(ipv4ToInt("203.0.113.7"))).toBe("203.0.113.7");
  });
});

// ── Integer CIDR (the routing/RIP/firewall hot path) ──────────────────────────

// The string-based rules the integer helpers replaced, kept verbatim as the
// reference: the integer path must agree with them on every input.
function referenceIsValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every(part => {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (part.length > 1 && part.startsWith("0")) return false;
    const octet = Number(part);
    return octet >= 0 && octet <= 255;
  });
}
// A local seeded generator (mulberry32) for the fuzz corpora — deterministic,
// and it leaves the engine's shared simulation PRNG untouched.
function seededPick(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}
function referenceCidrContains(cidr: string, ip: string): boolean {
  const slash = cidr.indexOf("/");
  const net = slash >= 0 ? cidr.slice(0, slash) : cidr;
  if (!referenceIsValidIpv4(net) || !referenceIsValidIpv4(ip)) return false;
  const len = slash >= 0 ? clampPrefixLength(Number(cidr.slice(slash + 1))) : 24;
  const mask = len <= 0 ? 0 : (~0 << (32 - len)) >>> 0;
  return (ipv4ToInt(net) & mask) === (ipv4ToInt(ip) & mask);
}

describe("parseIpv4", () => {
  it("parses a dotted quad to its unsigned value", () => {
    expect(parseIpv4("0.0.0.0")).toBe(0);
    expect(parseIpv4("192.168.1.1")).toBe(3232235777);
    expect(parseIpv4("255.255.255.255")).toBe(4294967295);   // unsigned, not -1
  });

  it("returns null for exactly what isValidIpv4 rejects", () => {
    for (const bad of ["", "abc", "1.2.3", "1.2.3.4.5", "1.2.3.4.", ".1.2.3.4", "1..2.3", "256.0.0.1",
      "01.2.3.4", "1.2.3.00", "1.2.3.1000", " 1.2.3.4", "1.2.3.4 ", "1.2.3.-4", "1.2.3.4/24", "１.2.3.4"]) {
      expect(parseIpv4(bad)).toBeNull();
      expect(isValidIpv4(bad)).toBe(false);
    }
    expect(parseIpv4(undefined as unknown as string)).toBeNull();
  });

  it("agrees with the string rules on a seeded fuzz corpus", () => {
    const pick = seededPick(1);
    const alphabet = "0123456789.0123456789./ x-";
    for (let i = 0; i < 20000; i++) {
      let s = "";
      if (pick(2) === 0) {
        s = [0, 0, 0, 0].map(() => String(pick(4) === 0 ? pick(400) : pick(256))).join(".");
        if (pick(5) === 0) s = s.replace(".", ".0");
      } else {
        for (let k = pick(18); k > 0; k--) s += alphabet[pick(alphabet.length)];
      }
      expect(isValidIpv4(s)).toBe(referenceIsValidIpv4(s));
      expect(parseIpv4(s)).toBe(referenceIsValidIpv4(s) ? ipv4ToInt(s) : null);
    }
  });
});

describe("parseCidr / cidrHas", () => {
  it("parses network, mask, and prefix — the network already masked", () => {
    expect(parseCidr("10.1.2.3/16")).toEqual({ net: parseIpv4("10.1.0.0")!, mask: 0xffff0000, prefix: 16 });
    expect(parseCidr("0.0.0.0/0")).toEqual({ net: 0, mask: 0, prefix: 0 });
    expect(parseCidr("192.168.1.7/32")).toEqual({ net: parseIpv4("192.168.1.7")!, mask: 0xffffffff, prefix: 32 });
  });

  it("follows cidrContains's rules: bare IP = /24, bad length = /24, bad address = null", () => {
    expect(parseCidr("192.168.1.10")!.prefix).toBe(24);
    expect(parseCidr("10.0.0.0/33")!.prefix).toBe(24);
    expect(parseCidr("10.0.0.0/abc")!.prefix).toBe(24);
    expect(parseCidr("bogus")).toBeNull();
    expect(parseCidr("10.0.0.256/8")).toBeNull();
    expect(parseCidr("")).toBeNull();
  });

  it("cidrHas is cidrContains over integers", () => {
    const c = parseCidr("172.16.0.0/12")!;
    expect(cidrHas(c, parseIpv4("172.31.255.255")!)).toBe(true);
    expect(cidrHas(c, parseIpv4("172.32.0.0")!)).toBe(false);
    expect(cidrHas(parseCidr("0.0.0.0/0")!, parseIpv4("203.0.113.9")!)).toBe(true);
    expect(cidrHas(parseCidr("255.255.255.0/24")!, parseIpv4("255.255.255.200")!)).toBe(true);   // high-bit network
  });

  it("cidrContains agrees with the string implementation on a seeded fuzz corpus", () => {
    const pick = seededPick(2);
    const octet = () => String(pick(3) === 0 ? pick(300) : pick(3) * 10);
    const quad = () => [octet(), octet(), octet(), octet()].join(".");
    const lengths = ["", "/", "/0", "/8", "/16", "/24", "/30", "/32", "/33", "/-1", "/x", "/ 16", "/1e1", "/0x8"];
    for (let i = 0; i < 20000; i++) {
      const cidr = quad() + lengths[pick(lengths.length)];
      const ip = pick(10) === 0 ? "1.2.3" : quad();
      expect(cidrContains(cidr, ip)).toBe(referenceCidrContains(cidr, ip));
    }
  });

  it("cidrOf / cidrText build and print the canonical network (networkOf's format)", () => {
    expect(cidrText(cidrOf(parseIpv4("192.168.1.6")!, 30))).toBe("192.168.1.4/30");
    expect(cidrText(cidrOf(parseIpv4("10.9.8.7")!, 8))).toBe(networkOf("10.9.8.7", 8));
    expect(cidrOf(parseIpv4("10.0.0.1")!, 99).prefix).toBe(24);   // clamped like every prefix
  });

  it("cachedCidr hands back one shared parse per CIDR text", () => {
    const a = cachedCidr("10.20.0.0/16");
    expect(a).toEqual(parseCidr("10.20.0.0/16"));
    expect(cachedCidr("10.20.0.0/16")).toBe(a);   // same object — no per-lookup allocation
    expect(cachedCidr("not-a-cidr")).toBeNull();
    expect(cachedCidr("not-a-cidr")).toBeNull();  // a cached miss stays a miss
  });

  it("internetGatewayIp validates and converts the router address in one parse", () => {
    expect(internetGatewayIp("203.0.113.1", 24)).toBe("203.0.113.254");
    expect(internetGatewayIp("203.0.113.254", 24)).toBe("203.0.113.253");   // never the router itself
    expect(internetGatewayIp("198.51.100.1", 30)).toBe("198.51.100.2");     // the other usable /30 host
    expect(internetGatewayIp("255.255.255.1", 24)).toBe("255.255.255.254"); // high-bit addresses stay unsigned
    expect(internetGatewayIp("10.0.0.1", 31)).toBeNull();                  // no spare host
    for (const bad of ["", "10.0.0", "10.0.0.256", "10.0.0.01", "10.0.0.1 "]) {
      expect(internetGatewayIp(bad, 24)).toBeNull();
    }
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

describe("clampApPortCount", () => {
  it("defaults a single wired uplink (1), clamping below 1 up", () => {
    expect(clampApPortCount(undefined)).toBe(1);
    expect(clampApPortCount(0)).toBe(1);
    expect(clampApPortCount(1)).toBe(1);
  });

  it("allows up to 4 LAN ports and clamps above", () => {
    expect(clampApPortCount(4)).toBe(4);
    expect(clampApPortCount(8)).toBe(4);
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

  it("accepts the /0 and /32 prefix bounds", () => {
    expect(parseIpv4Token("10.0.0.0/0")!.prefixLength).toBe(0);
    expect(parseIpv4Token("10.0.0.0/32")!.prefixLength).toBe(32);
  });

  it("rejects out-of-range and leading-zero prefixes", () => {
    expect(parseIpv4Token("10.0.0.0/33")).toBeNull();
    expect(parseIpv4Token("10.0.0.0/01")).toBeNull(); // leading zero
    expect(parseIpv4Token("10.0.0.0/00")).toBeNull();
  });
});

// ── escapeHtml ────────────────────────────────────────────────────────────────

describe("escapeHtml", () => {
  it("escapes HTML special characters", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml('"hello"')).toBe("&quot;hello&quot;");
  });

  it("escapes the apostrophe (so single-quoted attributes can't break out)", () => {
    expect(escapeHtml("x' onmouseover='alert(1)")).toBe("x&#39; onmouseover=&#39;alert(1)");
  });

  it("returns plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("normaliseSsid caps by OCTETS (802.11: 32 bytes), keeping whole code points", () => {
  it("ASCII: 32 characters", () => { expect(normaliseSsid("a".repeat(40))).toHaveLength(32); });
  it("2-byte characters: 16 of them", () => { expect(normaliseSsid("é".repeat(20))).toBe("é".repeat(16)); });
  it("4-byte emoji: 8 of them, never a split surrogate", () => { expect(normaliseSsid("😀".repeat(10))).toBe("😀".repeat(8)); });
  it("truncateOctets is the general helper", () => { expect(truncateOctets("héllo", 2)).toBe("h"); expect(truncateOctets("héllo", 3)).toBe("hé"); });
});
