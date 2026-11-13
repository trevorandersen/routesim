import type { EthernetFrame, ArpPayload, Ipv4Payload, DhcpPayload, TcpPayload, DnsPayload, Dot11Payload, Dot1xPayload, BpduPayload, NatEntry, SimEvent, SimLogEntry, ActiveTransit, FrameHistoryEntry, RouteEntry, RouterInterface, Device, DeviceType, FirewallRule, FirewallTarget, ConnState, Link, Cidr, SimMode, ArpEntry } from "./types";
import { state, pushUndo, sync, sessionFor, appendSessionLine, showDock } from "./state";
import { dom } from "./dom";
import { getDevice, linkedPortsFor, routerInterfacesWithNames, linkName, linkById, linksFor, linkDataBlockReason, macsecState, macsOwnedBy, liveMacsOf, isPhysicalLink, dot1xPortFacing } from "./devices";
import { normalisePortVlans, normalisePortModes, normaliseTrunkAllowedVlans, normaliseArpTable, normaliseMacTable, normaliseDhcpLeases, normaliseStaticRoutes, ensureConfig } from "./normalise";
import { quoteArg } from "./tokenize";
import { sameSubnet, prefixOf, isValidIpv4, ipv4ToInt, intToIpv4, normaliseMacAddress, deriveMac, internetGatewayIp, parseIpv4, cidrOf, cidrHas, icmpTypeName } from "./utils";
import { simRandomInt, seedSimRng, seedLossRng, lossRandom } from "./prng";
import { createArpRequest, createArpReply, createIcmpEchoRequest, createIcmpEchoReply, createIcmpTimeExceeded, createIcmpDestUnreachable, icmpOriginalOf, createDhcpOffer, createDhcpRequest, createDhcpAck, createTcpSegment, createHttpRequest, createHttpResponse, createDnsResponse, createDot11Frame, createDot1xFrame, createBpduFrame, BROADCAST_MAC, frameLabel } from "./frame";
import { buildPingEvents, buildResolveEvents, buildDhcpEvents, buildAttackEvents, findPingTarget, hostnameToIp } from "./simulation";
import type { PingSetup } from "./simulation";
import { routingLookup, runRipConvergence, buildRoutingTable } from "./routing";
import { runStpConvergence, isStpParticipant } from "./stp";
import { runIdsRules } from "./snort";
import { isBootable, isDot1xSupplicant, isHost } from "./device-registry";
import type { CaptureEntry } from "./types";

// Re-exported so existing imports (terminal, tests, benchmarks) keep working.
export { buildRoutingTable, routingLookup, runRipConvergence } from "./routing";
export { runStpConvergence } from "./stp";

// ─── Run ownership ───────────────────────────────────────────────────────────

// One run owns `state.simulation` at a time. Both entry points — the animated
// startSimulation and the synchronous runSimulationHeadless — go through
// beginRun, which settles any run already in flight and then performs the ONE
// shared reset of the per-run state. The two used to carry byte-identical
// copies of that reset and checked nothing, so a second command silently
// replaced a run mid-animation: its result never printed, its capture was
// never archived, the transport pill stayed up, and a preempted network boot
// resumed afterwards. The policy, chosen for the learner:
// - A new ANIMATED run while the user's animated run is running or paused is
//   refused, with a reason. That run is the lesson on screen; replacing it
//   would lose it without a word, and the way out (wait, or Ctrl+C / Stop) is
//   one keystroke away.
// - A NETWORK-BOOT run yields. Boot DHCP is background chatter Play started,
//   not an experiment, so a user's run preempts it: the rest of the boot queue
//   is cancelled and the status line says how many hosts are still unassigned.
// - A HEADLESS run (console `run`, traceroute, a scenario Check) finishes in
//   one synchronous call, so refusing it would only make the learner stop the
//   animation by hand first. Instead the animated run is torn down properly
//   (the same teardown as Stop) and its terminal says why it ended.
export const RUN_BUSY = "A simulation is already running (or paused) — wait for it to finish, or stop it first (Ctrl+C or Stop).";

function runActive(): boolean {
  const status = state.simulation.status;
  return status === "running" || status === "paused";
}

// Why a new animated run cannot start right now, or null if it can (nothing in
// flight, or only a preemptible network boot). Callers check this BEFORE
// building their frames: the builders reseed the run PRNG, which would perturb
// the in-flight run's later draws under a pinned seed.
export function animatedRunBlockReason(): string | null {
  if (!runActive()) return null;
  return !state.simulation.headless && bootRunActive ? null : RUN_BUSY;
}

// What a run is, in the learner's words — names the run that needed the
// simulator in a preemption note ("a ping from PC3"). A headless caller can
// name itself instead (`purpose`: "traceroute from PC3", "the scenario Check");
// otherwise it is "a background check", never the internal word "headless".
function describeRun(mode: SimMode, originDeviceId: string, headless: boolean, purpose?: string): string {
  if (purpose) return purpose;
  const origin = getDevice(originDeviceId)?.name;
  return `${headless ? "a background check" : runNoun(mode)}${origin ? ` from ${origin}` : ""}`;
}

function runNoun(mode: SimMode): string {
  switch (mode) {
    case "ping": return "a ping";
    case "dhcp": return "a DHCP request";
    case "tcp": return "a TCP connect";
    case "http": return "an HTTP request";
    case "dns": return "a DNS lookup";
    case "associate": return "a WiFi association";
    case "dot1x": return "an 802.1X login";
    case "stp": return "a spanning-tree run";
    case "attack": return "an attack run";
  }
}

// The note from the last preemption, until a caller collects it — the console
// prints it above the output of the command that caused it.
let preemptionNote: string | null = null;

export function takePreemptionNote(): string | null {
  const note = preemptionNote;
  preemptionNote = null;
  return note;
}

// Tear the in-flight animated run down so `next` can own the simulator, and
// say so where the learner is looking: the interrupted run's terminal session,
// the status line, and (via takePreemptionNote) the console.
function preemptActiveRun(next: string): void {
  const sim = state.simulation;
  let note: string;
  if (bootRunActive) {
    const left = unconfiguredBootableHosts().length;
    note = `Network boot interrupted — ${next} needed the simulator; ${left} host${left === 1 ? "" : "s"} still unassigned (press Play to finish booting).`;
  } else {
    note = `Simulation stopped before it finished — ${next} needed the simulator.`;
  }
  const session = sessionFor(sim.originDeviceId);
  if (session) appendSessionLine(session, { kind: "error", text: note });
  stopSimulation();   // the Stop teardown — it also cancels the queued boot chain
  dom.modeLabel.textContent = note;
  preemptionNote = note;
}

// Claim the simulator for a new run: refuse or preempt whatever is in flight
// (see the policy above), converge, and reset the per-run state. Returns the
// refusal reason, or null once the run owns `state.simulation`. Only an
// animated run is ever refused.
function beginRun(setup: PingSetup, originDeviceId: string, targetIp: string, mode: SimMode, targetPort: number | null, headless: boolean, purpose?: string): string | null {
  const sim = state.simulation;
  const boot = !headless && pendingBootRun;   // armed by bootNextHost just before its startSimulation
  pendingBootRun = false;
  if (runActive()) {
    if (sim.headless) {
      if (!headless) return RUN_BUSY;           // never start an animation inside a headless drain
    } else if (headless || bootRunActive) {
      preemptActiveRun(describeRun(mode, originDeviceId, headless, purpose));
    } else {
      return RUN_BUSY;
    }
  }
  // A run that isn't part of the boot chain ends it: finishSimulation would
  // otherwise resume booting after the user's run.
  if (!boot) bootQueue = [];
  // Converge routing (RIP) and the spanning tree before the run, so frames route
  // correctly and loops are already broken (blocked ports) before the first hop.
  runRipConvergence();
  runStpConvergence();
  if (!headless) {
    // An animated run is an undo point (so the tables it learns can be undone) —
    // except a boot run: startNetworkBoot took ONE snapshot for the whole chain,
    // so one Ctrl+Z undoes one Play press rather than one host.
    if (!boot) pushUndo();
    // Link loss is animated-only, and its stream is reseeded here — the one
    // place every animated run passes — so `seed <n>` reproduces which frames a
    // lossy wire drops, whatever the run type.
    seedLossRng();
    bootRunActive = boot;   // latched for the run's lifetime (keeps boot chatter out of the compare archive)
  }
  resetRunState(setup, originDeviceId, targetIp, mode, targetPort, headless);
  return null;
}

// The one per-run reset of `state.simulation`, shared by both entry points.
// The packet capture is not touched here — only an animated run clears it.
function resetRunState(setup: PingSetup, originDeviceId: string, targetIp: string, mode: SimMode, targetPort: number | null, headless: boolean): void {
  const sim = state.simulation;
  resetIfaceNames();   // interface names are derived from the cabling — never carried across runs
  sim.status = "running";
  sim.mode = mode;
  sim.headless = headless;
  sim.events = [];
  sim.log = [];
  sim.transits = [];
  sim.pendingArp = { ...setup.pendingArp };
  sim.stepIndex = 0;
  sim.originDeviceId = originDeviceId;
  sim.pingTargetIp = setup.dns ? null : targetIp;
  sim.pingSuccess = false;
  sim.pingTtl = 64;
  sim.pingResponderIp = null;
  sim.pingTimeExceeded = false;
  sim.pingUnreachableFrom = null;
  sim.tcpSuccess = false;
  sim.tcpRefused = false;
  sim.tcpTargetPort = setup.dns?.port ?? targetPort;
  sim.httpPath = setup.httpPath ?? "/";
  sim.httpSuccess = false;
  sim.httpStatus = null;
  sim.httpStatusText = null;
  sim.httpServerTitle = null;
  sim.dnsName = setup.dns?.name ?? null;
  sim.dnsResolvedIp = null;
  sim.resolveThen = setup.dns?.then ?? null;
  sim.dhcpOfferTaken = false;
  sim.dhcpSuccess = false;
  sim.dhcpAssignedIp = null;
  sim.dhcpAssignedGateway = null;
  sim.wifiAssociated = false;
  sim.dot1xAuthorized = false;
  sim.dot1xFailure = null;
  sim.wifiFailure = null;
  sim.stormDetected = false;
  sim.diagnosis = [];
  sim.arpDrops = {};
  sim.scanOpen = []; sim.scanClosed = []; sim.sweepLive = []; sim.arpPoisoned = [];
  sim.conntrack = {};   // connection tracking starts empty each run
  sim.dnatSessions = {};
  sim.lossNoted = new Set();
  sim.loopTrace = new Set();
  sim.wireSteps = 0;
  // Each run reports only its own detections/findings — clear IDS alert logs and
  // attacker findings (like sim.log / sim.capture) so they don't accumulate.
  for (const d of state.devices) {
    if (d.type === "ids" && d.config) d.config.alerts = [];
    if ((d.type === "attacker" || d.type === "kali") && d.config) (d.config as any).attackLog = [];
  }
}

// The terminal line announcing a run. A switch with no default makes a new
// SimMode a compile error here rather than a silent "Simulating ping".
function runLabel(mode: SimMode, target: string): string {
  const sim = state.simulation;
  switch (mode) {
    case "dhcp": return "Requesting DHCP lease...";
    case "tcp": return `Opening TCP connection to ${target}:${sim.tcpTargetPort ?? "?"}...`;
    case "http": return `Requesting http://${target}${sim.httpPath}...`;
    case "dns": return `Resolving ${target}...`;
    case "associate": return `Associating to ${target || "WiFi"}...`;
    case "dot1x": return `802.1X authenticating ${target || "supplicant"}...`;
    case "stp": return "Spanning tree: advertising BPDUs from the root bridge...";
    case "attack": return "Red Team: launching attacks...";
    case "ping": return `Simulating ping to ${target}...`;
  }
}

