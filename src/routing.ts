/**
 * Routing — the router's forwarding decisions and RIP convergence, extracted
 * from engine.ts. buildRoutingTable merges connected/static/RIP routes by
 * metric; routingLookup resolves a destination to an egress interface;
 * runRipConvergence exchanges advertisements until stable (split horizon,
 * metric 16 = unreachable). Subnet decisions honour per-interface prefixes.
 */
import type { Device, RouteEntry, RouterInterface, NamedRouterIface } from "./types";
import { state } from "./state";
import { getDevice, routerInterfacesWithNames } from "./devices";
import { normaliseStaticRoutes } from "./normalise";
import { isValidIpv4, sameSubnet, networkOf, cidrContains, prefixLengthOfCidr, prefixOf, internetGatewayIp } from "./utils";

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

  // 3. Implicit internet default — a router cabled to an Internet cloud reaches
  // the rest of the world through it (the cloud routes by destination, so the
  // router just needs a default toward it; the cloud answers ARP for the
  // gateway address). Placed after statics so an explicit default route wins,
  // but before RIP so the router directly on the internet prefers its own real
  // path over a default it might otherwise learn back from a LAN neighbour.
  if (!seen.has("0.0.0.0/0")) {
    const def = internetDefaultGateway(ifaces);
    if (def) {
      table.push({ network: "0.0.0.0/0", nextHop: def.gateway, interface: def.ifaceName, type: "S", metric: 1 });
      seen.add("0.0.0.0/0");
    }
  }

  // 4. RIP learned routes (may carry a default originated by an edge router)
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

// The cloud gateway a router cabled to an Internet device default-routes toward
// (with the interface it faces the cloud on), or null if it isn't cabled to one
// — or the WAN subnet is too small to spare a gateway address (a /31 or /32).
// Shared by buildRoutingTable (which installs the default) and
// buildRipAdvertisements (which originates it into RIP, like Cisco's
// `default-information originate`), so the two never disagree.
function internetDefaultGateway(ifaces: NamedRouterIface[]): { gateway: string; ifaceName: string } | null {
  for (const iface of ifaces) {
    const ip = iface.config?.ipv4Address;
    if (!ip || !isValidIpv4(ip) || iface.peer?.type !== "internet") continue;
    const gateway = internetGatewayIp(ip, prefixOf(iface.config));
    if (gateway) return { gateway, ifaceName: iface.name };
  }
  return null;
}

// The interface whose connected network contains the address (per-iface prefix).
// Takes the FLAT RouterInterface[] (address at the top level), not the named view.
function ifaceOnSubnet(ifaces: RouterInterface[], ip: string): RouterInterface | undefined {
  return ifaces.find((iface) =>
    iface.ipv4Address && isValidIpv4(iface.ipv4Address) && sameSubnet(iface.ipv4Address, ip, prefixOf(iface))
  );
}

export function routingLookup(router: Device, dstIp: string, prebuilt?: RouteEntry[]): { egressIface: any; nextHopIp: string } | null {
  // A caller resolving several frames for the same router in one pass (e.g. an
  // ARP-reply flushing buffered frames) can pass a table built once.
  const table = prebuilt ?? buildRoutingTable(router);
  const ifaces: RouterInterface[] = router.config?.interfaces || [];

  // Longest-prefix match wins; ties resolve by metric. Single allocation-free
  // pass — this runs per routed frame and is benchmarked.
  let route: RouteEntry | null = null;
  let bestLen = -1;
  for (const r of table) {
    if (!cidrContains(r.network, dstIp)) continue;
    const len = prefixLengthOfCidr(r.network);
    if (len > bestLen) { route = r; bestLen = len; } // equal length: keep first (lower metric — table is metric-sorted)
  }
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

function buildRipAdvertisements(ifaces: NamedRouterIface[], ripNetworks: string[], learnedRoutes: any[]): RipAdvertisement[] {
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

  // Originate a default route when cabled to the internet (like Cisco's
  // `default-information originate`), so RIP neighbours several hops from the
  // edge still learn a way out. Unconditional — an edge never *learns* a
  // default (applyRipUpdates skips it), so origination can't be suppressed by
  // hearsay from another edge. Metric 1 (locally originated), sourced on the
  // internet-facing interface so split-horizon never sends it back to the ISP.
  const def = internetDefaultGateway(ifaces);
  if (def) {
    advertisements.push({ network: "0.0.0.0/0", metric: 1, sourceInterface: def.ifaceName });
  }

  return advertisements;
}

function applyRipUpdates(
  neighbor: Device, neighborIface: NamedRouterIface, neighborIfaces: NamedRouterIface[],
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

    // An internet-edge router never learns a default — it has its own implicit
    // one toward the cloud (the default-route analogue of the connected-network
    // skip below). Keeps dual-edge topologies symmetric: each edge originates,
    // neither depends on the other's word for a way out.
    if (ad.network === "0.0.0.0/0" && internetDefaultGateway(neighborIfaces)) continue;

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

  // Learned routes are derived state (like STP's port roles): recompute from
  // scratch each convergence, so a removed link, router, or network statement
  // doesn't leave a stale route behind. Real RIP ages routes out on timers;
  // the sim converges instantly, so a clean slate is the honest equivalent.
  for (const router of ripRouters) router.config!.rip!.learnedRoutes = [];

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
