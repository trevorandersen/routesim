/**
 * In-app reference (Help → Guide). The single source of truth for the
 * user-facing documentation of every device type and every simulation setting,
 * rendered into the help modal by `buildHelpHtml`.
 *
 * KEEP FRESH: `tests/help.test.ts` asserts every user-addable device type and
 * every Settings-pane toggle has an entry here — add a device or a setting and
 * the suite fails until it's documented. Device icons/labels come from
 * `DEVICE_SPECS`, so those never drift; only the prose lives here.
 */
import type { DeviceType } from "./types";
import { DEVICE_SPECS } from "./device-registry";
import { escapeHtml } from "./utils";

export interface DeviceDoc {
  type: DeviceType;
  /** One–three sentences: what it is, what it does, how you drive it. */
  body: string;
}

export interface SettingDoc {
  /** For pane toggles this is the checkbox id (e.g. `optAutoDhcp`) so the
   *  coverage test can pair every toggle with its doc; transport controls use a
   *  descriptive key. */
  id: string;
  title: string;
  body: string;
}

export interface SettingGroup {
  title: string;
  blurb: string;
  items: SettingDoc[];
}

// ─── Devices ─────────────────────────────────────────────────────────────────
// Ordered roughly by the ribbon tool groups. Titles + icons are pulled from
// DEVICE_SPECS at render time, so only the description lives here.
export const DEVICE_DOCS: DeviceDoc[] = [
  { type: "computer", body: "A general-purpose host with a single NIC. Give it an IP, gateway and DNS from the inspector or its Linux terminal (`ip addr`, `ip route`, `/etc/resolv.conf`), then run `ping`, `arp -n`, `nslookup`, `curl`, `nc`, and `traceroute`." },
  { type: "laptop", body: "A WiFi-only host. Instead of a cable it associates to an access point whose SSID (and password, if secured) matches — otherwise it behaves exactly like a client PC on the wired LAN it reaches through the AP." },
  { type: "kali", body: "A hand-driven pentest workstation. Its terminal is an ordinary Linux shell plus `nmap -sS` (SYN port scan), `nmap -sn` (ping sweep) and `arpspoof` — you launch the attacks yourself, one command at a time." },
  { type: "server", body: "A host that also runs dnsmasq — DNS A-records and a DHCP pool — and can serve HTTP. The DNS / DHCP / RADIUS / Web tool variants are the same device with a different service switched on; enable more from the inspector." },
  { type: "switch", body: "Forwards frames by learning which MAC lives on each port (floods the unknown). Adding, removing or shutting a cable flushes what it learnt on that LAN, so a moved host is re-learnt. The basic switch is unmanaged; the Managed variant adds 802.1Q VLANs, a SONiC-style CLI, SPAN port mirroring (to feed an IDS), and spanning tree." },
  { type: "router", body: "Forwards IP packets between subnets — longest-prefix routing, static routes and RIP — over an FRR-style CLI, with NAT and netfilter INPUT/FORWARD chains. The Border variant is the edge archetype (a “B” badge): the natural home for NAT and a firewall." },
  { type: "internet", body: "Stands in for the public internet. Cable several routers to it — each on its own public subnet — and it routes between them by destination, handing each a default route and answering ARP for the gateway it presents. Pair with NAT + port-forwarding for the full multi-site story." },
  { type: "firewall", body: "A transparent inline packet filter (the netfilter FORWARD chain). Write `iptables` rules to accept / drop / reject by protocol, address, port and connection state; a stateful `-m state ESTABLISHED,RELATED` ruleset lets replies back while blocking new inbound flows." },
  { type: "ids", body: "A passive Snort sensor. Cable it to a managed switch's SPAN/monitor port; it matches the mirrored traffic against your Snort rules (`local.rules`) and raises alerts. It only detects — it never forwards or drops." },
  { type: "attacker", body: "An autonomous Red Team (Kali) adversary. Set a target and a plan, and on Play it launches a port scan, ping sweep or ARP spoof and reports nmap-style findings. Without an address, Play first boots it over DHCP like any host. Pair it with an IDS for a red-vs-blue detection exercise." },
  { type: "access-point", body: "A WiFi access point. It bridges associated laptops onto the wired LAN (like an unmanaged switch over the air) and broadcasts an SSID, optionally secured with a WPA2 password so only matching laptops authenticate." },
  { type: "hub", body: "A layer-1 repeater: it floods every frame out all other ports with no MAC learning — the dumb predecessor to a switch. Useful for showing a single collision/broadcast domain and why switches are better." },
];

