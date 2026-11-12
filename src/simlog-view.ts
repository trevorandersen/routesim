/**
 * The Sim Log pane — a Wireshark-style packet list (default) or the narrative
 * event log, with the display-filter toolbar and the saved-capture bar.
 * Presentation only: it reads the run's capture and log from `state` and the
 * filter model from packet-filter.ts. It used to live in engine.ts, which made
 * the simulation engine a renderer and tied it to the dock UI; the engine now
 * asks for a redraw through the `syncSimLog` callback (state.ts), like every
 * other view.
 */
import type { CaptureEntry, LogFilter } from "./types";
import type { FilterRow } from "./packet-filter";
import { state } from "./state";
import { dom } from "./dom";
import { escapeHtml } from "./utils";
import { getDevice, linkById, linkName } from "./devices";
import { packetColumns, toneGlyph } from "./frame";
import { applyLogFilter, presentTokens, isFilterActive, PROTOCOL_CHIPS } from "./packet-filter";
import { captureEntriesFor } from "./engine";
import { syncSimLogBadge } from "./terminal";

// The sim-log pane: a Wireshark-style packet list (default) or the narrative
// event log, switched by the Packets/Events toggle (state.dock.logView). The
// packet list honours the display filter (state.dock.logFilter; packet-filter.ts).
let presentTokenCache: Set<string> = new Set();
// Device ids that appear as a wire endpoint across the currently displayed
// pane(s) — drives the device-filter dropdown (set in syncSimLog).
let presentDeviceIds: Set<string> = new Set();

// One capture's worth of rows to show: the live run, or a saved run.
interface CapturePane { id: string; label: string; entries: CaptureEntry[]; }

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
