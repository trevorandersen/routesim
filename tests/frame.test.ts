import { describe, it, expect } from "bun:test";
import {
  createArpRequest, createArpReply,
  createIcmpEchoRequest, createIcmpEchoReply,
  createDhcpDiscover, createDhcpOffer,
  createDhcpRequest, createDhcpAck,
  frameLabel, frameColor,
  BROADCAST_MAC,
} from "../src/frame";

// ── ARP frames ────────────────────────────────────────────────────────────────

describe("createArpRequest", () => {
  const frame = createArpRequest("02:00:00:00:01:10", "192.168.1.10", "192.168.1.20");

  it("sets destination MAC to broadcast", () => {
    expect(frame.dstMac).toBe(BROADCAST_MAC);
  });

  it("sets etherType to 0x0806 (ARP)", () => {
    expect(frame.etherType).toBe(0x0806);
  });

  it("sets ARP operation to request", () => {
    expect((frame.payload as any).operation).toBe("request");
  });

  it("sets correct IP addresses", () => {
    const arp = frame.payload as any;
    expect(arp.senderIp).toBe("192.168.1.10");
    expect(arp.targetIp).toBe("192.168.1.20");
  });

  it("sets correct MAC addresses", () => {
    expect(frame.srcMac).toBe("02:00:00:00:01:10");
    expect((frame.payload as any).senderMac).toBe("02:00:00:00:01:10");
  });

  it("sets VLAN tag to null by default", () => {
    expect(frame.vlanTag).toBeNull();
  });

  it("accepts explicit VLAN tag", () => {
    const tagged = createArpRequest("02:00:00:00:01:10", "192.168.1.10", "192.168.1.20", 10);
    expect(tagged.vlanTag).toBe(10);
  });
});

describe("createArpReply", () => {
  const frame = createArpReply(
    "02:00:00:00:01:20", "192.168.1.20",
    "02:00:00:00:01:10", "192.168.1.10"
  );

  it("sets unicast destination MAC", () => {
    expect(frame.dstMac).toBe("02:00:00:00:01:10");
  });

  it("sets ARP operation to reply", () => {
    expect((frame.payload as any).operation).toBe("reply");
  });

  it("sets sender and target correctly", () => {
    const arp = frame.payload as any;
    expect(arp.senderMac).toBe("02:00:00:00:01:20");
    expect(arp.senderIp).toBe("192.168.1.20");
    expect(arp.targetMac).toBe("02:00:00:00:01:10");
    expect(arp.targetIp).toBe("192.168.1.10");
  });
});

// ── ICMP frames ───────────────────────────────────────────────────────────────

describe("createIcmpEchoRequest", () => {
  const frame = createIcmpEchoRequest(
    "02:00:00:00:01:10", "02:00:00:00:01:20",
    "192.168.1.10", "192.168.1.20", 64
  );

  it("sets etherType to 0x0800 (IPv4)", () => {
    expect(frame.etherType).toBe(0x0800);
  });

  it("sets ICMP echo request type (8)", () => {
    const ipv4 = frame.payload as any;
    expect(ipv4.type).toBe("ipv4");
    expect(ipv4.payload.type).toBe("icmp");
    expect(ipv4.payload.icmpType).toBe(8);
  });

  it("sets TTL", () => {
    expect((frame.payload as any).ttl).toBe(64);
  });

  it("sets sequence number (default 1)", () => {
    expect((frame.payload as any).payload.sequence).toBe(1);
  });

  it("sets explicit sequence number", () => {
    const f = createIcmpEchoRequest("AA:BB:CC:DD:EE:FF", "11:22:33:44:55:66", "1.2.3.4", "5.6.7.8", 64, null, 42);
    expect((f.payload as any).payload.sequence).toBe(42);
  });
});

describe("createIcmpEchoReply", () => {
  const frame = createIcmpEchoReply(
    "02:00:00:00:01:20", "02:00:00:00:01:10",
    "192.168.1.20", "192.168.1.10", 63
  );

  it("sets ICMP echo reply type (0)", () => {
    expect((frame.payload as any).payload.icmpType).toBe(0);
  });

  it("uses provided TTL", () => {
    expect((frame.payload as any).ttl).toBe(63);
  });
});

