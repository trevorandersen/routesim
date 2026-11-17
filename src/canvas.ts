import type { Device, DeviceType, ActiveTransit, Link } from "./types";
import { state, colors } from "./state";
import { dom } from "./dom";
import { cssColor, prefixOf } from "./utils";
import { DEVICE_SPECS, isHost } from "./device-registry";
import { getDevice, isVisibleDevice, routerInterfacesWithNames, linkedPortsFor, wifiLinkAuthenticated, macsecState, placementPreview, findDeviceAt } from "./devices";
import { isRootBridge } from "./stp";
import { memoPortModes } from "./normalise";
import { getVlanForDevice } from "./simulation";
import { frameLabel, frameColor, frameGlyph, frameCalloutLines, type CalloutToken } from "./frame";

const VLAN_COLORS = [
  "#94a3b8",  // VLAN 1 — slate (default, muted)
  "#f59e0b",  // amber
  "#3b82f6",  // blue
  "#10b981",  // emerald
  "#a78bfa",  // violet
  "#f43f5e",  // rose
  "#06b6d4",  // cyan
];

function vlanColor(vlanId: number): string {
  if (vlanId <= 1) return VLAN_COLORS[0];
  return VLAN_COLORS[((vlanId - 2) % (VLAN_COLORS.length - 1)) + 1];
}

// Hoisted font strings — set on ctx.font many times per frame in the draw loop.
const FONT_LABEL = "700 13px Inter, system-ui, sans-serif";
const FONT_SECONDARY = "600 11px Inter, system-ui, sans-serif";
const FONT_SMALL = "600 10px Inter, system-ui, sans-serif";
const FONT_TRANSIT = "bold 10px Inter, system-ui, sans-serif";
const FONT_TRANSIT_GLYPH = "bold 8px Inter, system-ui, sans-serif";

const canvas = dom.canvas;
const ctx = dom.ctx;

