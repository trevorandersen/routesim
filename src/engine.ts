import type { EthernetFrame, ArpPayload, Ipv4Payload, DhcpPayload, TcpPayload, DnsPayload, Dot11Payload, Dot1xPayload, BpduPayload, NatEntry, SimEvent, SimLogEntry, ActiveTransit, FrameHistoryEntry, RouteEntry, RouterInterface, Device, DeviceType, FirewallRule, FirewallTarget, ConnState, Link, Cidr } from "./types";
import { state, pushUndo, sync } from "./state";
import { dom } from "./dom";
import { getDevice, linkedPortsFor, routerInterfacesWithNames, linkName, linkById, linksFor, linkAuthorizedForData, macsecState } from "./devices";
import { normalisePortVlans, normalisePortModes, normaliseTrunkAllowedVlans, normaliseArpTable, normaliseMacTable, normaliseDhcpLeases, normaliseStaticRoutes, ensureConfig } from "./normalise";
import { sameSubnet, prefixOf, isValidIpv4, escapeHtml, ipv4ToInt, intToIpv4, normaliseMacAddress, deriveMac, internetGatewayIp, parseIpv4, cidrOf, cidrHas } from "./utils";
import { simRandomInt } from "./prng";
import { createArpRequest, createArpReply, createIcmpEchoRequest, createIcmpEchoReply, createIcmpTimeExceeded, createIcmpDestUnreachable, icmpOriginalOf, createDhcpOffer, createDhcpRequest, createDhcpAck, createTcpSegment, createHttpRequest, createHttpResponse, createDnsResponse, createDot11Frame, createDot1xFrame, createBpduFrame, BROADCAST_MAC, frameLabel, packetColumns, toneGlyph } from "./frame";
import { terminalLine, terminalLineFor, sessionFor, syncTerminal, openDock, syncSimLogBadge } from "./terminal";
import { buildPingEvents, buildResolveEvents, buildDhcpEvents, buildAttackEvents, findPingTarget, hostnameToIp } from "./simulation";
import type { PingSetup } from "./simulation";
import { routingLookup, runRipConvergence, buildRoutingTable } from "./routing";
import { runStpConvergence, isStpParticipant } from "./stp";
import { runIdsRules } from "./snort";
import { applyLogFilter, presentTokens, isFilterActive, PROTOCOL_CHIPS } from "./packet-filter";
import type { FilterRow } from "./packet-filter";
import type { LogFilter, CaptureEntry } from "./types";

// Re-exported so existing imports (terminal, tests, benchmarks) keep working.
export { buildRoutingTable, routingLookup, runRipConvergence } from "./routing";
export { runStpConvergence } from "./stp";

// ─── Public API ──────────────────────────────────────────────────────────────

export function startSimulation(setup: PingSetup, originDeviceId: string, targetIp: string, mode: "ping" | "dhcp" | "tcp" | "dns" | "http" | "associate" | "dot1x" | "stp" | "attack" = "ping", targetPort: number | null = null): void {
  // Converge routing (RIP) and the spanning tree before the run, so frames route
  // correctly and loops are already broken (blocked ports) before the first hop.
  runRipConvergence();
  runStpConvergence();
  pushUndo();
  state.inspectedFrame = null; // a new run invalidates the inspected frame
  state.inspectedCapture = null;
  const sim = state.simulation;
  bootRunActive = pendingBootRun; // is this a network-boot run? (armed by bootNextHost)
  pendingBootRun = false;
  sim.status = "running";
  sim.mode = mode;
  sim.headless = false;
  sim.events = [];
  sim.log = [];
  sim.capture = [];
  state.dock.captureView = "live"; // watch the run that's starting, not an archived one
  sim.transits = [];
  sim.pendingArp = { ...setup.pendingArp };
  sim.stepIndex = 0;
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
  sim.originDeviceId = originDeviceId;
  sim.pingTargetIp = setup.dns ? null : targetIp;
  sim.pingSuccess = false;
  sim.pingTtl = 64;
  sim.pingResponderIp = null;
  sim.pingTimeExceeded = false;
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
  sim.stormDetected = false;
  sim.scanOpen = []; sim.scanClosed = []; sim.sweepLive = [];
  sim.conntrack = {};   // connection tracking starts empty each run
  sim.dnatSessions = {};
  sim.lossNoted = new Set();
  // Each run reports only its own detections/findings — clear IDS alert logs and
  // attacker findings (like sim.log / sim.capture) so they don't accumulate.
  for (const d of state.devices) {
    if (d.type === "ids" && d.config) d.config.alerts = [];
    if ((d.type === "attacker" || d.type === "kali") && d.config) (d.config as any).attackLog = [];
  }
  const target = setup.dns ? setup.dns.name : targetIp;
  const label = mode === "dhcp" ? "Requesting DHCP lease..."
    : mode === "tcp" ? `Opening TCP connection to ${target}:${sim.tcpTargetPort ?? "?"}...`
    : mode === "http" ? `Requesting http://${target}${sim.httpPath}...`
    : mode === "dns" ? `Resolving ${target}...`
    : mode === "associate" ? `Associating to ${target || "WiFi"}...`
    : mode === "dot1x" ? `802.1X authenticating ${target || "supplicant"}...`
    : mode === "stp" ? "Spanning tree: advertising BPDUs from the root bridge..."
    : mode === "attack" ? "Red Team: launching attacks..."
    : `Simulating ping to ${target}...`;
  state.terminal.lines.push({ kind: "sim", text: label });
  // Surface the hop-by-hop log: open the dock on the Sim Log pane if nothing
  // is showing; if the dock is already open, leave the user's tab alone (the
  // Sim Log tab badge counts entries as they arrive).
  if (!state.dock.open) openDock("simlog");
  syncTerminal();
  syncSimLog();
  updateSimControls(); // reveal the floating transport pill + set the pause icon
  startAnimationLoop();
  // With a seeded first-leg transit, the animation loop drives processing once
  // it lands; only kick the queue directly if nothing was seeded.
  if (sim.autoPlay && sim.transits.length === 0) processNextStep();
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
  state.inspectedCapture = null; // the capture it referenced is gone
  // The live capture was just cleared — fall back to the most recent saved run.
  state.dock.captureView = state.savedCaptures.length ? state.savedCaptures[state.savedCaptures.length - 1].id : "live";
  if (state.dock.compareBaseId === state.dock.captureView) state.dock.compareBaseId = "";
  stopAnimationLoop();
  updateSimControls(); // hide the floating transport pill
  syncSimLog();
  syncTerminal();
  sync().render();
}