// ── DHCP frames ──────────────────────────────────────────────────────────────

describe("createDhcpDiscover", () => {
  const frame = createDhcpDiscover("02:00:00:00:01:10", "txn-001");

  it("sets etherType to 0x0800 (IPv4)", () => {
    expect(frame.etherType).toBe(0x0800);
  });

  it("sets source MAC to client MAC", () => {
    expect(frame.srcMac).toBe("02:00:00:00:01:10");
  });

  it("sets destination MAC to broadcast", () => {
    expect(frame.dstMac).toBe(BROADCAST_MAC);
  });

  it("sets IPv4 source to 0.0.0.0", () => {
    const ipv4 = frame.payload as any;
    expect(ipv4.srcIp).toBe("0.0.0.0");
  });

  it("sets IPv4 destination to broadcast", () => {
    const ipv4 = frame.payload as any;
    expect(ipv4.dstIp).toBe("255.255.255.255");
  });

  it("sets DHCP messageType to discover", () => {
    const dhcp = (frame.payload as any).payload;
    expect(dhcp.messageType).toBe("discover");
  });

  it("sets DHCP clientMac correctly", () => {
    const dhcp = (frame.payload as any).payload;
    expect(dhcp.clientMac).toBe("02:00:00:00:01:10");
  });

  it("sets VLAN tag to null by default", () => {
    expect(frame.vlanTag).toBeNull();
  });

  it("accepts explicit VLAN tag", () => {
    const tagged = createDhcpDiscover("02:00:00:00:01:10", "txn-001", 10);
    expect(tagged.vlanTag).toBe(10);
  });
});

describe("createDhcpOffer", () => {
  const frame = createDhcpOffer("02:01:00:00:01:01", "192.168.1.1", "02:00:00:00:01:10", "192.168.1.100", "txn-001");

  it("sets source MAC to server MAC", () => {
    expect(frame.srcMac).toBe("02:01:00:00:01:01");
  });

  it("sets destination MAC to broadcast", () => {
    expect(frame.dstMac).toBe(BROADCAST_MAC);
  });

  it("sets DHCP messageType to offer", () => {
    const dhcp = (frame.payload as any).payload;
    expect(dhcp.messageType).toBe("offer");
  });

  it("includes assignedIp", () => {
    const dhcp = (frame.payload as any).payload;
    expect(dhcp.assignedIp).toBe("192.168.1.100");
  });

  it("includes gatewayIp from serverIp", () => {
    const dhcp = (frame.payload as any).payload;
    expect(dhcp.gatewayIp).toBe("192.168.1.1");
  });

  it("includes serverIp", () => {
    const dhcp = (frame.payload as any).payload;
    expect(dhcp.serverIp).toBe("192.168.1.1");
  });
});

describe("createDhcpRequest", () => {
  const frame = createDhcpRequest("02:00:00:00:01:10", "192.168.1.100", "192.168.1.1", "txn-001");

  it("sets source MAC to client MAC", () => {
    expect(frame.srcMac).toBe("02:00:00:00:01:10");
  });

  it("sets destination MAC to broadcast", () => {
    expect(frame.dstMac).toBe(BROADCAST_MAC);
  });

  it("sets DHCP messageType to request", () => {
    const dhcp = (frame.payload as any).payload;
    expect(dhcp.messageType).toBe("request");
  });

  it("includes requestedIp", () => {
    const dhcp = (frame.payload as any).payload;
    expect(dhcp.requestedIp).toBe("192.168.1.100");
  });

  it("includes serverIp", () => {
    const dhcp = (frame.payload as any).payload;
    expect(dhcp.serverIp).toBe("192.168.1.1");
  });
});

describe("createDhcpAck", () => {
  const frame = createDhcpAck("02:01:00:00:01:01", "192.168.1.1", "02:00:00:00:01:10", "192.168.1.100", "txn-001");

  it("sets source MAC to server MAC", () => {
    expect(frame.srcMac).toBe("02:01:00:00:01:01");
  });

  it("sets destination MAC to broadcast", () => {
    expect(frame.dstMac).toBe(BROADCAST_MAC);
  });

  it("sets DHCP messageType to ack", () => {
    const dhcp = (frame.payload as any).payload;
    expect(dhcp.messageType).toBe("ack");
  });

  it("includes assignedIp", () => {
    const dhcp = (frame.payload as any).payload;
    expect(dhcp.assignedIp).toBe("192.168.1.100");
  });

  it("includes gatewayIp", () => {
    const dhcp = (frame.payload as any).payload;
    expect(dhcp.gatewayIp).toBe("192.168.1.1");
  });
});

