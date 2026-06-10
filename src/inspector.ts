import type { Link, DeviceType } from "./types";
import { state, sync, pushUndo, captureUndoOnFocus } from "./state";
import { DEVICE_SPECS } from "./device-registry";
import { dom } from "./dom";
import { escapeHtml, isValidIpv4, isValidMac, normaliseMacAddress, randomMac, parseIpv4Token } from "./utils";
import { ensureConfig, normaliseVlans } from "./normalise";
import {
  getDevice, isVisibleDevice, connectedIds, linkedPortsFor,
  routerInterfacesWithNames, routerInterfaceFor, switchInterfacesWithNames,
  deleteSelection, collapseLan, expandLan, configureDevice
} from "./devices";
import {
  openTerminalFor, syncTerminal,
  addSwitchVlan, removeSwitchVlan, setSwitchPortVlan, setSwitchPortMode, setSwitchTrunkNative
} from "./terminal";
import { resizeCanvas } from "./canvas";
import { frameLabel } from "./frame";

export function syncOptionControls(): void {
  dom.showDeviceNames.checked = state.options.showDeviceNames;
  dom.showIpAddresses.checked = state.options.showIpAddresses;
  dom.showMacAddresses.checked = state.options.showMacAddresses;
}

export function syncNetworkPanel(): void {
  document.body.classList.toggle("inspector-closed", !state.options.networkPanelOpen);
  dom.inspectorOpenButton.setAttribute("aria-expanded", String(state.options.networkPanelOpen));
  requestAnimationFrame(resizeCanvas);
}

export function setNetworkPanel(open: boolean): void {
  state.options.networkPanelOpen = open;
  syncNetworkPanel();
}

export function setInspectorWidth(width: number): void {
  state.inspectorWidth = Math.min(520, Math.max(260, width));
  document.documentElement.style.setProperty("--inspector-width", `${state.inspectorWidth}px`);
  requestAnimationFrame(resizeCanvas);
}

export function startInspectorResize(event: PointerEvent): void {
  event.preventDefault();
  state.inspectorResize = {
    startX: event.clientX,
    startWidth: state.inspectorWidth
  };
  document.body.classList.add("resizing-inspector");
}

export function moveInspectorResize(event: PointerEvent): void {
  if (!state.inspectorResize) return;
  setInspectorWidth(state.inspectorResize.startWidth + state.inspectorResize.startX - event.clientX);
}

export function stopInspectorResize(): void {
  if (!state.inspectorResize) return;
  state.inspectorResize = null;
  document.body.classList.remove("resizing-inspector");
}

function vlanOptions(device: any, current: number): string {
  const vlans = normaliseVlans(device.config?.vlans || []);
  if (!vlans.some((v: any) => v.id === current)) vlans.push({ id: current, name: current === 1 ? "default" : `Vlan${current}` });
  return vlans
    .sort((a: any, b: any) => a.id - b.id)
    .map((v: any) => `<option value="${v.id}" ${v.id === current ? "selected" : ""}>VLAN ${v.id}</option>`)
    .join("");
}

export function renderSwitchVlans(device: any): string {
  const vlans = normaliseVlans(device.config?.vlans || []);
  const chips = vlans.map((v: any) => `
    <span class="vlan-chip">
      ${v.id} ${escapeHtml(v.name)}
      ${v.id !== 1 ? `<button class="vlan-remove" data-vlan="${v.id}" type="button" title="Remove VLAN ${v.id}" aria-label="Remove VLAN ${v.id}">&times;</button>` : ""}
    </span>
  `).join("");
  return `
    <div class="vlan-list">
      ${chips}
      <span class="vlan-add">
        <input id="addVlanId" type="number" min="2" max="4094" step="1" placeholder="VLAN ID" autocomplete="off">
        <button class="inline-button" id="addVlanBtn" type="button">Add</button>
      </span>
    </div>
  `;
}

