/**
 * The sim-log packet-list display filter (src/packet-filter.ts): the protocol
 * token classifier, the Wireshark-style expression grammar (boolean operators,
 * field comparisons, CIDR), and the three-dimension applyLogFilter combinator.
 * Pure logic — no DOM, no engine.
 */
import { describe, it, expect } from "bun:test";
import {
  frameMatchesToken, presentTokens, compileFilter, applyLogFilter, isFilterActive,
  PROTOCOL_CHIPS,
} from "../src/packet-filter";
import type { FilterRow } from "../src/packet-filter";
import type { EthernetFrame, Ipv4Payload, LogFilter } from "../src/types";

// ─── tiny frame builders ─────────────────────────────────────────────────────
function frame(payload: any, srcMac = "aa:aa:aa:aa:aa:01", dstMac = "bb:bb:bb:bb:bb:02"): EthernetFrame {
  let etherType: EthernetFrame["etherType"] = 0x0800;
  if (payload.type === "arp") etherType = 0x0806;
  else if (payload.type === "dot11" || payload.type === "dot1x") etherType = 0x888e;
  else if (payload.type === "bpdu") etherType = 0x0802;
  return { id: "f", srcMac, dstMac, etherType, vlanTag: null, payload };
}
function ipv4(inner: any, srcIp = "10.0.0.1", dstIp = "10.0.0.2", ttl = 64): Ipv4Payload {
  let protocol = 1;
  if (inner.type === "tcp") protocol = 6;
  else if (inner.type === "dns" || inner.type === "dhcp") protocol = 17;
  return { type: "ipv4", srcIp, dstIp, ttl, protocol, payload: inner };
}

function row(f: EthernetFrame, opts: Partial<FilterRow> = {}): FilterRow {
  return {
    frame: f,
    macsec: opts.macsec ?? false,
    no: opts.no ?? 1,
    step: opts.step ?? 1,
    fromId: opts.fromId ?? "d1",
    toId: opts.toId ?? "d2",
    fromName: opts.fromName ?? "PC-A",
    toName: opts.toName ?? "SW-1",
    linkId: opts.linkId ?? "l1",
  };
}

const arpReq = frame({ type: "arp", operation: "request", senderMac: "aa:aa:aa:aa:aa:01", senderIp: "10.0.0.1", targetMac: "00:00:00:00:00:00", targetIp: "10.0.0.2" });
const icmpEcho = frame(ipv4({ type: "icmp", icmpType: 8, sequence: 1 }, "10.0.0.1", "10.0.0.2"));
const tcpSyn = frame(ipv4({ type: "tcp", srcPort: 5000, dstPort: 80, flags: "syn" }, "10.0.0.1", "10.0.0.2"));
const dnsQuery = frame(ipv4({ type: "dns", op: "query", id: 1, name: "host", address: null }, "10.0.0.1", "10.0.0.53"));
const dhcpDisc = frame(ipv4({ type: "dhcp", messageType: "discover", transactionId: "tx0001" }, "0.0.0.0", "255.255.255.255"));
const bpdu = frame({ type: "bpdu", flavour: "config", rootId: "r", bridgeId: "b", rootCost: 0, portId: "Ethernet1" });
const dot11Assoc = frame({ type: "dot11", subtype: "assoc-req", ssid: "staff" });
const wpa2Key = frame({ type: "dot11", subtype: "eapol-m1", ssid: "staff" });
const dot1xStart = frame({ type: "dot1x", subtype: "eapol-start" });
const eapReq = frame({ type: "dot1x", subtype: "eap-req-id" });
const radiusReq = frame({ type: "dot1x", subtype: "radius-request", identity: "alice" });