// Whether the finished run achieved its mode's goal (the headless SimResult).
function runSucceeded(mode: SimMode): boolean {
  const sim = state.simulation;
  switch (mode) {
    case "dhcp": return sim.dhcpSuccess;
    case "tcp": return sim.tcpSuccess;
    case "http": return sim.httpSuccess;
    case "dns": return sim.dnsResolvedIp != null;
    case "associate": return sim.wifiAssociated;
    case "dot1x": return sim.dot1xAuthorized;
    case "stp": return !sim.stormDetected;
    case "attack": return sim.scanOpen.length > 0 || sim.sweepLive.length > 0 || sim.arpPoisoned.length > 0;
    case "ping": return sim.pingSuccess;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

// Starts an animated run. Returns null once it is running, or the reason it
// was refused (another animated run owns the simulator — see beginRun).
export function startSimulation(setup: PingSetup, originDeviceId: string, targetIp: string, mode: SimMode = "ping", targetPort: number | null = null): string | null {
  const refusal = beginRun(setup, originDeviceId, targetIp, mode, targetPort, false);
  if (refusal) return refusal;
  state.inspectedFrame = null; // a new run invalidates the inspected frame
  state.inspectedCapture = null;
  const sim = state.simulation;
  sim.capture = [];
  state.dock.captureView = "live"; // watch the run that's starting, not an archived one
  // Animate the first leg (source → first hop) as a transit instead of injecting
  // an arrive event straight at the first hop — otherwise the initial frame
  // appears to originate at the connected switch/router rather than leaving the
  // source. Every later hop already animates this way (a completed transit
  // creates the next arrive event). Headless runs drain the events directly.
  let seeded = false;
  const seedNow = performance.now();
  for (const ev of setup.events) {
    if (ev.linkId && ev.fromDeviceId && ev.fromDeviceId !== ev.deviceId) {
      const seedLink = linkById(ev.linkId);
      const src = getDevice(ev.fromDeviceId);
      seeded = true;   // the source emitted (or tried to) — it is step 1 either way
      if (seedLink && src && !admitOnLink(src, seedLink, ev.frame)) continue;   // dropped on the first leg (loss / gate)
      sim.transits.push({ frame: ev.frame, linkId: ev.linkId, fromDeviceId: ev.fromDeviceId, toDeviceId: ev.deviceId, progress: 0, startTime: seedNow, latencyFactor: linkLatencyFactor(seedLink), silent: isSilentFrame(ev.frame) });
    } else {
      sim.events.push(ev);
    }
  }
  if (seeded) sim.stepIndex++; // the source emitting is step 1
  state.terminal.lines.push({ kind: "sim", text: runLabel(mode, setup.dns ? setup.dns.name : targetIp) });
  // Surface the hop-by-hop log: open the dock on the Sim Log pane if nothing
  // is showing; if the dock is already open, leave the user's tab alone (the
  // Sim Log tab badge counts entries as they arrive).
  if (!state.dock.open) showDock("simlog");
  sync().syncTerminal();   // locks the terminal input for the run's lifetime (derived from sim.status)
  sync().syncSimLog();
  updateSimControls(); // reveal the floating transport pill + set the pause icon
  startAnimationLoop();
  // With a seeded first-leg transit, the animation loop drives processing once
  // it lands; only kick the queue directly if nothing was seeded.
  if (sim.autoPlay && sim.transits.length === 0) processNextStep();
  return null;
}

export function stopSimulation(): void {
  const sim = state.simulation;
  if (sim.status === "idle") return;
  sim.status = "idle";
  sim.events = [];
  sim.log = [];
  sim.capture = [];
  sim.transits = [];
  sim.pendingArp = {};
  bootQueue = [];          // stop also cancels any in-flight network-boot chain
  pendingBootRun = false;
  bootRunActive = false;
  state.inspectedCapture = null; // the capture it referenced is gone
  // The live capture was just cleared — fall back to the most recent saved run.
  state.dock.captureView = state.savedCaptures.length ? state.savedCaptures[state.savedCaptures.length - 1].id : "live";
  if (state.dock.compareBaseId === state.dock.captureView) state.dock.compareBaseId = "";
  stopAnimationLoop();
  updateSimControls(); // hide the floating transport pill
  sync().syncSimLog();
  sync().syncTerminal();
  sync().render();
}

export function pauseSimulation(): void {
  if (state.simulation.status === "running") {
    state.simulation.status = "paused";
    // Freeze: stop the rAF loop so in-flight dots neither advance nor get
    // delivered while paused (their current position is already on screen). The
    // loop restarts on resume. Without this, pausing to inspect a dot (which
    // calls this) let the frame keep moving, get delivered and get captured
    // while the run read "paused" (review R10).
    stopAnimationLoop();
    updateSimControls();
    sync().syncTerminal();   // the busy shell's placeholder says "paused"
  }
}

export function resumeSimulation(): void {
  if (state.simulation.status === "paused") {
    state.simulation.status = "running";
    // Rebase each frozen dot's startTime onto the resume instant so it carries
    // on from the progress it held, rather than jumping forward by the whole
    // paused interval (progress = (now - startTime) / span).
    const now = performance.now();
    for (const t of state.simulation.transits) {
      t.startTime = now - t.progress * (state.simulation.speed * (t.latencyFactor ?? 1));
    }
    updateSimControls();
    sync().syncTerminal();
    if (state.simulation.transits.length === 0) processNextStep();
    // processNextStep may have ended the run (no events left → finishSimulation).
    if (state.simulation.status === "running") startAnimationLoop();
  }
}

export function stepOnce(): void {
  const sim = state.simulation;
  if (sim.status !== "paused" && sim.status !== "running") return;
  const wasRunning = sim.status === "running";
  sim.status = "paused";
  if (wasRunning) sync().syncTerminal();   // the busy shell's placeholder says "paused"
  // If transits are in progress, complete them instantly
  if (sim.transits.length > 0) {
    for (const t of sim.transits) t.progress = 1;
    deliverCompletedTransits();
  }
  processNextStep();
  updateSimControls();
  // The paused loop no longer spins to draw the frames this step produced, so
  // render them here (frozen at their source until the next step) — review R10.
  sync().render();
}

export interface SimResult {
  success: boolean;
  refused?: boolean;             // TCP connect answered with RST (port closed)
  ttl?: number;
  responderIp?: string | null;   // who answered (echo reply or a router's TTL-exceeded)
  timeExceeded?: boolean;        // the answer was an ICMP Time-Exceeded
  unreachableFrom?: string | null; // who sent an ICMP Destination Unreachable (a REJECT), if anyone
  resolvedIp?: string | null;    // DNS answer (mode "dns" or a by-name ping/tcp/http flow)
  httpStatus?: number | null;    // HTTP response status (mode "http")
  assignedIp?: string | null;
  assignedGateway?: string | null;
  storm: boolean;                // the run hit the broadcast-storm cap (an L2 loop with no spanning tree)
  diagnosis: string[];           // the post-mortem: why the flow failed, when no single step says so (empty on success, bar a storm)
  log: SimLogEntry[];
  steps: number;
}

// Runs a simulation to completion synchronously — no animation / requestAnimationFrame —
// and returns the result plus the hop-by-hop log. Reuses the same process handlers as
// the animated path; powers the console `run` command, window.routesim, and tests.
// Never refused: an animated run in flight is stopped first, with a note (beginRun)
// naming `purpose` — what needed the simulator, in the learner's words.
export function runSimulationHeadless(
  setup: PingSetup, originDeviceId: string, targetIp: string, mode: SimMode = "ping", targetPort: number | null = null, purpose?: string
): SimResult {
  beginRun(setup, originDeviceId, targetIp, mode, targetPort, true, purpose);
  const sim = state.simulation;
  // sim.capture is deliberately left alone: headless runs don't capture, and
  // a scenario check (or first-boot chatter) must not wipe the packet list.
  sim.events = setup.events;
  try {
    return drainHeadless(mode);
  } finally {
    // A run that threw mid-drain must still end: a stale "running" headless run
    // would make beginRun refuse every later animated run and lock the origin
    // terminal, with no transport pill on screen to stop it from.
    if ((sim.status as string) !== "done") {
      sim.status = "done";
      sim.events = [];
      sim.transits = [];
      sim.pendingArp = {};
    }
    sim.headless = false;   // the flag belongs to the run, not to whatever comes after it
  }
}

function drainHeadless(mode: SimMode): SimResult {
  const sim = state.simulation;
  // Drain the event queue, completing each batch of transits instantly. processNextStep
  // recurses internally while status === "running" and events have no transits, and calls
  // finishSimulation() once fully drained. A broadcast storm can't spin this forever:
  // processNextStep's loop detection (and its STORM_BACKSTOP_STEPS backstop) finishes
  // the run — the same checks, at the same step, as the animated path.
  processNextStep();
  while (sim.transits.length > 0 && sim.status === "running") {
    for (const t of sim.transits) t.progress = 1;
    deliverCompletedTransits();
    processNextStep();
  }
  // `sim.status` is mutated inside processNextStep/finishSimulation; the cast
  // stops TS from over-narrowing it to the literal assigned above.
  if ((sim.status as string) !== "done") finishSimulation();

  return {
    success: runSucceeded(mode),
    refused: sim.tcpRefused,
    ttl: sim.pingTtl,
    responderIp: sim.pingResponderIp,
    timeExceeded: sim.pingTimeExceeded,
    unreachableFrom: sim.pingUnreachableFrom,
    resolvedIp: sim.dnsResolvedIp,
    httpStatus: sim.httpStatus,
    assignedIp: sim.dhcpAssignedIp,
    assignedGateway: sim.dhcpAssignedGateway,
    storm: sim.stormDetected,
    diagnosis: sim.diagnosis,
    log: sim.log,
    steps: sim.stepIndex,
  };
}

// ─── First boot (link-up / power-on autoconf) ────────────────────────────────

// Network boot. Adding/cabling a host no longer auto-configures it — it stays
// "unassigned" until the user starts the simulation. Then every unconfigured,
// cabled, powered-on host boots in turn with an *animated* DHCP exchange
// (Discover → Offer → Request → ACK on the canvas), self-assigning APIPA
// 169.254.x.y/16 only after the simulated DHCP times out — just like a real
// machine on carrier detect, but visible. Wired to the Play button (when idle).
let bootQueue: string[] = [];
// A network-boot run (Play auto-DHCP for unconfigured hosts) is chained chatter,
// not a user experiment — `pendingBootRun` is armed by bootNextHost just before
// its startSimulation and latched into `bootRunActive` by beginRun for the run's
// lifetime. It keeps the run's capture out of the multi-run compare archive,
// skips the per-run undo point, and marks the run as one a user's run preempts.
let pendingBootRun = false;
let bootRunActive = false;
// One Play press is ONE undo point, taken lazily by bootNextHost the first time
// it actually changes something (a boot run or an APIPA assignment) — so a press
// that boots nothing leaves the undo/redo stacks alone.
let bootUndoPending = false;

function hostNeedsBoot(device: Device | undefined): boolean {
  return !!device && isBootable(device.type)
    && !device.poweredOff && !device.config?.ipv4Address
    && state.links.some(l => isPhysicalLink(l) && !l.shutdown && (l.from === device.id || l.to === device.id));
}

export function unconfiguredBootableHosts(): Device[] {
  return state.devices.filter(hostNeedsBoot);
}

// Kick off the boot of every unconfigured cabled host. Returns false (nothing to
// do) if none qualify, both auto-DHCP and APIPA are off, or a run is already in
// flight — setting an explanatory status hint in each case. The two toggles are
// independent: auto-DHCP on → animated DHCP (APIPA on failure if enabled);
// auto-DHCP off but APIPA on → the host self-assigns link-local directly.
// Autonomous Red Team: when Play is pressed and there's nothing to boot, launch
// the first ready attacker's enabled attacks. Returns whether one launched.
// With Red Team actors placed but none ready, says why the first one can't go
// (rather than leaving "Nothing to boot" as the only word on it).
export function launchRedTeam(): boolean {
  const sim = state.simulation;
  if (sim.status === "running" || sim.status === "paused") return false;
  const actors = state.devices.filter(d => d.type === "attacker");
  const attacker = actors.find(d => !redTeamNotReadyReason(d));
  if (!attacker) {
    if (actors.length) dom.modeLabel.textContent = redTeamNotReadyReason(actors[0])!;
    return false;
  }
  const setup = buildAttackEvents(attacker);
  if (typeof setup === "string") { dom.modeLabel.textContent = setup; return false; }
  dom.modeLabel.textContent = `${attacker.name}: launching attacks...`;
  startSimulation(setup, attacker.id, "", "attack");
  return true;
}

// Why a Red Team actor can't launch on Play, or null when it's ready.
function redTeamNotReadyReason(actor: Device): string | null {
  if (actor.poweredOff) return `${actor.name} is powered off — power it on to launch its attacks.`;
  if (!actor.config?.ipv4Address) {
    const cabled = state.links.some(l => isPhysicalLink(l) && !l.shutdown && (l.from === actor.id || l.to === actor.id));
    return cabled
      ? `${actor.name} has no IP address — set a static IP, or turn on Auto-DHCP / APIPA fallback (Settings) so Play boots it.`
      : `${actor.name} has no IP address and no cable — connect it to the network first.`;
  }
  if (!(actor.config.attacks?.length)) return `${actor.name} has no attacks enabled — pick a scan, sweep or ARP spoof in its inspector.`;
  return null;
}

export function startNetworkBoot(): boolean {
  const sim = state.simulation;
  if (sim.status === "running" || sim.status === "paused") return false;
  if (!state.options.autoDhcp && !state.options.apipaFallback) {
    dom.modeLabel.textContent = "Auto-DHCP and APIPA fallback are both off — hosts won't self-configure (set a static IP, or run dhcp).";
    return false;
  }
  bootQueue = unconfiguredBootableHosts().map(d => d.id);
  if (!bootQueue.length) {
    dom.modeLabel.textContent = "Nothing to boot — every host already has an address.";
    return false;
  }
  // ONE undo point for the whole Play press: the boot runs below skip their own
  // (beginRun), and the direct-APIPA path never had one.
  bootUndoPending = true;
  // The direct-APIPA path starts no run, so nothing else reseeds for it: without
  // this the addresses depended on whatever the last run left in the stream, and
  // a pinned seed reproduced nothing. (A DHCP boot reseeds in its builder.)
  if (!state.options.autoDhcp) seedSimRng();
  return bootNextHost();
}

// Boot the next queued host. With auto-DHCP on, run its animated DHCP exchange
// (finishSimulation chains to the next one). With auto-DHCP off but APIPA on, no
// DHCP frames are sent — each host self-assigns a link-local address instantly,
// so the whole queue drains in this single call.
function bootNextHost(): boolean {
  let apipaCount = 0;
  while (bootQueue.length) {
    const device = getDevice(bootQueue.shift()!);
    if (!hostNeedsBoot(device)) continue; // skip any already addressed by a prior boot
    if (state.options.autoDhcp) {
      const setup = buildDhcpEvents(device!);
      if (typeof setup === "string") continue;
      dom.modeLabel.textContent = `Booting ${device!.name} via DHCP...`;
      takeBootUndo();
      pendingBootRun = true; // a boot run — keep its capture out of the compare archive
      startSimulation(setup, device!.id, "", "dhcp");
      return true;
    }
    // Auto-DHCP off, APIPA on (the only way we reach here): self-assign directly.
    takeBootUndo();
    assignApipa(device!);
    apipaCount++;
  }
  if (apipaCount) {
    dom.modeLabel.textContent = `Auto-DHCP off — ${apipaCount} host${apipaCount > 1 ? "s" : ""} self-assigned a link-local (APIPA) address.`;
    sync().render();
    sync().syncPanel();
  }
  bootUndoPending = false;   // the queue drained — a press that changed nothing took no undo point
  return false;
}

function takeBootUndo(): void {
  if (!bootUndoPending) return;
  bootUndoPending = false;
  pushUndo();
}

export interface TracerouteHop { ttl: number; ip: string | null; reached: boolean }
// `storm`: a probe hit the broadcast-storm cap — the trace stops there, since
// every later probe would drown in the same loop (and print 30 lines of `*`).
// `diagnosis`: when the destination was not reached, the last probe's
// post-mortem (an ARP nobody answered past the last hop, say). It plays the
// part of real traceroute's `!H`: why the trail goes silent, not just that it does.
export interface TracerouteResult { targetIp: string; hops: TracerouteHop[]; reached: boolean; storm?: boolean; diagnosis?: string[] }

// Runs traceroute headlessly: sends probes with increasing TTL and records who
// answered each round — a router's ICMP Time-Exceeded (intermediate hop) or the
// destination's Echo Reply (final hop). Reuses runSimulationHeadless per probe.
export function runTraceroute(source: Device, targetText: string, maxHops = 30): TracerouteResult | string {
  const purpose = `a traceroute from ${source.name}`;   // names it if it stops an animated run
  // Honour Instant DNS like ping/connect do (review R16): with it off, a device
  // NAME must resolve through a real DNS query (below), not shortcut to the
  // device's IP — otherwise `ping PC-B` says "cannot resolve" while
  // `traceroute PC-B` quietly succeeds. A bare IP never needs resolving.
  const instant = state.options?.instantDns !== false;   // default on
  const target = instant ? findPingTarget(targetText) : null;
  let targetIp = target ? (target.config?.ipv4Address || targetText) : targetText.trim();
  if (!target && !isValidIpv4(targetIp)) {
    // A real hostname: resolve it headlessly via the configured nameserver
    // (real DNS frames), then trace the answer.
    const lookup = buildResolveEvents(source, targetIp, null, null);
    if (typeof lookup === "string") return `traceroute: unknown host ${targetIp}`;
    const res = runSimulationHeadless(lookup, source.id, targetIp, "dns", null, purpose);
    if (!res.resolvedIp) return `traceroute: unknown host ${targetIp}`;
    targetIp = res.resolvedIp;
  }
  // Warm ARP along the path first: a router's Time-Exceeded can't be delivered
  // on a cold ARP cache within a single headless probe, which would show false
  // "* no response" hops. A real router always answers TTL-exceeded, and
  // traceroute populating ARP as a side effect is itself realistic.
  // Probes target the resolved IP directly (per-probe TTLs must apply to the
  // ICMP leg, not a DNS round-trip).
  const warm = buildPingEvents(source, targetIp);
  const hops: TracerouteHop[] = [];
  if (typeof warm !== "string" && runSimulationHeadless(warm, source.id, targetIp, "ping", null, purpose).storm) {
    return { targetIp, hops, reached: false, storm: true };
  }

  let reached = false;
  let diagnosis: string[] = [];
  for (let ttl = 1; ttl <= maxHops; ttl++) {
    const setup = buildPingEvents(source, targetIp, { ttl });
    if (typeof setup === "string") return setup; // validation error (e.g. cannot resolve / no gateway)
    const res = runSimulationHeadless(setup, source.id, targetIp, "ping", null, purpose);
    if (res.storm) return { targetIp, hops, reached: false, storm: true };
    if (res.success) {
      hops.push({ ttl, ip: res.responderIp || targetIp, reached: true });
      reached = true;
      break;
    }
    hops.push({ ttl, ip: res.responderIp || null, reached: false });
    diagnosis = res.diagnosis;
  }
  return reached ? { targetIp, hops, reached } : { targetIp, hops, reached, diagnosis };
}

// ─── Animation loop ──────────────────────────────────────────────────────────

let animFrameId: number | null = null;

// Broadcast-storm backstop, shared by both paths: a run still putting frames on
// the wire after this many steps is stopped and reported as a storm. Storms are
// normally caught far sooner, by evidence (loopedBack: a frame coming back round
// a switching loop); this only bounds a loop that evidence somehow misses. It
// counts steps that sent frames — not every event, so the hosts that ignore a
// flooded broadcast don't count, and a large loop-free run never comes near it.
const STORM_BACKSTOP_STEPS = 10000;

// Service names for the Red Team scan report (nmap-style PORT/SERVICE column).
const SERVICE_NAMES: Record<number, string> = {
  21: "ftp", 22: "ssh", 23: "telnet", 25: "smtp", 53: "domain", 80: "http",
  110: "pop3", 143: "imap", 443: "https", 445: "microsoft-ds", 3306: "mysql",
  3389: "ms-wbt-server", 8080: "http-proxy",
};

function startAnimationLoop(): void {
  if (animFrameId != null) return;
  animFrameId = requestAnimationFrame(animationTick);
}

function stopAnimationLoop(): void {
  if (animFrameId != null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
}

// A frame the user has chosen to resolve silently (ARP/DHCP/DNS settings): the
// engine still processes it, but it is delivered instantly and neither drawn nor
// added to the packet list, so the higher-layer flow stays uncluttered.
export function isSilentFrame(frame: EthernetFrame): boolean {
  const opt = state.options;
  const payload = frame.payload;
  if (payload.type === "arp") return opt.silentArp;
  if (payload.type === "dot11") return opt.silentWifi;
  if (payload.type === "bpdu") return opt.silentStp;
  if (payload.type === "ipv4") {
    const inner = (payload as Ipv4Payload).payload;
    if (inner.type === "dhcp") return opt.silentDhcp;
    if (inner.type === "dns") return opt.silentDns;
  }
  return false;
}

export function animationTick(now: number): void {
  const sim = state.simulation;

  // Only a running simulation advances. While paused the whole visible state is
  // frozen: no progress, no delivery, no capture (review R10). A step (stepOnce)
  // advances the run by its own synchronous path, not through this loop.
  if (sim.status !== "running") {
    animFrameId = null;
    return;
  }

  // Update transit progress (per-link latency stretches a dot's crossing time).
  // Silent frames jump straight to delivered — no visible crossing.
  for (const t of sim.transits) {
    t.progress = t.silent ? 1 : Math.min(1, (now - t.startTime) / (sim.speed * (t.latencyFactor ?? 1)));
  }

  sync().render();

  // Check if all transits completed
  if (sim.transits.length > 0 && sim.transits.every(t => t.progress >= 1)) {
    deliverCompletedTransits();
    if (sim.autoPlay) {
      processNextStep();
    }
  } else if (sim.transits.length === 0 && sim.events.length > 0 && sim.autoPlay) {
    // No transits in flight but events queued (from a step that produced no outgoing)
    processNextStep();
  }

  // Keep looping while the run is still active. processNextStep may have ended
  // it (finishSimulation sets "done" and stops the loop); re-check status.
  if (sim.status === "running") {
    animFrameId = requestAnimationFrame(animationTick);
  } else {
    animFrameId = null;
  }
}

// ─── Event processing ────────────────────────────────────────────────────────

function deliverCompletedTransits(): void {
  const sim = state.simulation;
  const completed = sim.transits.filter(t => t.progress >= 1);
  sim.transits = sim.transits.filter(t => t.progress < 1);
  for (const t of completed) {
    // Packet list: one capture entry per wire traversal (animated runs only —
    // headless probes like traceroute/scenario checks stay invisible). Silent
    // frames (ARP/DHCP/DNS, per the settings) are delivered but never listed.
    if (!sim.headless && !t.silent) {
      const wireLink = linkById(t.linkId);
      // A frame crossing a MACsec-secured link is protected on the wire — shown
      // encrypted in the packet list (the engine still processes the real inner
      // frame at the far end, where MACsec would have decrypted it).
      const macsec = !!wireLink && t.frame.payload.type !== "dot11" && t.frame.payload.type !== "dot1x" && t.frame.payload.type !== "bpdu" && macsecState(wireLink) === "secured";
      // A strictly increasing capture number — derived from the last entry, not
      // the array length, so it stays unique after the 1000-entry cap shifts
      // older rows out (the packet list keys row clicks + selection on it).
      const lastNo = sim.capture.length ? sim.capture[sim.capture.length - 1].no : 0;
      sim.capture.push({
        no: lastNo + 1,
        step: sim.stepIndex,
        frame: t.frame,
        fromDeviceId: t.fromDeviceId,
        toDeviceId: t.toDeviceId,
        linkId: t.linkId,
        ...(macsec ? { macsec: true } : {}),
      });
      if (sim.capture.length > 1000) sim.capture.shift();
    }
    // Record frame on link
    const link = linkById(t.linkId);
    if (link) {
      if (!link.frameHistory) link.frameHistory = [];
      link.frameHistory.push({
        step: sim.stepIndex,
        frame: t.frame,
        fromDeviceId: t.fromDeviceId,
        toDeviceId: t.toDeviceId,
        timestamp: Date.now()
      });
      if (link.frameHistory.length > 200) link.frameHistory.splice(0, link.frameHistory.length - 200);
    }
    sim.events.push({
      type: "frame_arrive",
      frame: t.frame,
      deviceId: t.toDeviceId,
      fromDeviceId: t.fromDeviceId,
      linkId: t.linkId
    });
  }
}

function processNextStep(): void {
  const sim = state.simulation;
  if (sim.events.length === 0) {
    // No more events — simulation complete
    finishSimulation();
    return;
  }

  const event = sim.events.shift()!;
  sim.stepIndex++;

  const device = getDevice(event.deviceId);
  if (!device) {
    // The target was deleted mid-run. Drop the frame but still settle: if this
    // was the last queued work the run must finish, not sit on "running" with
    // live controls over a canvas the frame can no longer reach.
    const sender = event.fromDeviceId ? getDevice(event.fromDeviceId) : null;
    if (sender) logStep(sender, "sim-drop", `Frame for a device that no longer exists — dropped`);
    settleStep();
    return;
  }

  // A powered-off device processes nothing. One guard here, before dispatch,
  // so the drop is explained (the processors' own poweredOff early-outs stay as
  // defence for direct callers, but no longer swallow a run's frames silently).
  let outgoing: OutgoingFrame[];
  if (device.poweredOff) {
    logStep(device, "sim-drop", `${device.name} is powered off — ${frameLabel(event.frame)} dropped`);
    noteArpDrop(event.frame, device, `${device.name} is powered off`);
    outgoing = [];
  } else {
    outgoing = PROCESSORS[device.type]?.(device, event.frame, event.fromDeviceId) ?? [];
  }

  // Create transits for outgoing frames
  const now = performance.now();
  for (const out of outgoing) {
    const link = findLinkBetween(event.deviceId, out.toDeviceId);
    if (!link) continue;
    if (link.shutdown) {
      // Administratively down — the cable's there but it carries no traffic,
      // control frames included (so this precedes admitOnLink's data gate).
      const reason = linkDataBlockReason(link)!;
      logStep(device, "sim-drop", `${reason} — ${frameLabel(out.frame)} dropped`);
      noteArpDrop(out.frame, getDevice(out.toDeviceId), reason);
      continue;
    }
    // A link that hasn't authenticated (a wrong-password WiFi association, or an
    // 802.1X port still unauthorized), or a spanning-tree alternate port, passes
    // only control frames (dot11 / dot1x / BPDU) — never data. BPDUs in
    // particular must cross a blocked port so the tree stays converged.
    if (!admitOnLink(device, link, out.frame)) continue;
    if (loopedBack(device, link, out)) {
      sim.stormDetected = true;
      break;
    }
    sim.transits.push({
      frame: out.frame,
      linkId: link.id,
      fromDeviceId: event.deviceId,
      toDeviceId: out.toDeviceId,
      progress: 0,
      startTime: now,
      latencyFactor: linkLatencyFactor(link),
      silent: isSilentFrame(out.frame),
      // The frame this device received, so the callout can flash the fields the
      // device rewrote on the way out (MACs at every hop, src IP/port at NAT) —
      // issue #2. The first leg has none (nothing was rewritten yet).
      prevFrame: event.frame
    });
  }

  // A broadcast storm ends the run on both paths at this same step: a frame
  // came back round a loop (above), or — the backstop — frames are still being
  // sent after STORM_BACKSTOP_STEPS steps.
  if (!sim.stormDetected && sim.transits.length > 0 && ++sim.wireSteps > STORM_BACKSTOP_STEPS) {
    logStep(device, "sim-drop", `Frames still circulating after ${STORM_BACKSTOP_STEPS} forwarding steps — stopping the run as a broadcast storm`);
    sim.stormDetected = true;
  }
  if (sim.stormDetected) {
    finishSimulation();
    return;
  }

  // Headless runs never touch the DOM — skip per-step rendering (faster, and it
  // keeps probes like traceroute from flashing the canvas / sim-log panel).
  if (!sim.headless) {
    sync().syncSimLog();
    sync().render();
  }

  settleStep();
}

// A frame's lineage: the id it was created with. Forwarding copies a frame
// under a suffixed id (`-<port>` per flood copy, `-routed`, `-fw0`, `-span`…),
// so every copy of it descends from that root.
function frameLineage(id: string): string {
  if (!id.startsWith("frame-")) return id;
  const cut = id.indexOf("-", 6);
  return cut < 0 ? id : id.slice(0, cut);
}

// Broadcast-storm evidence: the same frame lineage crossing the same wire in
// the same direction a second time. In a loop-free network each lineage crosses
// each wire at most once per direction (a switch never floods back out the port
// a frame came in on), however many hosts a broadcast reaches. An L2 loop brings
// a copy back round unchanged, and with no TTL at layer 2 it will circulate —
// and multiply — forever. The IPv4 TTL is part of the key, so an IP routing loop
// (each lap one hop older, ended by TTL expiry) is never mistaken for one.
// Called for every frame put on a wire by both paths, so the animated and
// headless runs reach the same verdict at the same step. A host never forwards
// (whatever it sends is a new frame, a lineage of its own), so it is skipped.
function loopedBack(device: Device, link: Link, out: OutgoingFrame): boolean {
  if (isHost(device.type)) return false;
  const trace = state.simulation.loopTrace;
  const frame = out.frame;
  const ttl = frame.payload.type === "ipv4" ? (frame.payload as Ipv4Payload).ttl : "";
  const key = `${frameLineage(frame.id)}|${link.id}|${device.id}|${ttl}`;
  if (!trace.has(key)) {
    trace.add(key);
    return false;
  }
  const peer = getDevice(out.toDeviceId);
  logStep(device, "sim-drop", `${frameLabel(frame)} came back round to cross ${linkName(link)} (${device.name} → ${peer?.name ?? "?"}) again — a switching loop: nothing blocks the redundant link, so its copies will circulate forever`);
  return true;
}

// After a step: with no transits but events left, process the next event now
// (a device ignored a frame with no outgoing); with nothing at all left, the
// run is done. Shared by the normal path and the deleted-device drop above.
function settleStep(): void {
  const sim = state.simulation;
  if (sim.transits.length === 0 && sim.events.length > 0 && sim.status === "running") {
    processNextStep();
    return;
  }
  if (sim.transits.length === 0 && sim.events.length === 0 && sim.status !== "done") {
    finishSimulation();
  }
}

export interface OutgoingFrame {
  frame: EthernetFrame;
  toDeviceId: string;
}

// Frame processing per device type; a type absent here (e.g. lan) ignores frames.
const PROCESSORS: Partial<Record<DeviceType, (device: Device, frame: EthernetFrame, fromDeviceId: string | null) => OutgoingFrame[]>> = {
  computer: processAtComputer,
  laptop: processAtComputer,            // a laptop is a WiFi-only host
  server: processAtServer,
  switch: processAtSwitch,
  "access-point": processAtSwitch,      // an AP bridges like an unmanaged switch
  internet: processAtInternet,          // the internet cloud is an L3 transit — it routes between connected routers by destination
  router: processAtRouter,
  firewall: processAtFirewall,
  hub: processAtHub,
  ids: processAtIds,
  attacker: processAtAttacker,
  kali: processAtAttacker,              // a Kali PC tallies its own hand-run attacks
};

// ─── 802.11 association handshake ────────────────────────────────────────────

// The reactive association state machine, shared by the laptop (client) and the
// access point. Each device, on receiving one management frame, emits the next:
// Probe → open-system Auth → Association, then on a secured network the WPA2
// 4-way key handshake (EAPOL M1–M4). A response just swaps src/dst (the air is a
// single link), so it always goes back to the sender.
function handleDot11(device: Device, frame: EthernetFrame, fromDeviceId: string | null): OutgoingFrame[] {
  const payload = frame.payload as Dot11Payload;
  const ssid = payload.ssid;
  const next = (subtype: Dot11Payload["subtype"]) =>
    fromDeviceId ? [{ frame: createDot11Frame(frame.dstMac, frame.srcMac, subtype, ssid), toDeviceId: fromDeviceId }] : [];
  const done = (): OutgoingFrame[] => {
    state.simulation.wifiAssociated = true;
    logStep(device, "sim-wifi", `Associated to "${ssid}"`);
    return [];
  };

  if (device.type === "access-point") {
    const secured = !!device.config?.wifiPassword;
    switch (payload.subtype) {
      case "probe-req": {
        // Answer only a probe for the network this AP broadcasts. A probe for a
        // different SSID is ignored, exactly as a real AP does — so changing the
        // laptop's SSID after the link exists stalls the handshake here.
        const apSsid = (device.config?.ssid || "").trim();
        if (ssid !== apSsid) {
          const who = getDevice(fromDeviceId || "")?.name || "client";
          state.simulation.wifiFailure = `${device.name} broadcasts "${apSsid}", not "${ssid}" — ${who} is probing for a different network (set matching SSIDs)`;
          logStep(device, "sim-drop", `Probe Request for "${ssid}" ignored — ${device.name} broadcasts "${apSsid}"`);
          return [];
        }
        logStep(device, "sim-wifi", `Probe Request for "${ssid}" — sending Probe Response`);
        return next("probe-resp");
      }
      case "auth-req": logStep(device, "sim-wifi", `Open-system Authentication — sending success`); return next("auth-resp");
      case "assoc-req": logStep(device, "sim-wifi", `Association Request — sending Association Response${secured ? " (WPA2 follows)" : ""}`); return next("assoc-resp");
      case "eapol-start": logStep(device, "sim-wifi", `WPA2 4-way handshake — sending Message 1`); return next("eapol-m1");
      case "eapol-m2": {
        // The Message-2 MIC is derived from the client's PSK: a wrong password
        // fails the check and the AP deauthenticates instead of sending M3.
        const client = getDevice(fromDeviceId || "");
        if ((client?.config?.wifiPassword || "") === (device.config?.wifiPassword || "")) return next("eapol-m3");
        logStep(device, "sim-drop", `WPA2 key mismatch from ${client?.name || "client"} — sending Deauthentication`);
        return next("deauth");
      }
      case "eapol-m4": return done(); // client confirmed the keys
    }
    return [];
  }
  // The laptop (client) side.
  const ap = getDevice(fromDeviceId || "");
  const secured = !!ap?.config?.wifiPassword;
  switch (payload.subtype) {
    case "probe-resp": logStep(device, "sim-wifi", `Found "${ssid}" — authenticating`); return next("auth-req");
    case "auth-resp": return next("assoc-req");
    case "assoc-resp":
      if (secured) { logStep(device, "sim-wifi", `Associated — beginning WPA2 key exchange`); return next("eapol-start"); }
      return done(); // open network: associated once the response lands
    case "eapol-m1": return next("eapol-m2");
    case "eapol-m3": return next("eapol-m4");
    case "deauth":
      logStep(device, "sim-drop", `Deauthenticated from "${ssid}" — wrong password (WPA2 handshake failed)`);
      return []; // wifiAssociated stays false: the join failed
  }
  return [];
}

// ─── 802.1X port authentication ──────────────────────────────────────────────

const PAE_GROUP_MAC = "01:80:C2:00:00:03"; // the real 802.1X PAE group address

// The RADIUS server directly attached to an authenticator switch (the demo keeps
// the back-end adjacent; real RADIUS would route over IP).
function radiusServerFor(sw: Device): Device | null {
  for (const link of linksFor(sw.id)) {
    if (!isPhysicalLink(link) || link.shutdown) continue;
    const peer = getDevice(link.from === sw.id ? link.to : link.from);
    if (peer?.type === "server" && (peer.config as any)?.radius?.users?.length) return peer;
  }
  return null;
}

// The supplicant host on one of this switch's ports with a given MAC — the
// session key carried through the exchange, so the result lands on the port
// that started it (two hosts may present the same identity).
function supplicantByMac(sw: Device, mac: string | undefined): { host: Device; link: any } | null {
  if (!mac) return null;
  for (const link of linksFor(sw.id)) {
    if (!isPhysicalLink(link) || link.shutdown || link.wireless) continue;
    const host = getDevice(link.from === sw.id ? link.to : link.from);
    if (host && host.config?.macAddress === mac) return { host, link };
  }
  return null;
}

// Fallback: the supplicant host on one of this switch's ports presenting a given identity.
function supplicantByIdentity(sw: Device, identity: string): { host: Device; link: any } | null {
  for (const link of linksFor(sw.id)) {
    if (!isPhysicalLink(link) || link.shutdown || link.wireless) continue;
    const host = getDevice(link.from === sw.id ? link.to : link.from);
    if (host && isDot1xSupplicant(host.type) && host.config?.dot1x?.identity === identity) {
      return { host, link };
    }
  }
  return null;
}

// The reactive 802.1X exchange, routed by frame subtype across all three roles —
// supplicant (host), authenticator (switch), and RADIUS server. EAPOL/EAP runs
// host↔switch; RADIUS runs switch↔server. An `auto` port stays unauthorized
// (link.dot1xAuthorized) until EAP-Success.
//
// The authenticator obeys the port's control mode, as the 802.1X PAE state
// machine does: only an `auto` port runs the exchange. A force-unauthorized
// port answers with a canned EAP-Failure and a force-authorized one with a
// canned EAP-Success — neither asks RADIUS. (The handler used to ignore the
// mode: a force-unauthorized port relayed to RADIUS, recorded the link as
// authorised and reported success, while the data gate still held it closed.)
function handleDot1x(device: Device, frame: EthernetFrame, fromDeviceId: string | null): OutgoingFrame[] {
  const p = frame.payload as Dot1xPayload;
  const identity = p.identity || "";
  const back = (subtype: Dot1xPayload["subtype"], id?: string) =>
    fromDeviceId ? [{ frame: createDot1xFrame(frame.dstMac, frame.srcMac, subtype, id), toDeviceId: fromDeviceId }] : [];

  switch (p.subtype) {
    case "eapol-start": { // authenticator: obey the port's control mode, then kick off the identity request
      const port = dot1xPortFacing(device, fromDeviceId);
      if (port?.mode === "force-unauthorized") {
        state.simulation.dot1xFailure = `${device.name} ${port.port} is 802.1X force-unauthorized: the switch refuses every login on it without asking RADIUS, whatever the credentials — set it to auto to authenticate ("portauth ${quoteArg(device.name)} ${port.port} auto")`;
        logStep(device, "sim-drop", `EAPOL-Start on ${port.port} — the port is force-unauthorized: EAP-Failure without asking RADIUS (the port stays closed whatever the credentials)`);
        return back("eap-failure", identity);
      }
      if (port?.mode !== "auto") {
        logStep(device, "sim-dot1x", `EAPOL-Start on ${port?.port ?? "this port"} — the port is force-authorized (no 802.1X control): EAP-Success without asking RADIUS; nothing was authenticated`);
        return back("eap-success", identity);
      }
      logStep(device, "sim-dot1x", `EAPOL-Start — requesting the supplicant's identity`);
      return back("eap-req-id");
    }
    case "eap-req-id": { // supplicant: answer with its identity
      const id = device.config?.dot1x?.identity || "";
      logStep(device, "sim-dot1x", `EAP Identity request — responding "${id}"`);
      return back("eap-resp-id", id);
    }
    case "eap-resp-id": { // authenticator: relay to RADIUS
      const server = radiusServerFor(device);
      if (!server) {
        state.simulation.dot1xFailure = `${device.name} has no RADIUS server attached to check "${identity}" against — cable a server to it and add the user ("radius <server> <identity> <password>")`;
        logStep(device, "sim-drop", `802.1X: no RADIUS server reachable — cannot authenticate`);
        return [];
      }
      logStep(device, "sim-dot1x", `Relaying identity "${identity}" to RADIUS (${server.name})`);
      return [{ frame: createDot1xFrame(deriveMac(device.id), server.config?.macAddress || deriveMac(server.id), "radius-request", identity, frame.srcMac), toDeviceId: server.id }];
    }
    case "radius-request": { // RADIUS server: validate identity + the supplicant's password
      const users = (device.config as any)?.radius?.users || [];
      // The credentials of THIS session's supplicant (by MAC) — not whichever
      // device anywhere happens to present the same identity.
      const sup = (p.supplicantMac ? state.devices.find((d: any) => d.config?.macAddress === p.supplicantMac) : undefined)
        ?? state.devices.find((d: any) => d.config?.dot1x?.identity === identity);
      const supPw = sup?.config?.dot1x?.identity === identity ? sup?.config?.dot1x?.password : undefined;
      const ok = users.some((u: any) => u.identity === identity && u.password === supPw);
      logStep(device, "sim-dot1x", `RADIUS Access-Request "${identity}" — ${ok ? "Access-Accept" : "Access-Reject"}`);
      const reply = back(ok ? "radius-accept" : "radius-reject", identity);
      for (const r of reply) (r.frame.payload as Dot1xPayload).supplicantMac = p.supplicantMac;
      return reply;
    }
    case "radius-accept": { // authenticator: authorise the port, tell the supplicant
      const sup = supplicantByMac(device, p.supplicantMac) ?? supplicantByIdentity(device, identity);
      if (!sup) return [];
      sup.link.dot1xAuthorized = true;
      logStep(device, "sim-dot1x", `Access-Accept — authorising ${sup.host.name}`);
      return [{ frame: createDot1xFrame(PAE_GROUP_MAC, sup.host.config?.macAddress || "", "eap-success", identity), toDeviceId: sup.host.id }];
    }
    case "radius-reject": { // authenticator: keep the port closed
      const sup = supplicantByMac(device, p.supplicantMac) ?? supplicantByIdentity(device, identity);
      if (!sup) return [];
      sup.link.dot1xAuthorized = false;
      state.simulation.dot1xFailure = `RADIUS rejected "${identity}" — the identity or password ${sup.host.name} presents does not match a user on the server`;
      logStep(device, "sim-drop", `Access-Reject — ${sup.host.name} stays unauthorized`);
      return [{ frame: createDot1xFrame(PAE_GROUP_MAC, sup.host.config?.macAddress || "", "eap-failure", identity), toDeviceId: sup.host.id }];
    }
    case "eap-success": // supplicant: authenticated
      state.simulation.dot1xAuthorized = true;
      logStep(device, "sim-dot1x", `EAP-Success — the port is authorised, traffic may pass`);
      return [];
    case "eap-failure": { // supplicant: rejected
      const closed = dot1xPortFacing(getDevice(fromDeviceId), device.id)?.mode === "force-unauthorized";
      logStep(device, "sim-drop", closed
        ? `EAP-Failure — the switch port is force-unauthorized; no credentials can open it`
        : `EAP-Failure — 802.1X authentication denied (check the identity/password)`);
      return [];
    }
  }
  return [];
}

// ─── Computer processing ─────────────────────────────────────────────────────

export function processAtComputer(device: Device, frame: EthernetFrame, fromDeviceId: string | null): OutgoingFrame[] {
  const sim = state.simulation;
  const outgoing: OutgoingFrame[] = [];
  if (device.poweredOff) return outgoing;
  const config = device.config;
  if (!config) return outgoing;
  // A laptop drives the client side of the 802.11 association handshake.
  if (frame.payload.type === "dot11") return handleDot11(device, frame, fromDeviceId);
  // A host is the 802.1X supplicant (and a server may also be the RADIUS back end).
  if (frame.payload.type === "dot1x") return handleDot1x(device, frame, fromDeviceId);

  frame = { ...frame, srcMac: normaliseMacAddress(frame.srcMac), dstMac: normaliseMacAddress(frame.dstMac) };

  if (frame.payload.type === "arp") {
    const arp = frame.payload as ArpPayload;

    if (arp.operation === "request") {
      // Is this ARP for our IP?
      if (arp.targetIp === config.ipv4Address) {
        // Learn sender
        learnArp(config, arp.senderIp, arp.senderMac);
        logStep(device, "sim-arp", `Received ARP Request for ${arp.targetIp} — sending ARP Reply`);

        // Send ARP reply back
        const reply = createArpReply(config.macAddress || "", config.ipv4Address || "", arp.senderMac, arp.senderIp, frame.vlanTag);
        if (fromDeviceId) outgoing.push({ frame: reply, toDeviceId: fromDeviceId });
      } else {
        logStep(device, "sim-arp", `Received ARP Request for ${arp.targetIp} — not our IP, ignoring`);
      }
    } else if (arp.operation === "reply") {
      // Learn sender
      learnArp(config, arp.senderIp, arp.senderMac);
      recordArpPoison(device, arp);
      logStep(device, "sim-arp", `Received ARP Reply: ${arp.senderIp} is-at ${arp.senderMac}`);

      // Check if we have a pending ICMP to send
      const pendingKey = `${device.id}:${arp.senderIp}`;
      const pending = sim.pendingArp[pendingKey];
      if (pending && pending.length > 0) {
        for (const pf of pending) {
          // Rewrite dstMac now that we know it
          pf.dstMac = arp.senderMac;
          logStep(device, "sim-icmp", `Sending deferred ${frameLabel(pf)} to ${arp.senderIp}`);
          if (fromDeviceId) outgoing.push({ frame: pf, toDeviceId: fromDeviceId });
        }
        delete sim.pendingArp[pendingKey];
      }
    }
  } else if (frame.payload.type === "ipv4") {
    const ipv4 = frame.payload as Ipv4Payload;

    // IP forwarding (net.ipv4.ip_forward): a frame unicast to OUR MAC but bound
    // for another IP was handed to us — the signature of an arpspoof victim
    // whose ARP cache we poisoned. With forwarding on, relay it toward its true
    // destination from our own (unpoisoned) ARP cache instead of dropping it:
    // the silent MITM the tool is known for, and the ping still succeeds. Off by
    // default; a broadcast/flooded frame (dstMac ≠ our MAC) is never forwarded.
    if (config.ipForward
        && ipv4.dstIp !== config.ipv4Address
        && frame.dstMac === normaliseMacAddress(config.macAddress || "")
        && frame.dstMac !== BROADCAST_MAC) {
      forwardIntercepted(device, config, frame, ipv4, fromDeviceId, outgoing);
      return outgoing;
    }

    if (ipv4.payload.type === "icmp") {
      // Hosts only answer ICMP addressed to their own IP — a frame that leaks
      // here (e.g. flooded unknown unicast) must not be answered for someone else.
      if (ipv4.dstIp !== config.ipv4Address) return outgoing;
      if (ipv4.payload.icmpType === 8) {
        // A reply to a cross-subnet source needs a route back (the default
        // gateway) — without one, a real host cannot answer at all.
        if (!hostHasReturnRoute(config, ipv4.srcIp)) {
          logStep(device, "sim-drop", `Cannot reply to ${ipv4.srcIp} — no route (no default gateway)`);
          return outgoing;
        }
        // ICMP Echo Request — send reply
        logStep(device, "sim-icmp", `Received ICMP Echo Request from ${ipv4.srcIp} — sending Reply`);
        const seq = ipv4.payload.sequence;
        emitHostReply(device, config, hostReplyPath(config, ipv4.srcIp, frame.srcMac),
          dstMac => createIcmpEchoReply(config.macAddress || "", dstMac, config.ipv4Address || "", ipv4.srcIp, 64, frame.vlanTag, seq),
          fromDeviceId, outgoing, frame.vlanTag);
      } else if (ipv4.payload.icmpType === 0) {
        // ICMP Echo Reply — ping success only if it came from the pinged address.
        if (device.id === sim.originDeviceId && ipv4.srcIp === sim.pingTargetIp) {
          sim.pingSuccess = true;
          sim.pingTtl = ipv4.ttl;
          sim.pingResponderIp = ipv4.srcIp;
          logStep(device, "sim-icmp", `Received ICMP Echo Reply from ${ipv4.srcIp} (TTL=${ipv4.ttl})`);
          // Don't generate outgoing — simulation will end after this step
        }
      } else if (ipv4.payload.icmpType === 11) {
        // ICMP Time-Exceeded — a router dropped the packet at TTL 0 (traceroute hop).
        if (device.id === sim.originDeviceId) {
          sim.pingResponderIp = ipv4.srcIp;
          sim.pingTimeExceeded = true;
          logStep(device, "sim-icmp", `Received ICMP Time-Exceeded from ${ipv4.srcIp}`);
        }
      } else if (ipv4.payload.icmpType === 3) {
        // ICMP Destination Unreachable — a filter REJECTed the flow somewhere
        // along the path (real ping prints this; the run still reads as failed).
        // Recorded apart from pingResponderIp, which traceroute reads as "the hop".
        if (device.id === sim.originDeviceId) {
          sim.pingUnreachableFrom = ipv4.srcIp;
          logStep(device, "sim-icmp", `Received ICMP Destination Unreachable from ${ipv4.srcIp}`);
        }
      }
    } else if (ipv4.payload.type === "tcp") {
      const tcp = ipv4.payload as TcpPayload;
      if (ipv4.dstIp !== config.ipv4Address) return outgoing; // not for us
      if (tcp.flags === "syn") {
        if (!hostHasReturnRoute(config, ipv4.srcIp)) {
          logStep(device, "sim-drop", `Cannot answer ${ipv4.srcIp} — no route (no default gateway)`);
          return outgoing;
        }
        // Listener model: no openPorts list = accept on any port; otherwise RST.
        const listening = !Array.isArray(config.openPorts) || config.openPorts.includes(tcp.dstPort);
        learnOnLinkArp(config, ipv4.srcIp, frame.srcMac);
        if (listening) {
          logStep(device, "sim-tcp", `TCP SYN on port ${tcp.dstPort} — sending SYN-ACK`);
          emitHostReply(device, config, hostReplyPath(config, ipv4.srcIp, frame.srcMac),
            dstMac => createTcpSegment(config.macAddress || "", dstMac, config.ipv4Address || "", ipv4.srcIp, tcp.dstPort, tcp.srcPort, "syn-ack", 64, frame.vlanTag),
            fromDeviceId, outgoing, frame.vlanTag);
        } else {
          logStep(device, "sim-drop", `TCP SYN on closed port ${tcp.dstPort} — sending RST`);
          emitHostReply(device, config, hostReplyPath(config, ipv4.srcIp, frame.srcMac),
            dstMac => createTcpSegment(config.macAddress || "", dstMac, config.ipv4Address || "", ipv4.srcIp, tcp.dstPort, tcp.srcPort, "rst", 64, frame.vlanTag),
            fromDeviceId, outgoing, frame.vlanTag);
        }
      } else if (tcp.flags === "syn-ack") {
        logStep(device, "sim-tcp", `TCP SYN-ACK from ${ipv4.srcIp}:${tcp.srcPort} — sending ACK (connection established)`);
        if (device.id === sim.originDeviceId) {
          sim.tcpSuccess = true;
          sim.pingResponderIp = ipv4.srcIp;
        }
        outgoing.push({ frame: createTcpSegment(config.macAddress || "", frame.srcMac, config.ipv4Address || "", ipv4.srcIp, tcp.dstPort, tcp.srcPort, "ack", 64, frame.vlanTag), toDeviceId: fromDeviceId! });
        // HTTP: once the connection is up, the client immediately sends its GET.
        if (sim.mode === "http" && device.id === sim.originDeviceId) {
          const host = sim.dnsName || ipv4.srcIp;
          logStep(device, "sim-tcp", `HTTP GET ${sim.httpPath} (Host: ${host})`);
          outgoing.push({ frame: createHttpRequest(config.macAddress || "", frame.srcMac, config.ipv4Address || "", ipv4.srcIp, tcp.dstPort, tcp.srcPort, sim.httpPath, host, 64, frame.vlanTag), toDeviceId: fromDeviceId! });
        }
      } else if (tcp.flags === "rst") {
        if (device.id === sim.originDeviceId) {
          sim.tcpRefused = true;
          logStep(device, "sim-drop", `TCP RST from ${ipv4.srcIp}:${tcp.srcPort} — connection refused`);
        }
      } else if (tcp.flags === "ack" && tcp.http?.kind === "request") {
        // Server side: an HTTP GET arrived on the established connection. The web
        // service listens on port 80 — a GET to any other (open) port goes
        // unanswered, like connecting to a port with no HTTP server behind it.
        if (config.httpEnabled && tcp.dstPort === 80) {
          const title = config.httpTitle || `${device.name} — RouteSim web server`;
          logStep(device, "sim-tcp", `HTTP ${tcp.http.method} ${tcp.http.path} → 200 OK`);
          emitHostReply(device, config, hostReplyPath(config, ipv4.srcIp, frame.srcMac), dstMac => createHttpResponse(config.macAddress || "", dstMac, config.ipv4Address || "", ipv4.srcIp, tcp.dstPort, tcp.srcPort, 200, "OK", title, 64, frame.vlanTag), fromDeviceId, outgoing, frame.vlanTag);
        } else {
          logStep(device, "sim-drop", `HTTP ${tcp.http.method} ${tcp.http.path} on port ${tcp.dstPort} — no web service (no response)`);
        }
      } else if (tcp.flags === "ack" && tcp.http?.kind === "response") {
        // Client side: the HTTP response came back.
        if (device.id === sim.originDeviceId) {
          sim.httpStatus = tcp.http.status ?? null;
          sim.httpStatusText = tcp.http.statusText ?? null;
          sim.httpServerTitle = tcp.http.title ?? null;
          sim.httpSuccess = (tcp.http.status ?? 0) >= 200 && (tcp.http.status ?? 0) < 300;
          logStep(device, "sim-tcp", `HTTP ${tcp.http.status} ${tcp.http.statusText} from ${ipv4.srcIp}`);
        }
      } else if (tcp.flags === "ack") {
        logStep(device, "sim-tcp", `TCP ACK from ${ipv4.srcIp} — handshake complete`);
      }
    } else if (ipv4.payload.type === "dns") {
      const dns = ipv4.payload as DnsPayload;
      if (ipv4.dstIp !== config.ipv4Address) return outgoing; // not for us
      if (dns.op === "query") {
        // A query sent to a host that is not a nameserver (a PC named in
        // resolv.conf by mistake). It used to vanish without a word — a stopped
        // dnsmasq was explained, a plain host was not. Nothing listens on
        // UDP/53 here, so answer as a real host does: ICMP Port Unreachable,
        // which the asker's nslookup reads as "connection refused".
        logStep(device, "sim-drop", `DNS query for ${dns.name} — ${device.name} runs no DNS service (UDP/53 closed), sending ICMP Port Unreachable`);
        emitHostReply(device, config, hostReplyPath(config, ipv4.srcIp, frame.srcMac),
          dstMac => createIcmpDestUnreachable(config.macAddress || "", dstMac, config.ipv4Address || "", ipv4.srcIp, 64, frame.vlanTag, icmpOriginalOf(ipv4)),
          fromDeviceId, outgoing, frame.vlanTag);
        return outgoing;
      }
      if (dns.op === "response" && device.id === sim.originDeviceId && dns.name === sim.dnsName) {
        if (dns.address) {
          sim.dnsResolvedIp = dns.address;
          logStep(device, "sim-dns", `DNS: ${dns.name} is ${dns.address}`);
          // Resolve-then-act: launch the flow the name lookup was for.
          if (sim.resolveThen && fromDeviceId) {
            sim.pingTargetIp = dns.address;
            const followOn = buildFollowOnFrames(device, config, dns.address, sim.resolveThen, sim.tcpTargetPort, frame.vlanTag);
            if (typeof followOn === "string") {
              logStep(device, "sim-drop", followOn);
            } else {
              for (const f of followOn) outgoing.push({ frame: f, toDeviceId: fromDeviceId });
            }
          }
        } else {
          logStep(device, "sim-drop", `DNS: ${dns.name} — NXDOMAIN (no such name)`);
        }
      }
    } else if (ipv4.payload.type === "dhcp") {
      const dhcp = ipv4.payload as DhcpPayload;
      // Only process DHCP meant for this client
      if (dhcp.clientMac !== config.macAddress) return outgoing;

      if (dhcp.messageType === "offer") {
        // First offer wins: with several DHCP servers on the segment the
        // client requests from whoever answered first and ignores the rest.
        if (sim.dhcpOfferTaken) {
          logStep(device, "sim-dhcp", `Ignoring competing DHCP Offer from ${dhcp.serverIp} (already requesting)`);
          return outgoing;
        }
        sim.dhcpOfferTaken = true;
        logStep(device, "sim-dhcp", `Received DHCP Offer: ${dhcp.assignedIp} from ${dhcp.serverIp}`);
        const request = createDhcpRequest(config.macAddress, dhcp.assignedIp!, dhcp.serverIp!, dhcp.transactionId, frame.vlanTag);
        if (fromDeviceId) outgoing.push({ frame: request, toDeviceId: fromDeviceId });
      } else if (dhcp.messageType === "ack") {
        logStep(device, "sim-dhcp", `Received DHCP ACK: assigned ${dhcp.assignedIp}, gateway ${dhcp.gatewayIp}`);
        config.ipv4Address = dhcp.assignedIp || "";
        config.ipSource = "dhcp";
        if (dhcp.prefixLength != null) config.prefixLength = dhcp.prefixLength; // subnet-mask option
        config.gatewayIpv4Address = dhcp.gatewayIp || "";
        if (dhcp.dnsServerIp) config.dnsServerIp = dhcp.dnsServerIp; // DNS option (6)
        // Learn router MAC in ARP table — but only when the box that answered
        // IS the gateway (server==gateway, the usual router-runs-DHCP case). A
        // standalone DHCP server on a different IP has a different MAC, so
        // binding it to the gateway IP would poison the client's ARP table;
        // there, let the client ARP for its gateway on the first off-subnet send.
        if (dhcp.gatewayIp && dhcp.gatewayIp === dhcp.serverIp && frame.srcMac && frame.srcMac !== BROADCAST_MAC) {
          learnArp(config, dhcp.gatewayIp, frame.srcMac);
        }
        sim.dhcpSuccess = true;
        sim.dhcpAssignedIp = dhcp.assignedIp || null;
        sim.dhcpAssignedGateway = dhcp.gatewayIp || null;
      }
    }
  }

  return outgoing;
}

// After a DNS answer, the origin host starts the flow it resolved the name
// for: an ICMP echo (ping) or a TCP SYN (nc). Same next-hop decision as the
// setup builders — on-subnet direct, otherwise via the default gateway — with
// the real frame buffered behind an ARP request when the MAC is unknown.
function buildFollowOnFrames(device: Device, config: any, dstIp: string, then: "ping" | "tcp" | "http", port: number | null, vlanTag: number | null): EthernetFrame[] | string {
  const sim = state.simulation;
  const srcIp = config.ipv4Address;
  const srcMac = config.macAddress;
  let nextHopIp = dstIp;
  if (!sameSubnet(srcIp, dstIp, prefixOf(config))) {
    if (!config.gatewayIpv4Address) return `Cannot reach ${dstIp} — no default gateway`;
    nextHopIp = config.gatewayIpv4Address;
  }
  const srcPort = 30000 + (sim.stepIndex % 20000); // deterministic ephemeral port
  // tcp and http both open with a SYN (HTTP sends its GET once established); ping is ICMP.
  const make = (dstMac: string) => then === "ping"
    ? createIcmpEchoRequest(srcMac, dstMac, srcIp, dstIp, 64, vlanTag)
    : createTcpSegment(srcMac, dstMac, srcIp, dstIp, srcPort, port ?? 80, "syn", 64, vlanTag);
  const arpEntry = (config.arpTable || []).find((e: any) => e.ipv4Address === nextHopIp);
  if (arpEntry) return [make(arpEntry.macAddress)];
  const pendingKey = `${device.id}:${nextHopIp}`;
  if (!sim.pendingArp[pendingKey]) sim.pendingArp[pendingKey] = [];
  sim.pendingArp[pendingKey].push(make("00:00:00:00:00:00"));
  return [createArpRequest(srcMac, srcIp, nextHopIp, vlanTag)];
}

// Relay an intercepted frame (net.ipv4.ip_forward on): the host forwards an
// IPv4 frame addressed to its MAC but bound for another IP — issue #4. A real
// host router: decrement TTL, rewrite the source MAC to its own, resolve the
// true next hop from its OWN (unpoisoned) ARP cache, and send it back out the
// one NIC toward that hop. The source/destination IPs are untouched (no NAT),
// so the victim's traffic reaches its destination and the reply still returns —
// a silent man-in-the-middle. A cold next-hop MAC is ARP-resolved first (the
// frame buffered in pendingArp, flushed by the host's ARP-reply handler).
function forwardIntercepted(device: Device, config: any, frame: EthernetFrame, ipv4: Ipv4Payload, fromDeviceId: string | null, outgoing: OutgoingFrame[]): void {
  if (!fromDeviceId) return;
  if (ipv4.ttl <= 1) {
    logStep(device, "sim-drop", `ip_forward: TTL expired forwarding to ${ipv4.dstIp} — dropped`);
    return;
  }
  // Next hop: on our subnet → the destination itself; otherwise our gateway.
  let nextHopIp = ipv4.dstIp;
  if (!sameSubnet(config.ipv4Address, ipv4.dstIp, prefixOf(config))) {
    if (!config.gatewayIpv4Address) {
      logStep(device, "sim-drop", `ip_forward: no route to ${ipv4.dstIp} (no default gateway) — dropped`);
      return;
    }
    nextHopIp = config.gatewayIpv4Address;
  }
  const forwarded: EthernetFrame = { ...frame, srcMac: config.macAddress || "", payload: { ...ipv4, ttl: ipv4.ttl - 1 } };
  const entry = (config.arpTable || []).find((e: any) => e.ipv4Address === nextHopIp);
  if (entry) {
    forwarded.dstMac = entry.macAddress;
    logStep(device, "sim-forward", `ip_forward: relaying ${frameLabel(frame)} for ${ipv4.dstIp} via ${nextHopIp} (TTL ${ipv4.ttl}→${ipv4.ttl - 1})`);
    outgoing.push({ frame: forwarded, toDeviceId: fromDeviceId });
  } else {
    const key = `${device.id}:${nextHopIp}`;
    (state.simulation.pendingArp[key] ||= []).push(forwarded);
    logStep(device, "sim-arp", `ip_forward: ${nextHopIp} unknown — ARPing before relaying to ${ipv4.dstIp}`);
    outgoing.push({ frame: createArpRequest(config.macAddress || "", config.ipv4Address || "", nextHopIp, frame.vlanTag), toDeviceId: fromDeviceId });
  }
}

// ─── Server processing (dnsmasq: DNS + DHCP) ─────────────────────────────────

// A server is a host that also runs dnsmasq. Service frames (DNS queries to
// its address, DHCP broadcasts) are answered here; everything else — ARP,
// ICMP, TCP, its own client flows — falls through to the host handler.
export function processAtServer(device: Device, frame: EthernetFrame, fromDeviceId: string | null): OutgoingFrame[] {
  const config = device.config;
  if (!device.poweredOff && config && frame.payload.type === "ipv4") {
    const ipv4 = frame.payload as Ipv4Payload;
    const running = config.dnsmasqRunning !== false;

    // DHCP: dnsmasq serves leases once a dhcp-range is configured.
    if (running && ipv4.dstIp === "255.255.255.255" && ipv4.payload.type === "dhcp"
        && config.dhcpRangeStart && config.dhcpRangeEnd && config.ipv4Address) {
      return handleServerDhcp(device, fromDeviceId!, ipv4.payload as DhcpPayload, frame);
    }

    // DNS: answer A-record queries addressed to this server.
    if (ipv4.payload.type === "dns" && ipv4.payload.op === "query" && ipv4.dstIp === config.ipv4Address) {
      if (!running) {
        logStep(device, "sim-drop", `DNS query for ${ipv4.payload.name} — dnsmasq is not running`);
        return [];
      }
      if (!hostHasReturnRoute(config, ipv4.srcIp)) {
        logStep(device, "sim-drop", `Cannot answer ${ipv4.srcIp} — no route (no default gateway)`);
        return [];
      }
      learnOnLinkArp(config, ipv4.srcIp, frame.srcMac);
      const dns = ipv4.payload as DnsPayload;
      // Manual A-records first, then the auto-zone: any device's hostname
      // resolves to its IP without a configured record.
      const record = (config.dnsRecords || []).find(r => r.name === dns.name.toLowerCase());
      const address = record?.ip ?? hostnameToIp(dns.name);
      logStep(device, address ? "sim-dns" : "sim-drop",
        address ? `DNS query: ${dns.name} → ${address}` : `DNS query: ${dns.name} — NXDOMAIN`);
      const out: OutgoingFrame[] = [];
      emitHostReply(device, config, hostReplyPath(config, ipv4.srcIp, frame.srcMac),
        dstMac => createDnsResponse(config.macAddress || "", dstMac, config.ipv4Address || "", ipv4.srcIp, dns.name, address, dns.id, 64, frame.vlanTag),
        fromDeviceId, out, frame.vlanTag);
      return out;
    }
  }
  return processAtComputer(device, frame, fromDeviceId);
}

// The dnsmasq DHCP side: offer an address from the configured dhcp-range,
// ACK requests addressed to this server, and hand out the subnet mask, the
// router option (option:router, defaulting to the server itself — dnsmasq's
// own default) and this server as the nameserver (option 6).
function handleServerDhcp(device: Device, fromDeviceId: string, dhcp: DhcpPayload, frame: EthernetFrame): OutgoingFrame[] {
  const outgoing: OutgoingFrame[] = [];
  const config = device.config;
  const serverIp = config.ipv4Address || "";
  const routerIp = config.dhcpRouterIp || serverIp;

  if (dhcp.messageType === "discover") {
    const allocatedIp = allocateServerDhcpIp(device, dhcp.clientMac);
    if (!allocatedIp) {
      logStep(device, "sim-drop", `DHCP Discover from ${dhcp.clientMac}: no addresses available in dhcp-range`);
      return outgoing;
    }
    logStep(device, "sim-dhcp", `DHCP Discover from ${dhcp.clientMac} — offering ${allocatedIp}`);
    const offer = createDhcpOffer(config.macAddress || "", serverIp, dhcp.clientMac, allocatedIp,
      dhcp.transactionId, frame.vlanTag, prefixOf(config), routerIp, serverIp);
    outgoing.push({ frame: offer, toDeviceId: fromDeviceId });
  } else if (dhcp.messageType === "request") {
    // Only ACK requests addressed to this server (the client may have taken a
    // competing server's offer).
    if (dhcp.serverIp && dhcp.serverIp !== serverIp) return outgoing;
    const requestedIp = dhcp.requestedIp || "";
    if (!Array.isArray(config.dhcpLeases)) config.dhcpLeases = [];
    config.dhcpLeases = normaliseDhcpLeases(config.dhcpLeases);
    const existingLease = config.dhcpLeases.find(l => l.macAddress === dhcp.clientMac);
    if (existingLease) existingLease.ipv4Address = requestedIp;
    else config.dhcpLeases.push({ macAddress: dhcp.clientMac, ipv4Address: requestedIp });
    learnArp(config, requestedIp, dhcp.clientMac);
    logStep(device, "sim-dhcp", `DHCP Request from ${dhcp.clientMac} for ${requestedIp} — sending ACK`);
    const ack = createDhcpAck(config.macAddress || "", serverIp, dhcp.clientMac, requestedIp,
      dhcp.transactionId, frame.vlanTag, prefixOf(config), routerIp, serverIp);
    outgoing.push({ frame: ack, toDeviceId: fromDeviceId });
  }

  return outgoing;
}

// Allocate the next free address in [dhcp-range start, end], skipping the
// server's own address, existing leases, and any device's static IP.
function allocateServerDhcpIp(device: Device, clientMac?: string): string | null {
  const config = device.config;
  const start = ipv4ToInt(config.dhcpRangeStart!);
  const end = ipv4ToInt(config.dhcpRangeEnd!);
  if (end < start) return null;
  const used = new Set<string>();
  if (config.ipv4Address) used.add(config.ipv4Address);
  const leases = normaliseDhcpLeases(config.dhcpLeases || []);
  const mine = dhcpClientsOwn(clientMac, leases);
  for (const lease of leases) if (lease !== mine.lease) used.add(lease.ipv4Address);
  for (const d of state.devices) {   // a host collapsed into a LAN still holds its address
    const ip = d.config?.ipv4Address;
    if (ip && isValidIpv4(ip) && d !== mine.device) used.add(ip);
  }
  // A client asking again is offered the address it is bound to, as dnsmasq does.
  if (mine.lease && isValidIpv4(mine.lease.ipv4Address) && !used.has(mine.lease.ipv4Address)) {
    const bound = ipv4ToInt(mine.lease.ipv4Address);
    if (bound >= start && bound <= end) return mine.lease.ipv4Address;
  }
  for (let i = start; i <= end; i++) {
    const candidate = intToIpv4(i);
    if (!used.has(candidate)) return candidate;
  }
  return null;
}

// ─── Spanning-tree BPDU relay ────────────────────────────────────────────────

// A switch receives a Configuration BPDU. The tree is already computed
// (runStpConvergence, at sim start), so this animates the steady-state flood:
// a BPDU arriving on the root port is relayed out the designated ports toward
// the leaves, each advertising THIS bridge's own root path cost (the root
// advertises 0; the receiver adds the link cost). A BPDU on any other port is
// consumed (an inferior/own advertisement). BPDUs never loop — they follow the tree.
function handleBpdu(device: Device, frame: EthernetFrame, fromDeviceId: string | null): OutgoingFrame[] {
  const stp = device.config?.stp;
  if (!stp || !isStpParticipant(device)) return [];
  const p = frame.payload as BpduPayload;
  const ports = linkedPortsFor(device.id);
  const ingressIdx = fromDeviceId ? ports.findIndex(pt => pt?.peer?.id === fromDeviceId) : -1;
  const ingressPort = ingressIdx >= 0 ? `Ethernet${ingressIdx + 1}` : null;
  const ingressRole = ingressPort ? stp.ports?.[ingressPort]?.role : undefined;

  if (p.flavour !== "config" || ingressRole !== "root") {
    const agree = p.rootId === stp.rootId ? "agrees on root" : "inferior";
    logStep(device, "sim-stp", `BPDU on ${ingressPort || "?"} (${ingressRole || "edge"}) — ${agree}, not relayed`);
    return [];
  }

  logStep(device, "sim-stp", `Root BPDU on root port ${ingressPort} — relaying toward designated ports (cost ${(stp.rootCost ?? 0)})`);
  const srcMac = device.config?.macAddress || deriveMac(device.id);
  const out: OutgoingFrame[] = [];
  ports.forEach((pt, idx) => {
    if (!pt?.peer || !isStpParticipant(pt.peer)) return;   // relay along the inter-switch tree only
    const name = `Ethernet${idx + 1}`;
    if (stp.ports?.[name]?.role !== "designated") return;
    out.push({ frame: createBpduFrame(srcMac, stp.rootId || "", stp.bridgeId || "", stp.rootCost ?? 0, name), toDeviceId: pt.peer.id });
  });
  return out;
}

// ─── Switch processing ───────────────────────────────────────────────────────

export function processAtSwitch(device: Device, frame: EthernetFrame, fromDeviceId: string | null): OutgoingFrame[] {
  const outgoing: OutgoingFrame[] = [];
  if (device.poweredOff) return outgoing;
  const config = device.config;
  if (!config) return outgoing;
  // An access point answers the 802.11 association handshake (it does not bridge
  // these management frames onward — they live only on the air between AP/client).
  if (device.type === "access-point" && frame.payload.type === "dot11") return handleDot11(device, frame, fromDeviceId);
  // A managed switch is the 802.1X authenticator — it terminates EAPOL (it never
  // floods these) and relays to RADIUS.
  if (frame.payload.type === "dot1x") return handleDot1x(device, frame, fromDeviceId);
  // BPDUs are spanning-tree control frames: terminated and re-originated along
  // the tree, never flooded as data (their dst is the bridge group, not broadcast).
  if (frame.payload.type === "bpdu") return handleBpdu(device, frame, fromDeviceId);

  frame = { ...frame, srcMac: normaliseMacAddress(frame.srcMac), dstMac: normaliseMacAddress(frame.dstMac) };

  const ports = linkedPortsFor(device.id);
  // linkedPortsFor can be sparse (null gaps) when explicit port numbers skip a
  // slot — guard the peer access on every lookup below.
  const ingressIdx = fromDeviceId ? ports.findIndex(p => p?.peer?.id === fromDeviceId) : -1;
  const ingressPortName = ingressIdx >= 0 ? `Ethernet${ingressIdx + 1}` : null;

  // Precompute VLAN config for managed switches
  const managed = Boolean(config.managed);
  const portVlans = managed ? normalisePortVlans(config.portVlans || {}) : {};
  const portModes = managed ? normalisePortModes(config.portModes || {}) : {};
  const trunkNativeVlans = managed ? normalisePortVlans(config.trunkNativeVlans || {}) : {};
  const trunkAllowedVlans = managed ? normaliseTrunkAllowedVlans(config.trunkAllowedVlans || {}) : {};

  // 802.1Q ingress — determine VLAN for this frame
  let ingressVlan: number | null = null;
  if (managed && ingressPortName) {
    const mode = portModes[ingressPortName] || "access";
    if (mode === "trunk") {
      // Trunk: use frame tag, or native VLAN if untagged
      ingressVlan = frame.vlanTag ?? (trunkNativeVlans[ingressPortName] || 1);
      const allowed = trunkAllowedVlans[ingressPortName];
      if (allowed && allowed.length > 0 && !allowed.includes(ingressVlan)) {
        logStep(device, "sim-drop", `Drop ${frameLabel(frame)} — VLAN ${ingressVlan} not allowed on trunk ${ingressPortName}`);
        return outgoing;
      }
    } else {
      // Access: assign port VLAN, drop if frame is tagged
      if (frame.vlanTag != null) {
        logStep(device, "sim-drop", `Drop ${frameLabel(frame)} — tagged frame on access port ${ingressPortName}`);
        return outgoing;
      }
      ingressVlan = portVlans[ingressPortName] || 1;
    }
  }

  // MAC learning on ingress
  if (ingressPortName && frame.srcMac !== BROADCAST_MAC) {
    config.macTable = normaliseMacTable(config.macTable || []);
    const vlanStr = managed ? String(ingressVlan || 1) : "";
    const existing = config.macTable.find((e: any) => e.macAddress === frame.srcMac);
    if (existing) {
      existing.port = ingressPortName;
      if (vlanStr) existing.vlan = vlanStr;
    } else {
      config.macTable.push({
        macAddress: frame.srcMac,
        port: ingressPortName,
        type: "DYNAMIC",
        vlan: vlanStr
      });
    }
    logStep(device, "sim-learn", `MAC learn ${frame.srcMac} → ${ingressPortName}${managed ? ` (VLAN ${ingressVlan})` : ""}`);
  }

  // Helper: can this egress port carry this VLAN?
  function portCarriesVlan(portName: string, vlan: number): boolean {
    if (!managed) return true;
    const mode = portModes[portName] || "access";
    if (mode === "trunk") {
      const allowed = trunkAllowedVlans[portName];
      return !allowed || allowed.length === 0 || allowed.includes(vlan);
    }
    // Access port: only carries its assigned VLAN
    return (portVlans[portName] || 1) === vlan;
  }

  // Forwarding decision
  const isBroadcast = frame.dstMac === BROADCAST_MAC;
  let forwardPorts: number[] = [];
  // Flood to all ports except ingress (same VLAN if managed)
  const floodPorts = () => ports
    .map((_, idx) => idx)
    .filter(idx => idx !== ingressIdx)
    .filter(idx => ingressVlan == null || portCarriesVlan(`Ethernet${idx + 1}`, ingressVlan));

  if (isBroadcast) {
    forwardPorts = floodPorts();
    const portNames = forwardPorts.map(i => `Ethernet${i + 1}`).join(", ");
    logStep(device, "sim-forward", `Flood ${frameLabel(frame)} → ${portNames || "(none)"}`);
  } else {
    // Lookup MAC table
    config.macTable = normaliseMacTable(config.macTable || []);
    const entry = config.macTable.find((e: any) => {
      if (e.macAddress !== frame.dstMac) return false;
      if (managed && ingressVlan != null && e.vlan && Number(e.vlan) !== ingressVlan) return false;
      return true;
    });

    // Known unicast — unless the entry names a port with no cable on it any
    // more. Link changes flush the table (linksChanged), so this is a backstop:
    // a stale entry must never strand the frame (the old "dest port is ingress"
    // drop) — forget it and treat the destination as unknown.
    const portIdx = entry ? ports.findIndex((_, idx) => `Ethernet${idx + 1}` === entry.port) : -1;
    if (entry && !ports[portIdx]?.peer) {
      if (entry.type !== "STATIC") config.macTable = config.macTable.filter(e => e !== entry);
      logStep(device, "sim-learn", `Stale MAC entry ${frame.dstMac} → ${entry.port} — no cable on that port now, so the entry is ${entry.type === "STATIC" ? "ignored" : "forgotten"}`);
    }
    if (entry && ports[portIdx]?.peer) {
      if (portIdx !== ingressIdx) {
        forwardPorts = [portIdx];
        logStep(device, "sim-forward", `Forward ${frameLabel(frame)} → ${entry.port} (known unicast)`);
      } else {
        // 802.1D filtering: the destination was learnt on the port the frame
        // arrived on, so it is already on that segment — never sent back out.
        logStep(device, "sim-drop", `Drop ${frameLabel(frame)} — ${frame.dstMac} was learnt on ingress port ${entry.port}, so the switch filters it (the destination is on the segment it came from)`);
      }
    } else {
      // Unknown unicast — flood
      forwardPorts = floodPorts();
      const portNames = forwardPorts.map(i => `Ethernet${i + 1}`).join(", ");
      logStep(device, "sim-forward", `Flood ${frameLabel(frame)} → ${portNames} (unknown unicast)`);
    }
  }

  // SPAN port mirroring: the monitor (destination) port carries only mirrored
  // traffic — exclude it from normal forwarding here, then copy matching ingress
  // frames to it below (where a passive IDS sensor listens).
  const mirror = managed ? config.mirror : undefined;
  let mirrorDestIdx = -1;
  if (mirror?.dest) {
    mirrorDestIdx = ports.findIndex((p: any, idx: number) => p?.peer && `Ethernet${idx + 1}` === mirror.dest);
    if (mirrorDestIdx >= 0) forwardPorts = forwardPorts.filter(idx => idx !== mirrorDestIdx);
  }

  // 802.1Q egress — tag/untag frames for each output port
  for (const idx of forwardPorts) {
    const peer = ports[idx]?.peer;
    if (peer) {
      const egressPort = `Ethernet${idx + 1}`;
      const egressFrame = { ...frame, id: frame.id + `-${idx}` };
      if (managed && ingressVlan != null) {
        const egressMode = portModes[egressPort] || "access";
        if (egressMode === "trunk") {
          // Trunk egress: tag frame (null if native VLAN)
          const native = trunkNativeVlans[egressPort] || 1;
          egressFrame.vlanTag = ingressVlan === native ? null : ingressVlan;
        } else {
          // Access egress: always strip tag
          egressFrame.vlanTag = null;
        }
      }
      outgoing.push({ frame: egressFrame, toDeviceId: peer.id });
    }
  }

  // Mirror this ingress frame to the monitor port (rx SPAN). Sources empty/absent
  // = mirror every port; otherwise only the listed source ports. The copy is the
  // frame as it ingressed (the sensor sees the real traffic, untouched).
  if (mirrorDestIdx >= 0 && ingressIdx !== mirrorDestIdx) {
    const sources = mirror!.sources;
    const srcOk = !sources || sources.length === 0 || (ingressPortName != null && sources.includes(ingressPortName));
    const destPeer = ports[mirrorDestIdx]?.peer;
    if (srcOk && destPeer) {
      outgoing.push({ frame: { ...frame, id: frame.id + "-span" }, toDeviceId: destPeer.id });
      logStep(device, "sim-forward", `SPAN: mirror ${frameLabel(frame)} → ${mirror!.dest} (monitor)`);
    }
  }

  return outgoing;
}

// A hub is a layer-1 repeater: it copies every incoming frame out all other
// ports, with no MAC learning and no forwarding logic (the dumb predecessor to
// a switch — one collision domain, every port sees every frame). The teaching
// contrast with a switch is exactly that it floods unicast too.
export function processAtHub(device: Device, frame: EthernetFrame, fromDeviceId: string | null): OutgoingFrame[] {
  const outgoing: OutgoingFrame[] = [];
  if (device.poweredOff) return outgoing;
  const ports = linkedPortsFor(device.id);
  const ingressIdx = fromDeviceId ? ports.findIndex(p => p?.peer?.id === fromDeviceId) : -1;
  const repeated: string[] = [];
  ports.forEach((port, idx) => {
    if (idx === ingressIdx || !port?.peer) return;
    outgoing.push({ frame: { ...frame, id: `${frame.id}-${idx}` }, toDeviceId: port.peer.id });
    repeated.push(`Ethernet${idx + 1}`);
  });
  logStep(device, "sim-forward", `Repeat ${frameLabel(frame)} → ${repeated.join(", ") || "(none)"}`);
  return outgoing;
}

// ─── IDS processing ──────────────────────────────────────────────────────────

// A passive Snort sensor on a SPAN/monitor port: inspect the mirrored frame
// against the rule set and raise an alert on a match. It never forwards — it's
// not in the data path, so it can only watch, not block.
export function processAtIds(device: Device, frame: EthernetFrame, _fromDeviceId: string | null): OutgoingFrame[] {
  if (device.poweredOff) return [];
  const cfg = device.config;
  if (!cfg) return [];
  const hits = runIdsRules(cfg.idsRules, frame);
  if (hits.length) {
    cfg.alerts = cfg.alerts || [];
    for (const h of hits) {
      cfg.alerts.push(h.alert);
      logStep(device, "sim-ids", `Snort alert [${h.rule.gid}:${h.rule.sid}] ${h.rule.msg}`);
    }
    if (cfg.alerts.length > 500) cfg.alerts.splice(0, cfg.alerts.length - 500);   // FIFO cap (memory safety net for a single high-traffic run)
  }
  return [];   // passive sink — never forwards mirrored traffic
}

// ─── Red Team (attacker) processing ──────────────────────────────────────────

// A Red Team host is a normal host that also tallies attack results: during an
// "attack" run, replies addressed to it record open ports (SYN-ACK), closed
// ports (RST), and live hosts (ICMP echo reply). Everything else — ARP
// resolution that flushes the deferred scan/sweep frames, being pinged — is
// ordinary host behaviour (processAtComputer).
export function processAtAttacker(device: Device, frame: EthernetFrame, fromDeviceId: string | null): OutgoingFrame[] {
  if (device.poweredOff) return [];
  const sim = state.simulation;
  if (sim.mode === "attack" && device.id === sim.originDeviceId && frame.payload.type === "ipv4") {
    const ipv4 = frame.payload as Ipv4Payload;
    if (ipv4.dstIp === device.config?.ipv4Address) {
      const inner = ipv4.payload;
      if (inner.type === "tcp" && inner.flags === "syn-ack") {
        if (!sim.scanOpen.includes(inner.srcPort)) { sim.scanOpen.push(inner.srcPort); logStep(device, "sim-attack", `${ipv4.srcIp}:${inner.srcPort} open (SYN-ACK)`); }
        return [];   // half-open scan: don't complete the handshake
      }
      if (inner.type === "tcp" && inner.flags === "rst") {
        if (!sim.scanClosed.includes(inner.srcPort)) sim.scanClosed.push(inner.srcPort);
        return [];
      }
      if (inner.type === "icmp" && inner.icmpType === 0) {
        if (!sim.sweepLive.includes(ipv4.srcIp)) { sim.sweepLive.push(ipv4.srcIp); logStep(device, "sim-attack", `host up: ${ipv4.srcIp}`); }
        return [];
      }
    }
  }
  return processAtComputer(device, frame, fromDeviceId);
}

// ─── Internet cloud (L3 transit between routers) ─────────────────────────────

// A router's interface facing the cloud — the one whose peer is this Internet
// device (a primary interface, not a VLAN sub-interface). Read straight off the
// normalised config (its macAddress is already populated), so this stays cheap
// on the per-frame path.
function internetFacingIface(router: Device, internetId: string): RouterInterface | undefined {
  const ifaces: RouterInterface[] = (router.config?.interfaces as RouterInterface[]) || [];
  return ifaces.find((i) => i.peerId === internetId && i.vlanTag == null);
}

// Whether `ip` is a gateway address the cloud presents on one of its links —
// the highest host address of a connected router's public subnet.
function isInternetGatewayIp(internetId: string, ports: ReturnType<typeof linkedPortsFor>, ip: string): boolean {
  for (const port of ports) {
    const peer = port?.peer;
    if (!peer || peer.type !== "router") continue;
    const wan = internetFacingIface(peer, internetId);
    if (wan?.ipv4Address && internetGatewayIp(wan.ipv4Address, prefixOf(wan)) === ip) return true;
  }
  return false;
}

// The internet cloud is NOT an L2 bridge — it represents the public internet and
// routes IPv4 between the routers cabled to it, each on its own public subnet.
// It presents a gateway address per link (answering ARP for it, so a connected
// router can default-route to it) and forwards each packet to the router whose
// public (WAN) subnet owns the destination. It does not bridge, MAC-learn, or
// flood. Unroutable destinations are dropped (no router on the internet owns
// them). One L3 hop: TTL is decremented, and an expired packet earns an ICMP
// Time-Exceeded from the gateway the cloud presents to the sender — so
// traceroute sees the cloud as a single hop standing in for the many real ones.
// That gateway answers ping (and refuses everything else, with the reason).
export function processAtInternet(device: Device, frame: EthernetFrame, fromDeviceId: string | null): OutgoingFrame[] {
  if (device.poweredOff) return [];
  const out: OutgoingFrame[] = [];
  const cloudMac = deriveMac(device.id);          // the gateway MAC the cloud presents on every link
  const ports = linkedPortsFor(device.id);

  // ARP: answer for our gateway address on the asking router's WAN subnet, so
  // the router can resolve its default next-hop (us).
  if (frame.payload.type === "arp") {
    const arp = frame.payload;
    if (arp.operation !== "request" || !fromDeviceId) return out;
    const ingress = getDevice(fromDeviceId);
    if (!ingress || ingress.type !== "router") return out;
    const wan = internetFacingIface(ingress, device.id);
    if (!wan?.ipv4Address) return out;
    const gw = internetGatewayIp(wan.ipv4Address, prefixOf(wan));
    if (gw && arp.targetIp === gw) {
      logStep(device, "sim-arp", `ARP: ${gw} is-at ${cloudMac} (internet gateway) → ${ingress.name}`);
      out.push({ frame: createArpReply(cloudMac, gw, arp.senderMac, arp.senderIp, frame.vlanTag), toDeviceId: fromDeviceId });
    }
    return out;
  }

  if (frame.payload.type !== "ipv4") return out;  // the cloud only routes IPv4
  const ipv4 = frame.payload;
  // Same L2 admission as a router: only a frame sent to the gateway MAC the
  // cloud presents is a request to route it.
  const dstMac = normaliseMacAddress(frame.dstMac);
  if (dstMac !== cloudMac) {
    logStep(device, "sim-learn", `${frameLabel(frame)} ${ipv4.srcIp}→${ipv4.dstIp} is for ${dstMac}, not the internet gateway MAC ${cloudMac} — not ours to route, ignoring`);
    return out;
  }

  // Addressed to the cloud itself: one of the gateway addresses it presents.
  // It answers ARP for that address and sources Time-Exceeded from it (it is a
  // traceroute hop), so it answers ping there too — the routing loop below
  // skips the sender's own subnet, and an echo to the gateway used to fall
  // through to "No route to <gateway> on the internet". Nothing else is served
  // at the gateway, and it says so as a router does for its own address.
  if (fromDeviceId && isInternetGatewayIp(device.id, ports, ipv4.dstIp)) {
    const inner = ipv4.payload;
    if (inner.type === "icmp" && inner.icmpType === 8) {
      logStep(device, "sim-icmp", `Received ICMP Echo Request for the internet gateway (${ipv4.dstIp}) — sending Reply`);
      out.push({ frame: createIcmpEchoReply(cloudMac, frame.srcMac, ipv4.dstIp, ipv4.srcIp, 64, null, inner.sequence), toDeviceId: fromDeviceId });
    } else if ((inner.type === "tcp" && inner.flags === "syn") || (inner.type === "dns" && inner.op === "query")) {
      logStep(device, "sim-drop", inner.type === "tcp"
        ? `TCP SYN to ${ipv4.dstIp}:${inner.dstPort} — the internet gateway answers ping only, no service listens there; sending RST`
        : `DNS query to ${ipv4.dstIp} — the internet gateway answers ping only, it runs no DNS service (UDP/53 closed); sending ICMP Port Unreachable`);
      const resp = rejectResponse(frame, ipv4, cloudMac, ipv4.dstIp, null, fromDeviceId);
      if (resp) out.push(resp);
    } else {
      logStep(device, "sim-drop", `${frameLabel(frame)} addressed to the internet gateway itself (${ipv4.dstIp}) — it answers ping only, dropped`);
    }
    return out;
  }

  // Route by destination: hand the frame to the connected router whose public
  // subnet owns the destination address (or is the destination itself).
  for (const port of ports) {
    const peer = port?.peer;
    if (!peer || peer.id === fromDeviceId || peer.type !== "router") continue;
    const wan = internetFacingIface(peer, device.id);
    if (!wan?.ipv4Address) continue;
    if (ipv4.dstIp === wan.ipv4Address || sameSubnet(ipv4.dstIp, wan.ipv4Address, prefixOf(wan))) {
      if (ipv4.ttl <= 1) {
        // One L3 hop: an expired packet earns an ICMP Time-Exceeded from the
        // gateway the cloud presents to the sending router — so the internet
        // shows up as a real traceroute hop, not a silent gap.
        const ingress = fromDeviceId ? getDevice(fromDeviceId) : undefined;
        const ingressWan = ingress?.type === "router" ? internetFacingIface(ingress, device.id) : undefined;
        const gwIp = ingressWan?.ipv4Address ? internetGatewayIp(ingressWan.ipv4Address, prefixOf(ingressWan)) : null;
        if (gwIp && fromDeviceId) {
          logStep(device, "sim-drop", `TTL expired on the internet for ${ipv4.dstIp} — sending ICMP Time-Exceeded to ${ipv4.srcIp}`);
          out.push({ frame: createIcmpTimeExceeded(cloudMac, frame.srcMac, gwIp, ipv4.srcIp, 64, null, icmpOriginalOf(ipv4)), toDeviceId: fromDeviceId });
        } else {
          logStep(device, "sim-drop", `TTL expired on the internet for ${ipv4.dstIp} — dropping`);
        }
        return out;
      }
      const routed: EthernetFrame = {
        ...frame,
        id: frame.id + "-inet",
        srcMac: cloudMac,
        dstMac: wan.macAddress || deriveMac(peer.id),
        vlanTag: null,
        payload: { ...ipv4, ttl: ipv4.ttl - 1 }
      };
      logStep(device, "sim-forward", `Internet routes ${ipv4.srcIp}→${ipv4.dstIp} → ${peer.name} (TTL ${ipv4.ttl}→${ipv4.ttl - 1})`);
      out.push({ frame: routed, toDeviceId: peer.id });
      return out;
    }
  }
  logStep(device, "sim-drop", `No route to ${ipv4.dstIp} on the internet — dropping`);
  return out;
}

// ─── Router processing ──────────────────────────────────────────────────────

export function processAtRouter(device: Device, frame: EthernetFrame, fromDeviceId: string | null): OutgoingFrame[] {
  const outgoing: OutgoingFrame[] = [];
  if (device.poweredOff) return outgoing;
  const config = device.config;
  if (!config?.interfaces) return outgoing;

  frame = { ...frame, srcMac: normaliseMacAddress(frame.srcMac), dstMac: normaliseMacAddress(frame.dstMac) };

  // Find ingress interface — support sub-interfaces (multiple ifaces with same peerId, different vlanTag)
  const ifaces: any[] = config.interfaces;
  let ingressIface: any = null;
  if (fromDeviceId) {
    const peerIfaces = ifaces.filter((iface: any) => iface.peerId === fromDeviceId);
    if (peerIfaces.length > 1) {
      // Sub-interfaces: match by vlanTag. Two interfaces on the same segment
      // (two cables to one hub or switch) share a tag, so prefer the one the
      // frame is addressed to — the L2 admission below checks that MAC.
      const sameTag = peerIfaces.filter((iface: any) =>
        frame.vlanTag != null ? iface.vlanTag === frame.vlanTag : iface.vlanTag == null
      );
      ingressIface = sameTag.find((iface: any) => normaliseMacAddress(iface.macAddress || "") === frame.dstMac) ?? sameTag[0] ?? null;
    } else {
      ingressIface = peerIfaces[0] || null;
    }
  }

  if (!ingressIface) {
    logStep(device, "sim-drop", `Received frame but no matching interface for peer`);
    return outgoing;
  }

  if (frame.payload.type === "arp") {
    return handleRouterArp(device, frame, ifaces, ingressIface, fromDeviceId!);
  } else if (frame.payload.type === "ipv4") {
    const ipv4 = frame.payload as Ipv4Payload;
    const ifaceMac = normaliseMacAddress(ingressIface.macAddress || "");

    // L2 admission, as a real NIC filters: a router takes up an IPv4 frame only
    // when it is addressed to the ingress interface's MAC, or to a link-layer
    // group address (broadcast/multicast). A unicast frame for another host —
    // repeated by a hub, or flooded by a switch that has not learned the
    // destination yet — is not ours to route: routing it would hand the real
    // recipient a duplicate with TTL already decremented.
    const groupAddressed = isGroupMac(frame.dstMac);
    if (frame.dstMac !== ifaceMac && !groupAddressed) {
      logStep(device, "sim-learn", `${frameLabel(frame)} ${ipv4.srcIp}→${ipv4.dstIp} is for ${frame.dstMac}, not this interface's MAC ${ifaceMac} — not ours to route, ignoring`);
      return outgoing;
    }

    // Handle broadcast DHCP messages before any routing
    if (ipv4.dstIp === "255.255.255.255" && ipv4.payload.type === "dhcp") {
      return handleRouterDhcp(device, ingressIface, fromDeviceId!, ipv4.payload as DhcpPayload, ipv4);
    }

    // A link-layer broadcast/multicast is delivered to every station on the
    // segment; a router never forwards it beyond that segment (only a frame
    // sent to its own MAC is a request to route).
    if (groupAddressed) {
      logStep(device, "sim-learn", `${frameLabel(frame)} ${ipv4.srcIp}→${ipv4.dstIp} was sent to link-layer ${frame.dstMac === BROADCAST_MAC ? "broadcast" : "multicast"} — a router does not route it off the segment, ignoring`);
      return outgoing;
    }

    return routeIpv4Frame(device, frame, ifaces, ingressIface, fromDeviceId!, ipv4);
  }

  return outgoing;
}

function handleRouterArp(device: Device, frame: EthernetFrame, ifaces: any[], ingressIface: any, fromDeviceId: string): OutgoingFrame[] {
  const sim = state.simulation;
  const outgoing: OutgoingFrame[] = [];
  const arp = frame.payload as ArpPayload;

  if (arp.operation === "request" && arp.targetIp === ingressIface.ipv4Address) {
    learnRouterArp(ingressIface, arp.senderIp, arp.senderMac);
    logStep(device, "sim-arp", `Received ARP Request for ${arp.targetIp} on ${ifaceName(device, ingressIface)} — sending Reply`);
    const reply = createArpReply(
      ingressIface.macAddress, ingressIface.ipv4Address,
      arp.senderMac, arp.senderIp, ingressIface.vlanTag ?? null
    );
    outgoing.push({ frame: reply, toDeviceId: fromDeviceId });
  } else if (arp.operation === "reply") {
    // Learn only from a reply meant for this interface: one sent to its MAC (the
    // answer to our own request), or a broadcast (gratuitous) reply that
    // refreshes an entry we already hold or are resolving — as Linux does with
    // arp_accept off. A reply unicast to another host (repeated by a hub, or
    // flooded) is not ours: learning from it would let any on-link exchange
    // write the router's cache.
    const pendingKey = `${device.id}:${arp.senderIp}`;
    const pending = sim.pendingArp[pendingKey];
    const ifaceMac = normaliseMacAddress(ingressIface.macAddress || "");
    const known = (ingressIface.arpTable || []).some((e: any) => e.ipv4Address === arp.senderIp);
    const forUs = frame.dstMac === ifaceMac
      || (frame.dstMac === BROADCAST_MAC && (known || !!pending?.length));
    if (!forUs) {
      logStep(device, "sim-learn", `ARP Reply ${arp.senderIp} is-at ${arp.senderMac} is for ${frame.dstMac}, not this interface's MAC ${ifaceMac} — not learned, ignoring`);
      return outgoing;
    }
    learnRouterArp(ingressIface, arp.senderIp, arp.senderMac);
    recordArpPoison(device, arp);
    logStep(device, "sim-arp", `Received ARP Reply on ${ifaceName(device, ingressIface)}: ${arp.senderIp} is-at ${arp.senderMac}`);

    // Check for buffered frames
    if (pending && pending.length > 0) {
      const table = buildRoutingTable(device); // build once for the whole flush
      for (const pf of pending) {
        if (pf.payload.type !== "ipv4") continue; // only IPv4 frames are ever buffered for ARP
        const ipv4 = pf.payload;
        // Re-run the routing decision: the buffered frame may be destined for a
        // network reached VIA the next-hop we just resolved (static/RIP route),
        // so the egress lookup must use the route, not the final destination.
        const route = routingLookup(device, ipv4.dstIp, table);
        if (route && route.nextHopIp === arp.senderIp) {
          // A fresh frame with a fresh payload, as the immediate-forward path
          // builds: the buffered frame shares its payload object with the
          // inbound frame the capture, the wire's history and the inspector
          // still hold, so decrementing the TTL in place rewrote those rows
          // too (PC→router shown at TTL 63).
          const forwarded: EthernetFrame = {
            ...pf,
            srcMac: route.egressIface.macAddress,
            dstMac: arp.senderMac,
            vlanTag: route.egressIface.vlanTag ?? null,
            payload: { ...ipv4, ttl: ipv4.ttl - 1 }
          };
          logStep(device, "sim-forward", `Forward deferred ${frameLabel(pf)} to ${ipv4.dstIp} via ${ifaceName(device, route.egressIface)} (TTL ${ipv4.ttl}→${ipv4.ttl - 1})`);
          outgoing.push({ frame: forwarded, toDeviceId: route.egressIface.peerId });
        } else {
          logStep(device, "sim-drop", `Deferred frame to ${ipv4.dstIp}: no route via ${arp.senderIp} — dropping`);
        }
      }
      delete sim.pendingArp[pendingKey];
    }
  } else {
    logStep(device, "sim-arp", `Received ARP for ${arp.targetIp} — not our IP, ignoring`);
  }

  return outgoing;
}

function handleRouterDhcp(device: Device, ingressIface: any, fromDeviceId: string, dhcp: DhcpPayload, ipv4: Ipv4Payload): OutgoingFrame[] {
  const outgoing: OutgoingFrame[] = [];

  if (dhcp.messageType === "discover") {
    const allocatedIp = allocateDhcpIp(ingressIface, device, dhcp.clientMac);
    if (!allocatedIp) {
      logStep(device, "sim-drop", `DHCP Discover from ${dhcp.clientMac}: no addresses available`);
      return outgoing;
    }
    logStep(device, "sim-dhcp", `DHCP Discover from ${dhcp.clientMac} — offering ${allocatedIp}`);
    const offer = createDhcpOffer(
      ingressIface.macAddress, ingressIface.ipv4Address,
      dhcp.clientMac, allocatedIp, dhcp.transactionId, ingressIface.vlanTag ?? null,
      prefixOf(ingressIface)
    );
    outgoing.push({ frame: offer, toDeviceId: fromDeviceId });
  } else if (dhcp.messageType === "request") {
    // Only ACK requests addressed to this server — the client may have taken
    // a competing DHCP server's offer (its Request names that server).
    if (dhcp.serverIp && dhcp.serverIp !== ingressIface.ipv4Address) return outgoing;
    const requestedIp = dhcp.requestedIp || "";
    // Record lease
    if (!ingressIface.dhcpLeases) ingressIface.dhcpLeases = [];
    ingressIface.dhcpLeases = normaliseDhcpLeases(ingressIface.dhcpLeases);
    const existingLease = ingressIface.dhcpLeases.find((l: any) => l.macAddress === dhcp.clientMac);
    if (existingLease) {
      existingLease.ipv4Address = requestedIp;
    } else {
      ingressIface.dhcpLeases.push({ macAddress: dhcp.clientMac, ipv4Address: requestedIp });
    }
    learnRouterArp(ingressIface, requestedIp, dhcp.clientMac);
    logStep(device, "sim-dhcp", `DHCP Request from ${dhcp.clientMac} for ${requestedIp} — sending ACK`);
    const ack = createDhcpAck(
      ingressIface.macAddress, ingressIface.ipv4Address,
      dhcp.clientMac, requestedIp, dhcp.transactionId, ingressIface.vlanTag ?? null,
      prefixOf(ingressIface)
    );
    outgoing.push({ frame: ack, toDeviceId: fromDeviceId });
  }

  return outgoing;
}

// A host can answer a source only if it is on the local subnet or a default
// gateway provides the route back.
// Whether `device` may transmit `frame` onto `link`: the auth/STP data gate
// (control frames exempt) and per-link packet loss — a probabilistic drop in
// animated runs only, so headless reachability checks stay deterministic (a
// headless run notes each lossy link once, so the divergence is surfaced, not
// silent). ONE admission path for the seeded first leg and every later hop:
// startSimulation used to create the initial transit directly, so the first
// frame crossed even a 100 %-loss link and a one-way attack still landed.
// The device at the other end of `link` from `device`.
function linkPeer(device: Device, link: Link): Device | undefined {
  return getDevice(link.from === device.id ? link.to : link.from);
}

// Whether `device` holds `ip` — a host's address or one of a router's interfaces.
function ownsIp(device: Device, ip: string): boolean {
  const cfg = device.config;
  return cfg?.ipv4Address === ip || !!cfg?.interfaces?.some(iface => iface.ipv4Address === ip);
}

// Files why an ARP frame was dropped under the address it was resolving (a
// request's target, a reply's sender), so the post-mortem of an unanswered ARP
// can quote the real cause. Non-ARP frames are not recorded; this runs only on
// the drop paths, never on a delivered frame.
function noteArpDrop(frame: EthernetFrame, headedTo: Device | undefined, reason: string): void {
  const arp = frame.payload;
  if (arp.type !== "arp") return;
  const ip = arp.operation === "request" ? arp.targetIp : arp.senderIp;
  (state.simulation.arpDrops[ip] ||= []).push({ reason, atOwner: !!headedTo && ownsIp(headedTo, ip) });
}

function admitOnLink(device: Device, link: Link, frame: EthernetFrame): boolean {
  const sim = state.simulation;
  const ptype = frame.payload.type;
  const ctrl = ptype === "dot11" || ptype === "dot1x" || ptype === "bpdu";
  const blocked = ctrl ? null : linkDataBlockReason(link);
  if (blocked) {
    logStep(device, "sim-drop", `${blocked} — ${frameLabel(frame)} dropped`);
    // A spanning-tree block never explains an unanswered ARP: the tree keeps
    // every bridge reachable, so the dropped copy was redundant by design.
    if (!link.stpBlocked) noteArpDrop(frame, linkPeer(device, link), blocked);
    return false;
  }
  if (!sim.headless && Number(link.loss) > 0 && lossRandom() * 100 < Number(link.loss)) {
    logStep(device, "sim-drop", `${linkName(link)} dropped ${frameLabel(frame)} (${link.loss}% loss)`);
    noteArpDrop(frame, linkPeer(device, link), `${linkName(link)} lost it (${link.loss}% loss on that link — try the run again)`);
    return false;
  }
  if (sim.headless && Number(link.loss) > 0 && !(sim.lossNoted ||= new Set()).has(link.id)) {
    sim.lossNoted.add(link.id);
    logStep(device, "sim-learn", `${linkName(link)} carries ${link.loss}% loss — not applied in this headless run (checks stay deterministic; the animated run may drop frames here)`);
  }
  return true;
}

// The L2 next hop for a host's REPLY — the same decision an originated frame
// makes (buildFollowOnFrames): an on-link peer directly, otherwise the
// CONFIGURED default gateway, resolved through ARP like any other next hop.
// Replies used to reflect to the ingress frame's source MAC, so a host with a
// WRONG gateway still answered across subnets — hiding exactly the
// misconfiguration this tool exists to teach. hostHasReturnRoute stays the
// first gate (no address / no gateway at all).
type ReplyPath = { dstMac: string } | { arpFor: string } | { drop: string };
function hostReplyPath(config: any, dstIp: string, ingressMac: string): ReplyPath {
  const srcIp = config.ipv4Address;
  if (sameSubnet(srcIp, dstIp, prefixOf(config))) return { dstMac: ingressMac };   // on-link: the peer that spoke to us
  const gw = config.gatewayIpv4Address;
  if (!gw || !isValidIpv4(gw)) return { drop: `Cannot reply to ${dstIp} — no route (no default gateway)` };
  if (!sameSubnet(srcIp, gw, prefixOf(config))) return { drop: `Cannot reply to ${dstIp} — gateway ${gw} is not on this host's subnet` };
  const entry = (config.arpTable || []).find((e: any) => e.ipv4Address === gw);
  return entry ? { dstMac: entry.macAddress } : { arpFor: gw };
}

// Emit a reply along `path`: send it, or buffer it behind an ARP Request for
// the gateway (the host's ARP-reply handler stamps the learnt MAC and flushes).
// A wrong gateway therefore ARPs into silence and the reply never leaves.
function emitHostReply(device: Device, config: any, path: ReplyPath, make: (dstMac: string) => EthernetFrame, fromDeviceId: string | null, outgoing: OutgoingFrame[], vlanTag: number | null): void {
  if ("drop" in path) { logStep(device, "sim-drop", path.drop); return; }
  if (!fromDeviceId) return;
  if ("dstMac" in path) { outgoing.push({ frame: make(path.dstMac), toDeviceId: fromDeviceId }); return; }
  const sim = state.simulation;
  const key = `${device.id}:${path.arpFor}`;
  (sim.pendingArp[key] ||= []).push(make("00:00:00:00:00:00"));
  logStep(device, "sim-arp", `Reply must go via the gateway — sending ARP Request for ${path.arpFor}`);
  outgoing.push({ frame: createArpRequest(config.macAddress || "", config.ipv4Address || "", path.arpFor, vlanTag), toDeviceId: fromDeviceId });
}

function hostHasReturnRoute(config: any, srcIp: string): boolean {
  if (!config?.ipv4Address) return false;
  if (sameSubnet(config.ipv4Address, srcIp, prefixOf(config))) return true;
  return Boolean(config.gatewayIpv4Address);
}

// ─── NAT / PAT (overload on the outside interface address) ───────────────────

function natTable(device: Device): NatEntry[] {
  ensureConfig(device);
  if (!Array.isArray(device.config.natTranslations)) device.config.natTranslations = [];
  return device.config.natTranslations;
}

// Allocate a free PAT identifier (TCP source port / ICMP flow id).
function allocNatId(translations: NatEntry[]): number {
  let p = 20000 + translations.length;
  while (translations.some(t => t.outsidePort === p)) p++;
  return p;
}

// Mark the sim step a frame created or used this translation, so the inspector
// can flash it (issue #2). When the router's config panel is open, refresh it
// live so the entry pulses as the frame crosses — the NAT half of the callouts.
function touchNat(device: Device, entry: NatEntry): void {
  entry.lastStep = state.simulation.stepIndex;
  if (state.configuringId === device.id) sync().syncPanel();
}

// Source-translate an inside→outside flow onto the egress interface address.
// Returns the rewritten payload, or null when the packet isn't translatable
// (only ICMP echo requests and TCP segments carry a flow identifier we model).
function natTranslateOutbound(device: Device, ipv4: Ipv4Payload, egressIface: any): Ipv4Payload | null {
  const translations = natTable(device);
  const outsideIp = egressIface.ipv4Address;
  if (ipv4.payload.type === "icmp" && ipv4.payload.icmpType === 8) {
    const icmp = ipv4.payload;
    let entry = translations.find(t => t.protocol === "icmp" && t.insideIp === ipv4.srcIp && t.insidePort === icmp.sequence && t.destIp === ipv4.dstIp);
    if (!entry) {
      entry = { protocol: "icmp", insideIp: ipv4.srcIp, insidePort: icmp.sequence, outsideIp, outsidePort: allocNatId(translations), destIp: ipv4.dstIp };
      translations.push(entry);
    }
    touchNat(device, entry);
    return { ...ipv4, srcIp: outsideIp, payload: { ...icmp, sequence: entry.outsidePort } };
  }
  if (ipv4.payload.type === "tcp") {
    const tcp = ipv4.payload;
    let entry = translations.find(t => t.protocol === "tcp" && t.insideIp === ipv4.srcIp && t.insidePort === tcp.srcPort && t.destIp === ipv4.dstIp);
    if (!entry) {
      entry = { protocol: "tcp", insideIp: ipv4.srcIp, insidePort: tcp.srcPort, outsideIp, outsidePort: allocNatId(translations), destIp: ipv4.dstIp };
      translations.push(entry);
    }
    touchNat(device, entry);
    return { ...ipv4, srcIp: outsideIp, payload: { ...tcp, srcPort: entry.outsidePort } };
  }
  if (ipv4.payload.type === "dns" && ipv4.payload.op === "query") {
    // UDP/53: the DNS transaction id is the flow identifier.
    const dns = ipv4.payload;
    let entry = translations.find(t => t.protocol === "udp" && t.insideIp === ipv4.srcIp && t.insidePort === dns.id && t.destIp === ipv4.dstIp);
    if (!entry) {
      entry = { protocol: "udp", insideIp: ipv4.srcIp, insidePort: dns.id, outsideIp, outsidePort: allocNatId(translations), destIp: ipv4.dstIp };
      translations.push(entry);
    }
    touchNat(device, entry);
    return { ...ipv4, srcIp: outsideIp, payload: { ...dns, id: entry.outsidePort } };
  }
  return null;
}

// Restore the inside endpoint for return traffic addressed to an outside
// interface IP. Returns null when no translation matches (the packet is then
// genuinely for the router itself — INPUT chain + self handling apply).
function natRestoreInbound(device: Device, ipv4: Ipv4Payload, ifaces: any[]): Ipv4Payload | null {
  const outsideIface = ifaces.find((i: any) => i.natRole === "outside" && i.ipv4Address === ipv4.dstIp);
  if (!outsideIface) return null;
  const translations: NatEntry[] = device.config?.natTranslations || [];
  if (ipv4.payload.type === "icmp" && ipv4.payload.icmpType === 0) {
    const icmp = ipv4.payload;
    const entry = translations.find(t => t.protocol === "icmp" && t.outsidePort === icmp.sequence && t.destIp === ipv4.srcIp);
    if (entry) { touchNat(device, entry); return { ...ipv4, dstIp: entry.insideIp, payload: { ...icmp, sequence: entry.insidePort } }; }
  }
  if (ipv4.payload.type === "icmp" && (ipv4.payload.icmpType === 11 || ipv4.payload.icmpType === 3) && ipv4.payload.original) {
    // An ICMP error from beyond the NAT (Time-Exceeded / Dest-Unreachable): the
    // sender is an intermediate router, not the flow's destination, so the
    // translation is matched on the error's EMBEDDED original datagram — the
    // translated flow id + the flow's real destination — like a real NAT parsing
    // the quoted header. This is what lets traceroute work from behind NAT.
    const icmp = ipv4.payload;
    const o = icmp.original!;
    const entry = translations.find(t => t.protocol === o.proto && t.outsidePort === o.flowId && t.destIp === o.dstIp);
    if (entry) {
      touchNat(device, entry);
      // Rewrite the embedded original too (real NAT does), so the inside host
      // sees its own address/flow id quoted back.
      return { ...ipv4, dstIp: entry.insideIp, payload: { ...icmp, original: { ...o, srcIp: entry.insideIp, flowId: entry.insidePort } } };
    }
  }
  if (ipv4.payload.type === "tcp") {
    const tcp = ipv4.payload;
    const entry = translations.find(t => t.protocol === "tcp" && t.outsidePort === tcp.dstPort && t.destIp === ipv4.srcIp);
    if (entry) { touchNat(device, entry); return { ...ipv4, dstIp: entry.insideIp, payload: { ...tcp, dstPort: entry.insidePort } }; }
  }
  if (ipv4.payload.type === "dns" && ipv4.payload.op === "response") {
    const dns = ipv4.payload;
    const entry = translations.find(t => t.protocol === "udp" && t.outsidePort === dns.id && t.destIp === ipv4.srcIp);
    if (entry) { touchNat(device, entry); return { ...ipv4, dstIp: entry.insideIp, payload: { ...dns, id: entry.insidePort } }; }
  }
  return null;
}

// Static destination-NAT (port-forward): a TCP segment to a published
// outside IP:port is redirected to the inside server. The mirror of the PAT
// return path — this is the *inbound* leg of a new, outside-initiated flow. The
// outside client of the connection is recorded as a session so the reply leg is
// matched precisely (a static rule alone would catch unrelated traffic the inside
// server happens to source from the same port).
function dnatInbound(device: Device, ipv4: Ipv4Payload): Ipv4Payload | null {
  if (ipv4.payload.type !== "tcp") return null;
  const tcp = ipv4.payload;
  const rule = (device.config?.portForwards || []).find(r =>
    r.proto === "tcp" && r.outsideIp === ipv4.dstIp && r.outsidePort === tcp.dstPort);
  if (!rule) return null;
  const sim = state.simulation;
  if (!sim.dnatSessions) sim.dnatSessions = {};
  const sessions = sim.dnatSessions[device.id] || (sim.dnatSessions[device.id] = []);
  const known = sessions.some(s => s.clientIp === ipv4.srcIp && s.clientPort === tcp.srcPort && s.insideIp === rule.insideIp && s.insidePort === rule.insidePort);
  if (!known) sessions.push({ clientIp: ipv4.srcIp, clientPort: tcp.srcPort, insideIp: rule.insideIp, insidePort: rule.insidePort, outsideIp: rule.outsideIp, outsidePort: rule.outsidePort });
  return { ...ipv4, dstIp: rule.insideIp, payload: { ...tcp, dstPort: rule.insidePort } };
}

// The return leg of a port-forward: a reply from the inside server's published
// port, addressed to a client of a recorded session, is source-translated back
// to the outside IP:port that client connected to. Matching on the session (the
// client endpoint too, not just the inside port) means an unrelated flow the
// inside server sources from the same port is left untouched.
function dnatReturn(device: Device, ipv4: Ipv4Payload): Ipv4Payload | null {
  if (ipv4.payload.type !== "tcp") return null;
  const tcp = ipv4.payload;
  const sessions = state.simulation.dnatSessions?.[device.id] || [];
  const session = sessions.find(s =>
    s.insideIp === ipv4.srcIp && s.insidePort === tcp.srcPort && s.clientIp === ipv4.dstIp && s.clientPort === tcp.dstPort);
  if (!session) return null;
  return { ...ipv4, srcIp: session.outsideIp, payload: { ...tcp, srcPort: session.outsidePort } };
}

function routeIpv4Frame(device: Device, frame: EthernetFrame, ifaces: any[], ingressIface: any, fromDeviceId: string, ipv4: Ipv4Payload): OutgoingFrame[] {
  const sim = state.simulation;
  const outgoing: OutgoingFrame[] = [];

  // NAT return path: traffic addressed to an outside interface IP may belong
  // to a translated flow — restore the inside endpoint and route it onward.
  const restored = natRestoreInbound(device, ipv4, ifaces);
  if (restored) {
    logStep(device, "sim-nat", `NAT ${ipv4.dstIp} → ${restored.dstIp} (un-PAT return flow)`);
    ipv4 = restored;
    frame = { ...frame, payload: restored };
  } else {
    // DNAT (static port-forward): a new connection to a published outside
    // IP:port is redirected to the inside server before the self/route decision,
    // so the packet is forwarded on rather than consumed by the router.
    const forwarded = dnatInbound(device, ipv4);
    if (forwarded) {
      const tcp = ipv4.payload as TcpPayload;
      logStep(device, "sim-nat", `NAT ${ipv4.dstIp}:${tcp.dstPort} → ${forwarded.dstIp}:${(forwarded.payload as TcpPayload).dstPort} (port-forward)`);
      ipv4 = forwarded;
      frame = { ...frame, payload: forwarded };
    }
  }

  // Check if it's for the router itself (e.g., ping the router's interface IP)
  const selfIface = ifaces.find((iface: any) => iface.ipv4Address === ipv4.dstIp);
  if (selfIface) {
    // Router-destined traffic traverses the INPUT chain (netfilter is always
    // present on a router; an empty ruleset accepts).
    const inStateful = firewallUsesConntrack(device);
    const inputConn = inStateful ? connectionState(device, ipv4) : "new";
    const inputVerdict = evaluateFirewall(device, ipv4, "input", inputConn);
    if (inputVerdict !== "accept") {
      logStep(device, "sim-drop", `Firewall ${inputVerdict.toUpperCase()} ${frameLabel(frame)} ${ipv4.srcIp}→${ipv4.dstIp} (${inStateful ? `INPUT, ${inputConn}` : "INPUT"})`);
      if (inputVerdict === "reject") {
        const resp = rejectResponse(frame, ipv4, ingressIface.macAddress, selfIface.ipv4Address, ingressIface.vlanTag ?? null, fromDeviceId);
        if (resp) outgoing.push(resp);
      }
      return outgoing;
    }
    if (inStateful) trackConnection(device, ipv4);
    const inner = ipv4.payload;
    if (inner.type === "icmp" && inner.icmpType === 8) {
      logStep(device, "sim-icmp", `Received ICMP Echo Request for self (${ipv4.dstIp}) — sending Reply`);
      const reply = createIcmpEchoReply(
        ingressIface.macAddress, frame.srcMac,
        ipv4.dstIp, ipv4.srcIp,
        64, ingressIface.vlanTag ?? null, inner.sequence
      );
      outgoing.push({ frame: reply, toDeviceId: fromDeviceId });
    } else if ((inner.type === "tcp" && inner.flags === "syn") || (inner.type === "dns" && inner.op === "query")) {
      // INPUT accepted it, but nothing on the router listens — answer the way a
      // real kernel does (TCP RST / ICMP Port Unreachable), so `nc` reads
      // "refused" rather than timing out like a DROP would.
      logStep(device, "sim-drop", inner.type === "tcp"
        ? `TCP SYN to ${ipv4.dstIp}:${inner.dstPort} — no service listens on this port of the router, sending RST`
        : `DNS query to ${ipv4.dstIp} — the router runs no DNS service (UDP/53 closed), sending ICMP Port Unreachable`);
      const resp = rejectResponse(frame, ipv4, ingressIface.macAddress, selfIface.ipv4Address, ingressIface.vlanTag ?? null, fromDeviceId);
      if (resp) outgoing.push(resp);
    } else {
      logStep(device, "sim-drop", `${frameLabel(frame)} addressed to the router itself (${ipv4.dstIp}) — nothing on the router handles it, dropped`);
    }
    return outgoing;
  }

  // TTL check happens BEFORE the forwarding decision (as on a real router): when
  // it expires, drop the packet and — if the ingress interface has an address —
  // send an ICMP Time-Exceeded back to the source. This is exactly the signal
  // traceroute relies on to discover each hop, regardless of whether the
  // destination is routable.
  if (ipv4.ttl <= 1) {
    if (ingressIface.ipv4Address) {
      logStep(device, "sim-drop", `TTL expired for packet to ${ipv4.dstIp} — sending ICMP Time-Exceeded to ${ipv4.srcIp}`);
      const timeExceeded = createIcmpTimeExceeded(
        ingressIface.macAddress, frame.srcMac,
        ingressIface.ipv4Address, ipv4.srcIp,
        64, ingressIface.vlanTag ?? null,
        icmpOriginalOf(ipv4)
      );
      outgoing.push({ frame: timeExceeded, toDeviceId: fromDeviceId });
    } else {
      logStep(device, "sim-drop", `TTL expired for packet to ${ipv4.dstIp} — dropping`);
    }
    return outgoing;
  }

  // Route: find egress interface via routing table lookup
  const routeResult = routingLookup(device, ipv4.dstIp);
  if (!routeResult) {
    logStep(device, "sim-drop", `No route to ${ipv4.dstIp} — dropping`);
    return outgoing;
  }
  const { egressIface, nextHopIp } = routeResult;

  // FORWARD chain (post-routing-decision, like netfilter).
  const fwStateful = firewallUsesConntrack(device);
  const forwardConn = fwStateful ? connectionState(device, ipv4) : "new";
  const forwardVerdict = evaluateFirewall(device, ipv4, "forward", forwardConn);
  if (forwardVerdict !== "accept") {
    logStep(device, "sim-drop", `Firewall ${forwardVerdict.toUpperCase()} ${frameLabel(frame)} ${ipv4.srcIp}→${ipv4.dstIp} (${fwStateful ? `FORWARD, ${forwardConn}` : "FORWARD"})`);
    if (forwardVerdict === "reject") {
      const resp = rejectResponse(frame, ipv4, ingressIface.macAddress, ingressIface.ipv4Address, ingressIface.vlanTag ?? null, fromDeviceId);
      if (resp) outgoing.push(resp);
    }
    return outgoing;
  }
  if (fwStateful) trackConnection(device, ipv4);   // remember the accepted flow (for ESTABLISHED)

  // NAT. A port-forward reply (from an inside server's published port) is
  // source-translated back to the outside IP:port the client connected to —
  // checked first, so it isn't PAT'd to a fresh port instead.
  const back = dnatReturn(device, ipv4);
  if (back) {
    const tcp = ipv4.payload as TcpPayload;
    logStep(device, "sim-nat", `NAT ${ipv4.srcIp}:${tcp.srcPort} → ${back.srcIp}:${(back.payload as TcpPayload).srcPort} (port-forward reply)`);
    ipv4 = back;
    frame = { ...frame, payload: back };
  } else if (ingressIface.natRole === "inside" && egressIface.natRole === "outside" && egressIface.ipv4Address) {
    // PAT overload: inside→outside flows are source-translated onto the egress
    // interface address before leaving.
    const translated = natTranslateOutbound(device, ipv4, egressIface);
    if (translated) {
      logStep(device, "sim-nat", `NAT ${ipv4.srcIp} → ${translated.srcIp} (PAT via ${ifaceName(device, egressIface)})`);
      ipv4 = translated;
      frame = { ...frame, payload: translated };
    }
  }

  // ARP lookup on egress interface — resolve next-hop IP (may differ from dstIp for static/RIP routes)
  const egressVlanTag = egressIface.vlanTag ?? null;
  const arpEntry = (egressIface.arpTable || []).find((e: any) => e.ipv4Address === nextHopIp);
  if (arpEntry) {
    // Known next-hop — rewrite L2 and forward, set vlanTag for sub-interface
    const rewrittenFrame: EthernetFrame = {
      ...frame,
      id: frame.id + "-routed",
      srcMac: egressIface.macAddress,
      dstMac: arpEntry.macAddress,
      vlanTag: egressVlanTag,
      payload: { ...ipv4, ttl: ipv4.ttl - 1 }
    };
    const viaStr = nextHopIp !== ipv4.dstIp ? ` next-hop ${nextHopIp}` : "";
    logStep(device, "sim-forward", `Route ${ipv4.srcIp}→${ipv4.dstIp} via ${ifaceName(device, egressIface)}${viaStr} (TTL ${ipv4.ttl}→${ipv4.ttl - 1})`);
    outgoing.push({ frame: rewrittenFrame, toDeviceId: egressIface.peerId });
  } else {
    // Need ARP for next-hop — buffer the (already-translated) frame and ARP
    const pendingKey = `${device.id}:${nextHopIp}`;
    if (!sim.pendingArp[pendingKey]) sim.pendingArp[pendingKey] = [];
    sim.pendingArp[pendingKey].push({ ...frame, id: frame.id + "-buffered" });
    logStep(device, "sim-arp", `ARP miss for ${nextHopIp} on ${ifaceName(device, egressIface)} — buffering frame, sending ARP Request`);

    const arpReq = createArpRequest(egressIface.macAddress, egressIface.ipv4Address, nextHopIp, egressVlanTag);
    outgoing.push({ frame: arpReq, toDeviceId: egressIface.peerId });
  }

  return outgoing;
}

// ─── Firewall (transparent inline packet filter) ─────────────────────────────

// A rule's -s/-d pattern — an exact IP (matched as a /32) or a CIDR (e.g.
// "192.168.1.0/24") — parsed to integers; null when unparseable, which never
// matches. The length is read with parseInt, as iptables' own parser accepts.
function parseFirewallAddress(pattern: string): Cidr | null {
  const slash = pattern.indexOf("/");
  if (slash < 0) {
    const ip = parseIpv4(pattern);
    return ip === null ? null : cidrOf(ip, 32);
  }
  const net = parseIpv4(pattern.slice(0, slash));
  const bits = parseInt(pattern.slice(slash + 1), 10);
  if (net === null || !(bits >= 0 && bits <= 32)) return null;
  return cidrOf(net, bits);
}

// Rule patterns parsed once, keyed by the pattern text (so an edited rule can
// never read a stale parse, and nothing extra is stored on — or serialised
// with — the rule). A rule scan per frame is then integer compares. Bounded:
// dropped wholesale if a pathological ruleset ever fills it.
const firewallAddressCache = new Map<string, Cidr | null>();
function firewallAddress(pattern: string): Cidr | null {
  let parsed = firewallAddressCache.get(pattern);
  if (parsed === undefined) {
    parsed = parseFirewallAddress(pattern);
    if (firewallAddressCache.size >= 4096) firewallAddressCache.clear();
    firewallAddressCache.set(pattern, parsed);
  }
  return parsed;
}

// Does a parsed frame address (null = not a valid IPv4) fall in a rule pattern?
function addressMatches(addr: number | null, pattern: string): boolean {
  if (addr === null) return false;
  const cidr = firewallAddress(pattern);
  return cidr !== null && cidrHas(cidr, addr);
}

export function firewallRuleMatches(rule: FirewallRule, ipv4: Ipv4Payload, conn: ConnState = "new"): boolean {
  return ruleMatchesParsed(rule, ipv4, parseIpv4(ipv4.srcIp), parseIpv4(ipv4.dstIp), conn);
}

// firewallRuleMatches with the frame's addresses already parsed — evaluateFirewall
// parses them once per frame, not once per rule.
function ruleMatchesParsed(rule: FirewallRule, ipv4: Ipv4Payload, srcAddr: number | null, dstAddr: number | null, conn: ConnState): boolean {
  if (rule.protocol && rule.protocol !== "all") {
    const proto = ipv4.protocol === 1 ? "icmp" : ipv4.protocol === 6 ? "tcp" : ipv4.protocol === 17 ? "udp" : "other";
    if (rule.protocol !== proto) return false;
  }
  if (rule.dport != null) {
    if (ipv4.payload.type !== "tcp" || ipv4.payload.dstPort !== rule.dport) return false;
  }
  if (rule.icmpType) {
    if (ipv4.payload.type !== "icmp") return false;
    // "any" matches every ICMP type; otherwise compare canonical names (the
    // parser canonicalised numeric and named forms to the same space).
    if (rule.icmpType !== "any" && icmpTypeName(ipv4.payload.icmpType) !== rule.icmpType) return false;
  }
  if (rule.src && !addressMatches(srcAddr, rule.src)) return false;
  if (rule.dst && !addressMatches(dstAddr, rule.dst)) return false;
  // -m state --state / -m conntrack --ctstate: the frame's connection state must
  // be one the rule lists. "related" is assigned to ICMP errors (see
  // connectionState); "invalid" is still never assigned.
  if (rule.states && rule.states.length && !rule.states.includes(conn)) return false;
  return true;
}

// ─── Connection tracking (netfilter conntrack) ───────────────────────────────

// The proto + ports that key a flow. ICMP/other carry no ports (0,0) — so an
// ICMP/UDP entry is keyed on the address pair alone, and a reverse-direction
// packet of an UNRELATED flow would read as "established". That is safe only
// because the conntrack table is reset at every run start; if it ever persists
// across runs, key ICMP on id/seq and UDP on ports first.
function connTuple(ipv4: Ipv4Payload): { proto: string; sport: number; dport: number } {
  const p = ipv4.payload;
  if (p.type === "tcp") return { proto: "tcp", sport: p.srcPort, dport: p.dstPort };
  // UDP flows (DNS/DHCP) and ICMP carry no L4 ports in the model — key on the
  // address pair + protocol (so a DNS reply still matches its query).
  const proto = ipv4.protocol === 1 ? "icmp" : ipv4.protocol === 17 ? "udp" : ipv4.protocol === 6 ? "tcp" : "other";
  return { proto, sport: 0, dport: 0 };
}

// Conntrack only runs when the device actually filters on connection state (a
// rule has `-m state`) — like real netfilter loading nf_conntrack on demand. A
// purely stateless ruleset pays nothing (no per-frame tracking).
export function firewallUsesConntrack(device: Device): boolean {
  return (device.config?.rules || []).some(r => r.states && r.states.length > 0);
}

// The connection state of a frame at `device`: "established" when it is the
// reply (or a later packet) of a flow we already tracked, else "new".
export function connectionState(device: Device, ipv4: Ipv4Payload): ConnState {
  const table = state.simulation.conntrack?.[device.id];
  if (!table) return "new";
  const { proto, sport, dport } = connTuple(ipv4);
  for (const e of table) {
    // Reply direction (the original went the other way) → established.
    if (e.proto === proto && e.srcIp === ipv4.dstIp && e.dstIp === ipv4.srcIp && e.srcPort === dport && e.dstPort === sport) return "established";
    // A later original-direction packet of a flow that already saw a reply.
    if (e.established && e.proto === proto && e.srcIp === ipv4.srcIp && e.dstIp === ipv4.dstIp && e.srcPort === sport && e.dstPort === dport) return "established";
  }
  // An ICMP error (Time-Exceeded / Dest-Unreachable) is sourced by an
  // intermediate router, so its own tuple is "new" — but netfilter classifies it
  // RELATED to the flow its quoted datagram belongs to. Match the embedded
  // original (the packet that triggered the error) against the tracked flows, so
  // a stateful default-drop + accept-ESTABLISHED,RELATED ruleset lets traceroute
  // hops and path-MTU/unreachable messages back in (review R20).
  const p = ipv4.payload;
  if (p.type === "icmp" && (p.icmpType === 11 || p.icmpType === 3) && p.original) {
    const o = p.original;
    for (const e of table) {
      // TCP flows key on the source port (= flowId); ICMP/UDP key on the address
      // pair alone (srcPort 0), so only compare flowId when the entry carries one.
      if (e.proto === o.proto && e.srcIp === o.srcIp && e.dstIp === o.dstIp && (e.srcPort === 0 || e.srcPort === o.flowId)) return "related";
    }
  }
  return "new";
}

// Record an accepted frame: mark a flow established when its reply arrives, else
// create the original entry (idempotent for repeated original packets).
function trackConnection(device: Device, ipv4: Ipv4Payload): void {
  const sim = state.simulation;
  if (!sim.conntrack) sim.conntrack = {};
  const table = sim.conntrack[device.id] || (sim.conntrack[device.id] = []);
  const { proto, sport, dport } = connTuple(ipv4);
  const reply = table.find(e => e.proto === proto && e.srcIp === ipv4.dstIp && e.dstIp === ipv4.srcIp && e.srcPort === dport && e.dstPort === sport);
  if (reply) { reply.established = true; return; }
  if (table.some(e => e.proto === proto && e.srcIp === ipv4.srcIp && e.dstIp === ipv4.dstIp && e.srcPort === sport && e.dstPort === dport)) return;
  table.push({ proto, srcIp: ipv4.srcIp, dstIp: ipv4.dstIp, srcPort: sport, dstPort: dport, established: false });
}

// The frame a filtering device sends back when it REJECTs a packet: a TCP RST
// for TCP (so a scan/connect reads the port as closed/refused), else an ICMP
// destination-unreachable. `srcMac`/`icmpSrcIp` are the responder's identity
// (a router's ingress interface, or — on a transparent firewall — the target it
// stands in for). Sent back out the ingress link (toDeviceId = fromDeviceId).
function rejectResponse(frame: EthernetFrame, ipv4: Ipv4Payload, srcMac: string, icmpSrcIp: string, vlanTag: number | null, fromDeviceId: string | null): OutgoingFrame | null {
  if (!fromDeviceId) return null;
  const inner = ipv4.payload;
  if (inner.type === "tcp") {
    // The RST appears to come from the intended destination — "connection refused".
    const rst = createTcpSegment(srcMac, frame.srcMac, ipv4.dstIp, ipv4.srcIp, inner.dstPort, inner.srcPort, "rst", 64, vlanTag);
    return { frame: rst, toDeviceId: fromDeviceId };
  }
  const unreach = createIcmpDestUnreachable(srcMac, frame.srcMac, icmpSrcIp, ipv4.srcIp, 64, vlanTag, icmpOriginalOf(ipv4));
  return { frame: unreach, toDeviceId: fromDeviceId };
}

// First-match-wins over the chain's rules, else the chain's default policy.
export function evaluateFirewall(device: Device, ipv4: Ipv4Payload, chain = "forward", conn: ConnState = "new"): FirewallTarget {
  // First match wins, in rule order, within the chain. One pass, no filtered
  // copy, and the frame's addresses parsed once — this runs per filtered frame.
  const rules = device.config?.rules || [];
  const srcAddr = parseIpv4(ipv4.srcIp);
  const dstAddr = parseIpv4(ipv4.dstIp);
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if ((rule.chain || "forward") !== chain) continue;
    if (ruleMatchesParsed(rule, ipv4, srcAddr, dstAddr, conn)) return rule.target;
  }
  return (device.config?.policy || {})[chain] || "accept";
}

export function processAtFirewall(device: Device, frame: EthernetFrame, fromDeviceId: string | null): OutgoingFrame[] {
  const outgoing: OutgoingFrame[] = [];
  if (device.poweredOff) return outgoing;

  // Transparent bridge legs (every linked peer except the ingress one).
  // (linkedPortsFor can be sparse — null gaps — when explicit ports skip a slot.)
  const egressAll = linkedPortsFor(device.id)
    .filter((p: any) => p?.peer)
    .map((p: any) => p.peer.id)
    .filter((id: string) => id !== fromDeviceId);

  // L2 MAC learning, like the switch (review R93): learn the source MAC on the
  // ingress leg — even for a frame the filter then drops, as a real bridge does.
  // Without it the firewall flooded every accepted frame out all legs, leaking
  // unicast and ARP replies the moment it had three or more legs (a hub).
  const cfg: any = device.config;
  if (fromDeviceId && frame.srcMac && frame.srcMac !== BROADCAST_MAC) {
    cfg.macTable = normaliseMacTable(cfg.macTable || []);
    const existing = cfg.macTable.find((e: any) => e.macAddress === frame.srcMac);
    if (existing) existing.port = fromDeviceId;
    else cfg.macTable.push({ macAddress: frame.srcMac, port: fromDeviceId, type: "DYNAMIC", vlan: "" });
  }

  // Filter IPv4 on the FORWARD chain; pass ARP and other control frames through.
  if (frame.payload.type === "ipv4") {
    const ipv4 = frame.payload as Ipv4Payload;
    const stateful = firewallUsesConntrack(device);
    const conn = stateful ? connectionState(device, ipv4) : "new";
    const tag = stateful ? `FORWARD, ${conn}` : "FORWARD";
    const verdict = evaluateFirewall(device, ipv4, "forward", conn);
    if (verdict !== "accept") {
      logStep(device, "sim-drop", `Firewall ${verdict.toUpperCase()} ${frameLabel(frame)} ${ipv4.srcIp}→${ipv4.dstIp} (${tag})`);
      // REJECT answers back (transparent: the firewall stands in for the target).
      if (verdict === "reject") {
        const resp = rejectResponse(frame, ipv4, frame.dstMac, ipv4.dstIp, frame.vlanTag, fromDeviceId);
        if (resp) outgoing.push(resp);
      }
      return outgoing;
    }
    if (stateful) trackConnection(device, ipv4);   // remember the accepted flow (for ESTABLISHED)
    logStep(device, "sim-forward", `Firewall ACCEPT ${frameLabel(frame)} ${ipv4.srcIp}→${ipv4.dstIp} (${tag})`);
  }

  // Forward a known unicast to just the learnt leg; flood a broadcast or an
  // unknown unicast. A learnt leg that is no longer cabled falls back to flood.
  let targets = egressAll;
  if (frame.dstMac && frame.dstMac !== BROADCAST_MAC) {
    const entry = (cfg.macTable || []).find((e: any) => e.macAddress === frame.dstMac);
    if (entry && egressAll.includes(entry.port)) targets = [entry.port];
  }
  targets.forEach((toDeviceId: string, i: number) => {
    outgoing.push({ frame: { ...frame, id: `${frame.id}-fw${i}` }, toDeviceId });
  });
  return outgoing;
}

function generateApipaAddress(self?: Device): string {
  // Seeded (not Math.random) — an APIPA address is config-visible, so a pinned
  // seed reproduces the same link-local fallback. A candidate another device
  // already holds is skipped: the stand-in for the ARP probe a real host sends
  // before claiming a link-local address (RFC 3927 §2.2.1). Without it a pinned
  // seed would hand every host the same first draw.
  for (let attempt = 0; attempt < 64; attempt++) {
    const candidate = `169.254.${simRandomInt(1, 255)}.${simRandomInt(1, 255)}`;
    if (!state.devices.some(d => d !== self && d.config?.ipv4Address === candidate)) return candidate;
  }
  return `169.254.${simRandomInt(1, 255)}.${simRandomInt(1, 255)}`;
}

// Self-assign a link-local 169.254.0.0/16 address (no DHCP, no gateway). Used
// both as the DHCP-failure fallback and as the direct boot path when auto-DHCP
// is off but APIPA is on. Returns the assigned address.
function assignApipa(device: Device): string {
  const apipaIp = generateApipaAddress(device);
  if (device.config) {
    device.config.ipv4Address = apipaIp;
    device.config.ipSource = "apipa";
    device.config.prefixLength = 16;
    device.config.gatewayIpv4Address = "";
  }
  return apipaIp;
}

// What a DHCP server must not count against the client that is asking: its own
// binding, and the address it currently holds. Both servers used to treat the
// requester's own lease (and its own current address) as taken, so a client
// that asked again was offered the NEXT address — a renewing host alternated
// between two (review R69).
function dhcpClientsOwn<L extends { macAddress: string; ipv4Address: string }>(clientMac: string | undefined, leases: L[]): { lease: L | undefined; device: Device | undefined } {
  if (!clientMac) return { lease: undefined, device: undefined };
  const mac = normaliseMacAddress(clientMac);
  return {
    lease: leases.find(l => normaliseMacAddress(l.macAddress) === mac),
    device: state.devices.find(d => !!d.config?.macAddress && normaliseMacAddress(d.config.macAddress) === mac),
  };
}

export function allocateDhcpIp(iface: any, router: Device, clientMac?: string): string | null {
  if (!iface.ipv4Address || !isValidIpv4(iface.ipv4Address)) return null;
  const ifPrefix = prefixOf(iface);
  // The pool is the interface's USABLE range — network+1 … broadcast−1 for the
  // real prefix — starting at the conventional .100 when the network is a /24
  // or larger, else at the first usable address. It used to be the textual /24
  // slice (.100–.254) whatever the prefix, so a /25 interface at .129 leased
  // .100 from the OTHER half and told the client it was on-subnet with a
  // gateway it could never reach.
  const net = ifPrefix <= 0 ? 0 : (ipv4ToInt(iface.ipv4Address) & (0xffffffff << (32 - ifPrefix))) >>> 0;   // network base for the real prefix
  const size = 2 ** (32 - ifPrefix);
  const first = net + 1, last = net + size - 2;          // exclude network + broadcast
  if (last < first) return null;                         // /31, /32: nothing to lease
  const start = size >= 256 ? net + 100 : first;

  const usedIps = new Set<string>();
  // Router interface IPs in this subnet
  for (const ri of (router.config?.interfaces || [])) {
    if (ri.ipv4Address && sameSubnet(ri.ipv4Address, iface.ipv4Address, ifPrefix)) {
      usedIps.add(ri.ipv4Address);
    }
  }
  // Existing DHCP leases on this interface — bar the asking client's own
  const leases = normaliseDhcpLeases(iface.dhcpLeases || []);
  const mine = dhcpClientsOwn(clientMac, leases);
  for (const lease of leases) {
    if (lease !== mine.lease) usedIps.add(lease.ipv4Address);
  }
  // Static IPs of all devices in this subnet (a host collapsed into a LAN
  // still holds its address) — bar the address the asking client holds itself
  for (const d of state.devices) {
    const ip = d.config?.ipv4Address;
    if (ip && isValidIpv4(ip) && d !== mine.device && sameSubnet(ip, iface.ipv4Address, ifPrefix)) {
      usedIps.add(ip);
    }
  }

  usedIps.add(iface.ipv4Address);
  // A client asking again is offered the address it is bound to.
  if (mine.lease && isValidIpv4(mine.lease.ipv4Address) && !usedIps.has(mine.lease.ipv4Address)) {
    const bound = ipv4ToInt(mine.lease.ipv4Address);
    if (bound >= first && bound <= last) return mine.lease.ipv4Address;
  }
  const scan = (from: number, to: number): string | null => {
    for (let v = from; v <= to; v++) { const c = intToIpv4(v); if (!usedIps.has(c)) return c; }
    return null;
  };
  // Prefer the conventional upper pool; fall back to the low addresses before
  // reporting exhaustion (the offer is refused only when nothing usable is left).
  return scan(start, last) ?? (start > first ? scan(first, start - 1) : null);
}

// ── Router interface names for log lines ─────────────────────────────────────
// A stored router interface is keyed by its peer's id (+ VLAN tag) and has no
// name — the name (Ethernet1, Serial2, Ethernet1.10) is derived from the
// cabling by `routerInterfacesWithNames`. The log lines used to print
// `iface.name || iface.peerId`, so "Route … via", "ARP miss … on", "PAT via"
// and "Forward deferred … via" named the interface by its peer's UUID (review
// R52). They now say what `show ip interface brief` and the inspector say.
//
// Deriving the names enumerates the router's cables, and these lines are
// written per routed frame, so the map is cached per router. It is dropped at
// the start of every run and whenever the device or link list changes (the
// same identity + length test the lookup indexes in devices.ts use); a key it
// does not hold (a sub-interface made since) rebuilds it once.
interface IfaceNameCache { devices: unknown; links: unknown; linkCount: number; names: Map<string, string> }
let ifaceNameCaches = new Map<string, IfaceNameCache>();

function resetIfaceNames(): void {
  ifaceNameCaches = new Map();
}

const ifaceKey = (peerId: string, vlanTag: number | null | undefined) => vlanTag == null ? peerId : `${peerId}#${vlanTag}`;

function buildIfaceNames(router: Device): Map<string, string> {
  const names = new Map<string, string>();
  for (const iface of routerInterfacesWithNames(router, true)) {
    const key = ifaceKey(iface.peerId, iface.config?.vlanTag);
    if (!names.has(key)) names.set(key, iface.name);
    // A port carrying sub-interfaces lists only those; its untagged base is
    // still an interface a frame can arrive on, named without the ".tag".
    const dot = iface.name.indexOf(".");
    if (dot > 0 && !names.has(iface.peerId)) names.set(iface.peerId, iface.name.slice(0, dot));
  }
  return names;
}

function ifaceName(router: Device, iface: { peerId?: string; vlanTag?: number | null; name?: string }): string {
  const peerId = iface.peerId || "";
  const key = ifaceKey(peerId, iface.vlanTag);
  let cache = ifaceNameCaches.get(router.id);
  const fresh = cache && cache.devices === state.devices && cache.links === state.links && cache.linkCount === state.links.length;
  if (!cache || !fresh || !cache.names.has(key)) {
    cache = { devices: state.devices, links: state.links, linkCount: state.links.length, names: buildIfaceNames(router) };
    ifaceNameCaches.set(router.id, cache);
  }
  const name = cache.names.get(key);
  if (name) return name;
  // No port name (more cables than ports, say): name the far end instead —
  // never the id.
  const peer = peerId ? getDevice(peerId) : undefined;
  if (peer) return `the interface to ${peer.name}`;
  return iface.name || "an unnamed interface";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function learnArp(config: any, ip: string, mac: string): void {
  config.arpTable = normaliseArpTable(config.arpTable || []);
  const existing = config.arpTable.find((e: any) => e.ipv4Address === ip);
  if (existing) {
    existing.macAddress = mac;
  } else {
    config.arpTable.push({ ipv4Address: ip, macAddress: mac });
  }
}

// Learn a neighbour from the source of an IP packet the host is answering — but
// only a neighbour: an ARP cache maps on-link addresses. A routed packet arrives
// with the ROUTER's MAC as its source, so learning from it filed the remote
// host's address against the gateway's MAC (`arp -n` on a server listed every
// off-subnet client that way — review R70).
function learnOnLinkArp(config: any, ip: string, mac: string): void {
  if (config?.ipv4Address && sameSubnet(config.ipv4Address, ip, prefixOf(config))) learnArp(config, ip, mac);
}

// Count an ARP-cache poison towards the attack report. A spoof is a gratuitous
// reply whose sender MAC is the attack origin's but whose sender IP is some
// other host's; an honest reply's sender MAC and IP belong to the same device,
// so this fires only on a spoof (review R48). Called at each ARP-reply learn
// site (host and router), so a forward or reverse poison is both tallied.
function recordArpPoison(victim: Device, arp: ArpPayload): void {
  const sim = state.simulation;
  if (sim.mode !== "attack") return;
  const atk = getDevice(sim.originDeviceId);
  if (!atk?.config || victim.id === atk.id) return;
  const atkMac = normaliseMacAddress(atk.config.macAddress || "");
  if (!atkMac || normaliseMacAddress(arp.senderMac) !== atkMac) return;
  if (arp.senderIp === atk.config.ipv4Address) return;   // an honest self-announcement, not a poison
  if (!sim.arpPoisoned.includes(victim.name)) {
    sim.arpPoisoned.push(victim.name);
    logStep(victim, "sim-attack", `ARP cache poisoned: ${arp.senderIp} is-at ${arp.senderMac}`);
  }
}

// A link-layer group address (broadcast or multicast): the I/G bit — the least
// significant bit of the first octet — is set.
function isGroupMac(mac: string): boolean {
  const first = parseInt(mac.slice(0, 2), 16);
  return Number.isFinite(first) && (first & 1) === 1;
}

function learnRouterArp(iface: any, ip: string, mac: string): void {
  iface.arpTable = normaliseArpTable(iface.arpTable || []);
  const existing = iface.arpTable.find((e: any) => e.ipv4Address === ip);
  if (existing) {
    existing.macAddress = mac;
  } else {
    iface.arpTable.push({ ipv4Address: ip, macAddress: mac });
  }
}

function logStep(device: Device, kind: string, summary: string): void {
  const sim = state.simulation;
  const entry: SimLogEntry = {
    step: sim.stepIndex,
    deviceId: device.id,
    deviceName: device.name,
    action: summary,
    kind,
    summary: `[Step ${sim.stepIndex}] ${device.name}: ${summary}`
  };
  sim.log.push(entry);
}

// Saved captures: each finished animated run is archived (a ring of 12) so a
// later run can be compared against it. The packet list that shows them is
// simlog-view.ts; the engine only keeps the data.

const CAPTURE_HISTORY_CAP = 12;

// The capture entries for a pane id ("live" = the running/most-recent run, else
// a saved capture). Used by the renderer and the ui.ts row-click resolver.
export function captureEntriesFor(capId: string): CaptureEntry[] {
  if (capId === "live") return state.simulation.capture;
  return state.savedCaptures.find(c => c.id === capId)?.entries || [];
}

// Derive a short label for a finished run from its outcome (mode + endpoints + ✓/✗).
function captureLabel(): string {
  const sim = state.simulation;
  const who = getDevice(sim.originDeviceId)?.name || "";
  const target = sim.dnsName || sim.pingTargetIp || "";
  const flow = target ? `${who}→${target}` : who;
  let verb: string, mark = "";
  switch (sim.mode) {
    case "dhcp": verb = "dhcp"; mark = sim.dhcpSuccess ? " ✓" : " ✗"; break;
    case "tcp": verb = `tcp:${sim.tcpTargetPort ?? "?"}`; mark = sim.tcpSuccess ? " ✓" : " ✗"; break;
    case "dns": verb = "dns"; mark = sim.dnsResolvedIp ? " ✓" : " ✗"; break;
    case "associate": verb = "wifi"; mark = sim.wifiAssociated ? " ✓" : " ✗"; break;
    case "dot1x": verb = "802.1x"; mark = sim.dot1xAuthorized ? " ✓" : " ✗"; break;
    case "stp": verb = "stp"; break;
    case "attack": verb = "scan"; break;
    default: verb = "ping"; mark = sim.pingSuccess ? " ✓" : " ✗"; break;
  }
  return `${verb} ${flow}${mark}`.trim();
}

// Archive the just-completed animated run so a later run can be compared against
// it. Monotonic index → stable, unique id (survives the ring-buffer cap).
function saveCurrentCapture(): void {
  const sim = state.simulation;
  if (sim.capture.length === 0) return;
  const idx = state.savedCaptures.length ? state.savedCaptures[state.savedCaptures.length - 1].index + 1 : 1;
  const id = `cap-${idx}`;
  state.savedCaptures.push({ id, index: idx, label: `#${idx} ${captureLabel()}`, mode: sim.mode, entries: sim.capture.slice() });
  while (state.savedCaptures.length > CAPTURE_HISTORY_CAP) state.savedCaptures.shift();
  state.dock.captureView = id; // show the run that just finished
  if (state.dock.compareBaseId && !state.savedCaptures.some(c => c.id === state.dock.compareBaseId)) {
    state.dock.compareBaseId = ""; // the baseline scrolled out of the buffer
  }
}

function findLinkBetween(a: string, b: string): any | null {
  // Use the by-endpoint adjacency index instead of scanning every link. Frames
  // cross the real cable even when a collapsed LAN hides it, never a proxy link.
  return linksFor(a).find(link =>
    isPhysicalLink(link) && ((link.from === a && link.to === b) || (link.from === b && link.to === a))
  ) || null;
}

// Maps a link's latency (ms) to a transit-time multiplier for the animation.
// 10 ms is the "normal" LAN baseline (1×); the result is clamped so the dot
// stays watchable (a far/satellite link crawls but never stalls forever).
export function linkLatencyFactor(link: any): number {
  const ms = Number(link?.latency);
  if (!(ms > 0)) return 1;
  return Math.min(20, Math.max(0.25, ms / 10));
}

// The one-line storm diagnosis: the sim-log entry, the headless SimResult's
// diagnosis, and what `run`/`traceroute` print when a probe storms.
export const STORM_DIAGNOSIS = "Broadcast storm — frames are circulating endlessly: an L2 loop with no spanning tree to break it (enable STP on the switches, or remove the redundant link)";

// Why an ARP for `ip` was dropped on the way this run, if a recorded drop
// explains it. A drop on the way INTO the device owning `ip` certainly
// mattered. Failing that, when some device does own `ip`, the ARP (or its
// reply) was lost somewhere on the path, so any recorded drop is the lead. When
// nothing owns `ip`, a dropped flooded copy is beside the point: the address
// itself is the problem. At most two distinct reasons are quoted.
function arpDropReason(ip: string): string | null {
  const notes = state.simulation.arpDrops[ip];
  if (!notes?.length) return null;
  let relevant = notes.filter(n => n.atOwner);
  if (!relevant.length && state.devices.some(d => ownsIp(d, ip))) relevant = notes;
  if (!relevant.length) return null;
  return [...new Set(relevant.map(n => n.reason))].slice(0, 2).join("; ");
}

// Why frames still queued behind an ARP at the end of a run were never sent:
// name who the ARP was meant for (a router's next hop, the host's own default
// gateway, or an on-subnet target). When the run recorded the ARP being
// dropped on the way (a data gate, a shut cable, a powered-off device, link
// loss), that reason is the answer. Otherwise nobody answered it, and the hint
// points at the classic causes, such as the gateway set to the wrong address.
function explainUnansweredArp(device: Device, ip: string, frames: EthernetFrame[]): string {
  const counts = new Map<string, number>();
  for (const f of frames) { const label = frameLabel(f); counts.set(label, (counts.get(label) ?? 0) + 1); }
  const queued = [...counts].map(([label, n]) => `${n} queued ${label}`).join(", ");
  const head = `ARP for ${ip} got no reply — ${queued} never sent`;
  const isRouter = device.type === "router";
  const isGateway = !isRouter && ip === device.config?.gatewayIpv4Address;
  const dropped = arpDropReason(ip);
  if (dropped) {
    const who = isRouter ? `next hop ${ip}` : isGateway ? `${ip} (this host's default gateway)` : ip;
    return `${head}: the ARP for ${who} was dropped on the way — ${dropped}`;
  }
  if (isRouter) return `${head}: next hop ${ip} did not answer — is it powered on, cabled, and addressed on that subnet?`;
  if (isGateway)
    return `${head}: ${ip} is this host's default gateway and no device answered for it — is the gateway address right, and is the router interface up on this subnet?`;
  return `${head}: no device on this subnet answered for ${ip} — is the address right, and is that host cabled and powered on?`;
}

// ARP cache entries that could have sunk this flow: an entry for one of its
// endpoints (the origin, its target, its gateway or nameserver), or a router's
// next hop toward either end, that maps the
// address to a MAC nothing presents on a cable any more — a changed NIC
// address, a router interface whose cable was moved (re-cabling the port gives
// it a new MAC), or a cache imported from another topology. A router takes up
// only frames sent to its own interface MAC, so a routed flow addressed there
// dies with no ARP left to explain it. Reported only on a failed run.
function staleArpEntries(origin: Device | undefined): { device: Device; reason: string }[] {
  if (!origin) return [];
  const sim = state.simulation;
  const cfg = origin.config;
  const roles = new Map<string, string>();
  const note = (ip: string | null | undefined, role: string) => { if (ip && !roles.has(ip)) roles.set(ip, role); };
  note(sim.pingTargetIp ?? sim.dnsResolvedIp, "the target");
  note(cfg?.gatewayIpv4Address, `${origin.name}'s default gateway`);
  note(cfg?.dnsServerIp, `${origin.name}'s nameserver`);
  note(cfg?.ipv4Address, origin.name);
  const live = new Set<string>();
  for (const d of state.devices) for (const mac of liveMacsOf(d)) live.add(mac);
  const ends = [sim.pingTargetIp ?? sim.dnsResolvedIp, cfg?.ipv4Address].filter((ip): ip is string => !!ip);
  const found: { device: Device; reason: string }[] = [];
  const check = (device: Device, table: ArpEntry[] | undefined, hops?: Map<string, string>) => {
    for (const entry of table ?? []) {
      const role = roles.get(entry.ipv4Address) ?? hops?.get(entry.ipv4Address);
      if (!role || !entry.macAddress) continue;
      const mac = normaliseMacAddress(entry.macAddress);
      if (live.has(mac)) continue;
      const owner = state.devices.find(d => macsOwnedBy(d).includes(mac));
      const whose = owner
        ? `which belongs to ${owner.name}${owner.type === "router" ? "'s interface" : ""} with no cable now`
        : "which no device on the network owns";
      const remedy = device.type === "router"
        ? "the simulator never ages ARP entries out, so flush the router's cache with `ip neigh flush all` (privileged mode) and retry"
        : "the simulator never ages ARP entries out, so flush the cache with `ip neigh flush all` and retry";
      found.push({ device, reason: `Stale ARP entry: ${entry.ipv4Address} (${role}) is cached at ${entry.macAddress}, ${whose} — a router takes up only frames sent to its own interface MAC, so frames sent there are ignored; ${remedy}` });
    }
  };
  for (const d of state.devices) {
    check(d, d.config?.arpTable);
    if (!d.config?.interfaces?.length) continue;
    // A router's entry for its next hop toward either end of the flow.
    const hops = new Map<string, string>();
    if (d.type === "router") {
      for (const ip of ends) {
        const hop = routingLookup(d, ip)?.nextHopIp;
        if (hop && hop !== ip && !hops.has(hop)) hops.set(hop, `${d.name}'s next hop toward ${ip}`);
      }
    }
    for (const iface of d.config.interfaces) check(d, iface.arpTable, hops);
  }
  return found;
}

// The run's post-mortem, before finishSimulation discards its queues: explain
// what no single step could. A storm is the whole story (queued frames are its
// symptom); otherwise every pendingArp entry still holding frames is an ARP
// nobody answered. Each reason is logged on the device that waited, and
// returned — the origin's verbatim, others prefixed with their name — for the
// origin's terminal and SimResult.diagnosis. A sweep's many silent addresses
// collapse into one line per device. On a run that met its goal (a sweep that
// found hosts, a ping that got its reply) the unanswered ARPs are expected —
// the dead addresses a sweep probes — so they are logged as plain ARP notes and
// left out of the diagnosis, which explains failures. A storm is always reported.
function runPostMortem(succeeded: boolean): string[] {
  const sim = state.simulation;
  const origin = sim.originDeviceId ? getDevice(sim.originDeviceId) : undefined;
  if (sim.stormDetected) {
    if (origin) logStep(origin, "sim-drop", STORM_DIAGNOSIS);
    return [STORM_DIAGNOSIS];
  }
  const byDevice = new Map<string, { ip: string; frames: EthernetFrame[] }[]>();
  for (const key in sim.pendingArp) {
    const frames = sim.pendingArp[key];
    if (!frames?.length) continue;
    const cut = key.lastIndexOf(":");   // `${deviceId}:${ip}` — an IPv4 address has no colon
    const id = key.slice(0, cut);
    const list = byDevice.get(id) ?? [];
    list.push({ ip: key.slice(cut + 1), frames });
    byDevice.set(id, list);
  }
  const lines: string[] = [];
  // An 802.1X login's failure was decided — and logged — by one handler; carry
  // its reason into the result so a headless `run dot1x` can state it too.
  if (!succeeded && sim.dot1xFailure) lines.push(sim.dot1xFailure);
  if (!succeeded && sim.wifiFailure) lines.push(sim.wifiFailure);
  if (!succeeded) {
    for (const { device, reason } of staleArpEntries(origin)) {
      logStep(device, "sim-drop", reason);
      lines.push(device.id === sim.originDeviceId ? reason : `${device.name}: ${reason}`);
    }
  }
  for (const [id, entries] of byDevice) {
    const device = getDevice(id);
    if (!device) continue;
    const reasons: string[] = [];
    if (entries.length > 3) {
      const gw = device.config?.gatewayIpv4Address;
      for (const e of entries) if (e.ip === gw) reasons.push(explainUnansweredArp(device, e.ip, e.frames));
      const rest = entries.filter(e => e.ip !== gw);
      const shown = rest.slice(0, 4).map(e => e.ip).join(", ") + (rest.length > 4 ? ", …" : "");
      const queued = rest.reduce((n, e) => n + e.frames.length, 0);
      reasons.push(`ARP got no reply from ${rest.length} addresses (${shown}) — ${queued} queued frames never sent: no device on this subnet answered for them`);
    } else {
      for (const e of entries) reasons.push(explainUnansweredArp(device, e.ip, e.frames));
    }
    for (const reason of reasons) {
      logStep(device, succeeded ? "sim-arp" : "sim-drop", reason);
      lines.push(id === sim.originDeviceId ? reason : `${device.name}: ${reason}`);
    }
  }
  return succeeded ? [] : lines;
}

function finishSimulation(): void {
  const sim = state.simulation;

  // Results land in the session of the device that started the run — the
  // user may have switched tabs while the simulation animated.
  const originSession = sessionFor(sim.originDeviceId);
  const out = (kind: string, text: string) =>
    appendSessionLine(originSession ?? state.terminal, { kind, text });

  // Explain the failure before the queues holding the evidence are cleared.
  const originArpUnanswered = Object.keys(sim.pendingArp).some(k => sim.pendingArp[k].length > 0 && k.startsWith(`${sim.originDeviceId}:`));
  const succeeded = runSucceeded(sim.mode);
  sim.diagnosis = runPostMortem(succeeded);

  if (sim.stormDetected) {
    // A switching loop multiplied frames without bound: no spanning tree to
    // break it. Report it plainly (and on the status line) instead of the
    // mode's usual result — the run never really completed.
    if (!sim.headless) {
      out("error", "Broadcast storm: frames are looping endlessly — there's an L2 loop with no spanning tree to break it.\nEnable STP on the switches (it's on by default for managed switches), or remove the redundant link.");
      dom.modeLabel.textContent = "Broadcast storm detected — an L2 loop with no spanning tree.";
    }
  } else if (sim.mode === "stp") {
    if (!sim.headless) {
      const blocked = state.links.filter(l => l.stpBlocked).length;
      const roots = state.devices.filter(d => d.type === "switch" && d.config?.stp?.bridgeId && d.config.stp.bridgeId === d.config.stp.rootId);
      const rootNames = roots.map(r => r.name).join(", ") || "(none)";
      out("", `Spanning tree converged.\n  Root bridge: ${rootNames}\n  Blocking ports: ${blocked} (${blocked === 1 ? "1 redundant link cut" : blocked === 0 ? "no loop to break" : blocked + " redundant links cut"})`);
    }
  } else if (sim.mode === "attack") {
    // nmap-style report of what the Red Team run found; also stash it on the
    // attacker for the inspector.
    const open = [...sim.scanOpen].sort((a, b) => a - b);
    const closed = [...sim.scanClosed].sort((a, b) => a - b);
    const lines: string[] = [];
    if (open.length || closed.length) {
      lines.push("PORT      STATE  SERVICE");
      for (const p of open) lines.push(`${String(p + "/tcp").padEnd(10)}open   ${SERVICE_NAMES[p] || "unknown"}`);
      for (const p of closed) lines.push(`${String(p + "/tcp").padEnd(10)}closed ${SERVICE_NAMES[p] || "unknown"}`);
    }
    if (sim.sweepLive.length) lines.push(`Hosts up: ${sim.sweepLive.length} (${[...sim.sweepLive].sort().join(", ")})`);
    if (sim.arpPoisoned.length) lines.push(`ARP cache poisoned on: ${[...sim.arpPoisoned].sort().join(", ")}`);
    if (!lines.length) lines.push("No open ports or live hosts found (target unreachable, filtered, or no attack target set).");
    const origin = getDevice(sim.originDeviceId);
    if (origin?.config) (origin.config as any).attackLog = lines;
    if (!sim.headless) out("", lines.join("\n"));
  } else if (sim.mode === "dhcp") {
    if (sim.dhcpSuccess) {
      if (!sim.headless) out("", `DHCP configured:\n  IP address: ${sim.dhcpAssignedIp}\n  Default gateway: ${sim.dhcpAssignedGateway}`);
    } else if (state.options.apipaFallback && sim.headless) {
      // A headless run observes; it does not re-address the host. It used to
      // self-assign 169.254.x.y here — over a static address too — while `run
      // dhcp` and the scenario check printed only "no response", with no log
      // line and no undo point. The animated path does fall back, so the
      // difference is said out loud (in the diagnosis `run` prints, and the log).
      const origin = getDevice(sim.originDeviceId);
      const kept = origin?.config?.ipv4Address ? `its address stays ${origin.config.ipv4Address}` : "it stays unassigned";
      const note = `No DHCP server answered. APIPA fallback is on, but a headless run leaves ${origin?.name ?? "the host"} as it is (${kept}) — the animated dhcp, or Play, would self-assign a 169.254.x.y link-local address.`;
      sim.diagnosis.push(note);
      if (origin) logStep(origin, "sim-drop", note);
    } else if (state.options.apipaFallback) {
      // APIPA fallback — link-local 169.254.0.0/16
      const origin = getDevice(sim.originDeviceId);
      const apipaIp = origin ? assignApipa(origin) : generateApipaAddress();
      sim.dhcpAssignedIp = apipaIp;
      out("error", `DHCP: no response from server.\nAPIPA: assigned link-local ${apipaIp}`);
    } else {
      // APIPA disabled (pedagogical) — no DHCP, no fallback: the host has no address.
      if (!sim.headless) out("error", "DHCP: no response from server.\nAPIPA disabled — no address assigned.");
    }
  } else if (sim.mode === "dns") {
    if (!sim.headless) {
      const origin = getDevice(sim.originDeviceId);
      const server = origin?.config?.dnsServerIp || "?";
      if (sim.dnsResolvedIp) {
        out("", `Server:\t\t${server}\nAddress:\t${server}#53\n\nName:\t${sim.dnsName}\nAddress: ${sim.dnsResolvedIp}`);
      } else if (sim.log.some(e => e.kind === "sim-drop" && e.action.includes("NXDOMAIN"))) {
        out("error", `** server can't find ${sim.dnsName}: NXDOMAIN`);
      } else if (sim.pingUnreachableFrom) {
        // The nameserver's host answered ICMP Port Unreachable: nothing listens on UDP/53 there.
        out("error", `;; communications error to ${server}#53: connection refused`);
      } else {
        out("error", `;; connection timed out; no servers could be reached`);
      }
    }
  } else if (sim.mode === "tcp") {
    if (!sim.headless) {
      const target = sim.pingTargetIp || sim.dnsName || "?";
      const port = sim.tcpTargetPort ?? "?";
      if (sim.dnsName && !sim.dnsResolvedIp) {
        out("error", `nc: getaddrinfo for host "${sim.dnsName}" port ${port}: Name or service not known`);
      } else if (sim.tcpSuccess) {
        out("", `Connection to ${target} ${port} port [tcp/*] succeeded!`);
      } else if (sim.tcpRefused) {
        out("error", `nc: connect to ${target} port ${port} (tcp) failed: Connection refused`);
      } else {
        out("error", `nc: connect to ${target} port ${port} (tcp) failed: Operation timed out`);
      }
    }
  } else if (sim.mode === "http") {
    if (!sim.headless) {
      const target = sim.dnsName || sim.pingTargetIp || "?";
      const url = `http://${target}${sim.httpPath || "/"}`;
      if (sim.dnsName && !sim.dnsResolvedIp) {
        out("error", `curl: (6) Could not resolve host: ${sim.dnsName}`);
      } else if (sim.tcpRefused) {
        out("error", `curl: (7) Failed to connect to ${target} port ${sim.tcpTargetPort ?? 80}: Connection refused`);
      } else if (sim.httpStatus != null) {
        out("", `> GET ${sim.httpPath || "/"} HTTP/1.1\n< HTTP/1.1 ${sim.httpStatus} ${sim.httpStatusText}\n\n${sim.httpServerTitle || ""}`);
      } else if (sim.tcpSuccess) {
        out("error", `curl: (52) Empty reply from server (${url} — connected, but no web service is listening)`);
      } else {
        out("error", `curl: (28) Failed to connect to ${target} port ${sim.tcpTargetPort ?? 80}: Operation timed out`);
      }
    }
  } else if (!sim.headless) {
    if (sim.dnsName && !sim.dnsResolvedIp) {
      out("error", `ping: ${sim.dnsName}: Name or service not known`);
    } else {
      const targetIp = sim.pingTargetIp || "?";
      const name = sim.dnsName ? `${sim.dnsName} (${targetIp})` : targetIp;
      if (sim.pingSuccess) {
        const ttl = sim.pingTtl;
        const rtt = sim.stepIndex < 15 ? "1.0" : "2.0";
        out("", `PING ${name}\n64 bytes from ${targetIp}: icmp_seq=1 ttl=${ttl} time=${rtt} ms\n\n--- ${name} ping statistics ---\n1 packets transmitted, 1 received, 0% packet loss`);
      } else {
        // An ICMP error back to the origin is printed the way Linux ping does
        // (`From <who> icmp_seq=1 …`, counted under "+1 errors"); so is the
        // origin's own unanswered ARP (Destination Host Unreachable).
        const origin = getDevice(sim.originDeviceId);
        const errors: string[] = [];
        if (sim.pingTimeExceeded && sim.pingResponderIp) errors.push(`From ${sim.pingResponderIp} icmp_seq=1 Time to live exceeded`);
        if (sim.pingUnreachableFrom) errors.push(`From ${sim.pingUnreachableFrom} icmp_seq=1 Destination Port Unreachable`);
        if (originArpUnanswered) errors.push(`From ${origin?.config?.ipv4Address || "?"} icmp_seq=1 Destination Host Unreachable`);
        const body = errors.length ? errors.join("\n") + "\n" : "";
        const tally = errors.length ? `, +${errors.length} error${errors.length > 1 ? "s" : ""}` : "";
        out("", `PING ${name}\n${body}\n--- ${name} ping statistics ---\n1 packets transmitted, 0 received${tally}, 100% packet loss`);
      }
    }
  }

  // The post-mortem's reasons follow a failed flow's result in the origin's
  // terminal (a storm already printed its own explanation above).
  const flowMode = sim.mode === "ping" || sim.mode === "tcp" || sim.mode === "http" || sim.mode === "dns";
  if (!sim.headless && flowMode && !succeeded && !sim.stormDetected && sim.diagnosis.length) {
    out("error", sim.diagnosis.join("\n"));
  }

  // A capped storm can finish with thousands of frames still queued. They are
  // no longer runnable once the result is final, and retaining them leaves
  // stale device/link references if the user edits the topology afterwards.
  sim.events = [];
  sim.transits = [];
  sim.pendingArp = {};
  sim.status = "done";
  // Headless runs don't touch the DOM/terminal — the caller renders the result.
  if (sim.headless) return;
  // Archive this run's packet capture so a later run can be compared against it
  // — except network-boot chatter, which would flood the small history ring.
  if (!bootRunActive) saveCurrentCapture();
  sync().syncSimLog();
  sync().syncTerminal();   // unlocks the terminal input (the lock follows sim.status)
  sync().syncPanel();
  updateSimControls();
  stopAnimationLoop();
  // Mid network-boot sequence: animate the next unconfigured host's DHCP.
  if (bootQueue.length) bootNextHost();
}

const PLAY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13 -8z"></path></svg>`;
const PAUSE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6z"></path><path d="M14 5h4v14h-4z"></path></svg>`;

function updateSimControls(): void {
  const running = state.simulation.status === "running";
  const active = running || state.simulation.status === "paused";
  // The floating on-canvas transport pill: visible while a run is active, its
  // play/pause button showing the action it would take next.
  const controls = document.getElementById("simControls");
  if (controls) controls.classList.toggle("active", active);
  const transportPlayPause = document.getElementById("simTransportPlayPause");
  if (transportPlayPause) {
    transportPlayPause.innerHTML = running ? PAUSE_ICON : PLAY_ICON;
    transportPlayPause.setAttribute("title", running ? "Pause" : "Resume");
  }
  const playPause = document.getElementById("simPlayPause");
  if (playPause) playPause.textContent = running ? "⏸" : "▶";
}
