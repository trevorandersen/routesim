/**
 * Likely-cause hints (src/hints.ts): the nearest-cause probe behind a failed
 * scenario check. "Why?" says what happened; the hint says what is most likely
 * wrong — the cause, never the answer — and says nothing when the failure
 * already names its cause or no probe fits.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { state } from "../src/state";
import { dom } from "../src/dom";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { SCENARIOS, checkScenario, loadScenario, getScenario } from "../src/scenarios";
import { syncScenarioPanel, runActiveScenarioCheck } from "../src/scenario-ui";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());
beforeEach(() => resetState());

// The hint for one ad-hoc check against whatever network is loaded.
const hint = (check: any) => checkScenario({ id: "t", name: "t", objective: "", topology: {}, checks: [{ label: "l", ...check }] }).checks[0].hint;
// The hints of a built-in scenario's checks as it is first loaded, by label.
function hintsOf(id: string): Record<string, string | undefined> {
  loadScenario(id);
  return Object.fromEntries(checkScenario(getScenario(id)!).checks.filter(c => !c.passed).map(c => [c.label, c.hint]));
}

describe("the troubleshooting scenarios: the hint names the fault that was planted", () => {
  it("a wrong default gateway — from either end of the flow", () => {
    const h = hintsOf("troubleshoot-gateway");
    expect(h["PC-A can reach PC-B"]).toBe("No device has PC-A's default gateway address 192.168.1.254.");
    expect(h["PC-B can reach PC-A"]).toBe("No device has PC-A's default gateway address 192.168.1.254, so its reply to PC-B cannot leave its subnet.");
    // The cause, not the answer: the right gateway is never spelled out.
    for (const text of Object.values(h)) expect(text).not.toMatch(/192\.168\.1\.1\b/);
  });

  it("a host on the wrong VLAN", () => {
    expect(hintsOf("troubleshoot-vlan")["PC-A can reach PC-W"]).toBe("PC-A (VLAN 10) and PC-W (VLAN 20) are in different VLANs, so they cannot reach each other directly.");
  });

  it("a filter rule dropping the wanted flow, and nothing stopping the unwanted one", () => {
    const h = hintsOf("troubleshoot-firewall");
    expect(h["SSH (22) connects"]).toBe("FW-1's FORWARD rules drop this flow.");
    expect(h["Telnet (23) is blocked"]).toBe("Nothing on FW-1 stops this flow yet.");
  });

  it("a static route pointing at a next hop nobody has", () => {
    expect(hintsOf("troubleshoot-static-route")["PC-A can reach PC-B"]).toBe("R1's static route to 192.168.2.0/24 points at next hop 10.0.0.5, an address no device has.");
  });

  it("a DNS record pointing at the wrong address — for the lookup and for the ping that used it", () => {
    const h = hintsOf("troubleshoot-dns");
    expect(h["web.corp resolves to the web server"]).toBe("SRV-1's record for web.corp points at 192.168.1.99.");
    expect(h["web.corp answers pings"]).toBe("web.corp resolves to 192.168.1.99, an address no device has — SRV-1's record for it is wrong.");
  });
});

describe("the build-it scenarios: the hint names what is still missing", () => {
  it("no route, no NAT, no port-forward, a private address on the internet", () => {
    expect(hintsOf("static-routes")["PC-A can reach PC-B"]).toBe("R1 has no route to 192.168.2.10 (PC-B's network 192.168.2.0/24).");
    expect(hintsOf("nat-gateway")["PC-A can ping the ISP server"]).toContain("no router on the way is translating (NAT) that address");
    expect(Object.values(hintsOf("port-forward"))[0]).toBe("R1 itself has nothing on that port, and no port-forward sends it on to an inside server.");
    expect(Object.values(hintsOf("across-the-internet"))[0]).toBe("10.0.0.10 is a private address: the internet cannot route to it.");
  });

  it("no sub-interface for the gateway, no nameserver, no dhcp-range, a web service that is off", () => {
    expect(hintsOf("router-on-a-stick")["VLAN 10 can reach VLAN 20"]).toBe("No device has PC-A's default gateway address 192.168.10.1.");
    const dns = hintsOf("dns-service");
    expect(dns["web.corp resolves to 192.168.1.80"]).toBe("PC-A has no nameserver configured, so it cannot look up web.corp.");
    expect(dns["PC-A can ping web.corp by name"]).toBe("PC-A has no nameserver configured, so it cannot look up web.corp.");
    expect(hintsOf("server-dhcp")["PC-A obtains a DHCP lease"]).toBe("SRV-1 has no dhcp-range configured, so it leases no addresses.");
    expect(Object.values(hintsOf("web-service"))[0]).toBe("WEB's web service is off.");
  });

  it("nothing cabled or associated yet", () => {
    expect(hintsOf("connect-lan")["PC-A can ping PC-B"]).toBe("PC-A is not cabled to anything.");
    expect(hintsOf("wifi-join")["LT-1 can reach SRV-1"]).toBe("LT-1 is not associated with an access point.");
  });
});

describe("silence where the failure already names its cause", () => {
  it("an unauthenticated WiFi link, an 802.1X port, a failed MACsec link and a switching loop get no hint", () => {
    for (const id of ["troubleshoot-wifi", "port-auth-8021x", "macsec-link", "secure-access", "spanning-tree"]) {
      const flows = Object.entries(hintsOf(id)).filter(([label]) => /reach|ping/i.test(label));
      expect(flows.length).toBeGreaterThan(0);
      for (const [label, text] of flows) expect({ id, label, hint: text }).toEqual({ id, label, hint: undefined });
    }
  });

  it("a passed check never carries one — every built-in scenario, after its reference solution", () => {
    const stray: string[] = [];
    for (const scenario of SCENARIOS) {
      resetState();
      const script = readFileSync(join(import.meta.dir, "..", "scenario-solutions", `${scenario.id}.routesim.txt`), "utf8");
      runConsoleScript(script);
      for (const check of checkScenario(scenario).checks) {
        if (check.passed ? (check.hint || check.why) : false) stray.push(`${scenario.id}: ${check.label}`);
        if (!check.passed) stray.push(`${scenario.id}: "${check.label}" still fails after the solution`);
      }
    }
    expect(stray).toEqual([]);
  });
});

describe("the probes, one fault at a time", () => {
  // PC1 — SW — R1 — PC2 : two subnets, everything right.
  const build = () => expect(runConsoleScript(`
    add computer PC1 at 0 0
    add switch SW at 150 0
    add router R1 at 300 0
    add computer PC2 at 450 0
    link PC1 SW
    link SW R1
    link R1 PC2
    ip PC1 10.0.1.10/24
    gateway PC1 10.0.1.1
    ip PC2 10.0.2.10/24
    gateway PC2 10.0.2.1
    interface R1 SW ip 10.0.1.1/24
    interface R1 PC2 ip 10.0.2.1/24
  `).filter(r => !r.ok)).toEqual([]);
  const ping = { kind: "ping", from: "PC1", to: "PC2" };

  it("a working network has nothing to hint at", () => {
    build();
    expect(hint(ping)).toBeUndefined();
  });

  it("the origin: powered off, no address", () => {
    build(); exec("power PC1 off");
    expect(hint(ping)).toBe("PC1 is powered off.");
    exec("power PC1 on"); exec("cli PC1 ip addr flush dev eth0");
    expect(hint(ping)).toBe("PC1 has no IP address.");
  });

  it("the gateway: missing, off the subnet, a host, an unplugged router port", () => {
    build(); exec("cli PC1 ip route del default");
    expect(hint(ping)).toBe("PC1 has no default gateway, so it cannot send anything off its own subnet (10.0.1.0/24).");
    exec("gateway PC1 10.0.9.1");
    expect(hint(ping)).toBe("PC1's default gateway 10.0.9.1 is not on its own subnet (10.0.1.0/24) — a host can only use a gateway it can reach directly.");
    runConsoleScript("add computer PC3 at 0 200\nlink PC3 SW\nip PC3 10.0.1.30/24\ngateway PC1 10.0.1.30");
    expect(hint(ping)).toBe("PC1's default gateway 10.0.1.30 is PC3, which does not route.");
    runConsoleScript("gateway PC1 10.0.1.1\nunlink SW R1");
    expect(hint(ping)).toBe("PC1's default gateway 10.0.1.1 is R1's Ethernet2, which has no cable.");
  });

  it("the target: nobody has the address, powered off, and no way back for the reply", () => {
    build();
    expect(hint({ kind: "ping", from: "PC1", to: "10.0.1.99" })).toBe("No device has the address 10.0.1.99.");
    exec("power PC2 off");
    expect(hint(ping)).toBe("PC2 is powered off.");
    exec("power PC2 on"); exec("cli PC2 ip route del default");
    expect(hint(ping)).toBe("PC2 has no default gateway, so its reply to PC1 cannot leave its subnet.");
  });

  it("a closed port, a stopped dnsmasq, a nameserver that is not one, a missing record", () => {
    build(); exec("ports PC2 22");
    expect(hint({ kind: "tcp", from: "PC1", to: "PC2", port: 80 })).toBe("Nothing listens on port 80 at PC2.");
    runConsoleScript("add server SRV at 150 200\nlink SRV SW\nip SRV 10.0.1.53/24\nnameserver PC1 10.0.1.53");
    expect(hint({ kind: "dns", from: "PC1", name: "intranet.corp" })).toBe("SRV has no record for intranet.corp.");
    exec("cli SRV systemctl stop dnsmasq");
    expect(hint({ kind: "dns", from: "PC1", name: "intranet.corp" })).toBe("dnsmasq is stopped on SRV, so it answers no DNS queries.");
    exec("nameserver PC1 10.0.2.10");
    expect(hint({ kind: "dns", from: "PC1", name: "intranet.corp" })).toBe("PC1's nameserver 10.0.2.10 is PC2, which runs no DNS service.");
    exec("nameserver PC1 10.0.1.77");
    expect(hint({ kind: "dns", from: "PC1", name: "intranet.corp" })).toBe("PC1's nameserver 10.0.1.77 is an address no device has.");
  });

  it("DHCP: no server, a stopped one, a router with no address on the segment", () => {
    runConsoleScript("add computer PC1 at 0 0\nadd switch SW at 150 0\nlink PC1 SW");
    expect(hint({ kind: "dhcp", host: "PC1" })).toBe("No DHCP server is on PC1's segment.");
    runConsoleScript("add router R1 at 300 0\nlink SW R1");
    expect(hint({ kind: "dhcp", host: "PC1" })).toBe("R1's interface on PC1's segment has no address, so it cannot lease any.");
    runConsoleScript("add server SRV at 150 200\nlink SRV SW\nip SRV 10.0.1.2/24\ncli SRV echo dhcp-range=10.0.1.100,10.0.1.150 >> /etc/dnsmasq.conf\ncli SRV systemctl stop dnsmasq");
    expect(hint({ kind: "dhcp", host: "PC1" })).toBe("dnsmasq is stopped on SRV, so it is not answering DHCP.");
  });

  it("a host whose VLAN is not the one its gateway's sub-interface serves", () => {
    expect(runConsoleScript(`
      add switch MSW at 150 0
      managed MSW
      add router R1 at 300 0
      add computer PC1 at 0 0
      add computer PC2 at 0 200
      link R1 MSW
      link PC1 MSW
      link PC2 MSW
      vlan MSW add 10
      vlan MSW add 20
      port MSW Ethernet1 mode trunk
      port MSW Ethernet2 vlan 20
      port MSW Ethernet3 vlan 20
      interface R1 MSW ip 10.0.10.1/24 vlan 10
      interface R1 MSW ip 10.0.20.1/24 vlan 20
      ip PC1 10.0.10.10/24
      gateway PC1 10.0.10.1
      ip PC2 10.0.20.10/24
      gateway PC2 10.0.20.1
    `).filter(r => !r.ok)).toEqual([]);
    expect(hint({ kind: "ping", from: "PC1", to: "PC2" })).toBe("PC1 is in VLAN 20, but its gateway 10.0.10.1 is R1's sub-interface for VLAN 10.");
  });
});

describe("where the hint is shown", () => {
  it("the goal banner and `scenario check` carry it beneath the reasons", () => {
    registerNoopCallbacks({ syncScenarioPanel });
    exec("scenario load troubleshoot-gateway");
    const out = exec("scenario check").output;
    const at = out.findIndex(l => l.startsWith("    likely cause: "));
    expect(out[at]).toBe("    likely cause: No device has PC-A's default gateway address 192.168.1.254.");
    expect(out[at - 1].startsWith("    why: ")).toBe(true);
    runActiveScenarioCheck();
    const banner = dom.scenarioChecks.innerHTML;
    expect(banner).toContain(`<span class="scenario-why-title">Likely cause:</span>No device has PC-A&#39;s default gateway address 192.168.1.254.`);
    registerNoopCallbacks();
  });
});
