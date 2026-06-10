import type { EthernetFrame, ArpPayload, Ipv4Payload, DhcpPayload, TcpPayload, SimEvent, SimLogEntry, ActiveTransit, FrameHistoryEntry, RouteEntry, Device, DeviceType, FirewallRule, FirewallTarget } from "./types";
import { state, pushUndo, sync } from "./state";
import { dom } from "./dom";
import { getDevice, linkedPortsFor, routerInterfacesWithNames } from "./devices";
import { normalisePortVlans, normalisePortModes, normaliseTrunkAllowedVlans, normaliseArpTable, normaliseMacTable, normaliseDhcpLeases, normaliseStaticRoutes } from "./normalise";
import { sameSubnet, prefixOf, isValidIpv4, escapeHtml, ipv4ToInt, normaliseMacAddress } from "./utils";
import { createArpRequest, createArpReply, createIcmpEchoRequest, createIcmpEchoReply, createIcmpTimeExceeded, createDhcpOffer, createDhcpRequest, createDhcpAck, createTcpSegment, BROADCAST_MAC, frameLabel } from "./frame";
import { terminalLine, syncTerminal } from "./terminal";
import { buildPingEvents, findPingTarget } from "./simulation";
import type { PingSetup } from "./simulation";
import { routingLookup, runRipConvergence } from "./routing";

// Re-exported so existing imports (terminal, tests, benchmarks) keep working.
export { buildRoutingTable, routingLookup, runRipConvergence } from "./routing";

// ─── Public API ──────────────────────────────────────────────────────────────

export function startSimulation(setup: PingSetup, originDeviceId: string, targetIp: string, mode: "ping" | "dhcp" | "tcp" = "ping", targetPort: number | null = null): void {
  // Run RIP convergence before simulation to populate learned routes
  runRipConvergence();
  pushUndo();
  const sim = state.simulation;
  sim.status = "running";
  sim.mode = mode;
  sim.headless = false;
  sim.events = setup.events;
  sim.log = [];
  sim.transits = [];
  sim.pendingArp = { ...setup.pendingArp };
  sim.stepIndex = 0;
  sim.originDeviceId = originDeviceId;
  sim.pingTargetIp = targetIp;
  sim.pingSuccess = false;
  sim.pingTtl = 64;
  sim.pingResponderIp = null;
  sim.pingTimeExceeded = false;
  sim.tcpSuccess = false;
  sim.tcpRefused = false;
  sim.tcpTargetPort = targetPort;
  sim.dhcpSuccess = false;
  sim.dhcpAssignedIp = null;
  sim.dhcpAssignedGateway = null;
  const label = mode === "dhcp" ? "Requesting DHCP lease..."
    : mode === "tcp" ? `Opening TCP connection to ${targetIp}:${targetPort ?? "?"}...`
    : `Simulating ping to ${targetIp}...`;
  state.terminal.lines.push({ kind: "sim", text: label });
  syncTerminal();
  syncSimLog();
  startAnimationLoop();
  if (sim.autoPlay) processNextStep();
}

export function stopSimulation(): void {
  const sim = state.simulation;
  if (sim.status === "idle") return;
  sim.status = "idle";
  sim.events = [];
  sim.log = [];
  sim.transits = [];
  sim.pendingArp = {};
  stopAnimationLoop();
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
  assignedIp?: string | null;
  assignedGateway?: string | null;
  log: SimLogEntry[];
  steps: number;
}

