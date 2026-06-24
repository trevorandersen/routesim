import type { DeviceType, ActiveTransit } from "./types";
import { state, colors } from "./state";
import { dom } from "./dom";
import { cssColor, prefixOf } from "./utils";
import { DEVICE_SPECS } from "./device-registry";
import { getDevice, isVisibleDevice, routerInterfacesWithNames, linkedPortsFor, wifiLinkAuthenticated, macsecState } from "./devices";
import { isRootBridge } from "./stp";
import { memoPortModes } from "./normalise";
import { getVlanForDevice } from "./simulation";
import { frameLabel, frameColor } from "./frame";

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

const canvas = dom.canvas;
const ctx = dom.ctx;

export function resizeCanvas(): void {
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

const HOST_TYPES = new Set(["computer", "laptop", "server"]);

export function linkColorFor(from: any, to: any): string {
  if (from.type === "router" && to.type === "router") return cssColor("--link-router");
  if (from.type === "switch" || to.type === "switch") {
    if (!HOST_TYPES.has(from.type) && !HOST_TYPES.has(to.type)) return cssColor("--link-switch");
  }
  return cssColor("--link-host");
}

export function devicePalette(type: string): { fill: string; stroke: string; accent: string; dark: string } {
  const v = DEVICE_SPECS[type as DeviceType]?.paletteVar ?? "switch";
  return {
    fill: cssColor(`--${v}-fill`),
    stroke: cssColor(`--${v}-stroke`),
    accent: cssColor(`--${v}-accent`),
    dark: cssColor(`--${v}-icon`)
  };
}

// Exported for benchmarking the per-frame render cost (memoised port-mode read).
export function isTrunkLink(from: any, to: any): boolean {
  function hasTrunkPort(sw: any, peerId: string): boolean {
    if (sw.type !== "switch" || !sw.config?.managed) return false;
    const portModes = memoPortModes(sw.config.portModes);
    const ports = linkedPortsFor(sw.id);
    const idx = ports.findIndex((p: any) => p.peer.id === peerId);
    if (idx < 0) return false;
    return (portModes[`Ethernet${idx + 1}`] || "access") === "trunk";
  }
  return hasTrunkPort(from, to.id) || hasTrunkPort(to, from.id);
}

export function drawLink(link: any): void {
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

  // Label: an explicit name (opt-in canvas label), plus a "down"/"blocked" marker.
  const labelParts: string[] = [];
  if (link.name) labelParts.push(link.name);
  if (shut) labelParts.push("down");
  else if (blocked) labelParts.push("STP blocked");
  if (labelParts.length) {
    ctx.globalAlpha = 1;
    ctx.font = FONT_SMALL;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = shut ? cssColor("--danger") : blocked ? cssColor("--stp-block") : cssColor("--muted");
    ctx.fillText(labelParts.join(" · "), midX, midY - 8);
  }
  ctx.restore();
}

// Draws any device body + icon from its registry spec (size, radius, paths).
export function drawIconDevice(device: any, palette: any): void {
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

export function drawManagedBadge(device: any, palette: any): void {
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
function drawRootBridgeBadge(device: any): void {
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

function drawDeviceIcon(device: any): void {
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
  ctx.restore();
}

export function drawDevice(device: any): void {
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
  if (HOST_TYPES.has(device.type) && state.options.showIpAddresses) {
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
  if (HOST_TYPES.has(device.type) && state.options.showMacAddresses && device.config?.macAddress) {
    ctx.fillStyle = cssColor("--label-mac");
    ctx.font = FONT_SMALL;
    ctx.fillText(device.config.macAddress, device.x, labelY);
    labelY += 13;
  }
  // VLAN label for hosts (computers and servers)
  if (HOST_TYPES.has(device.type) && state.options.showIpAddresses) {
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
    const vlans = (device.config.vlans || []).filter((v: any) => v.id !== 1);
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
  ctx.restore();
}

// Hit-test a world point against the transit dots (click-a-packet inspector).
export function findTransitAt(world: { x: number; y: number }): ActiveTransit | null {
  const transits = state.simulation.transits;
  if (!transits || transits.length === 0) return null;
  // Generous radius; dots are drawn at 7 world units. Scan in reverse so the
  // most recently drawn (topmost) dot wins.
  const HIT = 14;
  for (let i = transits.length - 1; i >= 0; i--) {
    const transit = transits[i];
    const fromDevice = getDevice(transit.fromDeviceId);
    const toDevice = getDevice(transit.toDeviceId);
    if (!fromDevice || !toDevice) continue;
    const x = fromDevice.x + (toDevice.x - fromDevice.x) * transit.progress;
    const y = fromDevice.y + (toDevice.y - fromDevice.y) * transit.progress;
    if (Math.hypot(world.x - x, world.y - y) <= HIT) return transit;
  }
  return null;
}

function drawFrameTransits(): void {
  const transits = state.simulation.transits;
  if (!transits || transits.length === 0) return;

  for (const transit of transits) {
    if (transit.silent) continue; // resolved silently — delivered without a visible dot
    const fromDevice = getDevice(transit.fromDeviceId);
    const toDevice = getDevice(transit.toDeviceId);
    if (!fromDevice || !toDevice) continue;

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
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();

    // White inner dot
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();

    // Label above
    ctx.fillStyle = color;
    ctx.font = FONT_TRANSIT;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(label, x, y - 12);

    ctx.restore();
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