// ── Frame labels ──────────────────────────────────────────────────────────────

describe("frameLabel", () => {
  it("labels ARP request", () => {
    const frame = createArpRequest("AA:BB:CC:DD:EE:FF", "1.2.3.4", "5.6.7.8");
    expect(frameLabel(frame)).toContain("ARP");
    expect(frameLabel(frame)).toContain("Req");
  });

  it("labels ARP reply", () => {
    const frame = createArpReply("AA:BB:CC:DD:EE:FF", "1.2.3.4", "11:22:33:44:55:66", "5.6.7.8");
    expect(frameLabel(frame)).toContain("ARP");
    expect(frameLabel(frame)).toContain("Reply");
  });

  it("labels ICMP echo request", () => {
    const frame = createIcmpEchoRequest("AA:BB:CC:DD:EE:FF", "11:22:33:44:55:66", "1.2.3.4", "5.6.7.8", 64);
    expect(frameLabel(frame)).toContain("ICMP");
  });

  it("appends VLAN tag when present", () => {
    const frame = createArpRequest("AA:BB:CC:DD:EE:FF", "1.2.3.4", "5.6.7.8", 10);
    expect(frameLabel(frame)).toContain("[V10]");
  });

  it("does not append VLAN tag when null", () => {
    const frame = createArpRequest("AA:BB:CC:DD:EE:FF", "1.2.3.4", "5.6.7.8");
    expect(frameLabel(frame)).not.toContain("[V");
  });

  it("returns 'DHCP Disc' for discover frame", () => {
    expect(frameLabel(createDhcpDiscover("02:00:00:00:01:10", "txn"))).toBe("DHCP Disc");
  });

  it("returns 'DHCP Offer' for offer frame", () => {
    expect(frameLabel(createDhcpOffer("02:01:00:00:01:01", "192.168.1.1", "02:00:00:00:01:10", "192.168.1.100", "txn"))).toBe("DHCP Offer");
  });

  it("returns 'DHCP Req' for request frame", () => {
    expect(frameLabel(createDhcpRequest("02:00:00:00:01:10", "192.168.1.100", "192.168.1.1", "txn"))).toBe("DHCP Req");
  });

  it("returns 'DHCP ACK' for ack frame", () => {
    expect(frameLabel(createDhcpAck("02:01:00:00:01:01", "192.168.1.1", "02:00:00:00:01:10", "192.168.1.100", "txn"))).toBe("DHCP ACK");
  });
});

// ── Frame colors ──────────────────────────────────────────────────────────────

describe("frameColor", () => {
  it("returns a color string for ARP", () => {
    const frame = createArpRequest("AA:BB:CC:DD:EE:FF", "1.2.3.4", "5.6.7.8");
    const color = frameColor(frame);
    expect(typeof color).toBe("string");
    expect(color.length).toBeGreaterThan(0);
  });

  it("returns different colors for different frame types", () => {
    const arp = createArpRequest("AA:BB:CC:DD:EE:FF", "1.2.3.4", "5.6.7.8");
    const icmpReq = createIcmpEchoRequest("AA:BB:CC:DD:EE:FF", "11:22:33:44:55:66", "1.2.3.4", "5.6.7.8", 64);
    const icmpReply = createIcmpEchoReply("11:22:33:44:55:66", "AA:BB:CC:DD:EE:FF", "5.6.7.8", "1.2.3.4", 64);
    expect(frameColor(arp)).not.toBe(frameColor(icmpReq));
    expect(frameColor(icmpReq)).not.toBe(frameColor(icmpReply));
  });

  it("returns violet for DHCP frames", () => {
    expect(frameColor(createDhcpDiscover("02:00:00:00:01:10", "txn"))).toBe("#a78bfa");
  });
});
