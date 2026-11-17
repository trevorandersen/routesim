/**
 * Autosave (src/autosave.ts): the network is kept in the browser's
 * localStorage and restored on the next visit. Storage can be missing, blocked
 * or full, and what it holds is input like any file — so every path here has a
 * store that misbehaves as well as one that works.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { state, defaultConfig, undo } from "../src/state";
import { dom } from "../src/dom";
import { initAutosave, saveNow, restoreAutosave, setAutosave, savedAtText, AUTOSAVE_KEY, AUTOSAVE_OFF_KEY } from "../src/autosave";
import type { KeyValueStore } from "../src/autosave";
import { applyConfigWithoutUndo, buildConfigPayload } from "../src/config";
import { normaliseConfig } from "../src/normalise";
import { runConsoleScript, runConsoleCommand as exec } from "../src/commands";
import { openSharedNetwork, buildShareLink } from "../src/io";
import { parseSettingsFromUrl, buildSettingsQuery } from "../src/settings-url";
import { syncOptionControls } from "../src/inspector";
import { registerNoopCallbacks, resetState } from "./helpers";

class MemoryStore implements KeyValueStore {
  data = new Map<string, string>();
  writes = 0;
  getItem(key: string) { return this.data.has(key) ? this.data.get(key)! : null; }
  setItem(key: string, value: string) { this.writes++; this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

let store: MemoryStore;
const NOW = new Date(2026, 10, 17, 14, 2);
// A page load: the built-in network, then autosave's start-up, then the restore.
function boot(options: { urlChoice?: boolean; keepInstantDns?: boolean } = {}): boolean {
  resetState();
  applyConfigWithoutUndo(normaliseConfig(defaultConfig));
  initAutosave({ store, urlChoice: options.urlChoice });
  return restoreAutosave({ keepInstantDns: options.keepInstantDns, now: NOW });
}
const names = () => state.devices.map(d => d.name).sort();

beforeAll(() => registerNoopCallbacks({ syncOptionControls }));
beforeEach(() => { store = new MemoryStore(); });

describe("saving", () => {
  it("the built-in network is not worth keeping; a change to it is", () => {
    expect(boot()).toBe(false);
    expect(saveNow(NOW)).toBe("unchanged");
    expect(store.data.has(AUTOSAVE_KEY)).toBe(false);
    exec("add computer Mine at 0 0");
    expect(saveNow(NOW)).toBe("saved");
    const saved = JSON.parse(store.getItem(AUTOSAVE_KEY)!);
    expect(saved.v).toBe(1);
    expect(saved.savedAt).toBe(NOW.toISOString());
    expect(saved.config.devices.some((d: any) => d.name === "Mine")).toBe(true);
    expect(JSON.stringify(saved.config)).toBe(JSON.stringify(buildConfigPayload()));
  });

  it("writes only a difference", () => {
    boot();
    exec("add computer Mine at 0 0");
    saveNow(NOW);
    const writes = store.writes;
    expect(saveNow(NOW)).toBe("unchanged");
    expect(saveNow(NOW)).toBe("unchanged");
    expect(store.writes).toBe(writes);
    exec("ip Mine 10.0.0.9/24");
    expect(saveNow(NOW)).toBe("saved");
    expect(store.writes).toBe(writes + 1);
  });

  it("back at the built-in network, the stored copy goes: there is nothing to restore", () => {
    boot();
    exec("add computer Mine at 0 0");
    saveNow(NOW);
    undo();
    expect(saveNow(NOW)).toBe("cleared");
    expect(store.data.has(AUTOSAVE_KEY)).toBe(false);
    expect(boot()).toBe(false);
  });

  it("stays out of the tutorial's way — its network is the demo's, not the learner's", () => {
    boot();
    exec("add computer Mine at 0 0");
    state.tutorialActive = true;
    expect(saveNow(NOW)).toBe("skipped");
    expect(store.data.has(AUTOSAVE_KEY)).toBe(false);
    state.tutorialActive = false;
    expect(saveNow(NOW)).toBe("saved");
  });

  it("a store that refuses the write is reported once, in words — and the page carries on", () => {
    boot();
    store.setItem = () => { throw new Error("QuotaExceededError"); };
    exec("add computer Mine at 0 0");
    expect(saveNow(NOW)).toBe("failed");
    expect(dom.modeLabel.textContent).toBe("Autosave could not store this network (the browser's storage is full or blocked) — File → Export → Config keeps it as a file.");
    dom.modeLabel.textContent = "something else";
    expect(saveNow(NOW)).toBe("failed");
    expect(dom.modeLabel.textContent).toBe("something else");      // not repeated every poll
  });
});

describe("restoring", () => {
  it("the next visit opens on the network that was left, and says so", () => {
    boot();
    exec("clear");
    runConsoleScript("add computer Alpha at 0 0\nadd switch SW at 200 0\nlink Alpha SW\nip Alpha 10.0.0.1/24\ngateway Alpha 10.0.0.254");
    const left = JSON.stringify(buildConfigPayload());
    saveNow(new Date(2026, 10, 17, 9, 5));
    expect(boot()).toBe(true);
    expect(JSON.stringify(buildConfigPayload())).toBe(left);
    expect(dom.modeLabel.textContent).toBe("Restored your last session (2 devices, saved at 09:05). File → Topologies loads a fresh network.");
    expect(state.undoStack.length).toBe(0);                          // a restore is where the visit starts, not an edit
    expect(saveNow(NOW)).toBe("unchanged");                         // and is not written straight back
  });

  it("an emptied canvas is restored empty — Clear is work too", () => {
    boot();
    exec("clear");
    saveNow(NOW);
    expect(boot()).toBe(true);
    expect(state.devices.length).toBe(0);
  });

  it("a scenario in progress comes back with its goal and its name resolution", () => {
    boot();
    exec("scenario load troubleshoot-gateway");
    exec("gateway PC-A 192.168.1.1");
    saveNow(NOW);
    expect(boot()).toBe(true);
    expect(state.activeScenarioId).toBe("troubleshoot-gateway");
    expect(state.options.instantDns).toBe(false);
    expect(state.devices.find(d => d.name === "PC-A")!.config.gatewayIpv4Address).toBe("192.168.1.1");
    expect(exec("scenario check").ok).toBe(true);
    // The URL's explicit Instant DNS beats the save's.
    state.options.instantDns = true;
    expect(boot({ keepInstantDns: true })).toBe(true);
    expect(state.options.instantDns).toBe(true);
  });

  it("a scenario this page does not know (an imported one) restores as a plain network", () => {
    boot();
    exec("add computer Mine at 0 0");
    saveNow(NOW);
    const record = JSON.parse(store.getItem(AUTOSAVE_KEY)!);
    store.setItem(AUTOSAVE_KEY, JSON.stringify({ ...record, scenarioId: "someone-elses-lab" }));
    expect(boot()).toBe(true);
    expect(state.activeScenarioId).toBeNull();
    expect(names()).toContain("Mine");
  });

  it("a stored session that cannot be read is discarded, with a reason — the page still opens", () => {
    for (const junk of ["{not json", "null", JSON.stringify({ v: 1 }), JSON.stringify({ v: 1, config: { devices: [{ id: "x", type: "warp-drive" }], links: [] } })]) {
      store.setItem(AUTOSAVE_KEY, junk);
      expect(boot(), junk).toBe(false);
      expect(dom.modeLabel.textContent).toBe("The autosaved session could not be read, so it was discarded.");
      expect(store.data.has(AUTOSAVE_KEY)).toBe(false);
      expect(state.devices.length).toBeGreaterThan(0);                // the built-in network is still there
    }
  });

  it("says when it was saved: the time today, the date before that", () => {
    expect(savedAtText(new Date(2026, 10, 17, 9, 5).toISOString(), NOW)).toBe("at 09:05");
    expect(savedAtText(new Date(2026, 10, 3, 18, 40).toISOString(), NOW)).toBe("on 3 Nov at 18:40");
    expect(savedAtText("garbage", NOW)).toBe("earlier");
  });
});

describe("opting out", () => {
  it("off removes the stored session and is remembered; on starts keeping again", () => {
    boot();
    exec("add computer Mine at 0 0");
    saveNow(NOW);
    setAutosave(false);
    expect(store.data.has(AUTOSAVE_KEY)).toBe(false);
    expect(store.getItem(AUTOSAVE_OFF_KEY)).toBe("1");
    expect(dom.modeLabel.textContent).toBe("Autosave is off — the saved session was removed from this browser.");
    exec("add computer Another at 100 0");
    expect(saveNow(NOW)).toBe("off");
    expect(store.data.has(AUTOSAVE_KEY)).toBe(false);
    // The next visit remembers the choice, and the switch shows it.
    expect(boot()).toBe(false);
    expect(state.options.autosave).toBe(false);
    exec("add computer Mine at 0 0");
    setAutosave(true);
    expect(store.data.has(AUTOSAVE_OFF_KEY)).toBe(false);
    expect(store.data.has(AUTOSAVE_KEY)).toBe(true);                 // saved straight away
    expect(dom.modeLabel.textContent).toBe("Autosave is on — this network is kept in this browser between visits.");
    expect(boot()).toBe(true);
    expect(state.options.autosave).toBe(true);
  });

  it("`?autosave=0` is for this visit only: no restore, no saving, and the stored session is left alone", () => {
    boot();
    exec("add computer Mine at 0 0");
    saveNow(NOW);
    const kept = store.getItem(AUTOSAVE_KEY);
    expect(parseSettingsFromUrl("?autosave=0").options.autosave).toBe(false);
    expect(boot({ urlChoice: false })).toBe(false);
    expect(names()).not.toContain("Mine");
    exec("add computer Visitor at 0 0");
    expect(saveNow(NOW)).toBe("off");
    expect(store.getItem(AUTOSAVE_KEY)).toBe(kept);
    expect(store.data.has(AUTOSAVE_OFF_KEY)).toBe(false);
    expect(boot()).toBe(true);                                       // an ordinary visit still finds it
    expect(names()).toContain("Mine");
  });

  it("the choice never rides in a shared link — it is about the sender's own browser", async () => {
    boot();
    setAutosave(false);
    expect(buildSettingsQuery()).toBe("");
    expect(await buildShareLink("https://example.test/rs-web.html")).not.toContain("autosave");
  });
});

describe("with no storage to be had", () => {
  it("a missing store: nothing is saved, nothing breaks, and turning it on says why it cannot", () => {
    store = null as any;
    resetState();
    applyConfigWithoutUndo(normaliseConfig(defaultConfig));
    initAutosave({ store: null });
    exec("add computer Mine at 0 0");
    expect(saveNow(NOW)).toBe("off");
    expect(restoreAutosave()).toBe(false);
    setAutosave(true);
    expect(dom.modeLabel.textContent).toBe("Autosave is unavailable: this browser is not letting the page store anything (a private window, or blocked site data).");
  });

  it("a store that throws on every access is survived", () => {
    const hostile: KeyValueStore = {
      getItem() { throw new Error("SecurityError"); },
      setItem() { throw new Error("SecurityError"); },
      removeItem() { throw new Error("SecurityError"); },
    };
    resetState();
    applyConfigWithoutUndo(normaliseConfig(defaultConfig));
    initAutosave({ store: hostile });
    expect(state.options.autosave).toBe(true);
    expect(restoreAutosave()).toBe(false);
    exec("add computer Mine at 0 0");
    expect(saveNow(NOW)).toBe("failed");
    setAutosave(false);
    expect(state.options.autosave).toBe(false);
  });
});

describe("a shared link opened over a restored session", () => {
  it("the link wins, one Undo returns to the session, and the canvas is what gets saved", async () => {
    boot();
    exec("clear");
    exec("add computer Theirs at 0 0");
    const link = await buildShareLink("https://example.test/rs-web.html");
    exec("clear");
    exec("add router Mine at 0 0");
    saveNow(NOW);
    expect(boot()).toBe(true);
    expect(await openSharedNetwork(link.slice(link.indexOf("#")), { undo: true })).toBe(true);
    expect(names()).toEqual(["Theirs"]);
    expect(saveNow(NOW)).toBe("saved");
    undo();
    expect(names()).toEqual(["Mine"]);
    expect(saveNow(NOW)).toBe("saved");
    expect(boot()).toBe(true);
    expect(names()).toEqual(["Mine"]);
  });
});
