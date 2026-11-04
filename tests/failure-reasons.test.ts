/**
 * Failure-reason plumbing — every way a run can fail states WHY. Covers the
 * shared data-gate reason (`linkDataBlockReason`) and its two consumers
 * (`findFirstHop`'s "Network is unreachable (…)" and the transit step's drop
 * line), the powered-off guard before processor dispatch, the end-of-run
 * post-mortem (an ARP nobody answered, naming the gateway when it is the
 * cause), the broadcast storm on headless runs and traceroute, ICMP errors in
 * ping output, and a router answering TCP/DNS addressed to itself.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { state } from "../src/state";
import { runConsoleCommand as exec, runConsoleScript } from "../src/commands";
import { linkDataBlockReason, linkAuthorizedForData, addLink } from "../src/devices";
import { buildPingEvents, buildConnectEvents, buildResolveEvents, buildDhcpEvents, buildSweepEvents } from "../src/simulation";
import { runSimulationHeadless, runTraceroute, startSimulation, stepOnce, STORM_DIAGNOSIS } from "../src/engine";
import { runStpConvergence } from "../src/stp";
import { freshNameCounters } from "../src/device-registry";
import { routedTopology } from "./fixtures";
import { registerNoopCallbacks, resetState } from "./helpers";
import type { Device, Link } from "../src/types";

beforeAll(() => registerNoopCallbacks());

function reset(): void {
  resetState();
  state.nameCounters = freshNameCounters();
  state.configStore = { version: 1, configs: {} } as any;
}

const byName = (name: string): Device => state.devices.find(d => d.name === name)!;
const linkOf = (a: string, b: string): Link => {
  const x = byName(a).id, y = byName(b).id;
  return state.links.find(l => (l.from === x && l.to === y) || (l.from === y && l.to === x))!;
};
const drops = () => state.simulation.log.filter(e => e.kind === "sim-drop").map(e => e.action);

function lan(): void {
  runConsoleScript(`
    add computer PC1 at 0 0
    add switch SW at 150 0
    add computer PC2 at 300 0
    link PC1 SW
    link PC2 SW
    ip PC1 10.0.0.1/24
    ip PC2 10.0.0.2/24
  `);
}

function routed(): void {
  const topo = routedTopology();
  state.devices = topo.devices as any;
  state.links = topo.links as any;
}

// Animated runs are pumped by hand: the preload's synchronous rAF would recurse.
function runAnimated(source: Device, setup: ReturnType<typeof buildPingEvents>, target: string): string {
  expect(typeof setup).not.toBe("string");
  const realRaf = (globalThis as any).requestAnimationFrame;
  (globalThis as any).requestAnimationFrame = () => 0;
  try {
    state.simulation.autoPlay = true;
    startSimulation(setup as any, source.id, target, "ping");
    let guard = 0;
    while (state.simulation.status !== "done" && guard++ < 500) stepOnce();
  } finally {
    (globalThis as any).requestAnimationFrame = realRaf;
  }
  return state.terminal.lines.map(l => l.text).join("\n");
}

describe("linkDataBlockReason — one gate, a reason per cause", () => {
  beforeEach(reset);

  it("an open link carries data: null, and the boolean wrapper agrees", () => {
    lan();
    const link = linkOf("PC1", "SW");
    expect(linkDataBlockReason(link)).toBeNull();
    expect(linkAuthorizedForData(link)).toBe(true);
  });

  it("names a shut link, a spanning-tree block, and agrees with linkAuthorizedForData", () => {
    lan();
    const link = linkOf("PC1", "SW");
    link.shutdown = true;
    expect(linkDataBlockReason(link)).toContain("administratively down");
    expect(linkAuthorizedForData(link)).toBe(false);
    link.shutdown = false;
    link.stpBlocked = true;
    expect(linkDataBlockReason(link)).toContain("spanning tree");
    expect(linkAuthorizedForData(link)).toBe(false);
  });

  it("names a WiFi password mismatch", () => {
    runConsoleScript(`
      add laptop LT1 at 0 0
      add access-point AP1 at 100 0
      ssid AP1 Secure hunter2
      ssid LT1 Secure wrongpw
    `);
    addLink(byName("LT1").id, byName("AP1").id);
    const reason = linkDataBlockReason(state.links.find(l => l.wireless)!);
    expect(reason).toContain("WiFi password does not match");
  });

  it("names the 802.1X port, distinguishing force-unauthorized from a not-yet-authenticated auto port", () => {
    lan();
    exec("managed SW on");
    exec("portauth SW Ethernet1 auto");
    const link = linkOf("PC1", "SW");
    expect(linkDataBlockReason(link)).toContain("SW Ethernet1 is under 802.1X control and PC1 has not authenticated");
    exec("portauth SW Ethernet1 force-unauthorized");
    expect(linkDataBlockReason(link)).toContain("SW Ethernet1 is 802.1X force-unauthorized");
    // A peer that can't run a supplicant (a hub) is told so, not sent to `dot1x`.
    runConsoleScript("add hub HUB at 0 150\nlink HUB SW\nportauth SW Ethernet3 auto");
    const hubReason = linkDataBlockReason(linkOf("HUB", "SW"));
    expect(hubReason).toContain("HUB cannot authenticate (it is not an 802.1X supplicant)");
    expect(hubReason).not.toContain("run \"dot1x");
  });

  it("the 802.1X hint is a runnable command: names quoted, and an identity asked for first", () => {
    runConsoleScript(`
      add computer "My PC" at 0 0
      add switch SW at 150 0
      add server RAD at 150 150
      link "My PC" SW
      link SW RAD
      managed SW on
      ip RAD 10.0.0.2/24
      radius RAD alice s3cret
      portauth SW Ethernet1 auto
    `);
    const link = linkOf("My PC", "SW");
    // No identity yet: `dot1x` alone would refuse, so `supplicant` comes first.
    expect(linkDataBlockReason(link)).toContain(`give it an identity with supplicant "My PC" <identity> <password>, then run dot1x "My PC"`);
    exec(`supplicant "My PC" alice s3cret`);
    expect(linkDataBlockReason(link)).toContain(`run dot1x "My PC" first`);
    expect(exec(`run dot1x "My PC"`).ok).toBe(true);   // the hinted command is the one that works (headless form)
    expect(linkDataBlockReason(link)).toBeNull();
  });

  it("names why MACsec failed: a key mismatch, or a must-secure end facing a bare peer", () => {
    lan();
    runConsoleScript("macsec PC1 SW keyAAA must\nmacsec SW PC1 keyBBB must");
    expect(linkDataBlockReason(linkOf("PC1", "SW"))).toContain("pre-shared keys do not match");
    runConsoleScript("macsec SW PC1 off");
    expect(linkDataBlockReason(linkOf("PC1", "SW"))).toContain("PC1 requires MACsec but SW has none configured");
  });
});

describe("findFirstHop — the builders report the real reason, not 'no link' (R24)", () => {
  beforeEach(reset);

  it("no cable at all still reads 'no link'", () => {
    runConsoleScript("add computer PC1 at 0 0\nip PC1 10.0.0.1/24");
    expect(buildPingEvents(byName("PC1"), "10.0.0.2")).toBe("ping: connect: Network is unreachable (no link)");
  });

  it("a wrong WiFi password says so (the troubleshoot-wifi lesson)", () => {
    runConsoleScript(`
      add laptop LT1 at 0 0
      add access-point AP1 at 100 0
      ssid AP1 Secure hunter2
      ssid LT1 Secure wrongpw
      ip LT1 10.0.0.5/24
    `);
    addLink(byName("LT1").id, byName("AP1").id);
    const r = buildPingEvents(byName("LT1"), "10.0.0.9");
    expect(r).toContain("Network is unreachable");
    expect(r).toContain("WiFi password does not match");
    expect(r).not.toContain("no link");
  });

  it("a shut cable, an unauthorized 802.1X port and a powered-off peer each name themselves", () => {
    lan();
    const pc1 = byName("PC1");
    exec("shut PC1 SW");
    expect(buildConnectEvents(pc1, "10.0.0.2", 22)).toContain("administratively down");
    exec("noshut PC1 SW");
    exec("managed SW on");
    exec("portauth SW Ethernet1 force-unauthorized");
    expect(buildDhcpEvents(pc1)).toContain("802.1X force-unauthorized");
    exec("portauth SW Ethernet1 force-authorized");
    exec("power SW off");
    expect(buildPingEvents(pc1, "10.0.0.2")).toContain("SW, at the other end of");
    expect(buildPingEvents(pc1, "10.0.0.2")).toContain("is powered off");
    exec("nameserver PC1 10.0.0.2");
    expect(buildResolveEvents(pc1, "web")).toContain("is powered off");
  });
});

describe("the transit step names the data-gate reason (admitOnLink)", () => {
  beforeEach(reset);

  it("a frame dropped at an unauthorized 802.1X port says which port and why", () => {
    lan();
    exec("managed SW on");
    exec("portauth SW Ethernet2 auto");   // PC2's port: PC2 never authenticated
    const r = runSimulationHeadless(buildPingEvents(byName("PC1"), "10.0.0.2") as any, byName("PC1").id, "10.0.0.2");
    expect(r.success).toBe(false);
    expect(drops().some(d => d.includes("SW Ethernet2 is under 802.1X control and PC2 has not authenticated") && d.includes("ARP Req dropped"))).toBe(true);
    expect(drops().some(d => d.includes("is not authenticated — frame dropped"))).toBe(false);   // the old, causeless line
  });
});

describe("powered-off guard before dispatch (R50)", () => {
  beforeEach(reset);

  it("a frame reaching a powered-off device is logged, not swallowed", () => {
    lan();
    const pc1 = byName("PC1");
    const setup = buildPingEvents(pc1, "10.0.0.2");
    exec("power PC2 off");   // after the setup: the flooded ARP still reaches PC2's port
    const r = runSimulationHeadless(setup as any, pc1.id, "10.0.0.2");
    expect(r.success).toBe(false);
    expect(drops()).toContain("PC2 is powered off — ARP Req dropped");
  });
});

describe("post-mortem — unanswered ARPs explained (R14)", () => {
  beforeEach(reset);

  it("a wrong (on-subnet) gateway: the ARP for it got no reply, and the gateway is named", () => {
    routed();
    exec("gateway PC-A 192.168.10.254");   // on-subnet, but nothing owns it
    const r = runSimulationHeadless(buildPingEvents(byName("PC-A"), "192.168.20.10") as any, "pc-a", "192.168.20.10");
    expect(r.success).toBe(false);
    expect(r.diagnosis).toHaveLength(1);
    expect(r.diagnosis[0]).toContain("ARP for 192.168.10.254 got no reply — 1 queued ICMP Echo never sent");
    expect(r.diagnosis[0]).toContain("default gateway");
    expect(drops()).toContain(r.diagnosis[0]);   // logged on the host that waited
  });

  it("a mistyped on-subnet target: no device on this subnet answered for it", () => {
    lan();
    const r = exec("run ping PC1 10.0.0.99");
    expect(r.ok).toBe(false);
    expect(r.output.some(l => l.includes("no device on this subnet answered for 10.0.0.99"))).toBe(true);
  });

  it("a router's unanswered next-hop ARP is named, prefixed with the router (target powered off)", () => {
    routed();
    exec("power PC-B off");
    const r = runSimulationHeadless(buildPingEvents(byName("PC-A"), "192.168.20.10") as any, "pc-a", "192.168.20.10");
    expect(r.success).toBe(false);
    expect(r.diagnosis.some(l => l.startsWith("RTR-1: ARP for 192.168.20.10 got no reply") && l.includes("next hop"))).toBe(true);
    expect(drops()).toContain("PC-B is powered off — ARP Req dropped");
  });

  // The ARP was not ignored but DROPPED on the way: the post-mortem quotes the
  // drop's real cause instead of the generic "is the address right?".
  it("an unauthorized 802.1X port on the target's cable is named, not 'is the address right'", () => {
    lan();
    exec("managed SW on");
    exec("portauth SW Ethernet2 auto");   // PC2's port: PC2 never authenticated
    const r = exec("run ping PC1 10.0.0.2");
    expect(r.ok).toBe(false);
    const text = r.output.join("\n");
    expect(text).toContain("the ARP for 10.0.0.2 was dropped on the way — SW Ethernet2 is under 802.1X control and PC2 has not authenticated");
    expect(text).not.toContain("is the address right");
  });

  it("a failed MACsec link on the target's cable is named", () => {
    lan();
    exec("macsec SW PC2 k1 must");   // SW insists; PC2 has no key
    const text = exec("run ping PC1 10.0.0.2").output.join("\n");
    expect(text).toContain("was dropped on the way — PC2 ↔ SW failed MACsec");
    expect(text).not.toContain("is the address right");
  });

  it("a shut target cable is named", () => {
    lan();
    exec("shut PC2 SW");
    const text = exec("run ping PC1 10.0.0.2").output.join("\n");
    expect(text).toContain("was dropped on the way —");
    expect(text).toContain("administratively down");
    expect(text).not.toContain("is the address right");
  });

  it("an 802.1X block on the router's port names it, not 'is the gateway address right'", () => {
    routed();
    exec("managed SW-A on");
    exec("portauth SW-A Ethernet2 auto");   // SW-A's port facing RTR-1 (l2)
    const r = runSimulationHeadless(buildPingEvents(byName("PC-A"), "192.168.20.10") as any, "pc-a", "192.168.20.10");
    expect(r.success).toBe(false);
    expect(r.diagnosis[0]).toContain("the ARP for 192.168.10.1 (this host's default gateway) was dropped on the way");
    expect(r.diagnosis[0]).toContain("RTR-1 cannot authenticate");
    expect(r.diagnosis[0]).not.toContain("is the gateway address right");
  });

  it("a flooded copy dropped at someone else's port does not explain a mistyped address", () => {
    lan();
    exec("managed SW on");
    exec("portauth SW Ethernet2 auto");   // PC2's port drops the flooded ARP for .99
    const text = exec("run ping PC1 10.0.0.99").output.join("\n");
    expect(text).toContain("no device on this subnet answered for 10.0.0.99 — is the address right");
    expect(text).not.toContain("dropped on the way");
  });

  it("an animated run that loses the ARP on a lossy link blames the loss", () => {
    lan();
    linkOf("PC2", "SW").loss = 100;
    const pc1 = byName("PC1");
    const text = runAnimated(pc1, buildPingEvents(pc1, "10.0.0.2"), "10.0.0.2");
    expect(text).toContain("the ARP for 10.0.0.2 was dropped on the way —");
    expect(text).toContain("(100% loss on that link");
    expect(text).not.toContain("is the address right");
  });

  it("a successful sweep's silent addresses are logged as ARP notes, not a failure diagnosis", () => {
    lan();
    runConsoleScript("add kali K at 0 200\nlink K SW\nip K 10.0.0.50/24");
    const k = byName("K");
    const r = runSimulationHeadless(buildSweepEvents(k, "10.0.0.0/28") as any, k.id, "", "attack");
    expect(r.success).toBe(true);
    expect(r.diagnosis).toEqual([]);
    expect(r.log.some(e => e.kind === "sim-arp" && e.action.includes("ARP got no reply from"))).toBe(true);
    expect(r.log.some(e => e.kind === "sim-drop" && e.action.includes("ARP got no reply"))).toBe(false);
  });

  it("traceroute that goes silent says why after the hop list", () => {
    lan();
    const t = runTraceroute(byName("PC1"), "10.0.0.99");
    expect(typeof t).not.toBe("string");
    expect((t as any).reached).toBe(false);
    const out = exec("traceroute PC1 10.0.0.99").output;
    expect(out).toContain("(destination not reached within 30 hops)");
    expect(out.some(l => l.includes("no device on this subnet answered for 10.0.0.99"))).toBe(true);
    // A trace that arrives carries no diagnosis.
    expect((runTraceroute(byName("PC1"), "10.0.0.2") as any).diagnosis).toBeUndefined();
  });

  it("a successful run leaves no diagnosis", () => {
    lan();
    const r = runSimulationHeadless(buildPingEvents(byName("PC1"), "10.0.0.2") as any, byName("PC1").id, "10.0.0.2");
    expect(r.success).toBe(true);
    expect(r.diagnosis).toEqual([]);
  });

  it("the animated ping prints Destination Host Unreachable and the reason in the terminal", () => {
    routed();
    exec("gateway PC-A 192.168.10.254");
    const text = runAnimated(byName("PC-A"), buildPingEvents(byName("PC-A"), "192.168.20.10"), "192.168.20.10");
    expect(text).toContain("From 192.168.10.10 icmp_seq=1 Destination Host Unreachable");
    expect(text).toContain("+1 error, 100% packet loss");
    expect(text).toContain("192.168.10.254 is this host's default gateway");
  });
});

describe("broadcast storm surfaced on headless runs and traceroute (R49)", () => {
  beforeEach(reset);

  function stormingTriangle(): void {
    runConsoleScript(`
      add computer PC1 at 0 0
      add computer PC2 at 400 0
      add switch SW1 at 100 0
      add switch SW2 at 300 0
      add switch SW3 at 200 200
      managed SW1 on
      managed SW2 on
      managed SW3 on
      ip PC1 10.0.0.1/24
      ip PC2 10.0.0.2/24
      link PC1 SW1
      link PC2 SW2
      link SW1 SW2
      link SW2 SW3
      link SW3 SW1
      stp SW1 off
      stp SW2 off
      stp SW3 off
    `);
    runStpConvergence();
  }

  it("SimResult carries storm + the diagnosis, the log names it, and `run ping` prints it", () => {
    stormingTriangle();
    const r = exec("run ping PC1 PC2");
    const data = r.data as any;
    expect(data.storm).toBe(true);
    expect(data.diagnosis).toEqual([STORM_DIAGNOSIS]);
    expect(r.output).toContain(STORM_DIAGNOSIS);
    expect(drops()).toContain(STORM_DIAGNOSIS);
  });

  it("traceroute stops at the first storming probe instead of printing 30 silent hops", () => {
    stormingTriangle();
    const t = runTraceroute(byName("PC1"), "10.0.0.2");
    expect(typeof t).not.toBe("string");
    expect((t as any).storm).toBe(true);
    expect((t as any).hops.length).toBeLessThan(30);
    const out = exec("traceroute PC1 PC2").output;
    expect(out).toContain(STORM_DIAGNOSIS);
    expect(out).not.toContain("(destination not reached within 30 hops)");
  });

  it("a loop-free run reports storm: false", () => {
    lan();
    expect((exec("run ping PC1 PC2").data as any).storm).toBe(false);
  });
});

describe("ping output shows Time-Exceeded and Unreachable (R71)", () => {
  beforeEach(reset);

  it("a TTL that expires at the router prints `From <router> … Time to live exceeded`", () => {
    routed();
    const pcA = byName("PC-A");
    const text = runAnimated(pcA, buildPingEvents(pcA, "192.168.20.10", { ttl: 1 }), "192.168.20.10");
    expect(text).toContain("From 192.168.10.1 icmp_seq=1 Time to live exceeded");
    expect(text).toContain("+1 error, 100% packet loss");
  });

  it("a REJECT prints `Destination Port Unreachable` and SimResult names the sender", () => {
    routed();
    exec("cli RTR-1 enable");
    exec("cli RTR-1 iptables -A FORWARD -p icmp -j REJECT");
    const pcA = byName("PC-A");
    const r = exec("run ping PC-A 192.168.20.10");
    expect((r.data as any).unreachableFrom).toBe("192.168.10.1");
    expect(r.output[0]).toContain("Destination Port Unreachable from 192.168.10.1");
    const text = runAnimated(pcA, buildPingEvents(pcA, "192.168.20.10"), "192.168.20.10");
    expect(text).toContain("From 192.168.10.1 icmp_seq=1 Destination Port Unreachable");
  });
});

describe("traffic addressed to a router's own IP is answered or explained (R22)", () => {
  beforeEach(reset);

  it("a TCP SYN to a router port with no service is refused (RST), not timed out", () => {
    routed();
    const r = exec("run connect PC-A 192.168.10.1 22");
    expect((r.data as any).refused).toBe(true);
    expect(r.output[0]).toContain("refused (RST)");
    expect(drops().some(d => d.includes("no service listens on this port of the router"))).toBe(true);
  });

  it("a DNS query to the router gets ICMP Port Unreachable and a log line", () => {
    routed();
    exec("nameserver PC-A 192.168.10.1");
    const r = runSimulationHeadless(buildResolveEvents(byName("PC-A"), "web") as any, "pc-a", "web", "dns");
    expect(r.success).toBe(false);
    expect(r.unreachableFrom).toBe("192.168.10.1");
    expect(drops().some(d => d.includes("the router runs no DNS service"))).toBe(true);
  });
});
