/**
 * Autosave — the network on the canvas is kept in this browser's localStorage
 * and brought back on the next visit, so a refresh or a closed tab does not
 * lose the work. Opt-out (Settings → Autosave).
 *
 * It is storage, not network: the page still makes no request, and nothing
 * leaves the machine. What is kept is what a file would keep — the topology
 * payload (`buildConfigPayload`) — plus the two things a load changes along
 * with the network: the active scenario and Instant DNS (the same pair the
 * undo snapshot carries).
 *
 * How it saves: a slow poll compares the network with what was last written
 * and writes only a difference, with a flush when the page is hidden or
 * closed. A poll, not a hook in every mutator — there are four front doors and
 * dozens of mutators, and one comparison every few seconds cannot miss any of
 * them. It stays out of the way of the tutorial, whose network is the demo's,
 * not the learner's.
 *
 * Storage is not guaranteed: it can be missing, blocked, or full. Every access
 * is guarded, the page works without it, and a refusal is said once on the
 * status line rather than swallowed.
 */
import { state } from "./state";
import { dom } from "./dom";
import { buildConfigPayload, parseConfig, applyConfigWithoutUndo } from "./config";
import { sessionContext, resumeSession } from "./scenarios";
import type { SerialisedTopology } from "./types";

export const AUTOSAVE_KEY = "routesim.autosave";
export const AUTOSAVE_OFF_KEY = "routesim.autosave.off";
export const AUTOSAVE_INTERVAL_MS = 3000;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface SavedSession {
  v: 1;
  savedAt: string;                 // ISO time, for the "restored" message only
  scenarioId: string | null;
  instantDns: boolean;
  config: SerialisedTopology;
}

// ── The store ────────────────────────────────────────────────────────────────

let store: KeyValueStore | null = null;

// The browser's localStorage, or null when there is none to be had (a private
// window, blocked site data, a test harness). Reading the property can throw.
function browserStore(): KeyValueStore | null {
  try {
    const candidate = window.localStorage;
    if (!candidate) return null;
    candidate.getItem(AUTOSAVE_OFF_KEY);     // a blocked store throws on use, not on access
    return candidate;
  } catch {
    return null;
  }
}

const read = (key: string): string | null => { try { return store ? store.getItem(key) : null; } catch { return null; } };
const remove = (key: string): void => { try { store?.removeItem(key); } catch { /* nothing to do */ } };

// ── What is saved ────────────────────────────────────────────────────────────

// The session as text, without its timestamp — what "has anything changed?"
// compares.
function sessionText(): string {
  return JSON.stringify({ ...sessionContext(), config: buildConfigPayload() });
}

let baseline: string | null = null;      // the built-in network the page boots with: nothing worth keeping
let lastWritten: string | null = null;   // what the store holds now (as sessionText)
let refusalSaid = false;                 // a full or blocked store is reported once, not every poll

export type SaveOutcome = "saved" | "unchanged" | "cleared" | "skipped" | "off" | "failed";

// Write the session if it differs from what is stored. Exported for the tests
// and the page-hide flush; the poll calls it too.
export function saveNow(now: Date = new Date()): SaveOutcome {
  if (!store || !state.options.autosave) return "off";
  // The tutorial's network is the demo's; the learner's own is in its undo
  // snapshot and comes back when the tutorial exits. Wait for that.
  if (state.tutorialActive) return "skipped";
  let text: string;
  try { text = sessionText(); } catch { return "skipped"; }
  if (text === lastWritten) return "unchanged";
  if (text === baseline) {
    // Back to the network the page starts with: there is nothing to restore.
    if (lastWritten === null) return "unchanged";
    remove(AUTOSAVE_KEY);
    lastWritten = null;
    return "cleared";
  }
  try {
    store.setItem(AUTOSAVE_KEY, `{"v":1,"savedAt":${JSON.stringify(now.toISOString())},${text.slice(1)}`);
  } catch {
    if (!refusalSaid) {
      refusalSaid = true;
      dom.modeLabel.textContent = "Autosave could not store this network (the browser's storage is full or blocked) — File → Export → Config keeps it as a file.";
    }
    return "failed";
  }
  lastWritten = text;
  refusalSaid = false;
  return "saved";
}