export function renderSwitchPorts(device: any): string {
  const interfaces = switchInterfacesWithNames(device);
  const isManaged = Boolean(device.config?.managed);
  const ports = linkedPortsFor(device.id);
  return interfaces.map((iface: any, index: number) => {
    const port = ports[index];
    const peer = port?.peer;
    const removeButton = port ? `
      <button class="port-remove" data-link-id="${escapeHtml(port.link.id)}" title="Remove link to ${escapeHtml(peer.name)}" aria-label="Remove link to ${escapeHtml(peer.name)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>
      </button>
    ` : `<span></span>`;
    const modeControl = isManaged ? `
      <select class="port-mode-select" data-port="${escapeHtml(iface.name)}" title="Port mode">
        <option value="access" ${iface.mode === "trunk" ? "" : "selected"}>access</option>
        <option value="trunk" ${iface.mode === "trunk" ? "selected" : ""}>trunk</option>
      </select>
      ${iface.mode === "trunk"
        ? `<select class="port-native-select" data-port="${escapeHtml(iface.name)}" title="Native VLAN">${vlanOptions(device, iface.nativeVlan)}</select>`
        : `<select class="port-vlan-select" data-port="${escapeHtml(iface.name)}" title="Access VLAN">${vlanOptions(device, iface.vlan)}</select>`}
    ` : "";
    return `
      <div class="port-row">
        <span class="port-id">eth${index + 1}</span>
        ${modeControl}
        <span class="port-peer ${peer ? "" : "empty"}">${escapeHtml(peer?.name || "Empty")}</span>
        ${removeButton}
      </div>
    `;
  }).join("");
}

export function renderRouterInterfaces(device: any): string {
  const interfaces = routerInterfacesWithNames(device);
  return `
    <div class="interface-list">
      ${interfaces.map((iface: any) => {
        const vlanAttr = iface.config.vlanTag != null ? ` data-vlan-tag="${iface.config.vlanTag}"` : "";
        return `
          <div class="interface-row">
            <span class="interface-name">${escapeHtml(iface.name)}</span>
            <span class="interface-peer ${iface.peer ? "" : "empty"}" title="${escapeHtml(iface.peer?.name || "Empty")}">${escapeHtml(iface.peer?.name || "Empty")}</span>
            <input class="router-interface-ip" data-peer-id="${escapeHtml(iface.peerId)}"${vlanAttr} ${iface.peer ? "" : "disabled"} value="${escapeHtml(iface.config.ipv4Address || "")}" placeholder="192.168.1.1" autocomplete="off" inputmode="decimal">
          </div>
        `;
      }).join("")}
    </div>
  `;
}

export function renderFirewallRules(device: any): string {
  const rules = (device.config?.rules || []).filter((r: any) => (r.chain || "forward") === "forward");
  if (!rules.length) return `<p class="empty-state">No rules — the FORWARD policy applies to all traffic.</p>`;
  return `<ol class="fw-rule-list">${rules.map((r: any) => {
    const match = [
      r.protocol ? `-p ${escapeHtml(r.protocol)}` : "",
      r.src ? `-s ${escapeHtml(r.src)}` : "",
      r.dst ? `-d ${escapeHtml(r.dst)}` : "",
      r.icmpType ? `--icmp-type ${escapeHtml(r.icmpType)}` : "",
      r.dport ? `--dport ${escapeHtml(String(r.dport))}` : "",
    ].filter(Boolean).join(" ");
    return `<li><span class="fw-target fw-${escapeHtml(r.target)}">${escapeHtml(String(r.target).toUpperCase())}</span> ${match || "(any)"}</li>`;
  }).join("")}</ol>`;
}