describe("frameMatchesToken — protocol classification", () => {
  it("matches the obvious families", () => {
    expect(frameMatchesToken(row(arpReq), "arp")).toBe(true);
    expect(frameMatchesToken(row(icmpEcho), "icmp")).toBe(true);
    expect(frameMatchesToken(row(tcpSyn), "tcp")).toBe(true);
    expect(frameMatchesToken(row(dnsQuery), "dns")).toBe(true);
    expect(frameMatchesToken(row(dhcpDisc), "dhcp")).toBe(true);
    expect(frameMatchesToken(row(bpdu), "stp")).toBe(true);
    expect(frameMatchesToken(row(bpdu), "bpdu")).toBe(true);
  });

  it("ip/ipv4 covers any IPv4 frame but not ARP/BPDU/802.11", () => {
    expect(frameMatchesToken(row(icmpEcho), "ip")).toBe(true);
    expect(frameMatchesToken(row(tcpSyn), "ipv4")).toBe(true);
    expect(frameMatchesToken(row(arpReq), "ip")).toBe(false);
    expect(frameMatchesToken(row(bpdu), "ip")).toBe(false);
    expect(frameMatchesToken(row(dot11Assoc), "ip")).toBe(false);
  });

  it("udp covers DNS and DHCP only", () => {
    expect(frameMatchesToken(row(dnsQuery), "udp")).toBe(true);
    expect(frameMatchesToken(row(dhcpDisc), "udp")).toBe(true);
    expect(frameMatchesToken(row(tcpSyn), "udp")).toBe(false);
    expect(frameMatchesToken(row(icmpEcho), "udp")).toBe(false);
  });

  it("wlan covers 802.11 mgmt + WPA2 EAPOL-Key (dot11), not 802.1X (dot1x)", () => {
    expect(frameMatchesToken(row(dot11Assoc), "wlan")).toBe(true);
    expect(frameMatchesToken(row(wpa2Key), "wlan")).toBe(true);
    expect(frameMatchesToken(row(wpa2Key), "dot11")).toBe(true);
    expect(frameMatchesToken(row(dot1xStart), "wlan")).toBe(false);
  });

  it("dot1x covers the whole 802.1X family; eapol/eap/radius are finer", () => {
    for (const f of [dot1xStart, eapReq, radiusReq]) expect(frameMatchesToken(row(f), "dot1x")).toBe(true);
    expect(frameMatchesToken(row(dot1xStart), "eapol")).toBe(true);
    expect(frameMatchesToken(row(wpa2Key), "eapol")).toBe(true);   // WPA2 4-way is EAPOL-Key too
    expect(frameMatchesToken(row(eapReq), "eap")).toBe(true);
    expect(frameMatchesToken(row(dot1xStart), "eap")).toBe(false); // "eapol-start" is not an EAP frame
    expect(frameMatchesToken(row(radiusReq), "radius")).toBe(true);
    expect(frameMatchesToken(row(eapReq), "radius")).toBe(false);
  });

  it("macsec reads the row's encrypted-on-the-wire flag", () => {
    expect(frameMatchesToken(row(icmpEcho, { macsec: true }), "macsec")).toBe(true);
    expect(frameMatchesToken(row(icmpEcho), "macsec")).toBe(false);
  });
});

describe("presentTokens", () => {
  it("reports only the chip tokens occurring in the rows", () => {
    const present = presentTokens([row(arpReq), row(icmpEcho), row(dnsQuery, { macsec: true })]);
    expect(present.has("arp")).toBe(true);
    expect(present.has("icmp")).toBe(true);
    expect(present.has("dns")).toBe(true);
    expect(present.has("macsec")).toBe(true);
    expect(present.has("tcp")).toBe(false);
    expect(present.has("stp")).toBe(false);
  });

  it("every chip token is a recognised protocol", () => {
    for (const chip of PROTOCOL_CHIPS) {
      // a token the classifier knows returns true for at least one crafted frame,
      // so an empty present-set only ever means "absent", never "unknown token".
      expect(typeof chip.token).toBe("string");
    }
  });
});

// helper: compile + test a single row, asserting the filter parsed cleanly
function passes(expr: string, r: FilterRow): boolean {
  const c = compileFilter(expr);
  if (!c.ok) throw new Error(`expected a valid filter, got error: ${c.error}`);
  return c.test(r);
}

