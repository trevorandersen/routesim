/**
 * The port picker — the dialog the Connect tool opens on Shift-click to choose
 * the port at each end of a new cable by hand. Presentation only: the rows come
 * from `buildPortList` (devices.ts, built on the one port-occupancy function)
 * and the cable is made by `addLink`. It lived in devices.ts, the model layer,
 * which had no business building dialog HTML or wiring click handlers.
 */
import type { PortOption } from "./types";
import { state, sync } from "./state";
import { dom } from "./dom";
import { escapeHtml, mutationText } from "./utils";
import { hasSingleNic } from "./device-registry";
import { addLink, buildPortList, classifyLink, getDevice } from "./devices";

export function openPortSelectionModal(fromId: string, toId: string): void {
  const fromDevice = getDevice(fromId);
  const toDevice = getDevice(toId);
  if (!fromDevice || !toDevice) return;

  // A wireless association (laptop ↔ AP) auto-links with no port picker; an
  // invalid laptop pairing is rejected here (addLink surfaces the reason).
  const { reject, wireless } = classifyLink(fromId, toId);
  if (reject || wireless) { dom.modeLabel.textContent = mutationText(addLink(fromId, toId)); return; }

  const showFromPicker = !hasSingleNic(fromDevice.type);
  const showToPicker = !hasSingleNic(toDevice.type);

  // If both are single-port hosts, skip modal entirely
  if (!showFromPicker && !showToPicker) {
    dom.modeLabel.textContent = mutationText(addLink(fromId, toId, 1, 1));
    return;
  }

  const fromPorts = buildPortList(fromId, toId);
  const toPorts = buildPortList(toId, fromId);

  state.portSelection = {
    fromId,
    toId,
    fromPorts,
    toPorts,
    selectedFrom: showFromPicker ? null : 1,
    selectedTo: showToPicker ? null : 1,
    showFromPicker,
    showToPicker
  };

  // Auto-select first available port for non-picker side
  syncPortSelectionModal();
  dom.portSelectionOverlay.classList.add("open");
}

export function syncPortSelectionModal(): void {
  const ps = state.portSelection;
  if (!ps) return;

  const fromDevice = getDevice(ps.fromId);
  const toDevice = getDevice(ps.toId);
  if (!fromDevice || !toDevice) return;

  const columns: string[] = [];

  if (ps.showFromPicker) {
    columns.push(renderPortColumn(fromDevice.name, ps.fromPorts, ps.selectedFrom, "from"));
  }
  if (ps.showToPicker) {
    columns.push(renderPortColumn(toDevice.name, ps.toPorts, ps.selectedTo, "to"));
  }

  const singleColumn = !ps.showFromPicker || !ps.showToPicker;
  dom.portSelectionBody.className = `port-selection-body${singleColumn ? " single-column" : ""}`;
  dom.portSelectionBody.innerHTML = columns.join("");

  // Wire click handlers
  dom.portSelectionBody.querySelectorAll(".port-option:not(.occupied)").forEach(btn => {
    btn.addEventListener("click", () => {
      const side = (btn as HTMLElement).dataset.side;
      const port = Number((btn as HTMLElement).dataset.port);
      if (side === "from") {
        state.portSelection!.selectedFrom = port;
      } else {
        state.portSelection!.selectedTo = port;
      }
      syncPortSelectionModal();
    });
  });

  // Update confirm button state
  const canConfirm = ps.selectedFrom != null && ps.selectedTo != null;
  dom.portSelectionConfirm.disabled = !canConfirm;
}

function renderPortColumn(deviceName: string, ports: PortOption[], selected: number | null, side: string): string {
  return `<div class="port-column">
    <div class="port-column-header">${escapeHtml(deviceName)}</div>
    ${ports.map(p => {
      const classes = ["port-option"];
      if (!p.available) classes.push("occupied");
      if (p.port === selected) classes.push("selected");
      const status = p.connectedTo ? `Connected to ${escapeHtml(p.connectedTo)}` : "Available";
      return `<button class="${classes.join(" ")}" data-side="${side}" data-port="${p.port}">
        <span class="port-name">${escapeHtml(p.name)}</span>
        <span class="port-status">${status}</span>
      </button>`;
    }).join("")}
  </div>`;
}

export function confirmPortSelection(): void {
  const ps = state.portSelection;
  if (!ps || ps.selectedFrom == null || ps.selectedTo == null) return;
  const result = addLink(ps.fromId, ps.toId, ps.selectedFrom, ps.selectedTo);
  cancelPortSelection();
  dom.modeLabel.textContent = mutationText(result);
}

export function cancelPortSelection(): void {
  state.portSelection = null;
  dom.portSelectionOverlay.classList.remove("open");
  state.linkStartId = null;
  sync().render();
}
