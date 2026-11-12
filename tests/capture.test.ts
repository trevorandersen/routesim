/**
 * The packet list (Wireshark-style sim log): per-wire frame capture during
 * animated runs, and the Source/Destination/Protocol/Info column mapping.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { state } from "../src/state";
import { startSimulation, stepOnce, stopSimulation } from "../src/engine";
import { buildPingEvents } from "../src/simulation";
import {
  packetColumns, createArpRequest, createArpReply, createIcmpEchoRequest,
  createIcmpEchoReply, createIcmpTimeExceeded, createTcpSegment,
  createDnsQuery, createDnsResponse, createDhcpDiscover, createDot11Frame,
} from "../src/frame";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());

describe("packetColumns — Wireshark column mapping", () => {
  it("ARP request: Who has …? Tell …", () => {
    const c = packetColumns(createArpRequest("02:00:00:00:00:0A", "192.168.1.10", "192.168.1.20"));
    expect(c).toMatchObject({ src: "02:00:00:00:00:0A", dst: "Broadcast", protocol: "ARP", tone: "arp" });
    expect(c.info).toBe("Who has 192.168.1.20? Tell 192.168.1.10");
  });

  it("ARP reply: … is at …", () => {
    const c = packetColumns(createArpReply("02:00:00:00:00:0B", "192.168.1.20", "02:00:00:00:00:0A", "192.168.1.10"));
    expect(c.protocol).toBe("ARP");
    expect(c.info).toBe("192.168.1.20 is at 02:00:00:00:00:0B");
  });

  it("ICMP request/reply/time-exceeded", () => {
    const req = packetColumns(createIcmpEchoRequest("02:0A", "02:0B", "192.168.1.10", "192.168.1.20", 64));
    expect(req).toMatchObject({ src: "192.168.1.10", dst: "192.168.1.20", protocol: "ICMP", tone: "icmp" });
    expect(req.info).toContain("Echo (ping) request");
    expect(req.info).toContain("ttl=64");
    const rep = packetColumns(createIcmpEchoReply("02:0B", "02:0A", "192.168.1.20", "192.168.1.10", 64));
    expect(rep.tone).toBe("icmp-reply");
    expect(rep.info).toContain("Echo (ping) reply");
    const ttl = packetColumns(createIcmpTimeExceeded("02:0C", "02:0A", "10.0.0.1", "192.168.1.10"));
    expect(ttl.tone).toBe("bad");
    expect(ttl.info).toContain("Time-to-live exceeded");
  });

  it("TCP flags render Wireshark-style; RST is red", () => {
    const syn = packetColumns(createTcpSegment("02:0A", "02:0B", "192.168.1.10", "192.168.1.20", 30000, 80, "syn"));
    expect(syn).toMatchObject({ protocol: "TCP", tone: "tcp" });
    expect(syn.info).toContain("30000 → 80 [SYN]");
    const rst = packetColumns(createTcpSegment("02:0B", "02:0A", "192.168.1.20", "192.168.1.10", 80, 30000, "rst"));
    expect(rst.tone).toBe("bad");
    expect(rst.info).toContain("[RST]");
  });

  it("DNS query, answer, and NXDOMAIN", () => {
    const q = packetColumns(createDnsQuery("02:0A", "02:0B", "192.168.1.10", "192.168.1.53", "web.corp", 7));
    expect(q).toMatchObject({ protocol: "DNS", tone: "dns" });
    expect(q.info).toBe("Standard query 0x0007 A web.corp");
    const a = packetColumns(createDnsResponse("02:0B", "02:0A", "192.168.1.53", "192.168.1.10", "web.corp", "192.168.1.80", 7));
    expect(a.info).toBe("Standard query response 0x0007 A web.corp A 192.168.1.80");
    const nx = packetColumns(createDnsResponse("02:0B", "02:0A", "192.168.1.53", "192.168.1.10", "nope.corp", null, 8));
    expect(nx.tone).toBe("bad");
    expect(nx.info).toContain("No such name");
  });

  it("DHCP shows the message type", () => {
    const c = packetColumns(createDhcpDiscover("02:00:00:00:00:0A", "dhcp-test-1234"));
    expect(c).toMatchObject({ src: "0.0.0.0", dst: "255.255.255.255", protocol: "DHCP", tone: "dhcp" });
    expect(c.info).toContain("DHCP Discover");
  });

  it("802.11 management vs EAPOL frames", () => {
    const probe = packetColumns(createDot11Frame("02:0A", "02:BS", "probe-req", "CorpWiFi"));
    expect(probe).toMatchObject({ protocol: "802.11", tone: "dot11" });
    expect(probe.info).toBe('Probe Request, SSID="CorpWiFi"');
    const m1 = packetColumns(createDot11Frame("02:BS", "02:0A", "eapol-m1", "CorpWiFi"));
    expect(m1.protocol).toBe("EAPOL");
    expect(m1.info).toBe("Key (Message 1 of 4)");
  });
});

describe("capture — frames recorded per wire traversal", () => {
  // The preload's synchronous requestAnimationFrame would recurse inside the
  // animation loop, so animated runs are pumped manually via stepOnce().
  const realRaf = (globalThis as any).requestAnimationFrame;
  beforeEach(() => {
    resetState();
    (globalThis as any).requestAnimationFrame = () => 0;
  });
  afterEach(() => {
    (globalThis as any).requestAnimationFrame = realRaf;
  });

  function lanTopology() {
    runConsoleScript(`
      add computer PC1 at 0 0
      add switch SW at 200 0
      add computer PC2 at 400 0
      link PC1 SW
      link PC2 SW
      ip PC1 192.168.1.10/24
      ip PC2 192.168.1.20/24
    `);
    return state.devices.find(d => d.name === "PC1")!;
  }

  function runAnimated(source: any, target: string): void {
    const setup = buildPingEvents(source, target);
    expect(typeof setup).not.toBe("string");
    state.simulation.autoPlay = true;
    startSimulation(setup as any, source.id, target, "ping");
    let guard = 0;
    while (state.simulation.status !== "done" && guard++ < 500) stepOnce();
    expect(state.simulation.status).toBe("done");
  }

  it("an animated ping captures the ARP exchange and both ICMP legs", () => {
    const pc1 = lanTopology();
    runAnimated(pc1, "192.168.1.20");
    const cap = state.simulation.capture;
    expect(cap.length).toBeGreaterThanOrEqual(6); // ARP req (2 wires incl. flood) + reply + echo + reply legs
    // Numbering is 1-based and monotonic; steps never decrease.
    expect(cap[0].no).toBe(1);
    for (let i = 1; i < cap.length; i++) {
      expect(cap[i].no).toBe(cap[i - 1].no + 1);
      expect(cap[i].step).toBeGreaterThanOrEqual(cap[i - 1].step);
    }
    const protocols = cap.map(c => packetColumns(c.frame).protocol);
    expect(protocols).toContain("ARP");
    expect(protocols).toContain("ICMP");
    // The echo reply made it back across the last wire.
    const last = packetColumns(cap[cap.length - 1].frame);
    expect(last.info).toContain("Echo (ping) reply");
    expect(state.simulation.pingSuccess).toBe(true);
  });

  it("the first leg originates at the source, not the connected switch", () => {
    const pc1 = lanTopology();
    const sw = state.devices.find(d => d.name === "SW")!;
    runAnimated(pc1, "192.168.1.20");
    const first = state.simulation.capture[0];
    // The opening frame must leave PC1 → SW (an ARP request), not appear to
    // start at the switch — the bug this guards against.
    expect(first.fromDeviceId).toBe(pc1.id);
    expect(first.toDeviceId).toBe(sw.id);
    expect(packetColumns(first.frame).protocol).toBe("ARP");
  });

  it("the packet-list cross-link clears on a new run and on stop", () => {
    const pc1 = lanTopology();
    runAnimated(pc1, "192.168.1.20");
    // What a packet-row click sets — the canvas highlights its wire + endpoints.
    state.inspectedCapture = state.simulation.capture[0];
    expect(state.inspectedCapture).not.toBeNull();
    // A fresh run invalidates the previous selection (no stale canvas highlight).
    runAnimated(pc1, "192.168.1.20");
    expect(state.inspectedCapture).toBeNull();
    // Stopping clears it too (the capture it referenced is gone).
    state.inspectedCapture = state.simulation.capture[0];
    stopSimulation();
    expect(state.inspectedCapture).toBeNull();
  });

  it("capture entries reference real devices on a real link", () => {
    const pc1 = lanTopology();
    runAnimated(pc1, "192.168.1.20");
    for (const entry of state.simulation.capture) {
      expect(state.devices.some(d => d.id === entry.fromDeviceId)).toBe(true);
      expect(state.devices.some(d => d.id === entry.toDeviceId)).toBe(true);
      expect(state.links.some(l => l.id === entry.linkId)).toBe(true);
    }
  });

  it("a 100% packet-loss link drops every frame across it (animated)", () => {
    const pc1 = lanTopology();
    const sw = state.devices.find(d => d.name === "SW")!;
    const pc2 = state.devices.find(d => d.name === "PC2")!;
    const lossyLink = state.links.find(l =>
      (l.from === pc2.id && l.to === sw.id) || (l.from === sw.id && l.to === pc2.id))!;
    lossyLink.loss = 100; // always drops
    runAnimated(pc1, "192.168.1.20");
    expect(state.simulation.pingSuccess).toBe(false);
    // Nothing ever reached PC2 — every frame the switch sent its way was lost.
    expect(state.simulation.capture.some(c => c.toDeviceId === pc2.id)).toBe(false);
    // Headless reachability ignores loss (deterministic): the path still exists.
    expect(exec("run ping PC1 192.168.1.20").ok).toBe(true);
  });

  it("headless runs do not capture", () => {
    const pc1 = lanTopology();
    const r = exec("run ping PC1 192.168.1.20");
    expect(r.ok).toBe(true);
    expect(state.simulation.capture).toHaveLength(0);
  });

  it("a new run clears the previous capture", () => {
    const pc1 = lanTopology();
    runAnimated(pc1, "192.168.1.20");
    const firstCount = state.simulation.capture.length;
    expect(firstCount).toBeGreaterThan(0);
    runAnimated(pc1, "192.168.1.20");
    // Second run is shorter (ARP cached) — proof the list was reset, not appended.
    expect(state.simulation.capture.length).toBeLessThan(firstCount);
    expect(state.simulation.capture[0].no).toBe(1);
  });

  it("headless runs (scenario checks, boot chatter) leave the capture intact", () => {
    const pc1 = lanTopology();
    runAnimated(pc1, "192.168.1.20");
    const count = state.simulation.capture.length;
    expect(count).toBeGreaterThan(0);
    const r = exec("run ping PC1 192.168.1.20");
    expect(r.ok).toBe(true);
    expect(state.simulation.capture.length).toBe(count); // packet list survives
  });

  it("silent ARP resolves the ping but keeps ARP out of the packet list", () => {
    state.options.silentArp = true;
    try {
      const pc1 = lanTopology();
      runAnimated(pc1, "192.168.1.20");
      expect(state.simulation.pingSuccess).toBe(true); // engine still ran the ARP
      const protocols = state.simulation.capture.map(c => packetColumns(c.frame).protocol);
      expect(protocols).not.toContain("ARP");  // …it just isn't shown
      expect(protocols).toContain("ICMP");      // the ping itself still animates + captures
    } finally {
      state.options.silentArp = false;
    }
  });
});
