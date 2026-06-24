/**
 * Tutorial mode — an auto-playing, hands-off demo. A faux cursor moves over the
 * real UI (ribbon tools, then canvas positions) and, on each "click", fires the
 * REAL action through the console command engine — so what the learner watches
 * is exactly what they would build by hand. A caption explains each step, and a
 * control bar offers pause / skip / replay / exit.
 *
 * It drives everything via runConsoleCommand (the same verbs the command console
 * exposes) rather than importing ui.ts, which keeps the module free of import
 * cycles (commands.ts already owns setTool/setTheme). The launch is wired in
 * app.ts.
 */
import { state } from "./state";
import { dom } from "./dom";
import { getDevice } from "./devices";
import { worldToScreen, render } from "./canvas";
import { closeDock } from "./terminal";
import { runConsoleCommand } from "./commands";

// ── Timing (ms) ──────────────────────────────────────────────────────────────
const MOVE_MS = 650;     // cursor glide to a target (matches the CSS transition)
const CLICK_MS = 280;    // the click pulse
const HOLD = 900;        // dwell after an action so the eye can follow
const HOLD_LONG = 1700;  // narration beats

// ── Step model ───────────────────────────────────────────────────────────────
export interface Step {
  caption: string;
  // Where the cursor should be for this step (viewport px), evaluated lazily so
  // it can read positions of devices placed by earlier steps. null = stay put.
  point?: () => { x: number; y: number } | null;
  action?: () => void;      // the real action, fired on the click
  noClick?: boolean;        // move without a click pulse (a narration beat)
  hold?: number;            // dwell after the action (default HOLD)
  waitForSim?: boolean;     // after the action, wait for the animated run to finish
}