// Runs a simulation to completion synchronously — no animation / requestAnimationFrame —
// and returns the result plus the hop-by-hop log. Reuses the same process handlers as
// the animated path; powers the console `run` command, window.routesim, and tests.
export function runSimulationHeadless(
  setup: PingSetup, originDeviceId: string, targetIp: string, mode: "ping" | "dhcp" | "tcp" = "ping", targetPort: number | null = null
): SimResult {
  runRipConvergence();
  const sim = state.simulation;
  sim.status = "running";
  sim.mode = mode;
  sim.headless = true;
  sim.events = setup.events;
  sim.log = [];
  sim.transits = [];
  sim.pendingArp = { ...setup.pendingArp };
  sim.stepIndex = 0;
  sim.originDeviceId = originDeviceId;
  sim.pingTargetIp = targetIp;
  sim.pingSuccess = false;
  sim.pingTtl = 64;
  sim.pingResponderIp = null;
  sim.pingTimeExceeded = false;
  sim.tcpSuccess = false;
  sim.tcpRefused = false;
  sim.tcpTargetPort = targetPort;
  sim.dhcpSuccess = false;
  sim.dhcpAssignedIp = null;
  sim.dhcpAssignedGateway = null;

  // Drain the event queue, completing each batch of transits instantly. processNextStep
  // recurses internally while status === "running" and events have no transits, and calls
  // finishSimulation() once fully drained. The guard caps pathological loops (routing loops).
  const MAX_STEPS = 10000;
  let guard = 0;
  processNextStep();
  while (sim.transits.length > 0 && sim.status === "running" && guard++ < MAX_STEPS) {
    for (const t of sim.transits) t.progress = 1;
    deliverCompletedTransits();
    processNextStep();
  }
  // `sim.status` is mutated inside processNextStep/finishSimulation; the cast
  // stops TS from over-narrowing it to the literal assigned above.
  if ((sim.status as string) !== "done") finishSimulation();

  return {
    success: mode === "dhcp" ? sim.dhcpSuccess : mode === "tcp" ? sim.tcpSuccess : sim.pingSuccess,
    refused: sim.tcpRefused,
    ttl: sim.pingTtl,
    responderIp: sim.pingResponderIp,
    timeExceeded: sim.pingTimeExceeded,
    assignedIp: sim.dhcpAssignedIp,
    assignedGateway: sim.dhcpAssignedGateway,
    log: sim.log,
    steps: sim.stepIndex,
  };
}

export interface TracerouteHop { ttl: number; ip: string | null; reached: boolean }
export interface TracerouteResult { targetIp: string; hops: TracerouteHop[]; reached: boolean }