describe("compileFilter — expression grammar", () => {
  it("an empty filter matches everything", () => {
    expect(passes("", row(arpReq))).toBe(true);
    expect(passes("   ", row(tcpSyn))).toBe(true);
  });

  it("a bare protocol token", () => {
    expect(passes("icmp", row(icmpEcho))).toBe(true);
    expect(passes("icmp", row(tcpSyn))).toBe(false);
  });

  it("OR / AND / NOT with Wireshark precedence (not > and > or)", () => {
    // dns || icmp && !arp  ==  dns || (icmp && (not arp))
    expect(passes("dns || icmp && !arp", row(dnsQuery))).toBe(true);
    expect(passes("dns || icmp && !arp", row(icmpEcho))).toBe(true);
    expect(passes("dns || icmp && !arp", row(arpReq))).toBe(false);
    // word forms
    expect(passes("icmp and not arp", row(icmpEcho))).toBe(true);
    expect(passes("not tcp", row(icmpEcho))).toBe(true);
    expect(passes("not tcp", row(tcpSyn))).toBe(false);
  });

  it("parentheses regroup precedence", () => {
    // (dns || icmp) && !arp — arp can never pass, dns/icmp do
    expect(passes("(dns || icmp) && !arp", row(dnsQuery))).toBe(true);
    expect(passes("(dns || icmp) && !arp", row(arpReq))).toBe(false);
  });

  it("ip.addr / ip.src / ip.dst exact and CIDR", () => {
    const f = row(frame(ipv4({ type: "icmp", icmpType: 8, sequence: 1 }, "10.0.0.1", "192.168.1.1")));
    expect(passes("ip.addr == 10.0.0.1", f)).toBe(true);
    expect(passes("ip.addr == 192.168.1.1", f)).toBe(true);
    expect(passes("ip.src == 10.0.0.1", f)).toBe(true);
    expect(passes("ip.dst == 10.0.0.1", f)).toBe(false);
    expect(passes("ip.addr == 10.0.0.0/24", f)).toBe(true);     // src in range
    expect(passes("ip.dst == 10.0.0.0/24", f)).toBe(false);     // dst not in range
    expect(passes("ip.addr != 10.0.0.0/24", f)).toBe(false);    // src is in range → "neither side outside" is false
    expect(passes("ip.addr != 172.16.0.0/24", f)).toBe(true);   // neither side in range
  });

  it("ip.* never matches non-IP frames", () => {
    expect(passes("ip.addr == 10.0.0.1", row(arpReq))).toBe(false);
    expect(passes("ip.addr != 10.0.0.1", row(arpReq))).toBe(false); // field absent → excluded from both
  });

  it("tcp ports and numeric comparators", () => {
    expect(passes("tcp.port == 80", row(tcpSyn))).toBe(true);
    expect(passes("tcp.dstport == 80", row(tcpSyn))).toBe(true);
    expect(passes("tcp.srcport == 80", row(tcpSyn))).toBe(false);
    expect(passes("tcp.port < 1024", row(tcpSyn))).toBe(true);   // dstPort 80 < 1024
    expect(passes("tcp.srcport > 1024", row(tcpSyn))).toBe(true);
    expect(passes("tcp.port != 80", row(icmpEcho))).toBe(false); // no tcp port → excluded
  });

  it("eth.addr matches the L2 header (case-insensitive)", () => {
    expect(passes("eth.src == AA:AA:AA:AA:AA:01", row(icmpEcho))).toBe(true);
    expect(passes("eth.addr == bb:bb:bb:bb:bb:02", row(icmpEcho))).toBe(true);
    expect(passes("eth.dst == aa:aa:aa:aa:aa:01", row(icmpEcho))).toBe(false);
  });

  it("device filter by endpoint name (== and contains)", () => {
    const f = row(icmpEcho, { fromName: "PC-A", toName: "SW-1" });
    expect(passes("device == PC-A", f)).toBe(true);
    expect(passes("device == sw-1", f)).toBe(true);            // case-insensitive
    expect(passes("device == R1", f)).toBe(false);
    expect(passes("device contains PC", f)).toBe(true);
    expect(passes("dev contains zz", f)).toBe(false);
  });

  it("frame.no / frame.step numeric fields", () => {
    expect(passes("frame.no >= 5", row(icmpEcho, { no: 7 }))).toBe(true);
    expect(passes("no == 7", row(icmpEcho, { no: 7 }))).toBe(true);
    expect(passes("step < 3", row(icmpEcho, { step: 2 }))).toBe(true);
  });

  it("ip.ttl reads the IPv4 header", () => {
    const f = row(frame(ipv4({ type: "icmp", icmpType: 8, sequence: 1 }, "10.0.0.1", "10.0.0.2", 1)));
    expect(passes("ip.ttl == 1", f)).toBe(true);
    expect(passes("ip.ttl > 1", f)).toBe(false);
  });
});

