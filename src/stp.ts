/**
 * Spanning Tree (IEEE 802.1D) convergence — the L2 counterpart to routing.ts's
 * RIP convergence. runStpConvergence runs before each simulation (and on
 * topology/STP-config changes, via the recomputeStp callback) and, like RIP,
 * mutates device config in place with the computed result. It elects a root
 * bridge per connected switch component (lowest bridge id = priority + base MAC),
 * finds each bridge's least-cost path to the root, and assigns every port a role
 * (root / designated / alternate) and state (forwarding / blocking). An
 * alternate port blocks data on its link (link.stpBlocked) — that's what breaks
 * the loop, gated through linkAuthorizedForData like the other data-path gates.
 *
 * Simplifications for teaching (documented in docs/src/stp.md): one tree for the
 * whole bridge (not per-VLAN), a fixed per-link cost of 1 hop, instant
 * convergence (no listening/learning timers), and loop detection across directly
 * linked managed switches (a loop closed through a hub or unmanaged switch is out
 * of scope). bridgeId/rootId/rootCost/ports are derived and never serialised.
 */
import type { Device, StpRole, StpState, StpPortInfo } from "./types";
import { state } from "./state";
import { linkedPortsFor, isPhysicalLink } from "./devices";
import { bridgeMacOf } from "./utils";

export const DEFAULT_BRIDGE_PRIORITY = 32768;

// Whether a managed switch runs spanning tree. Default on for managed switches
// (as real switches are) — only an explicit `enabled: false` opts out.
export function isStpParticipant(device: Device): boolean {
  if (device.type !== "switch" || device.poweredOff) return false;   // a switch collapsed into a LAN still bridges
  if (!device.config?.managed) return false;
  const stp = device.config.stp;
  return stp ? stp.enabled !== false : true;
}

export function bridgePriority(device: Device): number {
  const p = device.config?.stp?.priority;
  return Number.isFinite(p) ? (p as number) : DEFAULT_BRIDGE_PRIORITY;
}

// A bridge id is the priority joined to the bridge's base MAC; lower wins.
function bridgeIdString(priority: number, mac: string): string {
  return `${priority}.${mac}`;
}

interface Bridge {
  dev: Device;
  priority: number;
  mac: string;
  id: string;
}

// Lower bridge id wins: compare priority first, then base MAC lexically.
function cmpBridge(a: Bridge, b: Bridge): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0;
}

// The Ethernet port (name + 1-based number) a device uses for a given link, from
// the engine's own port view (linkedPortsFor), so STP keys match the forwarding
// path exactly. Null if the link isn't a visible wired port on the device.
function portForLink(deviceId: string, linkId: string): { name: string; num: number } | null {
  const ports = linkedPortsFor(deviceId);
  const idx = ports.findIndex((p) => p && p.link && p.link.id === linkId);
  if (idx < 0) return null;
  return { name: `Ethernet${idx + 1}`, num: idx + 1 };
}

interface StpEdge {
  linkId: string;
  a: string; b: string;          // participant device ids
  aPort: { name: string; num: number };
  bPort: { name: string; num: number };
}

function setPort(map: Record<string, StpPortInfo>, name: string, role: StpRole, stpState: StpState): void {
  map[name] = { role, state: stpState };
}

/**
 * Recompute the spanning tree across all managed switches. Clears stale derived
 * state, elects a root per connected component, and writes port roles/states
 * plus link.stpBlocked. Returns counts for diagnostics/benchmarks.
 */
