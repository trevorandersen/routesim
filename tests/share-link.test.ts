/**
 * Shareable links (src/share-link.ts + the two actions in src/io.ts): a whole
 * network carried in the URL fragment, `rs-web.html#net=…`. The codec is pure;
 * a link is input from anywhere, so it is bounded and every failure is a
 * sentence — and a link that cannot be read leaves the canvas as it was.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { state, defaultConfig, vlanRoasConfig, routerMeshConfig, wifiVlanConfig, undo } from "../src/state";
import { dom } from "../src/dom";
import { encodeShare, decodeShare, shareTokenFromHash, shareUrl, pageBase, SHARE_MAX_BYTES, SHARE_LONG_LINK } from "../src/share-link";
import { buildShareLink, openSharedNetwork, copyShareLink } from "../src/io";
import { buildConfigPayload, applyConfigWithoutUndo } from "../src/config";
import { normaliseConfig } from "../src/normalise";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { SCENARIOS, loadScenario } from "../src/scenarios";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());
beforeEach(() => resetState());

const BASE = "https://example.test/rs-web.html";
const hashOf = (url: string) => url.slice(url.indexOf("#"));
const names = () => state.devices.map(d => d.name).sort();

describe("the codec", () => {
  it("round-trips text, compressed and plain, in a URL-safe alphabet", async () => {
    const text = JSON.stringify({ name: "Sales — 営業 ☕", list: Array.from({ length: 200 }, (_, i) => `host-${i}`) });
    for (const compress of [true, false]) {
      const token = await encodeShare(text, compress);
      expect(token).toMatch(compress ? /^z\.[A-Za-z0-9_-]+$/ : /^j\.[A-Za-z0-9_-]+$/);
      expect(await decodeShare(token)).toBe(text);
    }
    // Deflate earns its keep on the repetitive JSON a network is.
    expect((await encodeShare(text, true)).length).toBeLessThan((await encodeShare(text, false)).length / 3);
  });

  it("a link that is not one, or is damaged, fails with a reason — never a half-read network", async () => {
    const good = await encodeShare(JSON.stringify({ a: 1 }));
    const reasonFor = async (token: string) => { try { await decodeShare(token); return "decoded"; } catch (e: any) { return e.message as string; } };
    expect(await reasonFor("hello")).toBe("it is not a RouteSim network link");
    expect(await reasonFor("q.abc")).toBe("it is not a RouteSim network link");
    expect(await reasonFor("z.")).toBe("the link is empty");
    expect(await reasonFor("z.ab$cd")).toMatch(/damaged/);
    expect(await reasonFor(good.slice(0, good.length - 4))).toMatch(/damaged/);       // cut short
    expect(await reasonFor("z." + good.slice(2).split("").reverse().join(""))).toMatch(/damaged/);
  });

  it("refuses a link that unpacks without bound", async () => {
    const bomb = await encodeShare("0".repeat(SHARE_MAX_BYTES + 1024), true);
    expect(bomb.length).toBeLessThan(20000);                                          // small on the wire…
    let reason = "";
    try { await decodeShare(bomb); } catch (e: any) { reason = e.message; }
    expect(reason).toBe("the link unpacks to more than a network could need");       // …and stopped on the way out
  });

  it("finds the network in a fragment, and builds the URL around it", () => {
    expect(shareTokenFromHash("#net=z.abc")).toBe("z.abc");
    expect(shareTokenFromHash("net=z.abc")).toBe("z.abc");
    expect(shareTokenFromHash("#x=1&net=j.abc_-")).toBe("j.abc_-");
    expect(shareTokenFromHash("#internet=z.abc")).toBeNull();
    expect(shareTokenFromHash("")).toBeNull();
    expect(pageBase("file:///Users/a/rs-web.html?names=0#net=z.abc")).toBe("file:///Users/a/rs-web.html");
    expect(shareUrl(BASE, "", "z.abc")).toBe(`${BASE}#net=z.abc`);
    expect(shareUrl(BASE, "names=0&theme=dark", "z.abc")).toBe(`${BASE}?names=0&theme=dark#net=z.abc`);
  });
});

describe("a link carries the whole network", () => {
  const builtIn: [string, any][] = [
    ["topology:basic", defaultConfig], ["topology:vlan-roas", vlanRoasConfig],
    ["topology:router-mesh", routerMeshConfig], ["topology:wifi-vlan", wifiVlanConfig],
    ...SCENARIOS.map(s => [`scenario:${s.id}`, s.topology] as [string, any]),
  ];

  it("every built-in topology and scenario survives the trip, field for field", async () => {
    for (const [label, config] of builtIn) {
      applyConfigWithoutUndo(normaliseConfig(config));
      const before = JSON.stringify(buildConfigPayload());
      const url = await buildShareLink(BASE);
      exec("clear");
      expect(await openSharedNetwork(hashOf(url)), label).toBe(true);
      expect(JSON.stringify(buildConfigPayload()), label).toBe(before);
    }
  });

  it("the settings that differ from the defaults ride in the query", async () => {
    expect(await buildShareLink(BASE)).toMatch(/^https:\/\/example\.test\/rs-web\.html#net=z\./);
    state.options.silentArp = true;
    state.simulation.speed = 500;
    expect(await buildShareLink(BASE)).toMatch(/^https:\/\/example\.test\/rs-web\.html\?silentarp=1&speed=500#net=z\./);
  });

  it("the built-in networks make links short enough to paste anywhere", async () => {
    for (const [label, config] of builtIn) {
      applyConfigWithoutUndo(normaliseConfig(config));
      expect((await buildShareLink(BASE)).length, label).toBeLessThan(SHARE_LONG_LINK);
    }
  });
});

describe("opening a link", () => {
  async function linkTo(script: string): Promise<string> {
    exec("clear");
    expect(runConsoleScript(script).filter(r => !r.ok)).toEqual([]);
    const url = await buildShareLink(BASE);
    exec("clear");
    return hashOf(url);
  }

  it("is one undo point over what was on the canvas, and says so", async () => {
    const hash = await linkTo("add computer Alpha at 0 0\nadd computer Beta at 200 0\nadd switch SW at 100 100\nlink Alpha SW\nlink Beta SW\nip Alpha 10.0.0.1/24");
    runConsoleScript("add router Mine at 0 0");
    expect(await openSharedNetwork(hash)).toBe(true);
    expect(names()).toEqual(["Alpha", "Beta", "SW"]);
    expect(state.devices.find(d => d.name === "Alpha")!.config.ipv4Address).toBe("10.0.0.1");
    expect(state.links.length).toBe(2);
    expect(dom.modeLabel.textContent).toBe("Opened the network from the link (3 devices). Undo returns to what was here.");
    undo();
    expect(names()).toEqual(["Mine"]);
  });

  it("at boot it loads over the default with no undo point", async () => {
    const hash = await linkTo("add computer Alpha at 0 0");
    const depth = state.undoStack.length;
    expect(await openSharedNetwork(hash, { undo: false })).toBe(true);
    expect(state.undoStack.length).toBe(depth);
    expect(dom.modeLabel.textContent).toBe("Opened the network from the link (1 device).");
  });

  it("a fragment with no network does nothing; a broken one leaves the canvas alone and says why", async () => {
    runConsoleScript("add router Mine at 0 0");
    const depth = state.undoStack.length;
    dom.modeLabel.textContent = "untouched";
    expect(await openSharedNetwork("")).toBe(false);
    expect(await openSharedNetwork("#section-2")).toBe(false);
    expect(dom.modeLabel.textContent).toBe("untouched");
    expect(await openSharedNetwork("#net=z.not-a-deflate-stream")).toBe(false);
    expect(dom.modeLabel.textContent).toBe("This link could not be opened: the link is damaged (it was cut short or altered).");
    // Well-formed packing around something that is not a network.
    expect(await openSharedNetwork(`#net=${await encodeShare("not json")}`)).toBe(false);
    expect(dom.modeLabel.textContent).toBe("This link could not be opened: config file must be valid JSON text.");
    expect(names()).toEqual(["Mine"]);
    expect(state.undoStack.length).toBe(depth);
  });

  it("waits while undo is frozen (the tutorial, the port dialog): the network they guard is not replaced", async () => {
    const hash = await linkTo("add computer Alpha at 0 0");
    runConsoleScript("add router Mine at 0 0");
    state.tutorialActive = true;
    expect(await openSharedNetwork(hash)).toBe(false);
    expect(dom.modeLabel.textContent).toMatch(/^The link was not opened: Undo and redo are paused while the tutorial plays/);
    expect(names()).toEqual(["Mine"]);
    state.tutorialActive = false;
    expect(await openSharedNetwork(hash)).toBe(true);
  });

  it("a link is untrusted input: it gets exactly the treatment an imported file does", async () => {
    runConsoleScript("add router Mine at 0 0");
    // Refused outright by normalisation: the canvas is untouched, the reason shown.
    const broken = { version: 1, devices: [{ id: "y", type: "warp-drive", name: "Y", x: 0, y: 0 }], links: [] };
    let reason = "";
    try { normaliseConfig(JSON.parse(JSON.stringify(broken))); } catch (e: any) { reason = e.message; }
    expect(reason).not.toBe("");
    expect(await openSharedNetwork(`#net=${await encodeShare(JSON.stringify(broken))}`)).toBe(false);
    expect(dom.modeLabel.textContent).toBe(`This link could not be opened: ${reason.charAt(0).toLowerCase()}${reason.slice(1).replace(/\.$/, "")}.`);
    expect(names()).toEqual(["Mine"]);
    // Accepted, but cleaned: junk fields are normalised exactly as a file's would be.
    const messy = { version: 1, devices: [{ id: "x", type: "computer", name: "<img src=x onerror=alert(1)>", x: 10, y: 0, config: { ipv4Address: " 10.0.0.1 ", arpTable: "nope", bogus: { deep: true } } }], links: [] };
    const reference = normaliseConfig(JSON.parse(JSON.stringify(messy)));
    expect(await openSharedNetwork(`#net=${await encodeShare(JSON.stringify(messy))}`)).toBe(true);
    expect(JSON.stringify(state.devices.map(d => d.config))).toBe(JSON.stringify(reference.devices.map(d => d.config)));
  });
});

describe("a link carries the scenario in progress", () => {
  const SCENARIO = "troubleshoot-gateway";

  async function linkToScenarioInProgress(): Promise<string> {
    exec(`scenario load ${SCENARIO}`);
    exec("gateway PC-A 192.168.1.1");                       // half the work done
    const url = await buildShareLink(BASE);
    exec("clear");
    state.options.instantDns = true;
    return url;
  }

  it("the goal, the work so far and the name-resolution mode all arrive", async () => {
    const url = await linkToScenarioInProgress();
    expect(state.activeScenarioId).toBeNull();
    expect(await openSharedNetwork(hashOf(url))).toBe(true);
    expect(state.activeScenarioId).toBe(SCENARIO);
    expect(state.options.instantDns).toBe(false);          // a scenario resolves names for real
    expect(state.devices.find(d => d.name === "PC-A")!.config.gatewayIpv4Address).toBe("192.168.1.1");
    expect(exec("scenario check").ok).toBe(true);
    expect(dom.modeLabel.textContent).toBe(`Opened the network from the link (4 devices), with its scenario "Troubleshoot: broken gateway". Undo returns to what was here.`);
  });

  it("Undo returns to what was there — its network, its scenario (none), its Instant DNS", async () => {
    const url = await linkToScenarioInProgress();
    runConsoleScript("add router Mine at 0 0");
    await openSharedNetwork(hashOf(url));
    undo();
    expect(names()).toEqual(["Mine"]);
    expect(state.activeScenarioId).toBeNull();
    expect(state.options.instantDns).toBe(true);
  });

  it("a link made with no scenario ends the one that was active here", async () => {
    exec("clear");
    exec("add computer Alpha at 0 0");
    const url = await buildShareLink(BASE);
    exec(`scenario load ${SCENARIO}`);
    expect(await openSharedNetwork(hashOf(url))).toBe(true);
    expect(state.activeScenarioId).toBeNull();
    expect(state.options.instantDns).toBe(true);
    expect(dom.modeLabel.textContent).toBe("Opened the network from the link (1 device). Undo returns to what was here.");
  });

  it("a scenario this page has never seen (imported on the sender's) opens as a plain network, and says so", async () => {
    const payload = { ...normaliseAndPayload(), session: { scenarioId: "my-own-lab-" + "x".repeat(80), instantDns: false } };
    expect(await openSharedNetwork(`#net=${await encodeShare(JSON.stringify(payload))}`)).toBe(true);
    expect(state.activeScenarioId).toBeNull();
    expect(dom.modeLabel.textContent).toBe(`Opened the network from the link (${state.devices.length} devices) — its scenario "${("my-own-lab-" + "x".repeat(80)).slice(0, 40)}" is not one this page has, so it opened as a plain network. Undo returns to what was here.`);
  });

  it("a link from before links carried a session still opens, changing neither scenario nor mode beyond the load", async () => {
    const old = await encodeShare(JSON.stringify(normaliseAndPayload()));      // v0.7.0's payload: no `session`
    state.options.instantDns = false;
    expect(await openSharedNetwork(`#net=${old}`)).toBe(true);
    expect(state.activeScenarioId).toBeNull();
    expect(state.options.instantDns).toBe(false);
  });

  it("the session is input like the rest of the link: junk in it is ignored, never trusted", async () => {
    for (const session of [null, 7, "x", [], { scenarioId: 42, instantDns: "yes" }, { scenarioId: { toString: "x" } }, { scenarioId: "__proto__" }]) {
      state.options.instantDns = true;
      const payload = { ...normaliseAndPayload(), session };
      expect(await openSharedNetwork(`#net=${await encodeShare(JSON.stringify(payload))}`), JSON.stringify(session)).toBe(true);
      expect(state.activeScenarioId).toBeNull();
      expect(state.options.instantDns).toBe(true);
    }
  });
});

// The Basic Network as a file export would write it.
function normaliseAndPayload() {
  applyConfigWithoutUndo(normaliseConfig(defaultConfig));
  return buildConfigPayload();
}

describe("File → Copy link", () => {
  const nav = (globalThis as any).navigator;
  const win = (globalThis as any).window;
  let savedLocation: any, savedHistory: any;
  beforeEach(() => {
    savedLocation = win.location; savedHistory = win.history;
    win.location = { href: `${BASE}?names=0#old`, pathname: "/rs-web.html", search: "?names=0", hash: "#old" };
  });
  afterEach(() => {
    win.location = savedLocation; win.history = savedHistory;
    (globalThis as any).navigator = nav;
  });

  it("copies the link and says what it holds", async () => {
    let copied = "";
    (globalThis as any).navigator = { clipboard: { writeText: async (text: string) => { copied = text; } } };
    applyConfigWithoutUndo(normaliseConfig(defaultConfig));
    await copyShareLink();
    expect(copied.startsWith(`${BASE}#net=z.`)).toBe(true);
    expect(dom.modeLabel.textContent).toMatch(/^Link copied \(\d+(\.\d)?k? characters\) — it holds this whole network, any passwords and keys in it included\.$/);
    exec("clear");
    expect(await openSharedNetwork(hashOf(copied))).toBe(true);
    expect(state.devices.length).toBeGreaterThan(0);
  });

  it("with no clipboard in reach, puts the link in the address bar and says so", async () => {
    (globalThis as any).navigator = { clipboard: { writeText: async () => { throw new Error("denied"); } } };
    let replaced = "";
    win.history = { replaceState: (_s: unknown, _t: string, url: string) => { replaced = url; } };
    await copyShareLink();
    expect(replaced.startsWith(`${BASE}#net=z.`)).toBe(true);
    expect(dom.modeLabel.textContent).toMatch(/^Could not reach the clipboard — the link \(.+\) is in the address bar; copy it from there\.$/);
  });

  it("warns when the link is too long for a chat or mail app", async () => {
    let copied = "";
    (globalThis as any).navigator = { clipboard: { writeText: async (text: string) => { copied = text; } } };
    exec("clear");
    // Deflate-resistant bulk: 400 hosts with distinct names, addresses and MACs.
    runConsoleScript(Array.from({ length: 400 }, (_, i) => `add computer H${(i * 7919) % 100003} at ${i * 13} ${i * 17}\nip H${(i * 7919) % 100003} 10.${i % 250}.${(i * 31) % 250}.${(i * 53) % 250 + 1}/16`).join("\n"));
    await copyShareLink();
    expect(copied.length).toBeGreaterThan(SHARE_LONG_LINK);
    expect(dom.modeLabel.textContent).toContain("That is long for a chat or mail app, which may cut it — File → Export → Config is the sturdier way to send a large network.");
  });
});
