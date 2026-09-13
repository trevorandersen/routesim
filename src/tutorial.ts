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
import { state, pushUndo } from "./state";
import { dom } from "./dom";
import { getDevice } from "./devices";
import { worldToScreen, render } from "./canvas";
import { closeDock, openTerminalFor, runTerminalCommand } from "./terminal";
import { setNetworkPanel, syncPanel } from "./inspector";
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
// Viewport position of an element by selector (a ribbon button, an inspector
// field, the terminal input). Returns null for a missing or unrendered (zero-
// rect, e.g. on an inactive ribbon tab) element so the cursor stays put.
function elPoint(selector: string): () => { x: number; y: number } | null {
  return () => {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
}
const fieldPoint = (id: string) => elPoint(`#${id}`);
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

// Select a device AND open the inspector, so its config fields are on screen.
function inspect(name: string): void {
  exec(`select ${name}`);
  setNetworkPanel(true);
  syncPanel();   // make sure the panel shows the selected device's fields
}
// Open a device's terminal in the dock (so the ping runs in a real shell).
function openDeviceTerminal(name: string): void {
  const d = state.devices.find(dev => dev.name === name);
  if (d) openTerminalFor(d);
}

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

    { caption: "Select the router to open its settings on the right.", point: devicePoint("R1"), action: () => inspect("R1") },
    { caption: "Give it an address on each LAN — 192.168.1.1 and 192.168.2.1, the two gateways. They fill into the inspector.", point: devicePoint("R1"), action: () => { exec("interface R1 SW1 ip 192.168.1.1/24"); exec("interface R1 SW2 ip 192.168.2.1/24"); syncPanel(); }, noClick: true, hold: HOLD_LONG },

    { caption: "Select PC-A — its settings open in the inspector.", point: devicePoint("PC-A"), action: () => inspect("PC-A") },
    { caption: "Set its IPv4 address — 192.168.1.10 on the left subnet — and watch the inspector field fill in.", point: fieldPoint("selectedIpv4"), action: () => { exec("ip PC-A 192.168.1.10/24"); syncPanel(); } },
    { caption: "And its default gateway — the router's address on this LAN.", point: fieldPoint("selectedGateway"), action: () => { exec("gateway PC-A 192.168.1.1"); syncPanel(); } },

    { caption: "Now PC-B — select it.", point: devicePoint("PC-B"), action: () => inspect("PC-B") },
    { caption: "Its address on the right subnet, 192.168.2.10.", point: fieldPoint("selectedIpv4"), action: () => { exec("ip PC-B 192.168.2.10/24"); syncPanel(); } },
    { caption: "And its gateway, on the right LAN.", point: fieldPoint("selectedGateway"), action: () => { exec("gateway PC-B 192.168.2.1"); syncPanel(); } },

    { caption: "Open PC-A's terminal to test the link — a real shell, like Linux.", point: devicePoint("PC-A"), action: () => openDeviceTerminal("PC-A") },
    { caption: "Run \"ping PC-B\". Watch the ARP and ICMP frames hop PC-A -> switch -> router -> switch -> PC-B.", point: elPoint("#terminalInput"), action: () => { exec("speed 650"); runTerminalCommand("ping PC-B"); }, waitForSim: true, hold: 600 },

    { caption: "Done — PC-A reached PC-B across the router, all by hand. Step back/forward to review, replay to watch again, or exit and keep exploring.", noClick: true, hold: HOLD_LONG },
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

// Jump the cursor without the glide transition (initial park + manual stepping).
function moveCursorInstant(p: { x: number; y: number }): void {
  const c = cursorEl();
  if (!c) return;
  const prev = c.style.transition;
  c.style.transition = "none";
  c.style.transform = `translate(${p.x}px, ${p.y}px)`;
  void c.offsetWidth;            // reflow so the next animated move starts from here
  c.style.transition = prev;
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
    const step = steps[i];
    setCaption(step.caption);
    const p = step.point?.();
    if (p) { moveCursor(p); await sleep(MOVE_MS); }
    if (token !== runToken) return;
    if (!step.noClick) { clickPulse(); await sleep(CLICK_MS); }
    if (token !== runToken) return;

    step.action?.();
    if (step.waitForSim) await waitForSimDone(token);
    stepIndex = i;                    // mark this step complete (its caption is showing)
    await sleep(step.hold ?? HOLD);
    await gate();                     // pause AFTER a step, so stepIndex = last done
    if (token !== runToken) return;
  }
  if (token === runToken) finish();
}

function finish(): void {
  // Reveal the replay/exit affordance more prominently at the end.
  const l = layer();
  if (l) l.classList.add("tutorial-finished");
}