// ── Geometry helpers ─────────────────────────────────────────────────────────
// Viewport position of a ribbon button by its data-tool / selector.
function elPoint(selector: string): () => { x: number; y: number } | null {
  return () => {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
}
// Viewport position of a world coordinate (where a device will be / is).
function worldPoint(x: number, y: number): () => { x: number; y: number } {
  return () => {
    const r = dom.canvas.getBoundingClientRect();
    const s = worldToScreen({ x, y });
    return { x: r.left + s.x, y: r.top + s.y };
  };
}
// Viewport position of a placed device (by name).
function devicePoint(name: string): () => { x: number; y: number } | null {
  return () => {
    const d = state.devices.find(dev => dev.name === name);
    if (!d) return null;
    return worldPoint(d.x, d.y)();
  };
}

const exec = (line: string) => runConsoleCommand(line);

// ── The demo: two LANs joined by a router ────────────────────────────────────
// Layout is centred on the world origin; startTutorial pins scale/pan so these
// land on screen and the cursor maths stay valid for the whole run.
const R = { x: 0, y: 0 };
const SW1 = { x: -230, y: 95 }, SW2 = { x: 230, y: 95 };
const PCA = { x: -440, y: -10 }, PCB = { x: 440, y: -10 };

export function buildSteps(): Step[] {
  return [
    { caption: "Welcome. Let's connect two small networks with a router — built the same way you would by hand.", noClick: true, hold: HOLD_LONG },

    { caption: "Pick the Router tool.", point: elPoint('[data-tool="router"]'), action: () => exec("tool router") },
    { caption: "Drop a router in the middle. It will route between the two LANs.", point: worldPoint(R.x, R.y), action: () => exec(`add router R1 at ${R.x} ${R.y}`) },

    { caption: "Now the Switch tool.", point: elPoint('[data-tool="switch"]'), action: () => exec("tool switch") },
    { caption: "A switch for the left LAN.", point: worldPoint(SW1.x, SW1.y), action: () => exec(`add switch SW1 at ${SW1.x} ${SW1.y}`) },
    { caption: "And one for the right LAN.", point: worldPoint(SW2.x, SW2.y), action: () => exec(`add switch SW2 at ${SW2.x} ${SW2.y}`) },

    { caption: "The Computer tool.", point: elPoint('[data-tool="computer"]'), action: () => exec("tool computer") },
    { caption: "A PC on the left.", point: worldPoint(PCA.x, PCA.y), action: () => exec(`add computer PC-A at ${PCA.x} ${PCA.y}`) },
    { caption: "A PC on the right.", point: worldPoint(PCB.x, PCB.y), action: () => exec(`add computer PC-B at ${PCB.x} ${PCB.y}`) },

    { caption: "Switch to the Connect tool to cable everything together.", point: elPoint('[data-tool="connect"]'), action: () => exec("tool connect") },
    { caption: "Cable PC-A to its switch.", point: devicePoint("SW1"), action: () => exec("link PC-A SW1") },
    { caption: "Uplink the left switch to the router.", point: devicePoint("R1"), action: () => exec("link SW1 R1") },
    { caption: "Uplink the router to the right switch.", point: devicePoint("SW2"), action: () => exec("link R1 SW2") },
    { caption: "And cable PC-B to its switch.", point: devicePoint("PC-B"), action: () => exec("link SW2 PC-B") },

    { caption: "Give the router an address on each LAN — these are the two gateways.", point: devicePoint("R1"), action: () => { exec("select R1"); exec("interface R1 SW1 ip 192.168.1.1/24"); } },
    { caption: "192.168.1.1 faces the left LAN; 192.168.2.1 faces the right.", point: devicePoint("R1"), action: () => exec("interface R1 SW2 ip 192.168.2.1/24"), noClick: true },

    { caption: "Configure PC-A: an address on the left subnet, with the router as its default gateway.", point: devicePoint("PC-A"), action: () => { exec("select PC-A"); exec("ip PC-A 192.168.1.10/24"); exec("gateway PC-A 192.168.1.1"); } },
    { caption: "And PC-B on the right subnet, pointing at its own gateway.", point: devicePoint("PC-B"), action: () => { exec("select PC-B"); exec("ip PC-B 192.168.2.10/24"); exec("gateway PC-B 192.168.2.1"); } },

    { caption: "Now ping across the router. Watch the ARP and ICMP frames hop PC-A -> switch -> router -> switch -> PC-B.", point: devicePoint("PC-A"), action: () => { exec("speed 650"); exec("select PC-A"); exec("ping PC-A PC-B"); closeDock(); /* keep the canvas (not the packet list) in view */ }, waitForSim: true, hold: 400 },

    { caption: "Done — PC-A reached PC-B across the router. Replay to watch again, or exit and keep exploring this network.", noClick: true, hold: HOLD_LONG },
  ];
}

// ── Player ───────────────────────────────────────────────────────────────────
let steps: Step[] = [];
let stepIndex = 0;
let runToken = 0;       // bumped on skip/replay/exit to abort the in-flight run
let paused = false;
let active = false;
let resumeWaiters: (() => void)[] = [];

function layer(): HTMLElement | null { return document.getElementById("tutorialLayer"); }
function cursorEl(): HTMLElement | null { return document.getElementById("tutorialCursor"); }
function captionEl(): HTMLElement | null { return document.getElementById("tutorialCaption"); }

function sleep(ms: number): Promise<void> { return new Promise(res => setTimeout(res, ms)); }
// Resolves immediately unless paused, in which case it waits for resume.
function gate(): Promise<void> {
  if (!paused) return Promise.resolve();
  return new Promise(res => resumeWaiters.push(res));
}

function setCaption(text: string): void {
  const el = captionEl();
  if (el) el.textContent = text;
}

function moveCursor(p: { x: number; y: number }): void {
  const c = cursorEl();
  if (c) c.style.transform = `translate(${p.x}px, ${p.y}px)`;
}

function clickPulse(): void {
  const c = cursorEl();
  if (!c) return;
  c.classList.remove("clicking");
  // reflow so the animation restarts even on consecutive clicks
  void c.offsetWidth;
  c.classList.add("clicking");
}

function syncControls(): void {
  const pause = document.getElementById("tutorialPause");
  if (pause) pause.textContent = paused ? "▶" : "⏸";   // ▶ / ⏸
}

async function waitForSimDone(token: number): Promise<void> {
  // Poll the engine's status; the animated ping drives itself on requestAnimationFrame.
  for (let i = 0; i < 600; i++) {       // ~hard cap so we never hang the tutorial
    if (token !== runToken) return;
    const s = state.simulation.status;
    if (s === "done" || s === "idle") return;
    await sleep(120);
  }
}

async function play(from: number): Promise<void> {
  const token = ++runToken;
  for (let i = from; i < steps.length; i++) {
    if (token !== runToken) return;
    stepIndex = i;
    await gate();
    if (token !== runToken) return;

    const step = steps[i];
    setCaption(step.caption);
    const p = step.point?.();
    if (p) { moveCursor(p); await sleep(MOVE_MS); }
    if (token !== runToken) return;
    if (!step.noClick) { clickPulse(); await sleep(CLICK_MS); }
    if (token !== runToken) return;

    step.action?.();
    if (step.waitForSim) await waitForSimDone(token);
    await sleep(step.hold ?? HOLD);
  }
  if (token === runToken) finish();
}

function finish(): void {
  // Reveal the replay/exit affordance more prominently at the end.
  const l = layer();
  if (l) l.classList.add("tutorial-finished");
}

// ── Controls ─────────────────────────────────────────────────────────────────
function clearTopologyAndView(): void {
  exec("stop");
  exec("clear");
  closeDock();   // the demo plays on the canvas, not the packet list
  // Pin a stable view so the world coords above land on screen and the cursor
  // maths stay valid for the whole run. Sit the layout a touch above centre so
  // the bottom caption bar stays clear of the devices.
  const r = dom.canvas.getBoundingClientRect();
  const span = 1000; // world units the layout occupies horizontally
  // Fit the layout to the canvas width (floor low enough that even a narrow
  // canvas keeps every device on screen; cap so a wide one isn't oversized).
  state.scale = Math.max(0.28, Math.min(0.95, (r.width - 60) / span));
  state.pan = { x: r.width / 2, y: r.height * 0.42 };
  render();
}

export function startTutorial(): void {
  if (active) return;
  active = true;
  paused = false;
  resumeWaiters = [];
  steps = buildSteps();
  const l = layer();
  if (l) { l.hidden = false; l.classList.remove("tutorial-finished"); }
  syncControls();
  clearTopologyAndView();
  // Park the cursor centre-screen to start.
  const r = dom.canvas.getBoundingClientRect();
  moveCursor({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  play(0);
}

function togglePause(): void {
  paused = !paused;
  syncControls();
  if (!paused) { const w = resumeWaiters; resumeWaiters = []; w.forEach(fn => fn()); }
}

function skip(): void {
  paused = false; resumeWaiters = []; syncControls();
  const next = Math.min(stepIndex + 1, steps.length - 1);
  const l = layer(); if (l) l.classList.remove("tutorial-finished");
  play(next);
}

function replay(): void {
  paused = false; resumeWaiters = []; syncControls();
  const l = layer(); if (l) l.classList.remove("tutorial-finished");
  clearTopologyAndView();
  play(0);
}

function exitTutorial(): void {
  runToken++;            // abort any in-flight run
  paused = false; resumeWaiters = [];
  active = false;
  exec("stop");
  const l = layer();
  if (l) { l.hidden = true; l.classList.remove("tutorial-finished"); }
}

// Wire the control bar once (idempotent). Called from app.ts after setupUI.
export function setupTutorial(): void {
  document.getElementById("startTutorial")?.addEventListener("click", startTutorial);
  document.getElementById("tutorialPause")?.addEventListener("click", togglePause);
  document.getElementById("tutorialSkip")?.addEventListener("click", skip);
  document.getElementById("tutorialReplay")?.addEventListener("click", replay);
  document.getElementById("tutorialExit")?.addEventListener("click", exitTutorial);
  // Esc exits the tutorial.
  document.addEventListener("keydown", (e) => { if (active && e.key === "Escape") exitTutorial(); });
}
