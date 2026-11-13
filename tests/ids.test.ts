/**
 * IDS (Snort) + SPAN port mirroring. A passive sensor on a switch's monitor port
 * sees a mirrored copy of traffic and raises alerts on rule matches, without ever
 * sitting in the data path.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { undo as undoState } from "../src/state";
import { state } from "../src/state";
import { runConsoleCommand as exec, runConsoleScript, exportTopologyScript } from "../src/commands";
import { linkedPortsFor } from "../src/devices";
import { parseSnortRule, matchSnortRule, runIdsRules, formatAlert, snortRuleIssue } from "../src/snort";
import { runSwitchTerminalCommand, showSwitchMirror } from "../src/terminal/switch";
import { showIdsRules, addIdsRule, runIdsTerminalCommand } from "../src/terminal/ids";
import { renderMirrorSection } from "../src/inspector";
import { buildConfigPayload } from "../src/config";
import { normaliseConfig } from "../src/normalise";
import { createIcmpEchoRequest, createIcmpEchoReply, createTcpSegment, createArpRequest, createDnsQuery, createHttpRequest, createHttpResponse } from "../src/frame";
import { registerNoopCallbacks, resetState } from "./helpers";
import { freshNameCounters } from "../src/device-registry";

beforeAll(() => registerNoopCallbacks());

function reset() {
  resetState();
  state.nameCounters = freshNameCounters();
  state.configStore = { version: 1, configs: {} } as any;
}

// SW1 (managed) with PC1, PC2, and an IDS sensor; SPAN mirrors all traffic to the
// IDS's port. Returns the devices.
function spanTopology() {
  exec("add switch SW1 at 0 0");
  exec("add computer PC1 at -150 0");
  exec("add computer PC2 at 150 0");
  exec("add ids IDS1 at 0 150");
  const sw = state.devices.find(d => d.name === "SW1")!;
  sw.config.managed = true;
  exec("ip PC1 10.0.0.1/24");
  exec("ip PC2 10.0.0.2/24");
  exec("link PC1 SW1");
  exec("link PC2 SW1");
  exec("link IDS1 SW1");
  // Find the switch port the IDS is cabled to, and mirror everything to it.
  const ids = state.devices.find(d => d.name === "IDS1")!;
  const ports = linkedPortsFor(sw.id);
  const idx = ports.findIndex((p: any) => p?.peer?.id === ids.id);
  sw.config.mirror = { name: "MON", dest: `Ethernet${idx + 1}` };
  return { sw, ids };
}

describe("Snort rule engine", () => {
  it("parses a rule and matches the right traffic", () => {
    const rule = parseSnortRule(`alert tcp any any -> any 23 (msg:"Telnet"; sid:1000002; rev:1;)`)!;
    expect(rule.action).toBe("alert");
    expect(rule.proto).toBe("tcp");
    expect(rule.dstPort).toBe("23");
    expect(rule.msg).toBe("Telnet");
    expect(rule.sid).toBe(1000002);
    // A SYN to 23 matches; a SYN to 80 does not; ICMP does not.
    const telnet = createTcpSegment("02:00:00:00:00:01", "02:00:00:00:00:02", "10.0.0.1", "10.0.0.2", 40000, 23, "syn");
    const web = createTcpSegment("02:00:00:00:00:01", "02:00:00:00:00:02", "10.0.0.1", "10.0.0.2", 40000, 80, "syn");
    const ping = createIcmpEchoRequest("02:00:00:00:00:01", "02:00:00:00:00:02", "10.0.0.1", "10.0.0.2", 64);
    expect(matchSnortRule(rule, telnet)).toBe(true);
    expect(matchSnortRule(rule, web)).toBe(false);
    expect(matchSnortRule(rule, ping)).toBe(false);
  });

  it("a CIDR + itype rule matches by subnet and ICMP type", () => {
    const rule = parseSnortRule(`alert icmp any any -> 10.0.0.0/24 any (msg:"ping to LAN"; itype:8; sid:1;)`)!;
    const echo = createIcmpEchoRequest("x", "y", "192.168.1.1", "10.0.0.5", 64);          // itype 8 into the /24
    const arp = createArpRequest("x", "1.1.1.1", "1.1.1.2");
    expect(matchSnortRule(rule, echo)).toBe(true);
    expect(matchSnortRule(rule, arp)).toBe(false);   // ARP has no IP — never matches
  });

  it("a bare/comment line parses to null", () => {
    expect(parseSnortRule("")).toBeNull();
    expect(parseSnortRule("# a comment")).toBeNull();
    expect(parseSnortRule("not a rule")).toBeNull();
  });

  it("rejects the unsupported <- direction and keeps itype:0 (echo reply)", () => {
    expect(parseSnortRule(`alert tcp any any <- any any (sid:1;)`)).toBeNull();   // <- not supported
    const reply = parseSnortRule(`alert icmp any any -> any any (msg:"reply"; itype:0; sid:2;)`)!;
    expect(reply.itype).toBe(0);
    expect(matchSnortRule(reply, createIcmpEchoReply("x", "y", "1.1.1.1", "1.1.1.2", 64))).toBe(true);   // itype 0 matches
    expect(matchSnortRule(reply, createIcmpEchoRequest("x", "y", "1.1.1.1", "1.1.1.2", 64))).toBe(false); // itype 8 does not
  });

  it("rejects a header-shaped rule that can never match, with a reason (R26)", () => {
    // Each used to parse to a rule, load, and silently never fire.
    const cases: [string, RegExp][] = [
      [`alert tcp $EXTERNAL_NET any -> $HOME_NET 22 (sid:1;)`, /invalid source IP/],
      [`alert tcp any any -> !10.0.0.0/24 any (sid:1;)`, /invalid destination IP/],
      [`alert tcp any any -> [10.0.0.1,10.0.0.2] any (sid:1;)`, /invalid destination IP/],
      [`alert tpc any any -> any any (sid:1;)`, /unknown protocol "tpc"/],
      [`alert tcp any any -> any 99999 (sid:1;)`, /invalid destination port/],
      [`alert tcp any any -> any any (flow:established; sid:1;)`, /unsupported option "flow"/],
    ];
    for (const [rule, reason] of cases) {
      expect(snortRuleIssue(rule)).toMatch(reason);
      expect(parseSnortRule(rule)).toBeNull();   // not loaded into the active set
    }
    // A blank/comment line is not an error, and a good rule has no issue.
    expect(snortRuleIssue("# note")).toBeNull();
    expect(snortRuleIssue(`alert tcp 10.0.0.0/24 any -> any [22,80,443] (msg:"ok"; flags:S; sid:1;)`)).toBeNull();
  });

  it("addIdsRule surfaces the reason instead of a generic error (R26)", () => {
    const cfg: any = { idsRules: [] };
    const msg = addIdsRule({ config: cfg } as any, `alert tcp $HOME_NET any -> any 22 (sid:1;)`);
    expect(msg).toMatch(/invalid source IP/);
    expect(cfg.idsRules).toEqual([]);   // nothing loaded
  });

  it("a rule added after the first parse is not lost to the memo cache (regression)", () => {
    // Mirror addIdsRule's mutation pattern, then re-evaluate the SAME config.
    const cfg: any = { idsRules: [`alert icmp any any -> any any (msg:"icmp"; sid:1;)`] };
    runIdsRules(cfg.idsRules, createIcmpEchoRequest("x", "y", "1.1.1.1", "1.1.1.2", 64));  // parses + memoises
    addIdsRule({ config: cfg } as any, `alert udp any any -> any 53 (msg:"DNS"; sid:9;)`);
    const dns = createDnsQuery("aa:bb", "cc:dd", "10.0.0.1", "10.0.0.2", "evil.example");
    const hits = runIdsRules(cfg.idsRules, dns);
    expect(hits.some(h => h.rule.sid === 9)).toBe(true);   // the newly-added rule matches
  });
});

describe("SPAN mirroring + passive IDS", () => {
  beforeEach(reset);

  it("mirrors traffic to the sensor, which alerts but never forwards", () => {
    const { ids } = spanTopology();
    const r = exec("run ping PC1 PC2");
    expect(r.ok).toBe(true);
    expect((r.data as any).success).toBe(true);   // the IDS doesn't disrupt the data path
    // The default ICMP rule fired on the mirrored echo request.
    const alerts = ids.config.alerts || [];
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.some(a => a.includes("ICMP traffic detected"))).toBe(true);
    expect(alerts.every(a => a.startsWith("[**]"))).toBe(true);   // Snort fast format
  });

  it("a Telnet attempt across the switch trips the Telnet rule", () => {
    const { ids } = spanTopology();
    // PC2 listens only on 23 so the connect succeeds and crosses the switch.
    state.devices.find(d => d.name === "PC2")!.config.openPorts = [23];
    exec("run connect PC1 PC2 23");
    expect((ids.config.alerts || []).some(a => a.includes("Telnet connection attempt"))).toBe(true);
  });

  it("with no SPAN session the sensor sees nothing", () => {
    const { sw, ids } = spanTopology();
    delete sw.config.mirror;            // remove the mirror session
    exec("run ping PC1 PC2");
    expect((ids.config.alerts || []).length).toBe(0);
  });

  it("alerts report only the current run — they don't accumulate across runs (regression)", () => {
    const { ids } = spanTopology();
    exec("run ping PC1 PC2");
    const first = (ids.config.alerts || []).length;
    expect(first).toBeGreaterThan(0);
    exec("run ping PC1 PC2");           // a second run must not stack on the first
    expect((ids.config.alerts || []).length).toBe(first);
  });
});

describe("IDS — console, CLI, and round-trip", () => {
  beforeEach(reset);

  function build() {
    exec("add switch SW1 at 0 0");
    exec("add ids IDS1 at 0 150");
    state.devices.find(d => d.name === "SW1")!.config.managed = true;
    exec("link IDS1 SW1");
  }

  it("the mirror console command sets and clears a SPAN session and rejects unmanaged switches", () => {
    build();
    const sw = state.devices.find(d => d.name === "SW1")!;
    expect(exec("mirror SW1 Ethernet1").ok).toBe(true);
    expect(sw.config.mirror?.dest).toBe("Ethernet1");
    expect(exec("mirror SW1 off").ok).toBe(true);
    expect(sw.config.mirror).toBeUndefined();
    exec("add switch SW2 at 200 0");   // unmanaged
    expect(exec("mirror SW2 Ethernet1").ok).toBe(false);
  });

  it("the SONiC mirror CLI configures a session and show reports it", () => {
    build();
    const sw = state.devices.find(d => d.name === "SW1")!;
    runSwitchTerminalCommand(sw, "config mirror_session span add MON Ethernet2 Ethernet1");
    expect(sw.config.mirror).toEqual({ name: "MON", dest: "Ethernet2", sources: ["Ethernet1"] });
    expect(showSwitchMirror(sw)).toContain("Ethernet2");
  });

  it("the SONiC mirror CLI warns that a tx/both direction isn't simulated (R96)", () => {
    build();
    const sw = state.devices.find(d => d.name === "SW1")!;
    state.terminal.lines = [];
    runSwitchTerminalCommand(sw, "config mirror_session span add MON Ethernet2 Ethernet1 tx");
    // The session is still created (rx is what we model), but the ignored direction is called out.
    expect(sw.config.mirror).toEqual({ name: "MON", dest: "Ethernet2", sources: ["Ethernet1"] });
    expect(state.terminal.lines.at(-1)!.text).toContain("only rx");
    // An explicit rx carries no warning.
    state.terminal.lines = [];
    runSwitchTerminalCommand(sw, "config mirror_session span add MON Ethernet2 Ethernet1 rx");
    expect(state.terminal.lines.at(-1)!.text).not.toContain("only rx");
  });

  it("the inspector mirror GUI renders source-port checkboxes (all ticked = whole switch; a subset ticks only those, and the monitor port is excluded)", () => {
    const { sw } = spanTopology();   // PC1=Ethernet1, PC2=Ethernet2, IDS1=Ethernet3 (the dest)
    const cbState = (html: string, port: string) => {
      const m = html.match(new RegExp(`data-port="${port}"([^>]*)>`));
      return { present: !!m, checked: !!m && m[1].includes("checked") };
    };
    // No sources stored → mirror everything: both source ports ticked, dest excluded.
    let html = renderMirrorSection(sw);
    expect(cbState(html, "Ethernet1")).toEqual({ present: true, checked: true });
    expect(cbState(html, "Ethernet2")).toEqual({ present: true, checked: true });
    expect(cbState(html, "Ethernet3").present).toBe(false);   // the monitor port can't mirror itself
    // Narrow the session to only Ethernet1 → Ethernet1 ticked, Ethernet2 unticked.
    exec("mirror SW1 Ethernet3 Ethernet1");
    html = renderMirrorSection(sw);
    expect(cbState(html, "Ethernet1").checked).toBe(true);
    expect(cbState(html, "Ethernet2").checked).toBe(false);
  });

  it("the Snort terminal CLI views/edits local.rules and reports a version", () => {
    build();
    const ids = state.devices.find(d => d.name === "IDS1")!;
    state.terminal.lines = [];
    runIdsTerminalCommand(ids, "snort -V");
    expect(state.terminal.lines.at(-1)!.text).toContain("Snort++");
    const before = (ids.config.idsRules || []).length;
    runIdsTerminalCommand(ids, `echo 'alert udp any any -> any 53 (msg:"DNS"; sid:9001;)' >> /etc/snort/rules/local.rules`);
    expect((ids.config.idsRules || []).length).toBe(before + 1);
    runIdsTerminalCommand(ids, "snort -T");
    expect(state.terminal.lines.at(-1)!.text).toContain("validated");
    runIdsTerminalCommand(ids, "echo -n > /etc/snort/rules/local.rules");
    expect((ids.config.idsRules || []).length).toBe(0);
  });

  it("the Snort shell refreshes the inspector after editing rules/alerts (R87)", () => {
    build();
    const ids = state.devices.find(d => d.name === "IDS1")!;
    let panels = 0;
    registerNoopCallbacks({ syncPanel: () => { panels++; } });
    panels = 0;
    runIdsTerminalCommand(ids, `echo 'alert udp any any -> any 53 (msg:"DNS"; sid:9100;)' >> /etc/snort/rules/local.rules`);
    expect(panels).toBeGreaterThan(0);   // the add re-synced the panel
    panels = 0;
    runIdsTerminalCommand(ids, "echo -n > /etc/snort/rules/local.rules");
    expect(panels).toBeGreaterThan(0);   // the clear re-synced the panel
    registerNoopCallbacks();             // restore the suite default
  });

  it("idsrule adds and clears rules; addIdsRule rejects malformed rules", () => {
    build();
    const ids = state.devices.find(d => d.name === "IDS1")!;
    const before = (ids.config.idsRules || []).length;
    expect(exec(`idsrule IDS1 alert udp any any -> any 53 (msg:"DNS"; sid:5; rev:1;)`).ok).toBe(true);
    expect((ids.config.idsRules || []).length).toBe(before + 1);
    expect(addIdsRule(ids, "this is not a rule").startsWith("ERROR")).toBe(true);
    expect(exec("idsrule IDS1 clear").ok).toBe(true);
    expect((ids.config.idsRules || []).length).toBe(0);
    expect(showIdsRules(ids)).toContain("local.rules is empty");
  });

  it("rules + a mirror session round-trip through JSON and the script export", () => {
    build();
    const sw = state.devices.find(d => d.name === "SW1")!;
    const ids = state.devices.find(d => d.name === "IDS1")!;
    exec("mirror SW1 Ethernet1");
    exec("idsrule IDS1 clear");
    exec(`idsrule IDS1 alert tcp any any -> any 22 (msg:"SSH"; sid:42; rev:1;)`);

    // JSON round-trip.
    const payload = buildConfigPayload();
    const reSw = normaliseConfig(payload as any).devices.find((d: any) => d.name === "SW1")!;
    const reIds = normaliseConfig(payload as any).devices.find((d: any) => d.name === "IDS1")!;
    expect(reSw.config.mirror!.dest).toBe("Ethernet1");
    expect(reIds.config.idsRules).toEqual([`alert tcp any any -> any 22 (msg:"SSH"; sid:42; rev:1;)`]);

    // Script export replays the exact rule set + the SPAN session.
    const script = exportTopologyScript();
    expect(script).toContain("mirror SW1 Ethernet1");
    expect(script).toContain("idsrule IDS1 clear");
    expect(script).toContain(`idsrule IDS1 alert tcp any any -> any 22 (msg:"SSH"; sid:42; rev:1;)`);
    reset();
    runConsoleScript(script);
    const ids2 = state.devices.find(d => d.name === "IDS1")!;
    expect(ids2.config.idsRules).toEqual([`alert tcp any any -> any 22 (msg:"SSH"; sid:42; rev:1;)`]);
    expect(state.devices.find(d => d.name === "SW1")!.config.mirror?.dest).toBe("Ethernet1");
  });
});

describe("snort — flags exactness, port specs, non-IP alerts (LOW sweep)", () => {
  const syn = () => createTcpSegment("02:00:00:00:00:01", "02:00:00:00:00:02", "10.0.0.1", "10.0.0.2", 40000, 80, "syn", 64, null);
  const synAck = () => createTcpSegment("02:00:00:00:00:02", "02:00:00:00:00:01", "10.0.0.2", "10.0.0.1", 80, 40000, "syn-ack", 64, null);
  const rule = (opts: string, ports = "any any -> any any") => parseSnortRule(`alert tcp ${ports} (msg:"t"; ${opts} sid:1;)`)!;

  it("`flags:S` is EXACT — a SYN-ACK no longer matches; `S+` and `A*` do", () => {
    expect(matchSnortRule(rule("flags:S;"), syn())).toBe(true);
    expect(matchSnortRule(rule("flags:S;"), synAck())).toBe(false);   // used to fire (subset match)
    expect(matchSnortRule(rule("flags:S+;"), synAck())).toBe(true);
    expect(matchSnortRule(rule("flags:A*;"), synAck())).toBe(true);
    expect(matchSnortRule(rule("flags:A*;"), syn())).toBe(false);
  });

  it("`flags:0` matches only a segment with no flags set, not every TCP segment (R75)", () => {
    // A NULL scan (no flag bits) is the only thing flags:0 should fire on; our
    // sim's segments always carry a flag, so it matches none of them — the point
    // is that it no longer fires on SYN/SYN-ACK the way the strip-to-empty guard did.
    expect(matchSnortRule(rule("flags:0;"), syn())).toBe(false);
    expect(matchSnortRule(rule("flags:0;"), synAck())).toBe(false);
  });

  it("port specs: ranges, open ranges, lists, and negation", () => {
    const to = (ports: string) => matchSnortRule(rule("", `any any -> any ${ports}`), syn());   // dst port 80
    expect(to("80:443")).toBe(true);
    expect(to("81:443")).toBe(false);
    expect(to(":1024")).toBe(true);
    expect(to("1024:")).toBe(false);
    expect(to("[22,80]")).toBe(true);
    expect(to("[22,443:8080]")).toBe(false);
    expect(to("!80")).toBe(false);
    expect(to("!22")).toBe(true);
  });

  it("formatAlert on a non-IP frame does not throw", () => {
    const r = rule("");
    expect(() => formatAlert(r, createArpRequest("02:00:00:00:00:01", "10.0.0.1", "10.0.0.2"))).not.toThrow();
    expect(formatAlert(r, createArpRequest("02:00:00:00:00:01", "10.0.0.1", "10.0.0.2"))).toContain("NON-IP");
  });
});

describe("Snort content matches HTTP, not only DNS (R25)", () => {
  const macA = "02:00:00:00:00:01", macB = "02:00:00:00:00:02";
  const cRule = (content: string, ports = "any any -> any 80") => parseSnortRule(`alert tcp ${ports} (msg:"c"; content:"${content}"; sid:1;)`)!;

  it("a content rule fires on an HTTP request's path and Host, not a bare SYN", () => {
    const req = createHttpRequest(macA, macB, "10.0.0.1", "10.0.0.2", 40000, 80, "/admin", "srv.example");
    expect(matchSnortRule(cRule("/admin"), req)).toBe(true);
    expect(matchSnortRule(cRule("srv.example"), req)).toBe(true);
    expect(matchSnortRule(cRule("/login"), req)).toBe(false);
    const syn = createTcpSegment(macA, macB, "10.0.0.1", "10.0.0.2", 40000, 80, "syn", 64, null);
    expect(matchSnortRule(cRule("/admin"), syn)).toBe(false);   // no HTTP content on a bare SYN
  });

  it("a content rule fires on an HTTP response's status text and served title", () => {
    const resp = createHttpResponse(macB, macA, "10.0.0.2", "10.0.0.1", 80, 40000, 200, "OK", "Welcome");
    expect(matchSnortRule(cRule("Welcome", "any 80 -> any any"), resp)).toBe(true);
    expect(matchSnortRule(cRule("OK", "any 80 -> any any"), resp)).toBe(true);
    expect(matchSnortRule(cRule("Forbidden", "any 80 -> any any"), resp)).toBe(false);
  });

  it("DNS-name content matching still works (regression on the content-buffer rename)", () => {
    const q = createDnsQuery(macA, macB, "10.0.0.1", "10.0.0.2", "evil.example");
    expect(matchSnortRule(parseSnortRule(`alert udp any any -> any 53 (msg:"d"; content:"evil"; sid:1;)`)!, q)).toBe(true);
    expect(matchSnortRule(parseSnortRule(`alert udp any any -> any 53 (msg:"d"; content:"good"; sid:1;)`)!, q)).toBe(false);
  });
});

describe("the IDS shell keeps the undo contract (G2-03)", () => {
  it("a rule added through the terminal is undone by one undo", () => {
    resetState();
    runConsoleScript("add ids IDS at 0 0");
    const ids = state.devices.find(d => d.name === "IDS")!;
    state.terminal = { deviceId: ids.id, mode: "exec", interfacePeerId: null, interfaceVlanTag: null, lines: [], history: [], historyIndex: -1 } as any;
    const before = ((ids.config as any).idsRules || []).length;
    runIdsTerminalCommand(ids, `echo 'alert tcp any any -> any 22 (msg:"ssh"; sid:900;)' >> /etc/snort/rules/local.rules`);
    expect(((ids.config as any).idsRules || []).length).toBe(before + 1);
    undoState();
    expect(((state.devices.find(d => d.name === "IDS")!.config as any).idsRules || []).length).toBe(before);
  });
});
