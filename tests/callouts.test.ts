/**
 * Packet callouts (GitHub issue #2) — the field content and the rewrite diff.
 * The drawing itself is canvas work (no 2D context in tests); this pins what the
 * callout says and which fields it flags as rewritten at a hop.
 */
import { describe, it, expect } from "bun:test";
import { frameCalloutLines, shortMac, createArpRequest, createArpReply, createIcmpEchoRequest, createTcpSegment } from "../src/frame";
import type { CalloutToken } from "../src/frame";

// The plain text of a line, and the set of its tokens flagged `changed`.
const text = (line: CalloutToken[]) => line.map(t => t.t).join("");
const changed = (lines: CalloutToken[][]) =>
  lines.flat().filter(t => t.changed).map(t => t.t);

describe("callout content", () => {
  it("ARP request shows who-has the target", () => {
    const f = createArpRequest("aa:bb:cc:dd:ee:01", "10.0.0.1", "10.0.0.9");
    const lines = frameCalloutLines(f);
    expect(text(lines[0])).toBe("who-has 10.0.0.9");
  });

  it("ARP reply shows the binding it advertises", () => {
    const f = createArpReply("aa:bb:cc:dd:ee:09", "10.0.0.9", "aa:bb:cc:dd:ee:01", "10.0.0.1");
    expect(text(frameCalloutLines(f)[0])).toBe("10.0.0.9 is-at …ee:09");
  });

  it("an IPv4/ICMP frame shows src → dst and the MAC pair", () => {
    const f = createIcmpEchoRequest("aa:bb:cc:dd:ee:01", "aa:bb:cc:dd:ee:02", "10.0.0.1", "10.0.0.9", 64);
    const lines = frameCalloutLines(f);
    expect(text(lines[0])).toBe("10.0.0.1 → 10.0.0.9");
    expect(text(lines[lines.length - 1])).toBe("…ee:01 ▸ …ee:02");
  });

  it("a TCP frame shows the flags and ports", () => {
    const f = createTcpSegment("aa:bb:cc:dd:ee:01", "aa:bb:cc:dd:ee:02", "10.0.0.1", "10.0.0.9", 51000, 22, "syn");
    const lines = frameCalloutLines(f);
    expect(text(lines[1])).toContain("SYN");
    expect(text(lines[1])).toContain(":22");
  });
});

describe("the rewrite diff flashes what the hop changed", () => {
  it("a router hop rewrites the MAC pair but not the IP pair", () => {
    const received = createIcmpEchoRequest("aa:bb:cc:dd:ee:01", "aa:bb:cc:dd:ee:02", "10.0.0.1", "192.168.1.9", 64);
    // The router forwarded it: new src/dst MAC, same IPs.
    const forwarded = createIcmpEchoRequest("aa:bb:cc:dd:ee:02", "aa:bb:cc:dd:ee:09", "10.0.0.1", "192.168.1.9", 63);
    const flagged = changed(frameCalloutLines(forwarded, received));
    expect(flagged).toContain(shortMac("aa:bb:cc:dd:ee:02"));
    expect(flagged).toContain(shortMac("aa:bb:cc:dd:ee:09"));
    expect(flagged).not.toContain("10.0.0.1");
    expect(flagged).not.toContain("192.168.1.9");
  });

  it("a NAT hop rewrites the source address, not the destination", () => {
    const received = createIcmpEchoRequest("aa:bb:cc:dd:ee:01", "aa:bb:cc:dd:ee:02", "192.168.1.5", "8.8.8.8", 64);
    const natted = createIcmpEchoRequest("aa:bb:cc:dd:ee:02", "aa:bb:cc:dd:ee:03", "203.0.113.1", "8.8.8.8", 63);
    const lines = frameCalloutLines(natted, received);
    const netLine = lines[0];
    expect(netLine.find(t => t.t === "203.0.113.1")?.changed).toBe(true);   // the rewritten source
    expect(netLine.find(t => t.t === "8.8.8.8")?.changed).toBeFalsy();      // the untouched destination
  });

  it("the first leg (no previous frame) flags nothing", () => {
    const f = createIcmpEchoRequest("aa:bb:cc:dd:ee:01", "aa:bb:cc:dd:ee:02", "10.0.0.1", "10.0.0.9", 64);
    expect(changed(frameCalloutLines(f, undefined))).toEqual([]);
  });

  it("a TCP destination port rewritten by DNAT is flagged", () => {
    const received = createTcpSegment("aa:bb:cc:dd:ee:01", "aa:bb:cc:dd:ee:02", "10.0.0.1", "203.0.113.1", 51000, 8080, "syn");
    const dnatted = createTcpSegment("aa:bb:cc:dd:ee:02", "aa:bb:cc:dd:ee:03", "10.0.0.1", "192.168.1.9", 51000, 80, "syn");
    const flagged = changed(frameCalloutLines(dnatted, received));
    expect(flagged).toContain(":80");
  });
});