export function renderArpTable(device: any): string {
  const entries = Array.isArray(device.config?.arpTable) ? device.config.arpTable : [];
  return `
    <table class="data-table">
      <thead>
        <tr><th>IPv4</th><th>MAC</th></tr>
      </thead>
      <tbody>
        ${entries.length ? entries.map((entry: any) => `
          <tr>
            <td>${escapeHtml(entry.ipv4Address || "")}</td>
            <td>${escapeHtml(entry.macAddress || "")}</td>
          </tr>
        `).join("") : `<tr><td class="table-empty" colspan="2">Empty</td></tr>`}
      </tbody>
    </table>
  `;
}

export function renderMacAddressTable(device: any): string {
  const entries = Array.isArray(device.config?.macTable) ? device.config.macTable : [];
  const isManaged = Boolean(device.config?.managed);
  const columns = isManaged ? 4 : 3;
  return `
    <table class="data-table">
      <thead>
        <tr>${isManaged ? "<th>VLAN</th>" : ""}<th>MAC Address</th><th>Type</th><th>Port</th></tr>
      </thead>
      <tbody>
        ${entries.length ? entries.map((entry: any) => `
          <tr>
            ${isManaged ? `<td>${escapeHtml(entry.vlan || "")}</td>` : ""}
            <td>${escapeHtml(entry.macAddress || "")}</td>
            <td>${escapeHtml(entry.type || "DYNAMIC")}</td>
            <td>${escapeHtml(entry.port || "")}</td>
          </tr>
        `).join("") : `<tr><td class="table-empty" colspan="${columns}">Empty</td></tr>`}
      </tbody>
    </table>
  `;
}

export function bindPortRemoveButtons(): void {
  document.querySelectorAll(".port-remove").forEach(button => {
    button.addEventListener("click", () => {
      pushUndo();
      state.links = state.links.filter(link => link.id !== (button as HTMLElement).dataset.linkId);
      sync().syncPanel();
      sync().render();
    });
  });
}

// Wires the managed-switch VLAN/mode controls. Each handler delegates to the
// terminal mutators, which validate, pushUndo(), and sync().syncPanel() —
// re-rendering the panel (so no manual rebind is needed afterwards).
export function bindSwitchPortControls(device: any): void {
  document.querySelectorAll(".port-mode-select").forEach(el => {
    el.addEventListener("change", (event: any) => {
      setSwitchPortMode(device, event.target.dataset.port, event.target.value);
    });
  });
  document.querySelectorAll(".port-vlan-select").forEach(el => {
    el.addEventListener("change", (event: any) => {
      setSwitchPortVlan(device, event.target.dataset.port, event.target.value);
    });
  });
  document.querySelectorAll(".port-native-select").forEach(el => {
    el.addEventListener("change", (event: any) => {
      setSwitchTrunkNative(device, event.target.dataset.port, event.target.value);
    });
  });
  const addVlanBtn = document.getElementById("addVlanBtn");
  const addVlanId = document.getElementById("addVlanId") as HTMLInputElement;
  if (addVlanBtn && addVlanId) {
    const add = () => {
      if (!addVlanId.value.trim()) return;
      addSwitchVlan(device, addVlanId.value);
    };
    addVlanBtn.addEventListener("click", add);
    addVlanId.addEventListener("keydown", (event: any) => {
      if (event.key === "Enter") { event.preventDefault(); add(); }
    });
  }
  document.querySelectorAll(".vlan-remove").forEach(el => {
    el.addEventListener("click", (event: any) => {
      removeSwitchVlan(device, event.target.dataset.vlan);
    });
  });
}

