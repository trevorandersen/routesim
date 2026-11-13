/**
 * Routing — the router's forwarding decisions and RIP convergence, extracted
 * from engine.ts. buildRoutingTable merges connected/static/RIP routes by
 * metric; routingLookup resolves a destination to an egress interface;
 * runRipConvergence exchanges advertisements until stable (split horizon,
 * metric 16 = unreachable). Subnet decisions honour per-interface prefixes.
 *
 * Both paths are hot (a lookup per routed frame, RIP before every run and up
 * to 31 times per traceroute), so addresses are parsed to integers once —
 * each RouteEntry carries its parsed `cidr`, RIP precomputes each interface's
 * network and RIP-active flag per convergence — and the inner loops compare
 * integers (utils.ts: parseIpv4/cachedCidr/cidrHas) instead of re-splitting
 * the same strings per route per frame.
 */
import type { Device, RouteEntry, RouterInterface, NamedRouterIface, RipRoute } from "./types";
import { state } from "./state";
import { getDevice, routerInterfacesWithNames } from "./devices";
import { normaliseStaticRoutes } from "./normalise";
import { prefixOf, internetGatewayIp, parseIpv4, cidrOf, cidrText, cachedCidr, cidrHas } from "./utils";

export function buildRoutingTable(router: Device): RouteEntry[] {
  const table: RouteEntry[] = [];
  const ifaces = routerInterfacesWithNames(router, true);   // only cabled interfaces carry routes
  const seen = new Set<string>();

  // 1. Connected routes — interfaces with valid IPs and an active peer
  for (const iface of ifaces) {
    const addr = parseIpv4(iface.config?.ipv4Address ?? "");
    if (addr === null || !iface.peer || iface.link?.shutdown) continue;  // a shut cable carries no routes / RIP
    const cidr = cidrOf(addr, prefixOf(iface.config));
    const network = cidrText(cidr);
    if (seen.has(network)) continue;
    seen.add(network);
    table.push({ network, cidr, nextHop: "", interface: iface.name, type: "C", metric: 0, peerId: iface.peerId, vlanTag: iface.config?.vlanTag ?? null });
  }

  // 2. Static routes — active only when the next hop resolves through a live
  // connected route. An inactive static (next hop down, shut, or just wrong) is
  // listed for `show ip route` but never forwards, and never shadows RIP or the
  // internet default for its prefix (review R18) — FRR marks such a static
  // inactive too. Previously every static was installed and added to `seen`, so
  // a mistyped next hop black-holed the prefix and hid a working default/RIP.
  const statics = normaliseStaticRoutes(router.config?.staticRoutes || []);
  for (const sr of statics) {
    if (seen.has(sr.network)) continue;
    const hop = parseIpv4(sr.nextHop);
    const active = hop !== null && longestMatch(table, hop, true) !== null;
    table.push({ network: sr.network, cidr: cachedCidr(sr.network), nextHop: sr.nextHop, type: "S", metric: 1, inactive: !active });
    if (active) seen.add(sr.network);   // only an active static shadows RIP / the default
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
      table.push({ network: "0.0.0.0/0", cidr: cachedCidr("0.0.0.0/0"), nextHop: def.gateway, interface: def.ifaceName, type: "S", metric: 1 });
      seen.add("0.0.0.0/0");
    }
  }

  // 4. RIP learned routes (may carry a default originated by an edge router)
  if (router.config?.rip?.enabled && Array.isArray(router.config.rip.learnedRoutes)) {
    for (const rr of router.config.rip.learnedRoutes) {
      if (seen.has(rr.network)) continue;
      seen.add(rr.network);
      table.push({ network: rr.network, cidr: cachedCidr(rr.network), nextHop: rr.nextHop, interface: rr.interface, type: "R", metric: rr.metric });
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
    if (!ip || iface.peer?.type !== "internet" || iface.link?.shutdown) continue;
    const gateway = internetGatewayIp(ip, prefixOf(iface.config));   // null for an invalid address, too
    if (gateway) return { gateway, ifaceName: iface.name };
  }
  return null;
}

// Longest-prefix match of an address integer over the table (optionally only
// connected routes); ties keep the first — the lower metric, as the table is
// metric-sorted. Integer compares only: no parsing, no allocation.
function longestMatch(table: RouteEntry[], addr: number, connectedOnly: boolean): RouteEntry | null {
  let best: RouteEntry | null = null;
  let bestLen = -1;
  for (let i = 0; i < table.length; i++) {
    const r = table[i];
    const cidr = r.cidr;
    if (cidr === null || r.inactive || (connectedOnly && r.type !== "C") || !cidrHas(cidr, addr)) continue;
    if (cidr.prefix > bestLen) { best = r; bestLen = cidr.prefix; }
  }
  return best;
}