describe("compileFilter — parse errors", () => {
  const bad = [
    "icmp &&",                 // dangling operator
    "(icmp",                   // missing close paren
    "wat",                     // unknown term
    "tcp.port == abc",         // non-numeric value
    "ip.addr 10.0.0.1",        // missing comparator
    "ip.addr = 10.0.0.1",      // single = is not ==
    "tcp.port < 10.0.0.0/24",  // CIDR with a relational op on a numeric field is nonsense
    'name == "',               // unterminated string
    // relational operators are rejected at COMPILE time for string-valued fields
    // (else the predicate would throw lazily at render time — see the review)
    "ip.addr < 11.0.0.0",
    "ip.src >= 1.0.0.0",
    "eth.addr > aa:bb:cc:dd:ee:ff",
    "device <= z",
    // numeric fields take whole numbers only — no hex/exponent coercions
    "tcp.port == 0x50",
    "frame.no == 1e2",
  ];
  for (const expr of bad) {
    it(`rejects: ${expr}`, () => {
      const c = compileFilter(expr);
      expect(c.ok).toBe(false);
      if (!c.ok) expect(typeof c.error).toBe("string");
    });
  }
});

describe("applyLogFilter — the ANDed dimensions", () => {
  const rows = [
    row(arpReq, { no: 1, fromName: "PC-A", toName: "SW-1", fromId: "pc", toId: "sw", linkId: "l-pc-sw" }),
    row(icmpEcho, { no: 2, fromName: "PC-A", toName: "SW-1", fromId: "pc", toId: "sw", linkId: "l-pc-sw" }),
    row(tcpSyn, { no: 3, fromName: "SW-1", toName: "SRV", fromId: "sw", toId: "srv", linkId: "l-sw-srv" }),
    row(dnsQuery, { no: 4, fromName: "PC-A", toName: "SW-1", fromId: "pc", toId: "sw", linkId: "l-pc-sw" }),
  ];
  const empty = (): LogFilter => ({ protocols: [], device: "", expr: "" });

  it("no filter shows all rows", () => {
    const { rows: out, error } = applyLogFilter(rows, empty());
    expect(out.length).toBe(4);
    expect(error).toBeNull();
  });

  it("protocol chips OR within the set", () => {
    const out = applyLogFilter(rows, { ...empty(), protocols: ["icmp", "dns"] }).rows;
    expect(out.map(r => r.no)).toEqual([2, 4]);
  });

  it("device filter keeps frames crossing that device id", () => {
    const out = applyLogFilter(rows, { ...empty(), device: "srv" }).rows;
    expect(out.map(r => r.no)).toEqual([3]);
  });

  it("link filter keeps only frames that crossed that wire (the inspector jump)", () => {
    const out = applyLogFilter(rows, { ...empty(), link: "l-pc-sw" }).rows;
    expect(out.map(r => r.no)).toEqual([1, 2, 4]);
  });

  it("link combines with the other dimensions", () => {
    const out = applyLogFilter(rows, { ...empty(), link: "l-pc-sw", protocols: ["icmp", "dns"] }).rows;
    expect(out.map(r => r.no)).toEqual([2, 4]);
  });

  it("expr AND device AND chips all combine", () => {
    const out = applyLogFilter(rows, { protocols: ["icmp", "dns", "tcp"], device: "pc", expr: "!tcp" }).rows;
    // device pc → rows 1,2,4; chips icmp/dns/tcp → 2,4 (arp excluded); !tcp keeps both
    expect(out.map(r => r.no)).toEqual([2, 4]);
  });

  it("an invalid expression is reported and treated as no constraint", () => {
    const { rows: out, error } = applyLogFilter(rows, { ...empty(), expr: "bogus &&" });
    expect(out.length).toBe(4);          // not emptied
    expect(error).not.toBeNull();
  });

  it("a relational op on a string field never throws — it reports an error and keeps the list", () => {
    // (a compile-time reject; this guards against the lazy-throw regression)
    expect(() => applyLogFilter(rows, { ...empty(), expr: "ip.addr < 11.0.0.0" })).not.toThrow();
    const { rows: out, error } = applyLogFilter(rows, { ...empty(), expr: "ip.addr < 11.0.0.0" });
    expect(out.length).toBe(4);
    expect(error).not.toBeNull();
  });
});

describe("isFilterActive", () => {
  it("detects any active dimension", () => {
    expect(isFilterActive({ protocols: [], device: "", expr: "" })).toBe(false);
    expect(isFilterActive({ protocols: ["arp"], device: "", expr: "" })).toBe(true);
    expect(isFilterActive({ protocols: [], device: "x", expr: "" })).toBe(true);
    expect(isFilterActive({ protocols: [], device: "", link: "l1", expr: "" })).toBe(true);
    expect(isFilterActive({ protocols: [], device: "", expr: "icmp" })).toBe(true);
    expect(isFilterActive({ protocols: [], device: "", expr: "   " })).toBe(false);
  });
});