// Renders the inspector panel for a selected link (frame history + clear).
function renderLinkPanel(link: Link): void {
  const fromDev = getDevice(link.from);
  const toDev = getDevice(link.to);
  const history = link.frameHistory || [];
  dom.detailsPanel.innerHTML = `
    <h2>Link</h2>
    <div class="pill-row">
      <span class="pill">${escapeHtml(fromDev?.name || link.from)}</span>
      <span class="pill">${escapeHtml(toDev?.name || link.to)}</span>
    </div>
    <div style="height: 12px"></div>
    <div class="field">
      <label>Frame History (${history.length})</label>
      ${history.length ? `
        <div class="frame-history-list">
          ${history.map((entry: any) => {
            const dir = getDevice(entry.fromDeviceId)?.name || entry.fromDeviceId;
            const label = frameLabel(entry.frame);
            const kind = entry.frame.etherType === 0x0806 ? "arp"
              : ((entry.frame.payload as any)?.payload?.type === "dhcp" ? "dhcp" : "icmp");
            return `<div class="frame-history-entry ${kind}">
              <span class="frame-step">Step ${entry.step}</span>
              <span class="frame-label">${escapeHtml(label)}</span>
              <span class="frame-dir">${escapeHtml(dir)} &rarr;</span>
            </div>`;
          }).join("")}
        </div>
      ` : `<p class="empty-state">No frames recorded.</p>`}
    </div>
    <button class="wide-button danger" id="clearLinkHistory">Clear history</button>
  `;
  const clearBtn = document.getElementById("clearLinkHistory");
  if (clearBtn) clearBtn.addEventListener("click", () => {
    link.frameHistory = [];
    syncPanel();
  });
}

// Click-a-packet inspector: a full field breakdown of one captured frame.
export function renderFramePanel(frame: any): void {
  const rows: [string, string][] = [
    ["Frame id", frame.id],
    ["Src MAC", frame.srcMac],
    ["Dst MAC", frame.dstMac],
    ["EtherType", frame.etherType === 0x0806 ? "0x0806 (ARP)" : "0x0800 (IPv4)"],
    ["802.1Q VLAN", frame.vlanTag != null ? String(frame.vlanTag) : "untagged"],
  ];
  const p = frame.payload;
  if (p.type === "arp") {
    rows.push(["ARP operation", p.operation], ["Sender MAC", p.senderMac], ["Sender IP", p.senderIp],
      ["Target MAC", p.targetMac], ["Target IP", p.targetIp]);
  } else if (p.type === "ipv4") {
    rows.push(["Src IP", p.srcIp], ["Dst IP", p.dstIp], ["TTL", String(p.ttl)],
      ["Protocol", p.protocol === 1 ? "1 (ICMP)" : p.protocol === 6 ? "6 (TCP)" : p.protocol === 17 ? "17 (UDP)" : String(p.protocol)]);
    const inner = p.payload;
    if (inner.type === "icmp") {
      const names: Record<number, string> = { 8: "echo request", 0: "echo reply", 11: "time exceeded" };
      rows.push(["ICMP type", `${inner.icmpType} (${names[inner.icmpType] || "?"})`], ["Sequence", String(inner.sequence)]);
    } else if (inner.type === "tcp") {
      rows.push(["Src port", String(inner.srcPort)], ["Dst port", String(inner.dstPort)], ["TCP flags", inner.flags.toUpperCase()]);
    } else if (inner.type === "dhcp") {
      rows.push(["DHCP message", inner.messageType], ["Client MAC", inner.clientMac]);
      if (inner.assignedIp) rows.push(["Assigned IP", inner.assignedIp]);
      if (inner.prefixLength != null) rows.push(["Prefix length", `/${inner.prefixLength}`]);
      if (inner.gatewayIp) rows.push(["Gateway", inner.gatewayIp]);
    }
  }
  dom.detailsPanel.innerHTML = `
    <h2>Frame</h2>
    <p class="empty-state">Captured in flight — the simulation is paused. Click elsewhere or press Resume to continue.</p>
    <table class="data-table frame-detail">
      <tbody>
        ${rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join("")}
      </tbody>
    </table>
    <div style="height: 10px"></div>
    <button class="wide-button" id="closeFramePanel">Close</button>
  `;
  document.getElementById("closeFramePanel")?.addEventListener("click", () => {
    state.inspectedFrame = null;
    syncPanel();
    sync().render();
  });
}