export function routingLookup(router: Device, dstIp: string, prebuilt?: RouteEntry[]): { egressIface: any; nextHopIp: string } | null {
  // A caller resolving several frames for the same router in one pass (e.g. an
  // ARP-reply flushing buffered frames) can pass a table built once.
  const table = prebuilt ?? buildRoutingTable(router);
  const ifaces: RouterInterface[] = router.config?.interfaces || [];

  // Longest-prefix match wins; ties resolve by metric. The destination is
  // parsed once — this runs per routed frame and is benchmarked.
  const dst = parseIpv4(dstIp);
  if (dst === null) return null;
  const route = longestMatch(table, dst, false);
  if (!route) return null;

  // The STORED interface object (the engine reads/learns its ARP table), found
  // by the stable identity the route carries — never the first raw interface
  // whose subnet merely contains an address: with overlapping prefixes
  // (10.0.0.1/8 first, 10.1.0.1/16 second) that returned the /8 interface even
  // though the /16 route had just been selected.
  const storedIface = (peerId: string | undefined, vlanTag: number | null | undefined): RouterInterface | undefined =>
    peerId ? ifaces.find((i) => i.peerId === peerId && (i.vlanTag ?? null) === (vlanTag ?? null)) : undefined;

  if (route.type === "C") {
    // No ifaceOnSubnet fallback: it ignored shutdown/peer state (review R18).
    const egressIface = storedIface(route.peerId, route.vlanTag);
    return egressIface ? { egressIface, nextHopIp: dstIp } : null;
  }

  // Static or RIP — resolve the next hop through the best CONNECTED route that
  // contains it (longest prefix; only live, un-shut interfaces make the table),
  // then to that route's stored interface.
  const nextHop = route.nextHop;
  const hop = nextHop ? parseIpv4(nextHop) : null;
  if (hop === null) return null;
  const via = longestMatch(table, hop, true);
  const egressIface = via ? storedIface(via.peerId, via.vlanTag) : undefined;
  return egressIface ? { egressIface, nextHopIp: nextHop } : null;
}

// ─── RIP convergence ─────────────────────────────────────────────────────────

interface RipAdvertisement {
  network: string;
  metric: number;
  sourceInterface: string;
}

// One interface's RIP-relevant facts. Addresses, prefixes, cables, and
// `network` statements don't change while convergence runs (only learned routes
// do), so these are computed once per convergence rather than re-parsed in the
// per-iteration, per-neighbour, per-advertisement loops.
interface RipIface {
  iface: NamedRouterIface;
  ripActive: boolean;   // a `network` statement covers the interface's address
}

// A router as RIP convergence sees it — built once per convergence, on first
// touch (as a sender or as a neighbour).
interface RipRouterView {
  device: Device;
  ifaces: NamedRouterIface[];
  ripIfaces: RipIface[];
  connectedAds: RipAdvertisement[];   // its own covered, cabled networks (metric 1)
  defaultAd: RipAdvertisement | null; // the originated default, when cabled to the internet
  connectedNets: Set<string>;         // networks it is directly connected to — never learned
  isEdge: boolean;                    // cabled to an internet cloud (never learns a default)
  learnedByNetwork: Map<string, RipRoute>;   // index over rip.learnedRoutes (first entry per network)
}

function buildRipRouterView(device: Device): RipRouterView {
  const ifaces = routerInterfacesWithNames(device, true);   // RIP only speaks on cabled interfaces
  const networks = (device.config?.rip?.networks || []).map(cachedCidr);
  const ripIfaces: RipIface[] = [];
  const connectedAds: RipAdvertisement[] = [];
  const connectedNets = new Set<string>();
  for (const iface of ifaces) {
    const addr = parseIpv4(iface.config?.ipv4Address ?? "");
    // `network <cidr>` enables RIP for interfaces whose address that cidr covers.
    const ripActive = addr !== null && networks.some(c => c !== null && cidrHas(c, addr));
    ripIfaces.push({ iface, ripActive });
    if (addr === null || !iface.peer) continue;
    const network = cidrText(cidrOf(addr, prefixOf(iface.config)));
    connectedNets.add(network);   // (a shut cable still counts here — as before)
    if (ripActive && !iface.link?.shutdown) {   // a shut cable carries no routes / RIP
      connectedAds.push({ network, metric: 1, sourceInterface: iface.name });
    }
  }

  // Originate a default route when cabled to the internet (like Cisco's
  // `default-information originate`), so RIP neighbours several hops from the
  // edge still learn a way out. Unconditional — an edge never *learns* a
  // default (applyRipUpdates skips it), so origination can't be suppressed by
  // hearsay from another edge. Metric 1 (locally originated), sourced on the
  // internet-facing interface so split-horizon never sends it back to the ISP.
  const def = internetDefaultGateway(ifaces);
  const defaultAd = def ? { network: "0.0.0.0/0", metric: 1, sourceInterface: def.ifaceName } : null;

  const learnedByNetwork = new Map<string, RipRoute>();
  for (const r of device.config?.rip?.learnedRoutes || []) {
    if (!learnedByNetwork.has(r.network)) learnedByNetwork.set(r.network, r);
  }
  return { device, ifaces, ripIfaces, connectedAds, defaultAd, connectedNets, isEdge: def !== null, learnedByNetwork };
}