export function resizeCanvas(): void {
  if (!ctx) return;   // no 2D context (e.g. headless tests) — nothing to size or draw
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

export function screenToWorld(point: { x: number; y: number }): { x: number; y: number } {
  return {
    x: (point.x - state.pan.x) / state.scale,
    y: (point.y - state.pan.y) / state.scale
  };
}

// Inverse of screenToWorld: a world point → canvas-relative pixels (add the
// canvas bounding rect's left/top for viewport coords). Used by the tutorial
// to place its faux cursor over devices.
export function worldToScreen(point: { x: number; y: number }): { x: number; y: number } {
  return {
    x: point.x * state.scale + state.pan.x,
    y: point.y * state.scale + state.pan.y
  };
}


export function setZoom(nextScale: number, anchor: { x: number; y: number }): void {
  const before = screenToWorld(anchor);
  state.scale = Math.min(2.5, Math.max(0.25, nextScale));
  state.pan.x = anchor.x - before.x * state.scale;
  state.pan.y = anchor.y - before.y * state.scale;
  syncZoomLevel();
  render();
}

export function syncZoomLevel(): void {
  dom.zoomLevel.textContent = `${Math.round(state.scale * 100)}%`;
}

export function linkColorFor(from: Device, to: Device): string {
  if (from.type === "router" && to.type === "router") return cssColor("--link-router");
  if (from.type === "switch" || to.type === "switch") {
    if (!isHost(from.type) && !isHost(to.type)) return cssColor("--link-switch");
  }
  return cssColor("--link-host");
}

export interface DevicePalette { fill: string; stroke: string; accent: string; dark: string }

export function devicePalette(type: string): DevicePalette {
  const v = DEVICE_SPECS[type as DeviceType]?.paletteVar ?? "switch";
  return {
    fill: cssColor(`--${v}-fill`),
    stroke: cssColor(`--${v}-stroke`),
    accent: cssColor(`--${v}-accent`),
    dark: cssColor(`--${v}-icon`)
  };
}

// Exported for benchmarking the per-frame render cost (memoised port-mode read).
export function isTrunkLink(from: Device, to: Device): boolean {
  function hasTrunkPort(sw: Device, peerId: string): boolean {
    if (sw.type !== "switch" || !sw.config?.managed) return false;
    const portModes = memoPortModes(sw.config.portModes);
    const ports = linkedPortsFor(sw.id);
    const idx = ports.findIndex((p) => p?.peer?.id === peerId);   // linkedPortsFor can be sparse (null gaps)
    if (idx < 0) return false;
    return (portModes[`Ethernet${idx + 1}`] || "access") === "trunk";
  }
  return hasTrunkPort(from, to.id) || hasTrunkPort(to, from.id);
}

// The non-colour, always-drawn partner for a link's state. Colour alone is not
// perceivable by everyone (CLAUDE.md), so an unauthenticated WiFi link, a failed
// or secured MACsec link and a shut/blocked link each carry a midpoint text
// marker. Precedence mirrors the colour precedence in drawLink. Pure and exported
// so the precedence is unit-testable — drawLink itself needs a live canvas.
export function linkStatusLabel(
  s: { shut?: boolean; unauth?: boolean; blocked?: boolean; macsec?: string | null },
): { text: string; tone: "danger" | "stp" | "secure" | "muted" } | null {
  if (s.shut) return { text: "down", tone: "danger" };
  if (s.unauth) return { text: "auth failed", tone: "danger" };
  if (s.macsec === "failed") return { text: "MACsec ✗", tone: "danger" };
  if (s.blocked) return { text: "STP blocked", tone: "stp" };
  if (s.macsec === "secured") return { text: "MACsec ✓", tone: "secure" };
  return null;
}

// A link's canvas label: its name, then a non-default latency and loss, then
// the state marker — "WAN · 40 ms · 5% loss · down". Latency and loss are text,
// not a colour (they were inspector-only). "" = no label: an unnamed, healthy
// link at the default latency and loss is drawn as it always was. Pure and
// exported for the tests — drawLink itself needs a live canvas.
export function linkLabelText(link: Pick<Link, "name" | "latency" | "loss">, statusText: string | null = null): string {
  const parts: string[] = [];
  if (link.name) parts.push(link.name);
  const latency = Number(link.latency);
  if (latency > 0) parts.push(`${roundForLabel(latency)} ms`);
  const loss = Number(link.loss);
  if (loss > 0) parts.push(`${roundForLabel(Math.min(100, loss))}% loss`);
  if (statusText) parts.push(statusText);
  return parts.join(" · ");
}

// At most two decimals: a typed 2.5 ms stays 2.5, a float artefact does not show.
const roundForLabel = (n: number): string => String(Math.round(n * 100) / 100);

export function drawLink(link: Link): void {
  const from = getDevice(link.from);
  const to = getDevice(link.to);
  if (!isVisibleDevice(from) || !isVisibleDevice(to) || link.hidden) return;
  const linkSelected = state.selectedLinkId === link.id;
  const active = linkSelected || state.selectedId === from.id || state.selectedId === to.id || state.linkStartId === from.id || state.linkStartId === to.id;
  // Cross-link: a selected packet-list row glows its wire amber (matches the
  // inspected-frame transit dot), so the row and the canvas point at each other.
  const captureLink = state.inspectedCapture?.linkId === link.id;
  const shut = !!link.shutdown;
  const wireless = !!link.wireless;
  // A wireless association with a wrong password never authenticates — draw it
  // red/dotted so it's clearly not a working link.
  const unauth = wireless && !wifiLinkAuthenticated(link);
  // A spanning-tree alternate port blocks this link to break a loop. Drawn amber
  // and dashed (distinct from shut/failed red) — present but not carrying data.
  const blocked = !!link.stpBlocked && !shut && !unauth;
  // MACsec: a secured link is teal; one that can't secure (must-secure mismatch) is red.
  const macsec = macsecState(link);
  const linkColor = captureLink ? colors.selected : active ? cssColor("--link-active")
    : (shut || unauth || macsec === "failed") ? cssColor("--danger")
    : blocked ? cssColor("--stp-block")
    : macsec === "secured" ? "#14b8a6"
    : linkColorFor(from, to);
  const dimmed = from.poweredOff || to.poweredOff;
  const trunk = isTrunkLink(from, to);

  ctx.save();
  if (dimmed) ctx.globalAlpha = 0.3;
  else if (shut) ctx.globalAlpha = 0.6; // administratively down — drawn faint + dashed
  else if (blocked) ctx.globalAlpha = 0.7; // STP-blocked — faint + dashed (not carrying data)
  else if (wireless) ctx.globalAlpha = 0.85;
  if (captureLink) { ctx.shadowColor = colors.selected; ctx.shadowBlur = 12; }
  ctx.strokeStyle = linkColor;
  ctx.lineWidth = captureLink ? 4 : active ? 3 : 2;
  if (shut) ctx.setLineDash([6, 5]);
  else if (blocked) ctx.setLineDash([11, 5]); // dashed, distinct from shut's tighter pattern
  else if (wireless) ctx.setLineDash([2, 6]); // a WiFi association — dotted, not a cable

  if (trunk) {
    // Double line for trunk links
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * 2.5;
    const ny = dx / len * 2.5;
    ctx.beginPath();
    ctx.moveTo(from.x + nx, from.y + ny);
    ctx.lineTo(to.x + nx, to.y + ny);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(from.x - nx, from.y - ny);
    ctx.lineTo(to.x - nx, to.y - ny);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }

  ctx.setLineDash([]);
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  ctx.fillStyle = (active || captureLink) ? linkColor : cssColor("--canvas-bg");
  ctx.strokeStyle = linkColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(midX, midY, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Label: an explicit name (opt-in canvas label), a non-default latency/loss,
  // plus a non-colour state marker ("down", "auth failed", "MACsec ✗/✓", "STP
  // blocked") — linkLabelText. Drawn unconditionally — like "down"/"STP
  // blocked" always were — so selecting an endpoint (which repaints the wire
  // the active colour) can no longer hide the cue.
  const status = linkStatusLabel({ shut, unauth, blocked, macsec });
  const label = linkLabelText(link, status?.text ?? null);
  if (label) {
    ctx.globalAlpha = 1;
    ctx.font = FONT_SMALL;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = status
      ? status.tone === "danger" ? cssColor("--danger")
        : status.tone === "stp" ? cssColor("--stp-block")
        : status.tone === "secure" ? "#14b8a6"
        : cssColor("--muted")
      : cssColor("--muted");
    ctx.fillText(label, midX, midY - 8);
  }
  ctx.restore();
}

// Draws any device body + icon from its registry spec (size, radius, paths).
export function drawIconDevice(device: Device, palette: DevicePalette): void {
  const spec = DEVICE_SPECS[device.type as DeviceType] ?? DEVICE_SPECS.switch;
  const radius = spec.iconRadius;
  const x = device.x - device.width / 2;
  const y = device.y - device.height / 2;
  ctx.fillStyle = palette.fill;
  ctx.strokeStyle = palette.stroke;
  ctx.lineWidth = 2;
  roundRect(x, y, device.width, device.height, radius);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = palette.accent;
  roundRect(x + 10, y + 10, device.width - 20, device.height - 20, Math.max(5, radius - 3));
  ctx.fill();

  drawTablerIcon(device.x, device.y, spec.iconPaths, palette.dark, Math.min(device.width, device.height) - 22, spec.iconStrokeWidth ?? 1.7);
}

// Icon paths are static compiled-in strings; build each Path2D once and reuse it
// every frame rather than reallocating per path, per device, per animation tick.
const _path2dCache = new Map<string, Path2D>();
function path2dFor(path: string): Path2D {
  let p = _path2dCache.get(path);
  if (!p) { p = new Path2D(path); _path2dCache.set(path, p); }
  return p;
}

export function drawTablerIcon(centerX: number, centerY: number, paths: string[], color: string, size: number, strokeWidth = 1.7): void {
  const scale = size / 24;
  ctx.save();
  ctx.translate(centerX - size / 2, centerY - size / 2);
  ctx.scale(scale, scale);
  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.fillStyle = "transparent";
  paths.forEach(path => {
    ctx.stroke(path2dFor(path));
  });
  ctx.restore();
}

export function drawManagedBadge(device: Device, palette: DevicePalette): void {
  const x = device.x + device.width / 2 - 18;
  const y = device.y - device.height / 2 + 18;
  ctx.save();
  ctx.fillStyle = cssColor("--panel");
  ctx.strokeStyle = palette.stroke;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = palette.dark;
  ctx.lineWidth = 1.2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = 0; i < 8; i++) {
    const angle = i * Math.PI / 4;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(angle) * 6, y + Math.sin(angle) * 6);
    ctx.lineTo(x + Math.cos(angle) * 8, y + Math.sin(angle) * 8);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// The spanning-tree root bridge carries a small indigo "R" badge (top-left, so
// it doesn't collide with the managed badge top-right). Indigo ties it to BPDUs.
function drawRootBridgeBadge(device: Device): void {
  const x = device.x - device.width / 2 + 18;
  const y = device.y - device.height / 2 + 18;
  ctx.save();
  ctx.fillStyle = "#818cf8";
  ctx.strokeStyle = cssColor("--panel");
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("R", x, y + 0.5);
  ctx.restore();
}

// A border/edge router carries a small amber "B" badge (top-right) — it faces
// the outside, the natural place for NAT + a firewall.
function drawBorderBadge(device: Device): void {
  const x = device.x + device.width / 2 - 18;
  const y = device.y - device.height / 2 + 18;
  ctx.save();
  ctx.fillStyle = "#f59e0b";
  ctx.strokeStyle = cssColor("--panel");
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#1a1208";
  ctx.font = "bold 12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("B", x, y + 0.5);
  ctx.restore();
}

function drawDeviceIcon(device: Device): void {
  if (device.hidden) return;
  const selected = state.selectedId === device.id;
  const linking = state.linkStartId === device.id;
  const cap = state.inspectedCapture;
  const captureEndpoint = !!cap && (cap.fromDeviceId === device.id || cap.toDeviceId === device.id);
  const palette = devicePalette(device.type);

  ctx.save();
  if (device.poweredOff) ctx.globalAlpha = 0.35;
  if (selected || linking || captureEndpoint) {
    // captureEndpoint (a cross-linked packet's wire end) glows amber like the wire.
    ctx.strokeStyle = (selected || captureEndpoint) ? colors.selected : cssColor("--link-active");
    ctx.lineWidth = 4;
    if (captureEndpoint && !selected) { ctx.shadowColor = colors.selected; ctx.shadowBlur = 10; }
    ctx.setLineDash(linking && !selected && !captureEndpoint ? [7, 5] : []);
    roundRect(device.x - device.width / 2 - 7, device.y - device.height / 2 - 7, device.width + 14, device.height + 14, 12);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawIconDevice(device, palette);
  if (device.type === "switch" && device.config?.managed) drawManagedBadge(device, palette);
  if (device.type === "switch" && isRootBridge(device)) drawRootBridgeBadge(device);
  if (device.type === "router" && device.config?.role === "border") drawBorderBadge(device);
  ctx.restore();
}

export function drawDevice(device: Device): void {
  if (device.hidden) return;

  ctx.save();
  if (device.poweredOff) ctx.globalAlpha = 0.35;

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  let labelY = device.y + device.height / 2 + 10;
  if (state.options.showDeviceNames) {
    ctx.fillStyle = cssColor("--label-primary");
    ctx.font = FONT_LABEL;
    const label = clampText(device.name, device.width + 10);
    ctx.fillText(label, device.x, labelY);
    labelY += 17;
  }
  if (isHost(device.type) && state.options.showIpAddresses) {
    ctx.font = FONT_SECONDARY;
    if (device.config?.ipv4Address) {
      ctx.fillStyle = cssColor("--label-ip");
      ctx.fillText(`${device.config.ipv4Address}/${prefixOf(device.config)}`, device.x, labelY);
    } else {
      // No address yet — flag it on the topology, not just in the inspector.
      ctx.fillStyle = cssColor("--muted");
      ctx.fillText("unassigned", device.x, labelY);
    }
    labelY += 15;
  }
  if (isHost(device.type) && state.options.showMacAddresses && device.config?.macAddress) {
    ctx.fillStyle = cssColor("--label-mac");
    ctx.font = FONT_SMALL;
    ctx.fillText(device.config.macAddress, device.x, labelY);
    labelY += 13;
  }
  // VLAN label for hosts (computers and servers)
  if (isHost(device.type) && state.options.showIpAddresses) {
    const vlan = getVlanForDevice(device.id);
    if (vlan > 1) {
      const color = vlanColor(vlan);
      ctx.font = FONT_SMALL; // set before measureText so the dot offset matches the label font
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(device.x - ctx.measureText(`VLAN ${vlan}`).width / 2 - 8, labelY + 5, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(`VLAN ${vlan}`, device.x + 2, labelY);
      labelY += 13;
    }
  }
  // VLAN dots for managed switches
  if (device.type === "switch" && device.config?.managed && state.options.showIpAddresses) {
    const vlans = (device.config.vlans || []).filter((v) => v.id !== 1);
    if (vlans.length > 0) {
      const dotRadius = 3.5;
      const dotSpacing = 12;
      const totalWidth = vlans.length * dotSpacing - (dotSpacing - dotRadius * 2);
      let dotX = device.x - totalWidth / 2 + dotRadius;
      for (const vlan of vlans) {
        ctx.fillStyle = vlanColor(vlan.id);
        ctx.beginPath();
        ctx.arc(dotX, labelY + 5, dotRadius, 0, Math.PI * 2);
        ctx.fill();
        dotX += dotSpacing;
      }
      labelY += 14;
    }
  }
  // The SSID an access point broadcasts — its defining property — shown with the
  // device name. Whether it is secured lives in the inspector / `show` output.
  if (device.type === "access-point" && state.options.showDeviceNames && device.config?.ssid) {
    ctx.fillStyle = cssColor("--label-ip");
    ctx.font = FONT_SECONDARY;
    ctx.fillText(device.config.ssid, device.x, labelY);
    labelY += 15;
  }
  // Only build the (allocation-heavy) interface list when a label toggle that
  // would actually render it is on — otherwise the result is discarded.
  if (device.type === "router" && (state.options.showIpAddresses || state.options.showMacAddresses)) {
    const ifaces = routerInterfacesWithNames(device);
    for (const iface of ifaces) {
      if (!iface.peer) continue;
      if (state.options.showIpAddresses && iface.config.ipv4Address) {
        ctx.fillStyle = cssColor("--label-ip");
        ctx.font = FONT_SECONDARY;
        ctx.fillText(`${iface.name}: ${iface.config.ipv4Address}/${prefixOf(iface.config)}`, device.x, labelY);
        labelY += 15;
      }
      if (state.options.showMacAddresses && iface.config.macAddress) {
        ctx.fillStyle = cssColor("--label-mac");
        ctx.font = FONT_SMALL;
        ctx.fillText(iface.config.macAddress, device.x, labelY);
        labelY += 13;
      }
    }
  }
  ctx.restore();
}

// How see-through the placement ghost is. Faint enough to read as "not there
// yet" over the grid in every theme, solid enough that the icon is recognisable.
export const PLACEMENT_GHOST_ALPHA = 0.55;

// While a placement tool is armed, a translucent copy of the device a click
// would drop follows the cursor, centred where the device would land (issue #3).
// It says what is about to be placed — the icon, the managed / border badge, and
// the name it will get, which is what tells the server presets apart — and that
// the canvas is still in place mode.
//
// Two cases keep it from fighting what is already drawn. Straight after a click
// the cursor is still exactly where the device was dropped, and a ghost there
// would wash the new device out (its translucent body over the real icon) — so
// nothing is drawn until the cursor moves off that spot. And while the cursor is
// anywhere on an existing device the name is left off, since two names would
// print over each other.
function drawPlacementGhost(): void {
  if (!state.pointer) return;
  const world = screenToWorld(state.pointer);
  const ghost = placementPreview(state.tool, world.x, world.y);
  if (!ghost) return;
  if (state.devices.some(d => !d.hidden && Math.abs(d.x - world.x) < 0.5 && Math.abs(d.y - world.y) < 0.5)) return;
  const palette = devicePalette(ghost.type);
  ctx.save();
  ctx.globalAlpha = PLACEMENT_GHOST_ALPHA;
  drawIconDevice(ghost, palette);
  if (ghost.type === "switch" && ghost.config?.managed) drawManagedBadge(ghost, palette);
  if (ghost.type === "router" && ghost.config?.role === "border") drawBorderBadge(ghost);
  if (state.options.showDeviceNames && !findDeviceAt(world)) {
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = cssColor("--label-primary");
    ctx.font = FONT_LABEL;
    ctx.fillText(clampText(ghost.name, ghost.width + 10), ghost.x, ghost.y + ghost.height / 2 + 10);
  }
  ctx.restore();
}

export function clampText(text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let next = text;
  while (next.length > 1 && ctx.measureText(`${next}...`).width > maxWidth) {
    next = next.slice(0, -1);
  }
  return `${next}...`;
}

export function roundRect(x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

export function render(): void {
  if (!ctx) return;  // no 2D context (e.g. headless/test) — nothing to draw
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.save();
  ctx.translate(state.pan.x, state.pan.y);
  ctx.scale(state.scale, state.scale);

  canvas.style.backgroundPosition = `${state.pan.x}px ${state.pan.y}px`;
  const gridMajor = 80 * state.scale;
  const gridMinor = 20 * state.scale;
  canvas.style.backgroundSize = `${gridMajor}px ${gridMajor}px, ${gridMajor}px ${gridMajor}px, ${gridMinor}px ${gridMinor}px, ${gridMinor}px ${gridMinor}px`;

  state.links.forEach(drawLink);
  if (state.tool === "connect" && state.linkStartId && state.pointer) {
    const from = getDevice(state.linkStartId);
    const to = screenToWorld(state.pointer);
    if (from) {
      ctx.strokeStyle = cssColor("--link-active");
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  drawFrameTransits();
  state.devices.forEach(drawDeviceIcon);
  state.devices.forEach(drawDevice);
  drawPlacementGhost();
  ctx.restore();
}

// Hit-test a world point against the transit dots (click-a-packet inspector).
// Where a device is DRAWN: itself, or — when a collapsed LAN hides it — the LAN
// cloud standing in for it (followed outward through nested collapses). A frame
// crossing a hidden cable still runs (collapse is presentation, review R4), so
// its dot is drawn against what's on the canvas: along the LAN ↔ router proxy
// line, and not at all while it stays inside the cloud.
function drawnDevice(device: Device | undefined): Device | undefined {
  for (let hops = 0; device?.hidden && device.collapsedBy && hops < 8; hops++) {
    device = getDevice(device.collapsedBy);
  }
  return device;
}

// A transit's drawn endpoints, or null when there is no visible segment to draw.
function transitEndpoints(transit: ActiveTransit): { from: Device; to: Device } | null {
  const from = drawnDevice(getDevice(transit.fromDeviceId));
  const to = drawnDevice(getDevice(transit.toDeviceId));
  if (!isVisibleDevice(from) || !isVisibleDevice(to) || from === to) return null;
  return { from, to };
}

export function findTransitAt(world: { x: number; y: number }): ActiveTransit | null {
  const transits = state.simulation.transits;
  if (!transits || transits.length === 0) return null;
  // Generous radius; dots are drawn at 7 world units. Scan in reverse so the
  // most recently drawn (topmost) dot wins.
  const HIT = 14;
  for (let i = transits.length - 1; i >= 0; i--) {
    const transit = transits[i];
    const ends = transitEndpoints(transit);
    if (!ends) continue;
    const { from: fromDevice, to: toDevice } = ends;
    const x = fromDevice.x + (toDevice.x - fromDevice.x) * transit.progress;
    const y = fromDevice.y + (toDevice.y - fromDevice.y) * transit.progress;
    if (Math.hypot(world.x - x, world.y - y) <= HIT) return transit;
  }
  return null;
}

// At most this many callouts are drawn at once (the inspected flow first), so a
// busy run stays legible — issue #2 ("cap the callouts, prefer the selected flow").
const CALLOUT_CAP = 6;

// A field callout beside an in-flight frame: up to two lines (network/transport,
// then the MAC pair), with each field the last hop rewrote underlined and marked
// with a leading "✎" — a redundant, not-colour-only channel. The marked tokens
// also pulse (alpha by progress) so a change catches the eye as the dot moves.
function drawPacketCallout(transit: ActiveTransit, x: number, y: number, color: string): void {
  const lines = frameCalloutLines(transit.frame, transit.prevFrame);
  if (!lines.length) return;
  ctx.save();
  ctx.font = FONT_SMALL;
  ctx.textBaseline = "middle";
  const lineH = 13;
  const padX = 6, padY = 4;
  // Measure the widest line (a changed token carries a leading "✎ ").
  const widthOf = (toks: CalloutToken[]) => toks.reduce((w, tk) => w + ctx.measureText((tk.changed ? "✎" : "") + tk.t).width, 0);
  const boxW = Math.max(...lines.map(widthOf)) + padX * 2;
  const boxH = lines.length * lineH + padY * 2;
  // Sit to the lower-right of the dot, clear of the frameLabel drawn above it.
  const bx = x + 12, by = y + 10;
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = cssColor("--panel");
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  roundRect(bx, by, boxW, boxH, 5);
  ctx.fill();
  ctx.stroke();
  // A changed token pulses between ~0.55 and 1 as the dot crosses.
  const pulse = 0.55 + 0.45 * Math.abs(Math.sin(transit.progress * Math.PI * 3));
  lines.forEach((toks, i) => {
    const ly = by + padY + i * lineH + lineH / 2;
    let lx = bx + padX;
    for (const tk of toks) {
      // A rewritten field (✎, pulsing) takes precedence over an echoed one (↩):
      // a reply's echoed field is tinted and carries a marker so the request ⇄
      // reply correspondence reads without relying on colour (issue #2).
      const echoed = tk.echoed && !tk.changed;
      const text = (tk.changed ? "✎" : echoed ? "↩" : "") + tk.t;
      ctx.globalAlpha = tk.changed ? pulse : 0.92;
      ctx.fillStyle = cssColor(tk.changed ? "--label-primary" : echoed ? "--label-ip" : "--muted");
      ctx.textAlign = "left";
      ctx.fillText(text, lx, ly);
      const w = ctx.measureText(text).width;
      if (tk.changed) {   // underline: the colour-independent marker
        ctx.strokeStyle = cssColor("--label-primary");
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(lx, ly + 6);
        ctx.lineTo(lx + w, ly + 6);
        ctx.stroke();
      }
      lx += w;
    }
  });
  ctx.restore();
}

function drawFrameTransits(): void {
  const transits = state.simulation.transits;
  if (!transits || transits.length === 0) return;

  // Callouts (issue #2): choose which transits get one — the inspected frame
  // first, then the rest, capped so a busy run stays readable.
  const calloutFor = new Set<ActiveTransit>();
  if (state.options.packetCallouts) {
    const drawable = transits.filter(tr => !tr.silent && transitEndpoints(tr));
    drawable.sort((a, b) => Number(b.frame.id === state.inspectedFrame?.id) - Number(a.frame.id === state.inspectedFrame?.id));
    for (const tr of drawable.slice(0, CALLOUT_CAP)) calloutFor.add(tr);
  }

  for (const transit of transits) {
    if (transit.silent) continue; // resolved silently — delivered without a visible dot
    const ends = transitEndpoints(transit);
    if (!ends) continue;
    const { from: fromDevice, to: toDevice } = ends;

    const t = transit.progress;
    const x = fromDevice.x + (toDevice.x - fromDevice.x) * t;
    const y = fromDevice.y + (toDevice.y - fromDevice.y) * t;

    const color = frameColor(transit.frame);
    const label = frameLabel(transit.frame);

    // Glow effect
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;

    // Selection ring for the inspected frame
    if (state.inspectedFrame && state.inspectedFrame.id === transit.frame.id) {
      ctx.strokeStyle = colors.selected;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Draw dot
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fill();

    // White core carrying a monochrome per-protocol glyph — the redundant,
    // colour-blind-safe channel so the dot's category doesn't depend on hue
    // ("✕" for an error). Matches the packet list's glyph.
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#0b1220";
    ctx.font = FONT_TRANSIT_GLYPH;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(frameGlyph(transit.frame), x, y + 0.5);

    // Label above
    ctx.fillStyle = color;
    ctx.font = FONT_TRANSIT;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(label, x, y - 13);

    ctx.restore();

    if (calloutFor.has(transit)) drawPacketCallout(transit, x, y, color);
  }
}

export function fitNetwork(): void {
  const rect = canvas.getBoundingClientRect();
  const visibleDevices = state.devices.filter(isVisibleDevice);
  if (!visibleDevices.length) {
    state.pan = { x: rect.width / 2, y: rect.height / 2 };
    state.scale = 1;
    syncZoomLevel();
    render();
    return;
  }

  const bounds = visibleDevices.reduce((acc, device) => ({
    minX: Math.min(acc.minX, device.x - device.width / 2),
    minY: Math.min(acc.minY, device.y - device.height / 2),
    maxX: Math.max(acc.maxX, device.x + device.width / 2),
    maxY: Math.max(acc.maxY, device.y + device.height / 2)
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const scale = Math.min(1.2, rect.width / Math.max(width + 180, 1), rect.height / Math.max(height + 180, 1));
  state.scale = Math.max(0.55, scale);
  state.pan = {
    x: rect.width / 2 - ((bounds.minX + width / 2) * state.scale),
    y: rect.height / 2 - ((bounds.minY + height / 2) * state.scale)
  };
  syncZoomLevel();
  render();
}
