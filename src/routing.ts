/**
 * Routing — the router's forwarding decisions and RIP convergence, extracted
 * from engine.ts. buildRoutingTable merges connected/static/RIP routes by
 * metric; routingLookup resolves a destination to an egress interface;
 * runRipConvergence exchanges advertisements until stable (split horizon,
 * metric 16 = unreachable). All /24 assumptions live here (see FUTURE_PLANS).
 */
import type { Device, RouteEntry } from "./types";
import { state } from "./state";
import { getDevice, routerInterfacesWithNames } from "./devices";
import { normaliseStaticRoutes } from "./normalise";
import { isValidIpv4, sameSubnet, networkOf, cidrContains, prefixLengthOfCidr, prefixOf } from "./utils";

export function buildRoutingTable(router: Device): RouteEntry[] {
  const table: RouteEntry[] = [];
  const ifaces = routerInterfacesWithNames(router);
  const seen = new Set<string>();

  // 1. Connected routes — interfaces with valid IPs and an active peer
  for (const iface of ifaces) {
    const ip = iface.config?.ipv4Address;
    if (!ip || !isValidIpv4(ip) || !iface.peer) continue;
    const network = networkOf(ip, prefixOf(iface.config));
    if (seen.has(network)) continue;
    seen.add(network);
    table.push({ network, nextHop: "", interface: iface.name, type: "C", metric: 0 });
  }

  // 2. Static routes
  const statics = normaliseStaticRoutes(router.config?.staticRoutes || []);
  for (const sr of statics) {
    if (seen.has(sr.network)) continue;
    seen.add(sr.network);
    table.push({ network: sr.network, nextHop: sr.nextHop, type: "S", metric: 1 });
  }

  // 3. RIP learned routes
  if (router.config?.rip?.enabled && Array.isArray(router.config.rip.learnedRoutes)) {
    for (const rr of router.config.rip.learnedRoutes) {
      if (seen.has(rr.network)) continue;
      seen.add(rr.network);
      table.push({ network: rr.network, nextHop: rr.nextHop, interface: rr.interface, type: "R", metric: rr.metric });
    }
  }

  // Sort: connected first, then static, then RIP (by metric)
  table.sort((a, b) => a.metric - b.metric);
  return table;
}

// The interface whose connected network contains the address (per-iface prefix).
function ifaceOnSubnet(ifaces: any[], ip: string): any | undefined {
  return ifaces.find((iface: any) =>
    iface.ipv4Address && isValidIpv4(iface.ipv4Address) && sameSubnet(iface.ipv4Address, ip, prefixOf(iface))
  );
}

export function routingLookup(router: Device, dstIp: string): { egressIface: any; nextHopIp: string } | null {
  const table = buildRoutingTable(router);
  const ifaces: any[] = router.config?.interfaces || [];

  // Longest-prefix match wins; ties resolve by metric (table is metric-sorted,
  // so a stable sort by prefix length alone preserves metric order within a length).
  const route = table
    .filter(r => cidrContains(r.network, dstIp))
    .sort((a, b) => prefixLengthOfCidr(b.network) - prefixLengthOfCidr(a.network))[0];
  if (!route) return null;

  if (route.type === "C") {
    // Connected — egress interface is the one whose network contains the destination
    const egressIface = ifaceOnSubnet(ifaces, dstIp);
    return egressIface ? { egressIface, nextHopIp: dstIp } : null;
  }

  // Static or RIP — resolve next-hop to a connected interface
  const nextHop = route.nextHop;
  if (!nextHop || !isValidIpv4(nextHop)) return null;

  const egressIface = ifaceOnSubnet(ifaces, nextHop);
  return egressIface ? { egressIface, nextHopIp: nextHop } : null;
}

// ─── RIP convergence ─────────────────────────────────────────────────────────

interface RipAdvertisement {
  network: string;
  metric: number;
  sourceInterface: string;
}

function buildRipAdvertisements(ifaces: any[], ripNetworks: string[], learnedRoutes: any[]): RipAdvertisement[] {
  const advertisements: RipAdvertisement[] = [];

  // Connected routes matching RIP networks
  for (const iface of ifaces) {
    const ip = iface.config?.ipv4Address;
    if (!ip || !isValidIpv4(ip) || !iface.peer) continue;
    const network = networkOf(ip, prefixOf(iface.config));
    // `network <cidr>` enables RIP for interfaces whose address that cidr covers.
    const isAdvertised = ripNetworks.some(rn => cidrContains(rn, ip));
    if (isAdvertised) {
      advertisements.push({ network, metric: 1, sourceInterface: iface.name });
    }
  }

  // Learned routes (re-advertise with metric + 1)
  for (const lr of learnedRoutes) {
    if (lr.metric >= 15) continue; // metric 16 = unreachable
    advertisements.push({ network: lr.network, metric: lr.metric + 1, sourceInterface: lr.interface || "" });
  }

  return advertisements;
}