export function runStpConvergence(): { participants: number; roots: number; blocked: number } {
  // 1. Reset derived state everywhere (a port that used to block may not now).
  for (const link of state.links) if (link.stpBlocked) link.stpBlocked = false;
  for (const d of state.devices) {
    if (d.type === "switch" && d.config?.stp) {
      delete d.config.stp.bridgeId;
      delete d.config.stp.rootId;
      delete d.config.stp.rootCost;
      delete d.config.stp.ports;
    }
  }

  const participants = state.devices.filter(isStpParticipant);
  if (participants.length === 0) return { participants: 0, roots: 0, blocked: 0 };

  // 2. Bridge ids, and a per-switch ports map we fill in as we assign roles.
  const bridges = new Map<string, Bridge>();
  const portsOut = new Map<string, Record<string, StpPortInfo>>();
  for (const dev of participants) {
    const priority = bridgePriority(dev);
    const mac = bridgeMacOf(dev);
    bridges.set(dev.id, { dev, priority, mac, id: bridgeIdString(priority, mac) });
    portsOut.set(dev.id, {});
  }

  // 3. Edges between two participants (direct wired links, not shut; a cable a
  // collapsed LAN hides is still one).
  const edges: StpEdge[] = [];
  for (const link of state.links) {
    if (!isPhysicalLink(link) || link.shutdown || link.wireless) continue;
    if (!bridges.has(link.from) || !bridges.has(link.to)) continue;
    const aPort = portForLink(link.from, link.id);
    const bPort = portForLink(link.to, link.id);
    if (!aPort || !bPort) continue;
    edges.push({ linkId: link.id, a: link.from, b: link.to, aPort, bPort });
  }

  // Every wired port to a *non-participant* peer (host/router/hub/AP) is an edge
  // port: designated and forwarding. Seed those first; bridge-to-bridge ports get
  // overwritten by the role assignment below.
  for (const dev of participants) {
    const map = portsOut.get(dev.id)!;
    const ports = linkedPortsFor(dev.id);
    ports.forEach((p, idx: number) => {
      // An administratively-down cable takes no part in the tree at all (it is
      // excluded from the participant edges above too) — seeding it forwarding
      // showed a shut port as live in the inspector's STP view.
      if (p && p.peer && !p.link?.shutdown) setPort(map, `Ethernet${idx + 1}`, "designated", "forwarding");
    });
  }

  // 4. Adjacency over participant edges, for BFS cost and root-port selection.
  interface Adj { edge: StpEdge; other: string; ownPort: { name: string; num: number }; otherPort: { name: string; num: number }; }
  const adj = new Map<string, Adj[]>();
  for (const id of bridges.keys()) adj.set(id, []);
  for (const e of edges) {
    adj.get(e.a)!.push({ edge: e, other: e.b, ownPort: e.aPort, otherPort: e.bPort });
    adj.get(e.b)!.push({ edge: e, other: e.a, ownPort: e.bPort, otherPort: e.aPort });
  }

  // 5. Per connected component: elect the lowest-id bridge as root, then BFS to
  //    get each bridge's least-cost (hop) distance to that root.
  const cost = new Map<string, number>();
  const rootOf = new Map<string, string>();   // bridge id-string of the component root
  const visited = new Set<string>();
  let roots = 0;

  for (const startId of bridges.keys()) {
    if (visited.has(startId)) continue;
    // Discover the component (undirected reachability over edges).
    const component: string[] = [];
    const stack = [startId];
    visited.add(startId);
    while (stack.length) {
      const id = stack.pop()!;
      component.push(id);
      for (const a of adj.get(id)!) {
        if (!visited.has(a.other)) { visited.add(a.other); stack.push(a.other); }
      }
    }
    // Root = lowest bridge id in the component.
    let root = bridges.get(component[0])!;
    for (const id of component) {
      const br = bridges.get(id)!;
      if (cmpBridge(br, root) < 0) root = br;
    }
    roots++;
    const rootIdStr = root.id;
    for (const id of component) rootOf.set(id, rootIdStr);

    // BFS hop-distance from the root over the component's edges.
    const queue: string[] = [root.dev.id];
    cost.set(root.dev.id, 0);
    while (queue.length) {
      const id = queue.shift()!;
      const c = cost.get(id)!;
      for (const a of adj.get(id)!) {
        if (!cost.has(a.other)) { cost.set(a.other, c + 1); queue.push(a.other); }
      }
    }
  }

  // 6. Choose each non-root bridge's root port: the incident edge toward a
  //    strictly-closer neighbour, tie-broken by (neighbour bridge id, neighbour
  //    port number, own port number) — the standard 802.1D ordering.
  const rootPortLink = new Map<string, string>();   // bridge id → its root-port link id
  for (const [id, br] of bridges) {
    if (cost.get(id) === 0) continue;   // the root has no root port
    const myCost = cost.get(id);
    if (myCost == null) continue;       // isolated bridge (no edges) — all-designated
    let best: Adj | null = null;
    for (const a of adj.get(id)!) {
      if (cost.get(a.other) !== myCost - 1) continue;   // must lead strictly toward the root
      if (!best) { best = a; continue; }
      const ob = bridges.get(a.other)!, bb = bridges.get(best.other)!;
      const byBridge = cmpBridge(ob, bb);
      if (byBridge < 0) { best = a; continue; }
      if (byBridge > 0) continue;
      if (a.otherPort.num !== best.otherPort.num) { if (a.otherPort.num < best.otherPort.num) best = a; continue; }
      if (a.ownPort.num < best.ownPort.num) best = a;
    }
    if (best) rootPortLink.set(id, best.edge.linkId);
  }

  // 7. Assign roles per edge. The designated end (lower cost, then lower bridge
  //    id) forwards; the other end is the root port (forwarding) or an alternate
  //    (blocking — this is the link we cut to break the loop).
  let blocked = 0;
  for (const e of edges) {
    const ca = cost.get(e.a)!, cb = cost.get(e.b)!;
    const ba = bridges.get(e.a)!, bb = bridges.get(e.b)!;
    let designated: "a" | "b";
    if (ca !== cb) designated = ca < cb ? "a" : "b";
    else designated = cmpBridge(ba, bb) < 0 ? "a" : "b";

    const desigId = designated === "a" ? e.a : e.b;
    const desigPort = designated === "a" ? e.aPort : e.bPort;
    const otherId = designated === "a" ? e.b : e.a;
    const otherPort = designated === "a" ? e.bPort : e.aPort;

    setPort(portsOut.get(desigId)!, desigPort.name, "designated", "forwarding");

    if (rootPortLink.get(otherId) === e.linkId) {
      setPort(portsOut.get(otherId)!, otherPort.name, "root", "forwarding");
    } else {
      setPort(portsOut.get(otherId)!, otherPort.name, "alternate", "blocking");
      const link = state.links.find(l => l.id === e.linkId);
      if (link) link.stpBlocked = true;
      blocked++;
    }
  }

  // 8. Write the derived result back onto each participant's stp config.
  for (const dev of participants) {
    const br = bridges.get(dev.id)!;
    if (!dev.config!.stp) dev.config!.stp = { enabled: true };
    const stp = dev.config!.stp;
    stp.bridgeId = br.id;
    stp.rootId = rootOf.get(dev.id) || br.id;
    stp.rootCost = cost.get(dev.id) ?? 0;
    stp.ports = portsOut.get(dev.id)!;
  }

  return { participants: participants.length, roots, blocked };
}

// Is this switch the root of its spanning tree? (Used by the canvas badge.)
export function isRootBridge(device: Device): boolean {
  const stp = device.config?.stp;
  return !!stp && !!stp.bridgeId && stp.bridgeId === stp.rootId;
}

// A device id and the BPDU-ready port roles for a switch, for the animated
// `stp` run: the designated ports a bridge advertises out of.
export function designatedPorts(device: Device): string[] {
  const ports = device.config?.stp?.ports || {};
  return Object.keys(ports).filter(name => ports[name].role === "designated");
}