// Runs traceroute headlessly: sends probes with increasing TTL and records who
// answered each round — a router's ICMP Time-Exceeded (intermediate hop) or the
// destination's Echo Reply (final hop). Reuses runSimulationHeadless per probe.
export function runTraceroute(source: Device, targetText: string, maxHops = 30): TracerouteResult | string {
  const target = findPingTarget(targetText);
  const targetIp = target ? (target.config?.ipv4Address || targetText)
    : (isValidIpv4(targetText.trim()) ? targetText.trim() : targetText.trim());
  // Warm ARP along the path first: a router's Time-Exceeded can't be delivered
  // on a cold ARP cache within a single headless probe, which would show false
  // "* no response" hops. A real router always answers TTL-exceeded, and
  // traceroute populating ARP as a side effect is itself realistic.
  const warm = buildPingEvents(source, targetText);
  if (typeof warm !== "string") runSimulationHeadless(warm, source.id, targetIp, "ping");

  const hops: TracerouteHop[] = [];
  let reached = false;
  for (let ttl = 1; ttl <= maxHops; ttl++) {
    const setup = buildPingEvents(source, targetText, { ttl });
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

function animationTick(now: number): void {
  const sim = state.simulation;

  // Update transit progress
  for (const t of sim.transits) {
    t.progress = Math.min(1, (now - t.startTime) / sim.speed);
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
    // Record frame on link
    const link = state.links.find(l => l.id === t.linkId);
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
  if (!device) return;

  const outgoing = PROCESSORS[device.type]?.(device, event.frame, event.fromDeviceId) ?? [];

  // Create transits for outgoing frames
  const now = performance.now();
  for (const out of outgoing) {
    const link = findLinkBetween(event.deviceId, out.toDeviceId);
    if (!link) continue;
    sim.transits.push({
      frame: out.frame,
      linkId: link.id,
      fromDeviceId: event.deviceId,
      toDeviceId: out.toDeviceId,
      progress: 0,
      startTime: now
    });
  }

  // Headless runs never touch the DOM — skip per-step rendering (faster, and it
  // keeps probes like traceroute from flashing the canvas / sim-log panel).
  if (!sim.headless) {
    syncSimLog();
    sync().render();
  }

  // If no transits were created but events remain, process next immediately
  // (e.g., a device ignored a frame with no outgoing)
  if (sim.transits.length === 0 && sim.events.length > 0 && sim.status === "running") {
    processNextStep();
    return;
  }

  // No transits and no events — simulation is done
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
  switch: processAtSwitch,
  router: processAtRouter,
  firewall: processAtFirewall,
};

// ─── Computer processing ─────────────────────────────────────────────────────

export function processAtComputer(device: Device, frame: EthernetFrame, fromDeviceId: string | null): OutgoingFrame[] {
  const sim = state.simulation;
  const outgoing: OutgoingFrame[] = [];
  if (device.poweredOff) return outgoing;
  const config = device.config;
  if (!config) return outgoing;

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
        // ICMP Echo Request — send reply
        logStep(device, "sim-icmp", `Received ICMP Echo Request from ${ipv4.srcIp} — sending Reply`);
        const reply = createIcmpEchoReply(
          config.macAddress || "", frame.srcMac,
          config.ipv4Address || "", ipv4.srcIp,
          64, frame.vlanTag, ipv4.payload.sequence
        );
        if (fromDeviceId) outgoing.push({ frame: reply, toDeviceId: fromDeviceId });
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
      }
    } else if (ipv4.payload.type === "tcp") {
      const tcp = ipv4.payload as TcpPayload;
      if (ipv4.dstIp !== config.ipv4Address) return outgoing; // not for us
      if (tcp.flags === "syn") {
        // Listener model: no openPorts list = accept on any port; otherwise RST.
        const listening = !Array.isArray(config.openPorts) || config.openPorts.includes(tcp.dstPort);
        learnArp(config, ipv4.srcIp, frame.srcMac);
        if (listening) {
          logStep(device, "sim-tcp", `TCP SYN on port ${tcp.dstPort} — sending SYN-ACK`);
          outgoing.push({ frame: createTcpSegment(config.macAddress || "", frame.srcMac, config.ipv4Address || "", ipv4.srcIp, tcp.dstPort, tcp.srcPort, "syn-ack", 64, frame.vlanTag), toDeviceId: fromDeviceId! });
        } else {
          logStep(device, "sim-drop", `TCP SYN on closed port ${tcp.dstPort} — sending RST`);
          outgoing.push({ frame: createTcpSegment(config.macAddress || "", frame.srcMac, config.ipv4Address || "", ipv4.srcIp, tcp.dstPort, tcp.srcPort, "rst", 64, frame.vlanTag), toDeviceId: fromDeviceId! });
        }
      } else if (tcp.flags === "syn-ack") {
        logStep(device, "sim-tcp", `TCP SYN-ACK from ${ipv4.srcIp}:${tcp.srcPort} — sending ACK (connection established)`);
        if (device.id === sim.originDeviceId) {
          sim.tcpSuccess = true;
          sim.pingResponderIp = ipv4.srcIp;
        }
        outgoing.push({ frame: createTcpSegment(config.macAddress || "", frame.srcMac, config.ipv4Address || "", ipv4.srcIp, tcp.dstPort, tcp.srcPort, "ack", 64, frame.vlanTag), toDeviceId: fromDeviceId! });
      } else if (tcp.flags === "rst") {
        if (device.id === sim.originDeviceId) {
          sim.tcpRefused = true;
          logStep(device, "sim-drop", `TCP RST from ${ipv4.srcIp}:${tcp.srcPort} — connection refused`);
        }
      } else if (tcp.flags === "ack") {
        logStep(device, "sim-tcp", `TCP ACK from ${ipv4.srcIp} — handshake complete`);
      }
    } else if (ipv4.payload.type === "dhcp") {
      const dhcp = ipv4.payload as DhcpPayload;
      // Only process DHCP meant for this client
      if (dhcp.clientMac !== config.macAddress) return outgoing;

      if (dhcp.messageType === "offer") {
        logStep(device, "sim-dhcp", `Received DHCP Offer: ${dhcp.assignedIp} from ${dhcp.serverIp}`);
        const request = createDhcpRequest(config.macAddress, dhcp.assignedIp!, dhcp.serverIp!, dhcp.transactionId, frame.vlanTag);
        if (fromDeviceId) outgoing.push({ frame: request, toDeviceId: fromDeviceId });
      } else if (dhcp.messageType === "ack") {
        logStep(device, "sim-dhcp", `Received DHCP ACK: assigned ${dhcp.assignedIp}, gateway ${dhcp.gatewayIp}`);
        config.ipv4Address = dhcp.assignedIp || "";
        if (dhcp.prefixLength != null) config.prefixLength = dhcp.prefixLength; // subnet-mask option
        config.gatewayIpv4Address = dhcp.gatewayIp || "";
        // Learn router MAC in ARP table
        if (dhcp.gatewayIp && frame.srcMac && frame.srcMac !== BROADCAST_MAC) {
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

// ─── Switch processing ───────────────────────────────────────────────────────

export function processAtSwitch(device: Device, frame: EthernetFrame, fromDeviceId: string | null): OutgoingFrame[] {
  const outgoing: OutgoingFrame[] = [];
  if (device.poweredOff) return outgoing;
  const config = device.config;
  if (!config) return outgoing;

  frame = { ...frame, srcMac: normaliseMacAddress(frame.srcMac), dstMac: normaliseMacAddress(frame.dstMac) };

  const ports = linkedPortsFor(device.id);
  const ingressIdx = fromDeviceId ? ports.findIndex(p => p.peer.id === fromDeviceId) : -1;
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

  return outgoing;
}

function getPortVlan(device: Device, portName: string): string {
  if (!device.config?.managed) return "";
  const portVlans = normalisePortVlans(device.config.portVlans || {});
  return String(portVlans[portName] || 1);
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
      for (const pf of pending) {
        const ipv4 = pf.payload as Ipv4Payload;
        // Re-run the routing decision: the buffered frame may be destined for a
        // network reached VIA the next-hop we just resolved (static/RIP route),
        // so the egress lookup must use the route, not the final destination.
        const route = routingLookup(device, ipv4.dstIp);
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

function routeIpv4Frame(device: Device, frame: EthernetFrame, ifaces: any[], ingressIface: any, fromDeviceId: string, ipv4: Ipv4Payload): OutgoingFrame[] {
  const sim = state.simulation;
  const outgoing: OutgoingFrame[] = [];

  // Check if it's for the router itself (e.g., ping the router's interface IP)
  const selfIface = ifaces.find((iface: any) => iface.ipv4Address === ipv4.dstIp);
  if (selfIface) {
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
        64, ingressIface.vlanTag ?? null
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
    // Need ARP for next-hop — buffer the frame and send ARP request
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

// Match an IPv4 address against an exact IP or a CIDR (e.g. "192.168.1.0/24").
function ipMatchesCidr(ip: string, pattern: string): boolean {
  if (!isValidIpv4(ip)) return false;
  const slash = pattern.indexOf("/");
  if (slash < 0) return ip === pattern;
  const net = pattern.slice(0, slash);
  const bits = parseInt(pattern.slice(slash + 1), 10);
  if (!isValidIpv4(net) || !(bits >= 0 && bits <= 32)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(net) & mask);
}

export function firewallRuleMatches(rule: FirewallRule, ipv4: Ipv4Payload): boolean {
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
  if (rule.src && !ipMatchesCidr(ipv4.srcIp, rule.src)) return false;
  if (rule.dst && !ipMatchesCidr(ipv4.dstIp, rule.dst)) return false;
  return true;
}

// First-match-wins over the chain's rules, else the chain's default policy.
export function evaluateFirewall(device: Device, ipv4: Ipv4Payload, chain = "forward"): FirewallTarget {
  const rules = (device.config?.rules || []).filter(r => (r.chain || "forward") === chain);
  for (const rule of rules) {
    if (firewallRuleMatches(rule, ipv4)) return rule.target;
  }
  return (device.config?.policy || {})[chain] || "accept";
}

export function processAtFirewall(device: Device, frame: EthernetFrame, fromDeviceId: string | null): OutgoingFrame[] {
  const outgoing: OutgoingFrame[] = [];
  if (device.poweredOff) return outgoing;

  // Transparent bridge: forward to every linked port except the ingress one.
  const egress = linkedPortsFor(device.id)
    .map((p: any) => p.peer.id)
    .filter((id: string) => id !== fromDeviceId);

  // Filter IPv4 on the FORWARD chain; pass ARP and other control frames through.
  if (frame.payload.type === "ipv4") {
    const ipv4 = frame.payload as Ipv4Payload;
    const verdict = evaluateFirewall(device, ipv4, "forward");
    if (verdict !== "accept") {
      logStep(device, "sim-drop", `Firewall ${verdict.toUpperCase()} ${frameLabel(frame)} ${ipv4.srcIp}→${ipv4.dstIp} (FORWARD)`);
      return outgoing;
    }
    logStep(device, "sim-forward", `Firewall ACCEPT ${frameLabel(frame)} ${ipv4.srcIp}→${ipv4.dstIp} (FORWARD)`);
  }
  egress.forEach((toDeviceId: string, i: number) => {
    outgoing.push({ frame: { ...frame, id: `${frame.id}-fw${i}` }, toDeviceId });
  });
  return outgoing;
}

function generateApipaAddress(): string {
  const second = 1 + Math.floor(Math.random() * 254); // 1–254
  const fourth = 1 + Math.floor(Math.random() * 254); // 1–254
  return `169.254.${second}.${fourth}`;
}

function allocateDhcpIp(iface: any, router: Device): string | null {
  if (!iface.ipv4Address || !isValidIpv4(iface.ipv4Address)) return null;
  const ifPrefix = prefixOf(iface);
  // The pool draws from the interface's own /24 slice (.100–.254), which sits
  // inside any larger network too; subnet-membership checks use the real prefix.
  const parts = iface.ipv4Address.split(".");
  const poolBase = `${parts[0]}.${parts[1]}.${parts[2]}`;

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

  for (let i = 100; i <= 254; i++) {
    const candidate = `${poolBase}.${i}`;
    if (!usedIps.has(candidate)) return candidate;
  }
  return null;
}

function findEgressInterface(ifaces: any[], dstIp: string): any | null {
  return ifaces.find((iface: any) => iface.ipv4Address && isValidIpv4(iface.ipv4Address) && sameSubnet(iface.ipv4Address, dstIp, prefixOf(iface))) || null;
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

export function syncSimLog(): void {
  const sim = state.simulation;
  const active = sim.status !== "idle" && sim.log.length > 0;
  dom.simLogPanel.classList.toggle("active", active);
  if (!active) return;
  dom.simLogOutput.innerHTML = sim.log.map(entry =>
    `<p class="sim-log-line ${escapeHtml(entry.kind || "")}">${escapeHtml(entry.summary)}</p>`
  ).join("");
  dom.simLogOutput.scrollTop = dom.simLogOutput.scrollHeight;
}

function findLinkBetween(a: string, b: string): any | null {
  return state.links.find(link =>
    !link.hidden && ((link.from === a && link.to === b) || (link.from === b && link.to === a))
  ) || null;
}

function finishSimulation(): void {
  const sim = state.simulation;

  if (sim.mode === "dhcp") {
    if (sim.dhcpSuccess) {
      if (!sim.headless) terminalLine("", `DHCP configured:\n  IP address: ${sim.dhcpAssignedIp}\n  Default gateway: ${sim.dhcpAssignedGateway}`);
    } else {
      // APIPA fallback
      const apipaIp = generateApipaAddress();
      const origin = getDevice(sim.originDeviceId);
      if (origin?.config) {
        origin.config.ipv4Address = apipaIp;
        origin.config.gatewayIpv4Address = "";
      }
      sim.dhcpAssignedIp = apipaIp;
      if (!sim.headless) terminalLine("error", `DHCP: no response from server.\nAPIPA: assigned link-local ${apipaIp}`);
    }
  } else if (sim.mode === "tcp") {
    if (!sim.headless) {
      const targetIp = sim.pingTargetIp || "?";
      const port = sim.tcpTargetPort ?? "?";
      if (sim.tcpSuccess) {
        terminalLine("", `Connection to ${targetIp} ${port} port [tcp/*] succeeded!`);
      } else if (sim.tcpRefused) {
        terminalLine("error", `nc: connect to ${targetIp} port ${port} (tcp) failed: Connection refused`);
      } else {
        terminalLine("error", `nc: connect to ${targetIp} port ${port} (tcp) failed: Operation timed out`);
      }
    }
  } else if (!sim.headless) {
    const targetIp = sim.pingTargetIp || "?";
    if (sim.pingSuccess) {
      const ttl = sim.pingTtl;
      const rtt = sim.stepIndex < 15 ? "1.0" : "2.0";
      terminalLine("", `PING ${targetIp}\n64 bytes from ${targetIp}: icmp_seq=1 ttl=${ttl} time=${rtt} ms\n\n--- ${targetIp} ping statistics ---\n1 packets transmitted, 1 received, 0% packet loss`);
    } else {
      terminalLine("", `PING ${targetIp}\n\n--- ${targetIp} ping statistics ---\n1 packets transmitted, 0 received, 100% packet loss`);
    }
  }

  sim.status = "done";
  // Headless runs don't touch the DOM/terminal — the caller renders the result.
  if (sim.headless) return;
  // Re-enable terminal input
  const termInput = document.getElementById("terminalInput") as HTMLInputElement | null;
  if (termInput) termInput.disabled = false;
  syncSimLog();
  syncTerminal();
  sync().syncPanel();
  updateSimControls();
  stopAnimationLoop();
}

function updateSimControls(): void {
  const controls = document.getElementById("simControls");
  const playPause = document.getElementById("simPlayPause");
  const active = state.simulation.status === "running" || state.simulation.status === "paused";
  if (controls) {
    controls.classList.toggle("active", active);
  }
  if (playPause) {
    playPause.textContent = state.simulation.status === "running" ? "⏸" : "▶";
  }
}