// This round's advertisements: connected networks, then learned routes
// (re-advertised at metric + 1), then the originated default.
function buildRipAdvertisements(view: RipRouterView, learnedRoutes: RipRoute[]): RipAdvertisement[] {
  const advertisements: RipAdvertisement[] = view.connectedAds.slice();
  for (const lr of learnedRoutes) {
    if (lr.metric >= 15) continue; // metric 16 = unreachable
    advertisements.push({ network: lr.network, metric: lr.metric + 1, sourceInterface: lr.interface || "" });
  }
  if (view.defaultAd) advertisements.push(view.defaultAd);
  return advertisements;
}

function applyRipUpdates(
  neighbor: RipRouterView, neighborIface: NamedRouterIface,
  advertisements: RipAdvertisement[], egressIfaceName: string, egressIfaceIp: string
): { changed: boolean; exchanged: number } {
  let changed = false;
  let exchanged = 0;
  // Caller only invokes this for RIP-enabled neighbors, so rip is present.
  const neighborRip = neighbor.device.config.rip!;

  for (const ad of advertisements) {
    // Split horizon: don't re-advertise a route back toward the interface it was learned from
    if (ad.sourceInterface === egressIfaceName && ad.metric > 1) continue;
    if (ad.metric > 15) continue; // unreachable

    // An internet-edge router never learns a default — it has its own implicit
    // one toward the cloud (the default-route analogue of the connected-network
    // skip below). Keeps dual-edge topologies symmetric: each edge originates,
    // neither depends on the other's word for a way out.
    if (ad.network === "0.0.0.0/0" && neighbor.isEdge) continue;

    // Check if neighbor already knows this route with equal or better metric
    const existing = neighbor.learnedByNetwork.get(ad.network);

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
      if (neighbor.connectedNets.has(ad.network)) continue;

      if (!neighborRip.learnedRoutes) neighborRip.learnedRoutes = [];
      const learned: RipRoute = {
        network: ad.network,
        nextHop: egressIfaceIp,
        interface: neighborIface.name,
        metric: ad.metric
      };
      neighborRip.learnedRoutes.push(learned);
      neighbor.learnedByNetwork.set(ad.network, learned);
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

  // Interface lists, their parsed networks, and RIP-active flags are stable
  // across convergence — only learnedRoutes change, which none of them read.
  // Built once per router (on first touch) instead of per iteration.
  const views = new Map<string, RipRouterView>();
  const viewFor = (device: Device): RipRouterView => {
    let view = views.get(device.id);
    if (!view) {
      view = buildRipRouterView(device);
      views.set(device.id, view);
    }
    return view;
  };

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let changed = false;
    iterations = iter + 1;

    for (const router of ripRouters) {
      const view = viewFor(router);
      const rip = router.config.rip!;  // ripRouters filter guarantees rip.enabled
      const advertisements = buildRipAdvertisements(view, rip.learnedRoutes || []);

      // Send advertisements to each RIP-enabled neighbor
      const passiveInterfaces: string[] = rip.passiveInterfaces || [];
      // RIP runs on an interface only when a `network` statement covers its
      // address (FRR's `network` enables the protocol on matching interfaces;
      // it is not merely a list of what to advertise). Both ends must be
      // active for an exchange. Before this, `networks` shaped only what was
      // advertised, so a router with an EMPTY network list still learned routes
      // and a transit interface left out of RIP still carried them.
      for (const { iface, ripActive } of view.ripIfaces) {
        if (!iface.peer || !ripActive || iface.link?.shutdown) continue;
        if (passiveInterfaces.includes(iface.name)) continue;

        const neighbor = getDevice(iface.peer.id);
        if (!neighbor || neighbor.type !== "router" || !neighbor.config?.rip?.enabled) continue;

        const neighborView = viewFor(neighbor);
        const facing = neighborView.ripIfaces.find((ni) => ni.iface.peer && ni.iface.peer.id === router.id);
        if (!facing || !facing.iface.config?.ipv4Address || !facing.ripActive) continue;
        const neighborIface = facing.iface;

        const neighborPassive: string[] = neighbor.config.rip.passiveInterfaces || [];
        if (neighborPassive.includes(neighborIface.name)) continue;

        const result = applyRipUpdates(neighborView, neighborIface, advertisements, iface.name, iface.config.ipv4Address!);
        if (result.changed) changed = true;
        totalExchanged += result.exchanged;
      }
    }

    if (!changed) break;
  }

  return { iterations, routesExchanged: totalExchanged };
}