export function syncPanel(): void {
  dom.deviceCount.textContent = String(state.devices.filter(isVisibleDevice).length);
  dom.linkCount.textContent = String(state.links.filter(link => !link.hidden).length);
  sync().syncCoordReadout();
  if (state.inspectedFrame) {
    renderFramePanel(state.inspectedFrame);
    return;
  }
  const selected = getDevice(state.selectedId);
  const isConfiguring = selected && state.configuringId === selected.id;

  if (!selected && state.selectedLinkId) {
    const link = state.links.find(l => l.id === state.selectedLinkId);
    if (link) {
      renderLinkPanel(link);
    } else {
      dom.detailsPanel.innerHTML = `
        <h2>Selection</h2>
        <p class="empty-state">No device selected.</p>
      `;
    }
  } else if (!selected) {
    dom.detailsPanel.innerHTML = `
      <h2>Selection</h2>
      <p class="empty-state">No device selected.</p>
    `;
  } else {
    const neighbors = connectedIds(selected.id).map((id: string) => getDevice(id)).filter(isVisibleDevice);
    const selectedType = DEVICE_SPECS[selected.type]?.label ?? "Device";
    const pcConfigFields = selected.type === "computer" ? `
      <div class="field">
        <label for="selectedIpv4">IPv4 address</label>
        <div class="input-with-button">
          <input id="selectedIpv4" value="${escapeHtml(selected.config?.ipv4Address || "")}" placeholder="192.168.1.10" autocomplete="off" inputmode="decimal">
          <button class="inline-button" id="clearIpv4" type="button" title="Clear IPv4 address">&times;</button>
        </div>
      </div>
      <div class="field">
        <label for="selectedGateway">Default gateway</label>
        <div class="input-with-button">
          <input id="selectedGateway" value="${escapeHtml(selected.config?.gatewayIpv4Address || "")}" placeholder="192.168.1.1" autocomplete="off" inputmode="decimal">
          <button class="inline-button" id="clearGateway" type="button" title="Clear default gateway">&times;</button>
        </div>
      </div>
      <div class="field">
        <label for="selectedMac">MAC address</label>
        <div class="input-with-button">
          <input id="selectedMac" value="${escapeHtml(selected.config?.macAddress || "")}" placeholder="02:00:00:00:00:01" autocomplete="off">
          <button class="inline-button" id="randomMac" type="button" title="Generate random MAC">Random</button>
        </div>
      </div>
      <button class="wide-button danger" id="deleteSelected">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path></svg>
        Delete
      </button>
      <div style="height: 14px"></div>
      <div class="field">
        <label>ARP table</label>
        ${renderArpTable(selected)}
      </div>
    ` : "";
    const switchConfigFields = selected.type === "switch" ? `
      <div class="field">
        <label for="selectedManaged">Managed switch</label>
        <input id="selectedManaged" type="checkbox" ${selected.config?.managed ? "checked" : ""}>
      </div>
      <div class="field">
        <label for="selectedPorts">Ethernet ports</label>
        <input id="selectedPorts" type="number" min="4" max="24" step="1" value="${escapeHtml(selected.config?.ethernetPorts || 8)}">
      </div>
      ${selected.config?.managed ? `
      <div class="field">
        <label>VLANs</label>
        <div id="switchVlanList">
          ${renderSwitchVlans(selected)}
        </div>
      </div>
      ` : ""}
      <div class="field">
        <label>Ports</label>
        <div class="port-list" id="switchPortList">
          ${renderSwitchPorts(selected)}
        </div>
      </div>
      <div class="field">
        <label>MAC Address Table</label>
        ${renderMacAddressTable(selected)}
      </div>
    ` : "";
    const routerConfigFields = selected.type === "router" ? `
      <div class="field">
        <label for="selectedRouterEthernetPorts">Ethernet ports</label>
        <input id="selectedRouterEthernetPorts" type="number" min="0" max="12" step="1" value="${escapeHtml(selected.config?.ethernetPorts ?? 4)}">
      </div>
      <div class="field">
        <label for="selectedRouterSerialPorts">Serial ports</label>
        <input id="selectedRouterSerialPorts" type="number" min="0" max="12" step="1" value="${escapeHtml(selected.config?.serialPorts ?? 4)}">
      </div>
      <div class="field">
        <label>Interfaces</label>
        <div id="routerInterfaceList">
        ${renderRouterInterfaces(selected)}
        </div>
      </div>
    ` : "";
    const firewallConfigFields = selected.type === "firewall" ? `
      <div class="field">
        <label for="selectedFwPorts">Ethernet ports</label>
        <input id="selectedFwPorts" type="number" min="2" max="8" step="1" value="${escapeHtml(selected.config?.ethernetPorts ?? 2)}">
      </div>
      <div class="field">
        <label>FORWARD policy</label>
        <span class="pill">${escapeHtml(((selected.config?.policy || {}).forward || "accept").toUpperCase())}</span>
      </div>
      <div class="field">
        <label>Rules (edit via the iptables terminal)</label>
        ${renderFirewallRules(selected)}
      </div>
    ` : "";
    dom.detailsPanel.innerHTML = `
      <h2>${isConfiguring ? "Configure" : "Selection"}</h2>
      <div class="field">
        <label for="selectedName">Name</label>
        <input id="selectedName" value="${escapeHtml(selected.name)}" autocomplete="off">
      </div>
      ${selected.type === "switch" ? `
        <button class="wide-button" id="collapseSelectedLan">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9h12"></path><path d="M9 6l-3 3l3 3"></path><path d="M15 6l3 3l-3 3"></path><path d="M8 17h8"></path></svg>
          Collapse LAN
        </button>
        <div style="height: 10px"></div>
      ` : ""}
      ${selected.type === "lan" ? `
        <button class="wide-button" id="expandSelectedLan">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h16"></path><path d="M7 6l-3 3l3 3"></path><path d="M17 6l3 3l-3 3"></path><path d="M8 17h8"></path></svg>
          Expand LAN
        </button>
        <div style="height: 10px"></div>
      ` : ""}
      ${(selected.type === "computer" || selected.type === "router" || selected.type === "firewall" || (selected.type === "switch" && selected.config?.managed)) ? `
        <button class="wide-button" id="openSelectedTerminal">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17l6 -6l-6 -6"></path><path d="M12 19h8"></path></svg>
          Terminal
        </button>
        <div style="height: 10px"></div>
      ` : ""}
      ${selected.type !== "lan" ? `
        <button class="wide-button ${selected.poweredOff ? "" : "danger"}" id="togglePower">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 6a7.75 7.75 0 1 0 10 0"></path><path d="M12 2v6"></path></svg>
          ${selected.poweredOff ? "Power On" : "Power Off"}
        </button>
        <div style="height: 10px"></div>
      ` : ""}
      ${selected.type !== "lan" && selected.type !== "computer" ? `
        <button class="wide-button danger" id="deleteSelected">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path></svg>
          Delete
        </button>
        <div style="height: 14px"></div>
      ` : ""}
      ${pcConfigFields}
      ${switchConfigFields}
      ${routerConfigFields}
      ${firewallConfigFields}
      <div class="pill-row">
        <span class="pill">${selectedType}</span>
        <span class="pill">${neighbors.length} links</span>
      </div>
    `;

    const nameInput = document.getElementById("selectedName") as HTMLInputElement;
    captureUndoOnFocus(nameInput);
    nameInput.addEventListener("input", (event: any) => {
      selected.name = event.target.value || selected.name;
      syncDeviceList();
      syncTerminal();
      sync().render();
    });
    const ipv4Input = document.getElementById("selectedIpv4") as HTMLInputElement;
    if (ipv4Input) {
      captureUndoOnFocus(ipv4Input);
      ipv4Input.addEventListener("input", (event: any) => {
        const value = event.target.value.trim();
        const parsed = value === "" ? null : parseIpv4Token(value);
        if (value !== "" && !parsed) {
          event.target.setCustomValidity("Enter a valid IPv4 address (optionally with /prefix).");
        } else {
          event.target.setCustomValidity("");
          selected.config = selected.config || {};
          selected.config.ipv4Address = parsed ? parsed.address : "";
          if (parsed?.prefixLength != null) selected.config.prefixLength = parsed.prefixLength;
          sync().render();
        }
      });
    }
    const gatewayInput = document.getElementById("selectedGateway") as HTMLInputElement;
    if (gatewayInput) {
      captureUndoOnFocus(gatewayInput);
      gatewayInput.addEventListener("input", (event: any) => {
        const value = event.target.value.trim();
        if (!isValidIpv4(value) && value !== "") {
          event.target.setCustomValidity("Enter a valid IPv4 address.");
        } else {
          event.target.setCustomValidity("");
          ensureConfig(selected);
          selected.config.gatewayIpv4Address = value;
        }
      });
    }
    const clearIpv4Btn = document.getElementById("clearIpv4");
    if (clearIpv4Btn && ipv4Input) {
      clearIpv4Btn.addEventListener("click", () => {
        pushUndo();
        selected.config = selected.config || {};
        selected.config.ipv4Address = "";
        ipv4Input.value = "";
        ipv4Input.setCustomValidity("");
        sync().render();
      });
    }
    const clearGatewayBtn = document.getElementById("clearGateway");
    if (clearGatewayBtn && gatewayInput) {
      clearGatewayBtn.addEventListener("click", () => {
        pushUndo();
        ensureConfig(selected);
        selected.config.gatewayIpv4Address = "";
        gatewayInput.value = "";
        gatewayInput.setCustomValidity("");
      });
    }
    const macInput = document.getElementById("selectedMac") as HTMLInputElement;
    if (macInput) {
      captureUndoOnFocus(macInput);
      macInput.addEventListener("input", (event: any) => {
        const value = normaliseMacAddress(event.target.value);
        if (!isValidMac(value) && value !== "") {
          event.target.setCustomValidity("Enter a valid MAC address.");
        } else {
          event.target.setCustomValidity("");
          selected.config = selected.config || {};
          selected.config.macAddress = value;
          event.target.value = value;
          sync().render();
        }
      });
    }
    const randomMacButton = document.getElementById("randomMac");
    if (randomMacButton && macInput) {
      randomMacButton.addEventListener("click", () => {
        pushUndo();
        const mac = randomMac();
        selected.config = selected.config || {};
        selected.config.macAddress = mac;
        macInput.value = mac;
        macInput.setCustomValidity("");
        sync().render();
      });
    }
    const managedInput = document.getElementById("selectedManaged") as HTMLInputElement;
    if (managedInput) {
      managedInput.addEventListener("change", (event: any) => {
        pushUndo();
        ensureConfig(selected);
        selected.config.managed = event.target.checked;
        syncPanel();
        sync().render();
      });
    }
    const portsInput = document.getElementById("selectedPorts") as HTMLInputElement;
    if (portsInput) {
      captureUndoOnFocus(portsInput);
      portsInput.addEventListener("input", (event: any) => {
        const value = Number(event.target.value);
        if (!Number.isInteger(value) || value < 4 || value > 24) {
          event.target.setCustomValidity("Enter a port count from 4 to 24.");
        } else {
          event.target.setCustomValidity("");
          ensureConfig(selected);
          selected.config.ethernetPorts = value;
          document.getElementById("switchPortList")!.innerHTML = renderSwitchPorts(selected);
          bindPortRemoveButtons();
          bindSwitchPortControls(selected);
        }
      });
    }
    const fwPortsInput = document.getElementById("selectedFwPorts") as HTMLInputElement;
    if (fwPortsInput) {
      captureUndoOnFocus(fwPortsInput);
      fwPortsInput.addEventListener("input", (event: any) => {
        const value = Number(event.target.value);
        if (!Number.isInteger(value) || value < 2 || value > 8) {
          event.target.setCustomValidity("Enter a port count from 2 to 8.");
        } else {
          event.target.setCustomValidity("");
          ensureConfig(selected);
          selected.config.ethernetPorts = value;
          sync().render();
        }
      });
    }
    document.querySelectorAll(".router-interface-ip").forEach(input => {
      captureUndoOnFocus(input as HTMLInputElement);
      input.addEventListener("input", (event: any) => {
        if (!event.target.dataset.peerId) return;
        const value = event.target.value.trim();
        if (!isValidIpv4(value) && value !== "") {
          event.target.setCustomValidity("Enter a valid IPv4 address.");
          return;
        }
        event.target.setCustomValidity("");
        const vlanTag = event.target.dataset.vlanTag != null ? Number(event.target.dataset.vlanTag) : undefined;
        const iface = routerInterfaceFor(selected, event.target.dataset.peerId, vlanTag);
        iface.ipv4Address = value;
      });
    });
    const routerEthernetPorts = document.getElementById("selectedRouterEthernetPorts") as HTMLInputElement;
    const routerSerialPorts = document.getElementById("selectedRouterSerialPorts") as HTMLInputElement;
    [routerEthernetPorts, routerSerialPorts].filter(Boolean).forEach(input => {
      captureUndoOnFocus(input);
      input.addEventListener("input", (event: any) => {
        const value = Number(event.target.value);
        if (!Number.isInteger(value) || value < 0 || value > 12) {
          event.target.setCustomValidity("Enter a port count from 0 to 12.");
          return;
        }
        event.target.setCustomValidity("");
        ensureConfig(selected);
        if (event.target.id === "selectedRouterEthernetPorts") {
          selected.config.ethernetPorts = value;
        } else {
          selected.config.serialPorts = value;
        }
        document.getElementById("routerInterfaceList")!.innerHTML = renderRouterInterfaces(selected);
      });
    });
    bindPortRemoveButtons();
    bindSwitchPortControls(selected);
    const terminalButton = document.getElementById("openSelectedTerminal");
    if (terminalButton) terminalButton.addEventListener("click", () => openTerminalFor(selected));
    const powerButton = document.getElementById("togglePower");
    if (powerButton) powerButton.addEventListener("click", () => {
      pushUndo();
      selected.poweredOff = !selected.poweredOff;
      syncPanel();
      sync().render();
    });
    const collapseButton = document.getElementById("collapseSelectedLan");
    if (collapseButton) collapseButton.addEventListener("click", () => collapseLan(selected));
    const expandButton = document.getElementById("expandSelectedLan");
    if (expandButton) expandButton.addEventListener("click", () => expandLan(selected));
    const deleteButton = document.getElementById("deleteSelected");
    if (deleteButton) deleteButton.addEventListener("click", deleteSelection);
  }

  syncDeviceList();
  if (state.terminal.open) syncTerminal();
}

export function syncDeviceList(): void {
  if (!state.devices.length) {
    dom.deviceList.innerHTML = "";
    return;
  }
  const visibleDevices = state.devices.filter(isVisibleDevice);
  dom.deviceList.innerHTML = visibleDevices.map(device => `
    <button class="device-row ${device.id === state.selectedId ? "active" : ""}" data-id="${device.id}">
      <span class="device-name">${escapeHtml(device.name)}</span>
      <span class="device-type">${DEVICE_SPECS[device.type as DeviceType]?.label ?? "Device"}</span>
    </button>
  `).join("");
  [...dom.deviceList.querySelectorAll(".device-row")].forEach((row: any) => {
    row.addEventListener("click", () => {
      state.selectedId = row.dataset.id;
      state.selectedLinkId = null;
      if (state.configuringId && state.configuringId !== state.selectedId) state.configuringId = null;
      syncPanel();
      sync().render();
    });
  });
}