function applyRipUpdates(
  neighbor: Device, neighborIface: any, neighborIfaces: any[],
  advertisements: RipAdvertisement[], egressIfaceName: string, egressIfaceIp: string
): { changed: boolean; exchanged: number } {
  let changed = false;
  let exchanged = 0;
  // Caller only invokes this for RIP-enabled neighbors, so rip is present.
  const neighborRip = neighbor.config.rip!;

  for (const ad of advertisements) {
    // Split horizon: don't re-advertise a route back toward the interface it was learned from
    if (ad.sourceInterface === egressIfaceName && ad.metric > 1) continue;
    if (ad.metric > 15) continue; // unreachable

    // Check if neighbor already knows this route with equal or better metric
    const existingRoutes: any[] = neighborRip.learnedRoutes || [];
    const existing = existingRoutes.find((r: any) => r.network === ad.network);

    if (existing) {
      if (ad.metric < existing.metric) {
        existing.metric = ad.metric;
        existing.nextHop = egressIfaceIp;
        existing.interface = neighborIface.name;
        changed = true;
        exchanged++;
      }
    } else {
      // Don't learn a route for a network this router is directly connected to
      const neighborConnected = neighborIfaces.some((ni: any) => {
        const nip = ni.config?.ipv4Address;
        if (!nip || !isValidIpv4(nip) || !ni.peer) return false;
        return networkOf(nip, prefixOf(ni.config)) === ad.network;
      });
      if (neighborConnected) continue;

      if (!neighborRip.learnedRoutes) neighborRip.learnedRoutes = [];
      neighborRip.learnedRoutes.push({
        network: ad.network,
        nextHop: egressIfaceIp,
        interface: neighborIface.name,
        metric: ad.metric
      });
      changed = true;
      exchanged++;
    }
  }

  return { changed, exchanged };
}

export function runRipConvergence(): { iterations: number; routesExchanged: number } {
  const ripRouters = state.devices.filter(d => d.type === "router" && !d.hidden && !d.poweredOff && d.config?.rip?.enabled);
  if (ripRouters.length === 0) return { iterations: 0, routesExchanged: 0 };

  let totalExchanged = 0;
  let iterations = 0;
  const MAX_ITERATIONS = 15;

  // Interface lists (name/peer/ipv4) are stable across convergence — only
  // learnedRoutes change, which routerInterfacesWithNames does not read.
  // Memoise per router to avoid re-normalising every iteration.
  const ifacesByRouter = new Map<string, any[]>();
  const ifacesFor = (router: any): any[] => {
    let ifaces = ifacesByRouter.get(router.id);
    if (!ifaces) {
      ifaces = routerInterfacesWithNames(router);
      ifacesByRouter.set(router.id, ifaces);
    }
    return ifaces;
  };

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let changed = false;
    iterations = iter + 1;

    for (const router of ripRouters) {
      const ifaces = ifacesFor(router);
      const rip = router.config.rip!;  // ripRouters filter guarantees rip.enabled
      const ripNetworks: string[] = rip.networks || [];
      const learnedRoutes = rip.learnedRoutes || [];
      const advertisements = buildRipAdvertisements(ifaces, ripNetworks, learnedRoutes);

      // Send advertisements to each RIP-enabled neighbor
      const passiveInterfaces: string[] = rip.passiveInterfaces || [];
      for (const iface of ifaces) {
        if (!iface.peer || !iface.config?.ipv4Address) continue;
        if (passiveInterfaces.includes(iface.name)) continue;

        const neighbor = getDevice(iface.peer.id);
        if (!neighbor || neighbor.type !== "router" || !neighbor.config?.rip?.enabled) continue;

        const neighborIfaces = ifacesFor(neighbor);
        const neighborIface = neighborIfaces.find((ni: any) => ni.peer && ni.peer.id === router.id);
        if (!neighborIface || !neighborIface.config?.ipv4Address) continue;

        const neighborPassive: string[] = neighbor.config.rip.passiveInterfaces || [];
        if (neighborPassive.includes(neighborIface.name)) continue;

        const result = applyRipUpdates(neighbor, neighborIface, neighborIfaces, advertisements, iface.name, iface.config.ipv4Address);
        if (result.changed) changed = true;
        totalExchanged += result.exchanged;
      }
    }

    if (!changed) break;
  }

  return { iterations, routesExchanged: totalExchanged };
}