export function pauseSimulation(): void {
  if (state.simulation.status === "running") {
    state.simulation.status = "paused";
    updateSimControls();
  }
}

export function resumeSimulation(): void {
  if (state.simulation.status === "paused") {
    state.simulation.status = "running";
    updateSimControls();
    if (state.simulation.transits.length === 0) processNextStep();
  }
}

export function stepOnce(): void {
  const sim = state.simulation;
  if (sim.status !== "paused" && sim.status !== "running") return;
  sim.status = "paused";
  // If transits are in progress, complete them instantly
  if (sim.transits.length > 0) {
    for (const t of sim.transits) t.progress = 1;
    deliverCompletedTransits();
  }
  processNextStep();
  updateSimControls();
}

export interface SimResult {
  success: boolean;
  refused?: boolean;             // TCP connect answered with RST (port closed)
  ttl?: number;
  responderIp?: string | null;   // who answered (echo reply or a router's TTL-exceeded)
  timeExceeded?: boolean;        // the answer was an ICMP Time-Exceeded
  resolvedIp?: string | null;    // DNS answer (mode "dns" or a by-name ping/tcp/http flow)
  httpStatus?: number | null;    // HTTP response status (mode "http")
  assignedIp?: string | null;
  assignedGateway?: string | null;
  log: SimLogEntry[];
  steps: number;
}

// Runs a simulation to completion synchronously — no animation / requestAnimationFrame —
// and returns the result plus the hop-by-hop log. Reuses the same process handlers as
// the animated path; powers the console `run` command, window.routesim, and tests.
export function runSimulationHeadless(
  setup: PingSetup, originDeviceId: string, targetIp: string, mode: "ping" | "dhcp" | "tcp" | "dns" | "http" | "associate" | "dot1x" | "stp" | "attack" = "ping", targetPort: number | null = null
): SimResult {
  runRipConvergence();
  runStpConvergence();
  const sim = state.simulation;
  sim.status = "running";
  sim.mode = mode;
  sim.headless = true;
  sim.events = setup.events;
  sim.log = [];
  // sim.capture is deliberately left alone: headless runs don't capture, and
  // a scenario check (or first-boot chatter) must not wipe the packet list.
  sim.transits = [];
  sim.pendingArp = { ...setup.pendingArp };
  sim.stepIndex = 0;
  sim.originDeviceId = originDeviceId;
  sim.pingTargetIp = setup.dns ? null : targetIp;
  sim.pingSuccess = false;
  sim.pingTtl = 64;
  sim.pingResponderIp = null;
  sim.pingTimeExceeded = false;
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
  sim.stormDetected = false;
  sim.scanOpen = []; sim.scanClosed = []; sim.sweepLive = [];
  sim.conntrack = {};   // connection tracking starts empty each run
  sim.dnatSessions = {};
  sim.lossNoted = new Set();
  // Each run reports only its own detections/findings — clear IDS alert logs and
  // attacker findings (like sim.log / sim.capture) so they don't accumulate.
  for (const d of state.devices) {
    if (d.type === "ids" && d.config) d.config.alerts = [];
    if ((d.type === "attacker" || d.type === "kali") && d.config) (d.config as any).attackLog = [];
  }

  // Drain the event queue, completing each batch of transits instantly. processNextStep
  // recurses internally while status === "running" and events have no transits, and calls
  // finishSimulation() once fully drained. The guard caps pathological loops (an L2 loop
  // with no spanning tree storms — broadcasts multiply without bound).
  const MAX_STEPS = 10000;
  let guard = 0;
  processNextStep();
  while (sim.transits.length > 0 && sim.status === "running" && guard++ < MAX_STEPS) {
    for (const t of sim.transits) t.progress = 1;
    deliverCompletedTransits();
    processNextStep();
  }
  // Hit the cap with frames still in flight: a broadcast storm (a switching loop
  // with STP off or unable to break it). Surface it rather than failing silently.
  if (guard >= MAX_STEPS && (sim.transits.length > 0 || sim.events.length > 0)) sim.stormDetected = true;
  // `sim.status` is mutated inside processNextStep/finishSimulation; the cast
  // stops TS from over-narrowing it to the literal assigned above.
  if ((sim.status as string) !== "done") finishSimulation();

  const result: SimResult = {
    success: mode === "dhcp" ? sim.dhcpSuccess
      : mode === "tcp" ? sim.tcpSuccess
      : mode === "http" ? sim.httpSuccess
      : mode === "dns" ? sim.dnsResolvedIp != null
      : mode === "associate" ? sim.wifiAssociated
      : mode === "dot1x" ? sim.dot1xAuthorized
      : mode === "stp" ? !sim.stormDetected
      : mode === "attack" ? (sim.scanOpen.length > 0 || sim.sweepLive.length > 0)
      : sim.pingSuccess,
    refused: sim.tcpRefused,
    ttl: sim.pingTtl,
    responderIp: sim.pingResponderIp,
    timeExceeded: sim.pingTimeExceeded,
    resolvedIp: sim.dnsResolvedIp,
    httpStatus: sim.httpStatus,
    assignedIp: sim.dhcpAssignedIp,
    assignedGateway: sim.dhcpAssignedGateway,
    log: sim.log,
    steps: sim.stepIndex,
  };
  sim.headless = false;   // the flag belongs to the run, not to whatever comes after it
  return result;
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
// its startSimulation, latched into `bootRunActive` for the run's lifetime, and
// keeps the run's capture out of the multi-run compare archive.
let pendingBootRun = false;
let bootRunActive = false;

function hostNeedsBoot(device: Device | undefined): boolean {
  return !!device && (device.type === "computer" || device.type === "laptop" || device.type === "kali" || device.type === "server")
    && !device.poweredOff && !device.config?.ipv4Address
    && state.links.some(l => !l.hidden && !l.shutdown && (l.from === device.id || l.to === device.id));
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
export function launchRedTeam(): boolean {
  const sim = state.simulation;
  if (sim.status === "running" || sim.status === "paused") return false;
  const attacker = state.devices.find(d => d.type === "attacker" && !d.poweredOff && d.config?.ipv4Address && (d.config?.attacks?.length ?? 0) > 0);
  if (!attacker) return false;
  const setup = buildAttackEvents(attacker);
  if (typeof setup === "string") { dom.modeLabel.textContent = setup; return false; }
  dom.modeLabel.textContent = `${attacker.name}: launching attacks...`;
  startSimulation(setup, attacker.id, "", "attack");
  return true;
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
      pendingBootRun = true; // a boot run — keep its capture out of the compare archive
      startSimulation(setup, device!.id, "", "dhcp");
      return true;
    }
    // Auto-DHCP off, APIPA on (the only way we reach here): self-assign directly.
    assignApipa(device!);
    apipaCount++;
  }
  if (apipaCount) {
    dom.modeLabel.textContent = `Auto-DHCP off — ${apipaCount} host${apipaCount > 1 ? "s" : ""} self-assigned a link-local (APIPA) address.`;
    sync().render();
    sync().syncPanel();
  }
  return false;
}

