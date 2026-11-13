/**
 * Export → replay → compare. The script export claims completeness: "the command
 * set can express everything the GUI can build". This suite holds it to that.
 * For every built-in topology and scenario, and for a set of authored networks
 * that exercise the awkward corners, it exports the network as a script,
 * replays the script from an empty canvas, and compares the two networks'
 * saved configuration field by field — nothing may be rejected on the way.
 *
 * It began as a one-off probe in the November 2026 review, which is how R32
 * (ports swap), R36 (credentials do not replay), R79 (VLAN names lost) and R81
 * (collapsed LANs and a device named "at") were found. Kept permanent so the
 * next field added to a device has to round-trip too.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state, defaultConfig, vlanRoasConfig, routerMeshConfig, wifiVlanConfig } from "../src/state";
import { runConsoleScript, runConsoleCommand as exec, exportTopologyScript } from "../src/commands";
import { applyConfigWithoutUndo, buildConfigPayload } from "../src/config";
import { normaliseConfig } from "../src/normalise";
import { collapseLan, moveDevice, macsecState } from "../src/devices";
import { USER_ADDABLE_TYPES } from "../src/device-registry";
import { SCENARIOS } from "../src/scenarios";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());
beforeEach(() => resetState());

const dev = (name: string) => state.devices.find(d => d.name === name)!;

// The saved configuration with everything that is not the network removed or
// made comparable: ids become names (they are regenerated on replay), devices
// and links are ordered by name, and an address with no stored prefix is
// compared as the /24 it means.
function canonical(): { devices: any[]; links: any[] } {
  const payload: any = JSON.parse(JSON.stringify(buildConfigPayload()));
  const names = new Map<string, string>(payload.devices.map((d: any) => [d.id, d.name]));
  const named = (id: string) => names.get(id) ?? id;
  const devices = payload.devices.map((d: any) => {
    const c = d.config || {};
    if (c.ipv4Address) c.prefixLength = c.prefixLength ?? 24;
    if (Array.isArray(c.interfaces)) {
      c.interfaces = c.interfaces
        .map((i: any) => ({ ...i, peerId: named(i.peerId), prefixLength: i.ipv4Address ? (i.prefixLength ?? 24) : i.prefixLength, macAddress: undefined, name: undefined }))
        .sort((a: any, b: any) => `${a.peerId}:${a.vlanTag}`.localeCompare(`${b.peerId}:${b.vlanTag}`));
    }
    if (c.macsec) c.macsec = Object.fromEntries(Object.entries(c.macsec).map(([peer, value]) => [named(peer), value]));
    if (Array.isArray(c.members)) c.members = c.members.map(named).sort();
    if (Array.isArray(c.absorbedLans)) c.absorbedLans = c.absorbedLans.map(named).sort();
    if (c.anchorId) c.anchorId = named(c.anchorId);
    return { ...d, id: undefined, collapsedBy: d.collapsedBy ? named(d.collapsedBy) : undefined, x: Math.round(d.x), y: Math.round(d.y), config: c };
  }).sort((a: any, b: any) => a.name.localeCompare(b.name));
  const links = payload.links.map((l: any) => {
    const ends = [named(l.from), named(l.to)].sort();
    return { ...l, from: undefined, to: undefined, fromPort: undefined, toPort: undefined, collapsedBy: l.collapsedBy ? named(l.collapsedBy) : undefined, a: ends[0], b: ends[1] };
  }).sort((a: any, b: any) => `${a.a}:${a.b}`.localeCompare(`${b.a}:${b.b}`));
  return { devices, links };
}

// Field-level differences, as "path: before -> after" lines.
function differences(before: unknown, after: unknown, path = "", out: string[] = []): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return out;
  const bothObjects = before && after && typeof before === "object" && typeof after === "object" && Array.isArray(before) === Array.isArray(after);
  if (!bothObjects) { out.push(`${path}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`); return out; }
  for (const key of new Set([...Object.keys(before as object), ...Object.keys(after as object)])) {
    differences((before as any)[key], (after as any)[key], `${path}.${key}`, out);
  }
  return out;
}

// Export the network on the canvas, replay it from empty, and report what the
// replay rejected and how the result differs.
function roundTrip(): { rejected: string[]; diffs: string[]; script: string } {
  const before = canonical();
  const script = exportTopologyScript();
  const results = runConsoleScript(script);
  const rejected = results.filter(r => !r.ok).map(r => r.output.join(" "));
  return { rejected, diffs: differences(before, canonical()), script };
}

describe("export → replay: every built-in network", () => {
  const networks: [string, any][] = [
    ["topology:basic", defaultConfig], ["topology:vlan-roas", vlanRoasConfig],
    ["topology:router-mesh", routerMeshConfig], ["topology:wifi-vlan", wifiVlanConfig],
    ...SCENARIOS.map(s => [`scenario:${s.id}`, s.topology] as [string, any]),
  ];
  for (const [name, topology] of networks) {
    it(`${name} replays to the same network, with nothing rejected`, () => {
      applyConfigWithoutUndo(normaliseConfig(topology));
      const { rejected, diffs, script } = roundTrip();
      expect(rejected).toEqual([]);
      expect(diffs).toEqual([]);
      expect(exportTopologyScript()).toBe(script);               // and the export is a fixed point
    });
  }
});

describe("export → replay: the awkward corners", () => {
  it("credentials: an empty password, a key with a space, names with spaces (R36)", () => {
    runConsoleScript(`
      add server "Auth Server" at 100 100
      add switch "Core SW" at 300 100
      add computer "My PC" at 500 100
      add switch "Edge SW" at 300 300
      link "Auth Server" "Core SW"
      link "My PC" "Core SW"
      link "Core SW" "Edge SW"
      managed "Core SW" on
      radius "Auth Server" alice ""
      radius "Auth Server" "bob smith" "p w"
      supplicant "My PC" alice ""
      portauth "Core SW" Ethernet2 auto
      macsec "Core SW" "Edge SW" "my secret key" must
      macsec "Edge SW" "Core SW" "my secret key" must
      macsec "My PC" "Core SW" dot1x should
    `);
    expect(dev("Auth Server").config!.radius!.users).toEqual([{ identity: "alice", password: "" }, { identity: "bob smith", password: "p w" }]);
    const { rejected, diffs, script } = roundTrip();
    expect(script).toContain('supplicant "My PC" alice ""');        // the empty password is written, not dropped
    expect(script).toContain('radius "Auth Server" alice ""');
    expect(script).toContain('macsec "Core SW" "Edge SW" "my secret key" must');
    expect(rejected).toEqual([]);
    expect(diffs).toEqual([]);
    expect(dev("Core SW").config!.macsec![dev("Edge SW").id]).toEqual({ cak: "my secret key", mode: "must" });   // not key "my", mode should
    expect(dev("My PC").config!.dot1x).toEqual({ identity: "alice", password: "" });
  });

  it("nftables: the language toggle, a drop policy and its rules replay (issue #1)", () => {
    runConsoleScript(`
      add firewall FW at 100 100
      add computer A at 300 100
      add computer B at 500 100
      link A FW
      link FW B
      rulelang FW nftables
      cli FW nft add chain inet filter forward { policy drop ; }
      cli FW nft add rule inet filter forward ct state established,related accept
      cli FW nft add rule inet filter forward ip saddr 10.0.0.5 tcp dport 22 accept
      cli FW nft add rule inet filter forward tcp dport 23 reject with tcp reset
    `);
    expect(dev("FW").config!.ruleLang).toBe("nftables");
    expect(dev("FW").config!.policy!.forward).toBe("drop");
    expect(dev("FW").config!.rules!.length).toBe(3);
    const { rejected, diffs, script } = roundTrip();
    expect(script).toContain("rulelang FW nftables");
    expect(script).toContain("nft add rule inet filter forward ip saddr 10.0.0.5 tcp dport 22 accept");
    expect(rejected).toEqual([]);
    expect(diffs).toEqual([]);
  });

  it("VLAN names survive (R79)", () => {
    runConsoleScript(`
      add switch SW at 100 100
      managed SW on
      vlan SW add 10 Sales
      vlan SW add 20 "Guest WiFi"
      vlan SW add 30
    `);
    expect(dev("SW").config!.vlans).toEqual([{ id: 1, name: "default" }, { id: 10, name: "Sales" }, { id: 20, name: "Guest WiFi" }, { id: 30, name: "Vlan30" }]);
    const { rejected, diffs, script } = roundTrip();
    expect(script).toContain("vlan SW add 10 Sales");
    expect(script).toContain('vlan SW add 20 "Guest WiFi"');
    expect(script).toMatch(/^vlan SW add 30$/m);                   // a default name is not written
    expect(rejected).toEqual([]);
    expect(diffs).toEqual([]);
  });

  it("`vlan add` with a name renames an existing VLAN, and is one undo step", () => {
    runConsoleScript("add switch SW at 100 100\nmanaged SW on\nvlan SW add 10");
    expect(exec("vlan SW add 10 Sales").output).toEqual(["Renamed VLAN 10 to Sales."]);
    expect(dev("SW").config!.vlans!.find(v => v.id === 10)!.name).toBe("Sales");
    exec("undo");
    expect(dev("SW").config!.vlans!.find(v => v.id === 10)!.name).toBe("Vlan10");
  });

  it("an unconfigured laptop stays unconfigured; an access point's SSID and password survive", () => {
    runConsoleScript(`
      add access-point AP at 100 100
      add laptop LT at 300 100
      add laptop LT2 at 300 300
      ssid AP "Guest WiFi" "pass word"
      ssid LT2 "Guest WiFi" "pass word"
      link LT2 AP
    `);
    expect(exec('ssid LT ""').output).toEqual(["LT: SSID cleared."]);
    expect(exec("ssid LT").ok).toBe(false);                        // a missing name is still a usage error
    const { rejected, diffs, script } = roundTrip();
    expect(script).toContain('ssid LT ""');
    expect(rejected).toEqual([]);
    expect(diffs).toEqual([]);
    expect(dev("LT").config!.ssid).toBe("");
  });

  it("a collapsed LAN comes back collapsed, with its name and position (R81)", () => {
    runConsoleScript(`
      add router R1 at 600 200
      add switch SW at 300 200
      add computer PC1 at 100 100
      add computer PC2 at 100 300
      link SW R1
      link PC1 SW
      link PC2 SW
      ip PC1 10.0.0.11/24
      interface R1 SW ip 10.0.0.1/24
    `);
    expect(collapseLan(dev("SW")).ok).toBe(true);
    exec('rename "SW LAN" "Office LAN"');
    moveDevice(dev("Office LAN"), 250, 420);
    const { rejected, diffs, script } = roundTrip();
    expect(script).not.toMatch(/^link "?(SW|Office) LAN/m);        // the proxy cable is a view, never linked
    expect(script).not.toMatch(/^add lan/m);
    expect(script).toContain("collapse SW");
    expect(script).toContain('rename "SW LAN" "Office LAN"');
    expect(rejected).toEqual([]);
    expect(diffs).toEqual([]);
    expect(dev("Office LAN").type).toBe("lan");
    expect(dev("PC1").hidden).toBe(true);
    expect(exec("run ping PC1 10.0.0.1").ok).toBe(true);           // still a working network behind the LAN node
  });

  it("two collapsed LANs on one router both come back", () => {
    runConsoleScript(`
      add router R1 at 500 300
      add switch SW-A at 200 100
      add switch SW-B at 200 500
      add computer A1 at 0 100
      add computer B1 at 0 500
      link SW-A R1
      link SW-B R1
      link A1 SW-A
      link B1 SW-B
    `);
    collapseLan(dev("SW-A")); collapseLan(dev("SW-B"));
    const { rejected, diffs } = roundTrip();
    expect(rejected).toEqual([]);
    expect(diffs).toEqual([]);
    expect(state.devices.filter(d => d.type === "lan").map(d => d.name).sort()).toEqual(["SW-A LAN", "SW-B LAN"]);
  });

  it("a device may be named \"at\" (R81)", () => {
    expect(exec("add computer at at 120 240").output).toEqual(["Added computer at at 120,240."]);
    expect(exec("add switch SW at 300 240").ok).toBe(true);
    expect(dev("at")).toMatchObject({ type: "computer", x: 120, y: 240 });
    expect(exec("link at SW").ok).toBe(true);
    const { rejected, diffs, script } = roundTrip();
    expect(script).toContain("add computer at at 120 240");
    expect(rejected).toEqual([]);
    expect(diffs).toEqual([]);
  });

  it("`add` still reads its plain forms, and refuses a malformed position", () => {
    expect(exec("add computer").ok).toBe(true);                     // auto-named, auto-placed
    expect(exec("add computer PC9").ok).toBe(true);
    expect(exec("add computer at 50 60").ok).toBe(true);            // no name: `at` is the keyword
    expect(state.devices[state.devices.length - 1]).toMatchObject({ x: 50, y: 60 });
    expect(exec("add computer PC10 at 50").ok).toBe(false);
    expect(exec("add computer PC11 at x y").ok).toBe(false);
  });

  // R42: a powered-off device refuses its shell, so the export writes `power
  // … off` after every `cli` line that configures it.
  it("a powered-off server, router and firewall keep their shell-set config", () => {
    runConsoleScript(`
      add server SRV at 100 100
      add router R1 at 400 100
      add firewall FW at 400 300
      link SRV R1
      link R1 FW
      ip SRV 10.0.0.2/24
      cli SRV echo address=/www.example/10.0.0.80 >> /etc/dnsmasq.conf
      cli SRV echo dhcp-range=10.0.0.100,10.0.0.150 >> /etc/dnsmasq.conf
      cli R1 enable
      cli R1 configure terminal
      cli R1 router rip
      cli R1 network 10.0.0.0/24
      cli FW iptables -P FORWARD DROP
      power SRV off
      power R1 off
      power FW off
    `);
    const { rejected, diffs, script } = roundTrip();
    expect(rejected).toEqual([]);
    expect(diffs).toEqual([]);
    const lines = script.split("\n");
    const lastCli = lines.map((l, i) => l.startsWith("cli ") ? i : -1).reduce((a, b) => Math.max(a, b), -1);
    const firstPower = lines.findIndex(l => l.startsWith("power "));
    expect(lastCli).toBeGreaterThan(-1);
    expect(firstPower).toBeGreaterThan(lastCli);
  });

  it("link properties, shut cables, power and port counts survive together", () => {
    runConsoleScript(`
      add switch SW at 100 100
      add router R1 at 400 100
      add firewall FW at 400 300
      link SW R1 5 2
      link R1 FW
      linkset SW R1 name "uplink one"
      linkset SW R1 latency 40
      linkset SW R1 loss 5
      shut R1 FW
      power FW off
      portcount SW 16
      portcount FW 4
      portcount R1 serial 2
    `);
    const { rejected, diffs } = roundTrip();
    expect(rejected).toEqual([]);
    expect(diffs).toEqual([]);
  });
});

// R30: `macsec` accepts every device type, but the payload wrote the keys only
// for hosts, switches, routers and firewalls — an access point, hub, IDS sensor
// or internet cloud lost its key on save, and a must-secure link then came
// back `failed`, dropping all data.
describe("MACsec keys survive a save and a replay on every device type (R30)", () => {
  for (const type of USER_ADDABLE_TYPES) {
    it(`${type}: a must-secure link is still secured after a JSON reload and a script replay`, () => {
      const peerType = type === "laptop" ? "access-point" : "switch";   // a laptop only associates to an AP
      expect(runConsoleScript(`
        add ${peerType} PEER at 0 0
        add ${type} DUT at 200 0
        link DUT PEER
        macsec DUT PEER "shared key" must
        macsec PEER DUT "shared key" must
      `).filter(r => !r.ok)).toEqual([]);
      const secured = () => state.links.map(macsecState);
      expect(secured()).toEqual(["secured"]);

      const payload = JSON.parse(JSON.stringify(buildConfigPayload()));
      const dut = payload.devices.find((d: any) => d.name === "DUT");
      const peer = payload.devices.find((d: any) => d.name === "PEER");
      expect(dut.config.macsec).toEqual({ [peer.id]: { cak: "shared key", mode: "must" } });
      applyConfigWithoutUndo(normaliseConfig(payload));
      expect(secured()).toEqual(["secured"]);

      const { rejected, diffs, script } = roundTrip();
      expect(rejected).toEqual([]);
      expect(diffs).toEqual([]);
      expect(script).toContain('macsec DUT PEER "shared key" must');
      expect(secured()).toEqual(["secured"]);
    });
  }
});