// ── Restoring ────────────────────────────────────────────────────────────────

const two = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "at 14:02" for today, "on 16 Nov at 14:02" otherwise.
export function savedAtText(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "earlier";
  const time = `${two(at.getHours())}:${two(at.getMinutes())}`;
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return sameDay ? `at ${time}` : `on ${at.getDate()} ${MONTHS[at.getMonth()]} at ${time}`;
}

// Bring back the stored session, if autosave is on and there is one. Called
// once at boot, after the built-in network has loaded. `keepInstantDns` is set
// when the URL named Instant DNS explicitly — the URL wins over the save.
// Returns true when a session was restored.
export function restoreAutosave(options: { keepInstantDns?: boolean; now?: Date } = {}): boolean {
  if (!store || !state.options.autosave) return false;
  const raw = read(AUTOSAVE_KEY);
  if (raw == null) return false;
  let session: SavedSession;
  try {
    session = JSON.parse(raw);
    if (!session || typeof session !== "object" || !session.config) throw new Error("not a session");
    applyConfigWithoutUndo(parseConfig(JSON.stringify(session.config)));
  } catch {
    // Written by a version this one cannot read, or damaged: it will never
    // load, so do not keep tripping over it.
    remove(AUTOSAVE_KEY);
    lastWritten = null;
    dom.modeLabel.textContent = "The autosaved session could not be read, so it was discarded.";
    return false;
  }
  // The scenario and name-resolution mode that stood with the network.
  resumeSession(session, options.keepInstantDns);
  lastWritten = sessionText();
  const count = state.devices.length;
  dom.modeLabel.textContent = `Restored your last session (${count} device${count === 1 ? "" : "s"}, saved ${savedAtText(session.savedAt, options.now)}). File → Topologies loads a fresh network.`;
  return true;
}

// ── The preference ───────────────────────────────────────────────────────────

// The learner flipped Settings → Autosave. Off removes the stored session and
// remembers the choice; on remembers that and saves straight away.
export function setAutosave(on: boolean): void {
  state.options.autosave = on;
  if (!store) {
    dom.modeLabel.textContent = on
      ? "Autosave is unavailable: this browser is not letting the page store anything (a private window, or blocked site data)."
      : "Autosave is off.";
    return;
  }
  try {
    if (on) store.removeItem(AUTOSAVE_OFF_KEY); else store.setItem(AUTOSAVE_OFF_KEY, "1");
  } catch { /* the choice still holds for this visit */ }
  if (on) {
    saveNow();
    dom.modeLabel.textContent = "Autosave is on — this network is kept in this browser between visits.";
  } else {
    remove(AUTOSAVE_KEY);
    lastWritten = null;
    dom.modeLabel.textContent = "Autosave is off — the saved session was removed from this browser.";
  }
}

// ── Start-up ─────────────────────────────────────────────────────────────────

// Called once at boot, right after the built-in network has loaded and before
// any restore. `urlChoice` is `?autosave=0|1` when the URL gave one: it holds
// for this visit only — it neither rewrites the stored preference nor removes
// a stored session (a lab bookmark with `?autosave=0` always starts fresh and
// leaves no trace).
export function initAutosave(options: { store?: KeyValueStore | null; urlChoice?: boolean } = {}): void {
  store = options.store !== undefined ? options.store : browserStore();
  baseline = null;
  lastWritten = null;
  refusalSaid = false;
  state.options.autosave = options.urlChoice ?? (read(AUTOSAVE_OFF_KEY) !== "1");
  try { baseline = sessionText(); } catch { baseline = null; }
}

// Begin saving: the poll, and a flush when the page is hidden or closed (the
// last few seconds of work would otherwise wait for a poll that never comes).
// Wires the Settings switch too. No timers without a store.
export function startAutosave(): void {
  dom.optAutosave.addEventListener("change", () => setAutosave(dom.optAutosave.checked));
  if (!store) return;
  setInterval(() => { saveNow(); }, AUTOSAVE_INTERVAL_MS);
  window.addEventListener("pagehide", () => { saveNow(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveNow(); });
}