// ─── Simulation settings ─────────────────────────────────────────────────────
// The pane groups mirror the Settings pane (ids match its checkboxes); the last
// group documents the sim transport, which lives in the ribbon rather than the
// pane.
export const SETTING_GROUPS: SettingGroup[] = [
  {
    title: "Network boot",
    blurb: "How unconfigured hosts behave when the simulation starts. Both are off by default, so addressing stays explicit until you opt in.",
    items: [
      { id: "optAutoDhcp", title: "Auto-DHCP on boot", body: "When you press Play, every unconfigured, cabled, powered-on host tries DHCP — an animated Discover / Offer / Request / Ack in turn." },
      { id: "optApipa", title: "APIPA fallback", body: "A host that gets no DHCP lease self-assigns a link-local `169.254.x.y/16` address (no gateway) — like a real machine that finds no DHCP server." },
    ],
  },
  {
    title: "Name resolution",
    blurb: "How a device name used as a target (e.g. `ping PC-A1`) turns into an IP. A DNS server always resolves device hostnames; this controls whether names also resolve without one.",
    items: [
      { id: "optInstantDns", title: "Instant DNS", body: "Resolve a device name straight to its IP with no query — a built-in hosts file. Off: a name needs a reachable nameserver, like the real world. On by default in topologies, off when a scenario loads." },
    ],
  },
  {
    title: "Silent protocols",
    blurb: "Resolve these instantly with no animated frames or packet-list rows. The exchange still happens — it just isn't shown — so the higher-layer flow stays uncluttered once you understand it.",
    items: [
      { id: "optSilentArp", title: "Silent ARP", body: "Skip the ARP request/reply animation; MAC addresses resolve instantly." },
      { id: "optSilentDhcp", title: "Silent DHCP", body: "Skip the DORA animation; a host takes its lease instantly." },
      { id: "optSilentDns", title: "Silent DNS", body: "Skip the query/response animation; names resolve instantly before the ping or connection." },
      { id: "optSilentWifi", title: "Silent WiFi association", body: "Skip the 802.11 probe / auth / association (and WPA2) frames when a laptop joins an access point." },
      { id: "optSilentStp", title: "Silent spanning tree", body: "Skip the BPDU frames when the spanning tree advertises. The tree still converges and blocks loops — only the control-plane animation is hidden." },
    ],
  },
  {
    title: "Running a simulation",
    blurb: "The transport controls in the Main ribbon (and the floating pill over the canvas while a run is active). Press Play on an idle network to boot unconfigured hosts first.",
    items: [
      { id: "sim-play", title: "Play / Pause", body: "Start, or pause and resume, the animated run. From an idle network it first boots any unconfigured cabled hosts (per the Network-boot settings above)." },
      { id: "sim-step", title: "Step", body: "Advance the simulation one hop at a time — watch a single frame move from one device to the next." },
      { id: "sim-stop", title: "Stop", body: "End the run and reset it to idle. `Ctrl+C` in a device terminal or the console does the same." },
      { id: "sim-speed", title: "Speed (ms / hop)", body: "How long each hop's animation takes. A link's own latency stretches its frames further, so a WAN link visibly crawls." },
    ],
  },
];

// ─── Render ──────────────────────────────────────────────────────────────────

// A 24×24 icon for a device, coloured with its palette (matches the canvas).
function deviceIcon(type: DeviceType): string {
  const spec = DEVICE_SPECS[type];
  const paths = spec.iconPaths.map(d => `<path d="${d}"></path>`).join("");
  const sw = (spec as any).iconStrokeWidth ?? 1.6;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" style="color: var(--${spec.paletteVar}-icon, var(--${spec.paletteVar}-stroke))" aria-hidden="true">${paths}</svg>`;
}

// The full inner HTML of the help modal body. Rebuilt from the content above on
// each open, so it always reflects the current registries.
export function buildHelpHtml(): string {
  const devices = DEVICE_DOCS.map(doc => `
    <div class="help-device">
      <span class="help-device-icon">${deviceIcon(doc.type)}</span>
      <div class="help-device-text">
        <span class="help-device-name">${escapeHtml(DEVICE_SPECS[doc.type].label)}</span>
        <p>${escapeHtml(doc.body)}</p>
      </div>
    </div>`).join("");

  const settings = SETTING_GROUPS.map(g => `
    <div class="help-setting-group">
      <h4>${escapeHtml(g.title)}</h4>
      <p class="help-setting-blurb">${escapeHtml(g.blurb)}</p>
      <dl>
        ${g.items.map(i => `<dt>${escapeHtml(i.title)}</dt><dd>${escapeHtml(i.body)}</dd>`).join("")}
      </dl>
    </div>`).join("");

  return `
    <p class="help-intro">RouteSim simulates real Ethernet frames hopping through a network you build. Drop devices on the canvas, cable them with the Connect tool, address them, then press Play (or run <code>ping</code> from a device terminal) and watch each frame move. Below is every device you can place and every setting that shapes a run.</p>
    <h3 class="help-heading">Devices</h3>
    <div class="help-devices">${devices}</div>
    <h3 class="help-heading">Simulation settings</h3>
    <div class="help-settings">${settings}</div>`;
}