// ── Controls ─────────────────────────────────────────────────────────────────
// The tool steps point at ribbon buttons (`[data-tool=…]`) — these only have a
// real on-screen rect when the Main ribbon tab is showing (an inactive panel is
// display:none, so getBoundingClientRect() is all-zero and the cursor would fly
// to the top-left corner). The tutorial is usually launched from the Help tab,
// so force Main active for the whole run.
function activateMainTab(): void {
  document.querySelectorAll<HTMLElement>(".ribbon-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === "main"));
  document.querySelectorAll<HTMLElement>(".ribbon-panel").forEach(p => p.classList.toggle("active", p.dataset.tab === "main"));
}

function clearTopologyAndView(): void {
  exec("stop");
  exec("clear");
  closeDock();   // the demo plays on the canvas, not the packet list
  activateMainTab();   // so the ribbon tool buttons have valid rects to point at
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
  // The demo clears the learner's topology and then runs ~20 undoable actions
  // (and rebuilds them on every Back/Forward), which used to bury the original
  // dozens of entries deep and off the 80-entry cap. One snapshot before the
  // clear, then everything the tutorial does runs as a composite change — a
  // single Undo after exiting restores whatever was there.
  pushUndo();
  state.isApplyingCompositeChange = true;
  const l = layer();
  if (l) { l.hidden = false; l.classList.remove("tutorial-finished"); }
  syncControls();
  clearTopologyAndView();
  // Park the cursor centre-screen to start (instant, so it doesn't streak in
  // from the top-left corner on the first move).
  const r = dom.canvas.getBoundingClientRect();
  moveCursorInstant({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  stepIndex = -1;
  play(0);
}

// Abort the in-flight auto-play loop and release any paused waiter so it exits.
function abortRun(): void {
  runToken++;
  const w = resumeWaiters; resumeWaiters = [];
  w.forEach(fn => fn());
}

// Jump to a step deterministically: rebuild the topology by replaying every
// action up to and including `target` instantly (no cursor glide / dwell), then
// show that step's caption + cursor. This is how Back works (rebuild without the
// undone step) and Forward (apply the next step). Leaves the tutorial paused.
function goToStep(target: number): void {
  if (!active || !steps.length) return;
  abortRun();
  paused = true;
  target = Math.max(0, Math.min(target, steps.length - 1));
  const l = layer(); if (l) l.classList.remove("tutorial-finished");
  clearTopologyAndView();
  for (let i = 0; i <= target; i++) steps[i].action?.();   // rebuild state (the ping just replays)
  render();
  stepIndex = target;
  setCaption(steps[target].caption);
  const p = steps[target].point?.();
  if (p) moveCursorInstant(p);
  syncControls();
}

function back(): void { goToStep(stepIndex - 1); }
function forward(): void { goToStep(stepIndex + 1); }

function togglePause(): void {
  paused = !paused;
  syncControls();
  if (!paused) {
    if (resumeWaiters.length) {                 // an auto-play loop is waiting at a gate
      const w = resumeWaiters; resumeWaiters = []; w.forEach(fn => fn());
    } else {                                    // resumed after a manual step: continue from the next
      const l = layer(); if (l) l.classList.remove("tutorial-finished");
      play(stepIndex + 1);
    }
  }
}

function replay(): void {
  if (!active) return;
  abortRun();
  paused = false; syncControls();
  const l = layer(); if (l) l.classList.remove("tutorial-finished");
  clearTopologyAndView();
  stepIndex = -1;
  play(0);
}

function exitTutorial(): void {
  abortRun();            // abort any in-flight run + release waiters
  paused = false;
  active = false;
  state.isApplyingCompositeChange = false;   // the demo's edits were one composite change
  exec("stop");
  const l = layer();
  if (l) { l.hidden = true; l.classList.remove("tutorial-finished"); }
}

// Wire the control bar once (idempotent). Called from app.ts after setupUI.
export function setupTutorial(): void {
  document.getElementById("startTutorial")?.addEventListener("click", startTutorial);
  document.getElementById("tutorialBack")?.addEventListener("click", back);
  document.getElementById("tutorialPause")?.addEventListener("click", togglePause);
  document.getElementById("tutorialForward")?.addEventListener("click", forward);
  document.getElementById("tutorialReplay")?.addEventListener("click", replay);
  document.getElementById("tutorialExit")?.addEventListener("click", exitTutorial);
  // Esc exits the tutorial; arrow keys step back/forward.
  document.addEventListener("keydown", (e) => {
    if (!active) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;   // typing in the console / a field is not stepping
    if (e.key === "Escape") exitTutorial();
    else if (e.key === "ArrowLeft") back();
    else if (e.key === "ArrowRight") forward();
  });
}