export interface TracerouteHop { ttl: number; ip: string | null; reached: boolean }
export interface TracerouteResult { targetIp: string; hops: TracerouteHop[]; reached: boolean }

// Runs traceroute headlessly: sends probes with increasing TTL and records who
// answered each round — a router's ICMP Time-Exceeded (intermediate hop) or the
// destination's Echo Reply (final hop). Reuses runSimulationHeadless per probe.
export function runTraceroute(source: Device, targetText: string, maxHops = 30): TracerouteResult | string {
  const target = findPingTarget(targetText);
  let targetIp = target ? (target.config?.ipv4Address || targetText) : targetText.trim();
  if (!target && !isValidIpv4(targetIp)) {
    // A real hostname: resolve it headlessly via the configured nameserver
    // (real DNS frames), then trace the answer.
    const lookup = buildResolveEvents(source, targetIp, null, null);
    if (typeof lookup === "string") return `traceroute: unknown host ${targetIp}`;
    const res = runSimulationHeadless(lookup, source.id, targetIp, "dns");
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
  if (typeof warm !== "string") runSimulationHeadless(warm, source.id, targetIp, "ping");

  const hops: TracerouteHop[] = [];
  let reached = false;
  for (let ttl = 1; ttl <= maxHops; ttl++) {
    const setup = buildPingEvents(source, targetIp, { ttl });
    if (typeof setup === "string") return setup; // validation error (e.g. cannot resolve / no gateway)
    const res = runSimulationHeadless(setup, source.id, targetIp, "ping");
    if (res.success) {
      hops.push({ ttl, ip: res.responderIp || targetIp, reached: true });
      reached = true;
      break;
    }
    hops.push({ ttl, ip: res.responderIp || null, reached: false });
  }
  return { targetIp, hops, reached };
}

// ─── Animation loop ──────────────────────────────────────────────────────────

let animFrameId: number | null = null;

// Animated-path broadcast-storm bounds: a switching loop with no spanning tree
// loops frames forever. Past either cap we declare a storm and stop. (Both are
// far above any legitimate single run; the headless path caps via MAX_STEPS.)
const STORM_STEP_CAP = 200;
const STORM_TRANSIT_CAP = 250;

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

function animationTick(now: number): void {
  const sim = state.simulation;

  // Update transit progress (per-link latency stretches a dot's crossing time).
  // Silent frames jump straight to delivered — no visible crossing.
  for (const t of sim.transits) {
    t.progress = t.silent ? 1 : Math.min(1, (now - t.startTime) / (sim.speed * (t.latencyFactor ?? 1)));
  }

  sync().render();

  // Check if all transits completed
  if (sim.transits.length > 0 && sim.transits.every(t => t.progress >= 1)) {
    deliverCompletedTransits();
    if (sim.status === "running" && sim.autoPlay) {
      processNextStep();
    }
  } else if (sim.transits.length === 0 && sim.events.length > 0 && sim.status === "running" && sim.autoPlay) {
    // No transits in flight but events queued (from a step that produced no outgoing)
    processNextStep();
  }

  // Keep looping if simulation is active
  if (sim.status === "running" || sim.status === "paused" || sim.transits.length > 0) {
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

  // Broadcast-storm guard for the animated path (the headless path caps via
  // MAX_STEPS). A switching loop with no spanning tree multiplies frames without
  // bound — frames keep looping every step and never drain. Past the cap, call
  // it: stop and surface a storm rather than animating forever.
  if (!sim.headless && (sim.stepIndex > STORM_STEP_CAP || sim.transits.length > STORM_TRANSIT_CAP)) {
    sim.stormDetected = true;
    finishSimulation();
    return;
  }

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

  const outgoing = PROCESSORS[device.type]?.(device, event.frame, event.fromDeviceId) ?? [];

  // Create transits for outgoing frames
  const now = performance.now();
  for (const out of outgoing) {
    const link = findLinkBetween(event.deviceId, out.toDeviceId);
    if (!link) continue;
    if (link.shutdown) {
      // Administratively down — the cable's there but it carries no traffic.
      logStep(device, "sim-drop", `${linkName(link)} is administratively down — frame dropped`);
      continue;
    }
    // A link that hasn't authenticated (a wrong-password WiFi association, or an
    // 802.1X port still unauthorized), or a spanning-tree alternate port, passes
    // only control frames (dot11 / dot1x / BPDU) — never data. BPDUs in
    // particular must cross a blocked port so the tree stays converged.
    if (!admitOnLink(device, link, out.frame)) continue;
    sim.transits.push({
      frame: out.frame,
      linkId: link.id,
      fromDeviceId: event.deviceId,
      toDeviceId: out.toDeviceId,
      progress: 0,
      startTime: now,
      latencyFactor: linkLatencyFactor(link),
      silent: isSilentFrame(out.frame)
    });
  }

  // Headless runs never touch the DOM — skip per-step rendering (faster, and it
  // keeps probes like traceroute from flashing the canvas / sim-log panel).
  if (!sim.headless) {
    syncSimLog();
    sync().render();
  }

  settleStep();
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
      case "probe-req": logStep(device, "sim-wifi", `Probe Request for "${ssid}" — sending Probe Response`); return next("probe-resp");
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
    if (link.hidden || link.shutdown) continue;
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
    if (link.hidden || link.shutdown || link.wireless) continue;
    const host = getDevice(link.from === sw.id ? link.to : link.from);
    if (host && host.config?.macAddress === mac) return { host, link };
  }
  return null;
}

// Fallback: the supplicant host on one of this switch's ports presenting a given identity.
function supplicantByIdentity(sw: Device, identity: string): { host: Device; link: any } | null {
  for (const link of linksFor(sw.id)) {
    if (link.hidden || link.shutdown || link.wireless) continue;
    const host = getDevice(link.from === sw.id ? link.to : link.from);
    if (host && (host.type === "computer" || host.type === "laptop" || host.type === "kali" || host.type === "server") && host.config?.dot1x?.identity === identity) {
      return { host, link };
    }
  }
  return null;
}

// The reactive 802.1X exchange, routed by frame subtype across all three roles —
// supplicant (host), authenticator (switch), and RADIUS server. EAPOL/EAP runs
// host↔switch; RADIUS runs switch↔server. An `auto` port stays unauthorized
// (link.dot1xAuthorized) until EAP-Success.
function handleDot1x(device: Device, frame: EthernetFrame, fromDeviceId: string | null): OutgoingFrame[] {
  const p = frame.payload as Dot1xPayload;
  const identity = p.identity || "";
  const back = (subtype: Dot1xPayload["subtype"], id?: string) =>
    fromDeviceId ? [{ frame: createDot1xFrame(frame.dstMac, frame.srcMac, subtype, id), toDeviceId: fromDeviceId }] : [];

  switch (p.subtype) {
    case "eapol-start": // authenticator: kick off identity request
      logStep(device, "sim-dot1x", `EAPOL-Start — requesting the supplicant's identity`);
      return back("eap-req-id");
    case "eap-req-id": { // supplicant: answer with its identity
      const id = device.config?.dot1x?.identity || "";
      logStep(device, "sim-dot1x", `EAP Identity request — responding "${id}"`);
      return back("eap-resp-id", id);
    }
    case "eap-resp-id": { // authenticator: relay to RADIUS
      const server = radiusServerFor(device);
      if (!server) { logStep(device, "sim-drop", `802.1X: no RADIUS server reachable — cannot authenticate`); return []; }
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
      logStep(device, "sim-drop", `Access-Reject — ${sup.host.name} stays unauthorized`);
      return [{ frame: createDot1xFrame(PAE_GROUP_MAC, sup.host.config?.macAddress || "", "eap-failure", identity), toDeviceId: sup.host.id }];
    }
    case "eap-success": // supplicant: authenticated
      state.simulation.dot1xAuthorized = true;
      logStep(device, "sim-dot1x", `EAP-Success — the port is authorised, traffic may pass`);
      return [];
    case "eap-failure": // supplicant: rejected
      logStep(device, "sim-drop", `EAP-Failure — 802.1X authentication denied (check the identity/password)`);
      return [];
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
        if (device.id === sim.originDeviceId) {
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
        learnArp(config, ipv4.srcIp, frame.srcMac);
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
      learnArp(config, ipv4.srcIp, frame.srcMac);
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
    const allocatedIp = allocateServerDhcpIp(device);
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
function allocateServerDhcpIp(device: Device): string | null {
  const config = device.config;
  const start = ipv4ToInt(config.dhcpRangeStart!);
  const end = ipv4ToInt(config.dhcpRangeEnd!);
  if (end < start) return null;
  const used = new Set<string>();
  if (config.ipv4Address) used.add(config.ipv4Address);
  for (const lease of normaliseDhcpLeases(config.dhcpLeases || [])) used.add(lease.ipv4Address);
  for (const d of state.devices) {
    if (d.hidden) continue;
    const ip = d.config?.ipv4Address;
    if (ip && isValidIpv4(ip)) used.add(ip);
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

  if (isBroadcast) {
    // Flood to all ports except ingress (same VLAN if managed)
    forwardPorts = ports
      .map((_, idx) => idx)
      .filter(idx => idx !== ingressIdx)
      .filter(idx => ingressVlan == null || portCarriesVlan(`Ethernet${idx + 1}`, ingressVlan));
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

    if (entry) {
      // Known unicast
      const portIdx = ports.findIndex((_, idx) => `Ethernet${idx + 1}` === entry.port);
      if (portIdx >= 0 && portIdx !== ingressIdx) {
        forwardPorts = [portIdx];
        logStep(device, "sim-forward", `Forward ${frameLabel(frame)} → ${entry.port} (known unicast)`);
      } else {
        logStep(device, "sim-drop", `Drop ${frameLabel(frame)} — dest port is ingress`);
      }
    } else {
      // Unknown unicast — flood
      forwardPorts = ports
        .map((_, idx) => idx)
        .filter(idx => idx !== ingressIdx)
        .filter(idx => ingressVlan == null || portCarriesVlan(`Ethernet${idx + 1}`, ingressVlan));
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

// The internet cloud is NOT an L2 bridge — it represents the public internet and
// routes IPv4 between the routers cabled to it, each on its own public subnet.
// It presents a gateway address per link (answering ARP for it, so a connected
// router can default-route to it) and forwards each packet to the router whose
// public (WAN) subnet owns the destination. It does not bridge, MAC-learn, or
// flood. Unroutable destinations are dropped (no router on the internet owns
// them). One L3 hop: TTL is decremented, and an expired packet earns an ICMP
// Time-Exceeded from the gateway the cloud presents to the sender — so
// traceroute sees the cloud as a single hop standing in for the many real ones.
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
      // Sub-interfaces: match by vlanTag
      ingressIface = peerIfaces.find((iface: any) =>
        frame.vlanTag != null ? iface.vlanTag === frame.vlanTag : iface.vlanTag == null
      );
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

    // Handle broadcast DHCP messages before any routing
    if (ipv4.dstIp === "255.255.255.255" && ipv4.payload.type === "dhcp") {
      return handleRouterDhcp(device, ingressIface, fromDeviceId!, ipv4.payload as DhcpPayload, ipv4);
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
    logStep(device, "sim-arp", `Received ARP Request for ${arp.targetIp} on ${ifaceName(ingressIface)} — sending Reply`);
    const reply = createArpReply(
      ingressIface.macAddress, ingressIface.ipv4Address,
      arp.senderMac, arp.senderIp, ingressIface.vlanTag ?? null
    );
    outgoing.push({ frame: reply, toDeviceId: fromDeviceId });
  } else if (arp.operation === "reply") {
    learnRouterArp(ingressIface, arp.senderIp, arp.senderMac);
    logStep(device, "sim-arp", `Received ARP Reply on ${ifaceName(ingressIface)}: ${arp.senderIp} is-at ${arp.senderMac}`);

    // Check for buffered frames
    const pendingKey = `${device.id}:${arp.senderIp}`;
    const pending = sim.pendingArp[pendingKey];
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
          pf.srcMac = route.egressIface.macAddress;
          pf.dstMac = arp.senderMac;
          pf.vlanTag = route.egressIface.vlanTag ?? null;
          logStep(device, "sim-forward", `Forward deferred ${frameLabel(pf)} to ${ipv4.dstIp} via ${ifaceName(route.egressIface)} (TTL ${ipv4.ttl}→${ipv4.ttl - 1})`);
          ipv4.ttl--;
          outgoing.push({ frame: pf, toDeviceId: route.egressIface.peerId });
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
    const allocatedIp = allocateDhcpIp(ingressIface, device);
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
function admitOnLink(device: Device, link: Link, frame: EthernetFrame): boolean {
  const sim = state.simulation;
  const ptype = frame.payload.type;
  const ctrl = ptype === "dot11" || ptype === "dot1x" || ptype === "bpdu";
  if (!ctrl && !linkAuthorizedForData(link)) {
    const reason = link.stpBlocked ? "is spanning-tree blocked" : "is not authenticated";
    logStep(device, "sim-drop", `${linkName(link)} ${reason} — frame dropped`);
    return false;
  }
  if (!sim.headless && Number(link.loss) > 0 && Math.random() * 100 < Number(link.loss)) {
    logStep(device, "sim-drop", `${linkName(link)} dropped ${frameLabel(frame)} (${link.loss}% loss)`);
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
    return { ...ipv4, srcIp: outsideIp, payload: { ...icmp, sequence: entry.outsidePort } };
  }
  if (ipv4.payload.type === "tcp") {
    const tcp = ipv4.payload;
    let entry = translations.find(t => t.protocol === "tcp" && t.insideIp === ipv4.srcIp && t.insidePort === tcp.srcPort && t.destIp === ipv4.dstIp);
    if (!entry) {
      entry = { protocol: "tcp", insideIp: ipv4.srcIp, insidePort: tcp.srcPort, outsideIp, outsidePort: allocNatId(translations), destIp: ipv4.dstIp };
      translations.push(entry);
    }
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
    if (entry) return { ...ipv4, dstIp: entry.insideIp, payload: { ...icmp, sequence: entry.insidePort } };
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
      // Rewrite the embedded original too (real NAT does), so the inside host
      // sees its own address/flow id quoted back.
      return { ...ipv4, dstIp: entry.insideIp, payload: { ...icmp, original: { ...o, srcIp: entry.insideIp, flowId: entry.insidePort } } };
    }
  }
  if (ipv4.payload.type === "tcp") {
    const tcp = ipv4.payload;
    const entry = translations.find(t => t.protocol === "tcp" && t.outsidePort === tcp.dstPort && t.destIp === ipv4.srcIp);
    if (entry) return { ...ipv4, dstIp: entry.insideIp, payload: { ...tcp, dstPort: entry.insidePort } };
  }
  if (ipv4.payload.type === "dns" && ipv4.payload.op === "response") {
    const dns = ipv4.payload;
    const entry = translations.find(t => t.protocol === "udp" && t.outsidePort === dns.id && t.destIp === ipv4.srcIp);
    if (entry) return { ...ipv4, dstIp: entry.insideIp, payload: { ...dns, id: entry.insidePort } };
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
    if (ipv4.payload.type === "icmp" && ipv4.payload.icmpType === 8) {
      logStep(device, "sim-icmp", `Received ICMP Echo Request for self (${ipv4.dstIp}) — sending Reply`);
      const reply = createIcmpEchoReply(
        ingressIface.macAddress, frame.srcMac,
        ipv4.dstIp, ipv4.srcIp,
        64, ingressIface.vlanTag ?? null, ipv4.payload.sequence
      );
      outgoing.push({ frame: reply, toDeviceId: fromDeviceId });
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
      logStep(device, "sim-nat", `NAT ${ipv4.srcIp} → ${translated.srcIp} (PAT via ${ifaceName(egressIface)})`);
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
    logStep(device, "sim-forward", `Route ${ipv4.srcIp}→${ipv4.dstIp} via ${ifaceName(egressIface)}${viaStr} (TTL ${ipv4.ttl}→${ipv4.ttl - 1})`);
    outgoing.push({ frame: rewrittenFrame, toDeviceId: egressIface.peerId });
  } else {
    // Need ARP for next-hop — buffer the (already-translated) frame and ARP
    const pendingKey = `${device.id}:${nextHopIp}`;
    if (!sim.pendingArp[pendingKey]) sim.pendingArp[pendingKey] = [];
    sim.pendingArp[pendingKey].push({ ...frame, id: frame.id + "-buffered" });
    logStep(device, "sim-arp", `ARP miss for ${nextHopIp} on ${ifaceName(egressIface)} — buffering frame, sending ARP Request`);

    const arpReq = createArpRequest(egressIface.macAddress, egressIface.ipv4Address, nextHopIp, egressVlanTag);
    outgoing.push({ frame: arpReq, toDeviceId: egressIface.peerId });
  }

  return outgoing;
}

// ─── Firewall (transparent inline packet filter) ─────────────────────────────

function icmpTypeName(t: number): string {
  return t === 8 ? "echo-request" : t === 0 ? "echo-reply" : t === 11 ? "time-exceeded" : `type-${t}`;
}

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
    if (icmpTypeName(ipv4.payload.icmpType) !== rule.icmpType) return false;
  }
  if (rule.src && !addressMatches(srcAddr, rule.src)) return false;
  if (rule.dst && !addressMatches(dstAddr, rule.dst)) return false;
  // -m state --state / -m conntrack --ctstate: the frame's connection state must
  // be one the rule lists. ("related"/"invalid" never match — never assigned.)
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

  // Transparent bridge: forward to every linked port except the ingress one.
  // (linkedPortsFor can be sparse — null gaps — when explicit ports skip a slot.)
  const egress = linkedPortsFor(device.id)
    .filter((p: any) => p?.peer)
    .map((p: any) => p.peer.id)
    .filter((id: string) => id !== fromDeviceId);

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
  egress.forEach((toDeviceId: string, i: number) => {
    outgoing.push({ frame: { ...frame, id: `${frame.id}-fw${i}` }, toDeviceId });
  });
  return outgoing;
}

function generateApipaAddress(): string {
  // Seeded (not Math.random) — an APIPA address is config-visible, so a pinned
  // seed reproduces the same link-local fallback.
  return `169.254.${simRandomInt(1, 255)}.${simRandomInt(1, 255)}`;
}

// Self-assign a link-local 169.254.0.0/16 address (no DHCP, no gateway). Used
// both as the DHCP-failure fallback and as the direct boot path when auto-DHCP
// is off but APIPA is on. Returns the assigned address.
function assignApipa(device: Device): string {
  const apipaIp = generateApipaAddress();
  if (device.config) {
    device.config.ipv4Address = apipaIp;
    device.config.ipSource = "apipa";
    device.config.prefixLength = 16;
    device.config.gatewayIpv4Address = "";
  }
  return apipaIp;
}

export function allocateDhcpIp(iface: any, router: Device): string | null {
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
  // Existing DHCP leases on this interface
  for (const lease of normaliseDhcpLeases(iface.dhcpLeases || [])) {
    usedIps.add(lease.ipv4Address);
  }
  // Static IPs of all devices in this subnet
  for (const d of state.devices) {
    if (d.hidden) continue;
    const ip = d.config?.ipv4Address;
    if (ip && isValidIpv4(ip) && sameSubnet(ip, iface.ipv4Address, ifPrefix)) {
      usedIps.add(ip);
    }
  }

  usedIps.add(iface.ipv4Address);
  const scan = (from: number, to: number): string | null => {
    for (let v = from; v <= to; v++) { const c = intToIpv4(v); if (!usedIps.has(c)) return c; }
    return null;
  };
  // Prefer the conventional upper pool; fall back to the low addresses before
  // reporting exhaustion (the offer is refused only when nothing usable is left).
  return scan(start, last) ?? (start > first ? scan(first, start - 1) : null);
}

function ifaceName(iface: any): string {
  return iface.name || iface.peerId || "unknown";
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

// The sim-log pane: a Wireshark-style packet list (default) or the narrative
// event log, switched by the Packets/Events toggle (state.dock.logView). The
// packet list honours the display filter (state.dock.logFilter; packet-filter.ts).
let presentTokenCache: Set<string> = new Set();
// Device ids that appear as a wire endpoint across the currently displayed
// pane(s) — drives the device-filter dropdown (set in syncSimLog).
let presentDeviceIds: Set<string> = new Set();

const CAPTURE_HISTORY_CAP = 12;

// One capture's worth of rows to show: the live run, or a saved run.
interface CapturePane { id: string; label: string; entries: CaptureEntry[]; }

// The capture entries for a pane id ("live" = the running/most-recent run, else
// a saved capture). Used by the renderer and the ui.ts row-click resolver.
export function captureEntriesFor(capId: string): CaptureEntry[] {
  if (capId === "live") return state.simulation.capture;
  return state.savedCaptures.find(c => c.id === capId)?.entries || [];
}

function paneFor(view: string): CapturePane {
  if (view && view !== "live") {
    const saved = state.savedCaptures.find(c => c.id === view);
    if (saved) return { id: saved.id, label: saved.label, entries: saved.entries };
  }
  return { id: "live", label: "Live capture", entries: state.simulation.capture };
}

// Repair a captureView that points nowhere before the panes are computed, so a
// single render is self-consistent (the capture bar would otherwise heal it only
// afterwards). Idle only — a running view is always "live".
function healCaptureView(): void {
  const sim = state.simulation;
  if (sim.status === "running" || sim.status === "paused") return;
  const saved = state.savedCaptures;
  const view = state.dock.captureView;
  if (view !== "live" && !saved.some(c => c.id === view)) {
    state.dock.captureView = saved.length ? saved[saved.length - 1].id : "live";
  } else if (view === "live" && saved.length && sim.capture.length === 0) {
    // A 0-frame finished run left the view on an empty live capture — show the
    // most recent saved run instead of "No packets".
    state.dock.captureView = saved[saved.length - 1].id;
  }
}

// The capture(s) the packet list renders: the live run while one is active,
// otherwise the selected saved run — with a baseline pane prepended in compare
// mode (before | after, left to right).
function displayedPanes(): CapturePane[] {
  const sim = state.simulation;
  if (sim.status === "running" || sim.status === "paused") {
    return [{ id: "live", label: "Live capture", entries: sim.capture }];
  }
  const main = paneFor(state.dock.captureView);
  if (state.dock.compareBaseId) {
    const base = state.savedCaptures.find(c => c.id === state.dock.compareBaseId);
    if (base && base.id !== main.id) return [{ id: base.id, label: base.label, entries: base.entries }, main];
  }
  return [main];
}

export function syncSimLog(): void {
  if (!state.dock.logFilter) state.dock.logFilter = { protocols: [], device: "", expr: "" };
  syncSimLogBadge();
  for (const btn of document.querySelectorAll<HTMLElement>("[data-logview]")) {
    btn.classList.toggle("active", btn.dataset.logview === state.dock.logView);
  }
  const packets = state.dock.logView === "packets";
  let html: string;
  let stats = { shown: 0, total: 0, error: null as string | null };
  if (packets) {
    healCaptureView();
    const panes = displayedPanes();
    const totalEntries = panes.reduce((n, p) => n + p.entries.length, 0);
    if (totalEntries === 0) {
      presentTokenCache = new Set();
      presentDeviceIds = new Set();
      html = `<p class="sim-log-line sim-learn">No packets captured — run a simulation (headless checks don't capture). The Events view holds imported logs.</p>`;
    } else {
      // Present-tokens + the device dropdown span every displayed pane. Rows
      // are built once per pane and reused below (this ran per sync, per step).
      const paneRows = panes.map(p => buildFilterRows(p.entries));
      const unionRows = paneRows.flat();
      presentTokenCache = presentTokens(unionRows);
      presentDeviceIds = new Set(unionRows.flatMap(r => [r.fromId, r.toId]));
      let firstError: string | null = null;
      const cols = panes.map((p, i) => {
        const rows = paneRows[i];
        const result = applyLogFilter(rows, state.dock.logFilter);
        stats.shown += result.rows.length;
        stats.total += rows.length;
        if (result.error && !firstError) firstError = result.error;
        const table = result.rows.length
          ? renderPacketTable(result.rows, p.id)
          : `<p class="sim-log-line sim-learn">No packets match the filter. <button type="button" class="sim-log-clear" data-action="clear-log-filter">Clear filter</button></p>`;
        return panes.length > 1
          ? `<div class="pkt-pane"><div class="pkt-pane-title">${escapeHtml(p.label)}</div><div class="pkt-pane-body">${table}</div></div>`
          : table;
      });
      stats.error = firstError;
      html = panes.length > 1 ? `<div class="pkt-compare">${cols.join("")}</div>` : cols[0];
    }
  } else {
    html = renderEventLog();
  }
  syncSimLogCaptureBar(packets);
  syncSimLogFilterBar(packets, stats);
  dom.simLogOutput.innerHTML = html;
  dom.simLogOutput.scrollTop = dom.simLogOutput.scrollHeight;
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

function renderEventLog(): string {
  const sim = state.simulation;
  // Imported logs render too (status idle but entries present).
  if (sim.log.length === 0) {
    return `<p class="sim-log-line sim-learn">No simulation running — start a ping, connect, or DHCP run to capture frames.</p>`;
  }
  return sim.log.map(entry =>
    `<p class="sim-log-line ${escapeHtml(entry.kind || "")}">${escapeHtml(entry.summary)}</p>`
  ).join("");
}

// Enrich each capture entry with its wire endpoints for the filter predicate.
function buildFilterRows(entries: CaptureEntry[]): FilterRow[] {
  return entries.map(entry => ({
    frame: entry.frame,
    macsec: !!entry.macsec,
    no: entry.no,
    step: entry.step,
    fromId: entry.fromDeviceId,
    toId: entry.toDeviceId,
    fromName: getDevice(entry.fromDeviceId)?.name ?? "?",
    toName: getDevice(entry.toDeviceId)?.name ?? "?",
    linkId: entry.linkId,
  }));
}

// One row per (filtered) captured frame; clicking a row opens the frame
// breakdown (wired in ui.ts by data-no + data-cap, which names the capture the
// row belongs to). The selected frame's row is highlighted — reference equality
// works because capture entries hold the same frame objects the transits use.
function renderPacketTable(rows: FilterRow[], capId: string): string {
  const linkMap = new Map(state.links.map(l => [l.id, l]));
  // Capture numbers restart at 1 per run, so a selected row is only highlighted
  // in the pane its entry actually belongs to (identity check) — matters in
  // compare mode where both panes share the 1..N range.
  const selectedEntry = state.inspectedCapture;
  const selectInPane = !!selectedEntry && captureEntriesFor(capId).includes(selectedEntry);
  const body = rows.map(row => {
    const inner = packetColumns(row.frame);
    // A MACsec-protected frame shows as encrypted on the wire (its real protocol
    // would only be visible after decryption at the far end).
    const cols = row.macsec
      ? { ...inner, protocol: "MACsec", info: `Encrypted ${inner.protocol} (SecTAG, ICV)`, tone: "macsec" }
      : inner;
    // The wire it was captured on: the link's name (user-given, or the
    // endpoint combo). Falls back to the traversal endpoints if the link is gone.
    const link = linkMap.get(row.linkId);
    const wire = link ? linkName(link) : `${row.fromName} ↔ ${row.toName}`;
    // Highlight the specific selected row (by capture no within its pane),
    // falling back to frame reference for a canvas-dot pick (no row of its own).
    const selected = (selectedEntry
      ? (selectInPane && selectedEntry.no === row.no)
      : state.inspectedFrame === row.frame) ? " selected" : "";
    return `<tr class="pkt-row pkt-${escapeHtml(cols.tone)}${selected}" data-no="${row.no}" data-cap="${escapeHtml(capId)}">
      <td class="pkt-num">${row.no}</td>
      <td class="pkt-num">${row.step}</td>
      <td>${escapeHtml(cols.src)}</td>
      <td>${escapeHtml(cols.dst)}</td>
      <td><span class="pkt-glyph" aria-hidden="true">${escapeHtml(toneGlyph(cols.tone))}</span>${escapeHtml(cols.protocol)}</td>
      <td class="pkt-info">${escapeHtml(cols.info)}</td>
      <td class="pkt-link">${escapeHtml(wire)}</td>
    </tr>`;
  }).join("");
  return `<table class="pkt-table">
    <thead><tr><th>No.</th><th>Step</th><th>Source</th><th>Destination</th><th>Protocol</th><th>Info</th><th>Link</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

// Sync the capture-history controls (which saved run to view + the compare
// toggle / baseline select). Shown only when the sim is idle and ≥1 run has been
// archived — while a run animates, the live capture is always what's displayed.
function syncSimLogCaptureBar(packets: boolean): void {
  const bar = dom.simLogCaptureBar;
  if (!bar) return;
  const sim = state.simulation;
  const running = sim.status === "running" || sim.status === "paused";
  const saved = state.savedCaptures;
  const show = packets && !running && saved.length > 0;
  bar.hidden = !show;
  if (!show) return;

  const sel = dom.simLogCaptureSelect as HTMLSelectElement;
  if (!saved.some(c => c.id === state.dock.captureView)) state.dock.captureView = saved[saved.length - 1].id;
  // A baseline can't compare against the primary view itself — drop a collision
  // so the toggle/render state stays consistent.
  if (state.dock.compareBaseId === state.dock.captureView) state.dock.compareBaseId = "";
  if (document.activeElement !== sel) {
    sel.innerHTML = saved.slice().reverse().map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`).join("");
    sel.value = state.dock.captureView;
  }

  const compareOn = !!state.dock.compareBaseId;
  const toggle = dom.simLogCompareToggle as HTMLButtonElement;
  toggle.classList.toggle("active", compareOn);
  toggle.disabled = saved.length < 2;

  const base = dom.simLogCompareSelect as HTMLSelectElement;
  base.hidden = !compareOn;
  if (compareOn && document.activeElement !== base) {
    const others = saved.filter(c => c.id !== state.dock.captureView).slice().reverse();
    if (!others.some(c => c.id === state.dock.compareBaseId)) state.dock.compareBaseId = others[0]?.id || "";
    base.innerHTML = others.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`).join("");
    base.value = state.dock.compareBaseId;
  }
}

// Sync the packet-list filter toolbar (protocol chips, device select, the
// display-filter input, the count/error status) to state.dock.logFilter. The
// chips are rendered once then class-toggled; the device select is rebuilt from
// the devices present in the capture. Hidden entirely in the Events view.
function syncSimLogFilterBar(packets: boolean, stats: { shown: number; total: number; error: string | null }): void {
  const bar = dom.simLogFilterBar;
  if (!bar) return;
  bar.hidden = !packets;
  if (!packets) return;
  const filter = state.dock.logFilter;

  const chipBox = dom.simLogChips as HTMLElement;
  if (chipBox && (chipBox.children?.length ?? 0) === 0) {
    chipBox.innerHTML = PROTOCOL_CHIPS.map(c =>
      `<button class="simlog-chip" data-proto="${c.token}" type="button">${escapeHtml(c.label)}</button>`).join("");
  }
  for (const chip of chipBox.querySelectorAll<HTMLElement>("[data-proto]")) {
    const tok = chip.dataset.proto || "";
    chip.classList.toggle("active", filter.protocols.includes(tok));
    chip.classList.toggle("empty", !presentTokenCache.has(tok));
  }

  // The expression input — don't clobber the cursor while the user types.
  const input = dom.simLogFilterInput as HTMLInputElement;
  if (document.activeElement !== input) input.value = filter.expr;
  input.classList.toggle("invalid", !!stats.error);
  input.title = stats.error ? `Filter error: ${stats.error}` : "Display filter — e.g. dns || icmp && !arp";

  populateDeviceFilter(filter);

  // The link filter is set by the link inspector's "open in packet log" jump —
  // surfaced as a dismissible pill (there's no always-present link <select>).
  const linkPill = dom.simLogLinkFilter as HTMLButtonElement;
  if (linkPill) {
    const filteredLink = filter.link ? linkById(filter.link) : null;
    if (filter.link && !filteredLink) filter.link = "";   // drop a deleted link
    if (filteredLink) {
      linkPill.hidden = false;
      linkPill.textContent = `Link: ${linkName(filteredLink)} ✕`;
    } else {
      linkPill.hidden = true;
    }
  }

  const status = dom.simLogFilterStatus as HTMLElement;
  if (status) {
    status.textContent = stats.error
      ? stats.error
      : isFilterActive(filter)
        ? `Showing ${stats.shown} of ${stats.total}`
        : (stats.total ? `${stats.total} packet${stats.total === 1 ? "" : "s"}` : "");
    status.classList.toggle("error", !!stats.error);
  }
  (dom.simLogFilterClear as HTMLButtonElement).disabled = !isFilterActive(filter);
}

// Rebuild the device <select> from the devices present across the displayed
// pane(s) (`presentDeviceIds`, so it matches the chips and the compare view).
// The option set rarely changes between animation steps, so it's only re-rendered
// when a signature of (options + extra) differs — avoiding a per-step innerHTML
// churn that could disturb an open dropdown.
let deviceFilterSig = "";

function populateDeviceFilter(filter: LogFilter): void {
  const sel = dom.simLogDeviceFilter as HTMLSelectElement;
  if (!sel) return;
  // Drop a deleted device's id regardless of focus, so the stored filter never
  // points at a device that no longer exists.
  if (filter.device && !getDevice(filter.device)) filter.device = "";
  if (document.activeElement === sel) return; // don't disturb an open dropdown
  const devices = state.devices.filter(d => presentDeviceIds.has(d.id)).sort((a, b) => a.name.localeCompare(b.name));
  // A selected device that carried no frames this run is kept visible as an extra option.
  const extra = filter.device && !devices.some(d => d.id === filter.device) ? getDevice(filter.device) : null;
  const sig = devices.map(d => d.id + "" + d.name).join("") + "" + (extra ? extra.id + "" + extra.name : "");
  if (sig !== deviceFilterSig) {
    const opts = [`<option value="">All devices</option>`];
    for (const d of devices) opts.push(`<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`);
    if (extra) opts.push(`<option value="${escapeHtml(extra.id)}">${escapeHtml(extra.name)}</option>`);
    sel.innerHTML = opts.join("");
    deviceFilterSig = sig;
  }
  sel.value = filter.device;
}

function findLinkBetween(a: string, b: string): any | null {
  // Use the by-endpoint adjacency index instead of scanning every link.
  return linksFor(a).find(link =>
    !link.hidden && ((link.from === a && link.to === b) || (link.from === b && link.to === a))
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

function finishSimulation(): void {
  const sim = state.simulation;

  // Results land in the session of the device that started the run — the
  // user may have switched tabs while the simulation animated.
  const originSession = sessionFor(sim.originDeviceId);
  const out = (kind: string, text: string) =>
    originSession ? terminalLineFor(originSession, kind, text) : terminalLine(kind, text);

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
    const lines: string[] = [];
    if (open.length) { lines.push("PORT      STATE  SERVICE"); for (const p of open) lines.push(`${String(p + "/tcp").padEnd(10)}open   ${SERVICE_NAMES[p] || "unknown"}`); }
    if (sim.sweepLive.length) lines.push(`Hosts up: ${sim.sweepLive.length} (${[...sim.sweepLive].sort().join(", ")})`);
    if (!lines.length) lines.push("No open ports or live hosts found (target unreachable, filtered, or no attack target set).");
    const origin = getDevice(sim.originDeviceId);
    if (origin?.config) (origin.config as any).attackLog = lines;
    if (!sim.headless) out("", lines.join("\n"));
  } else if (sim.mode === "dhcp") {
    if (sim.dhcpSuccess) {
      if (!sim.headless) out("", `DHCP configured:\n  IP address: ${sim.dhcpAssignedIp}\n  Default gateway: ${sim.dhcpAssignedGateway}`);
    } else if (state.options.apipaFallback) {
      // APIPA fallback — link-local 169.254.0.0/16
      const origin = getDevice(sim.originDeviceId);
      const apipaIp = origin ? assignApipa(origin) : generateApipaAddress();
      sim.dhcpAssignedIp = apipaIp;
      if (!sim.headless) out("error", `DHCP: no response from server.\nAPIPA: assigned link-local ${apipaIp}`);
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
        out("", `PING ${name}\n\n--- ${name} ping statistics ---\n1 packets transmitted, 0 received, 100% packet loss`);
      }
    }
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
  // Re-enable terminal input
  const termInput = document.getElementById("terminalInput") as HTMLInputElement | null;
  if (termInput) termInput.disabled = false;
  syncSimLog();
  syncTerminal();
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
