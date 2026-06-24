import type { Link, DeviceType } from "./types";
import { state, sync, pushUndo, captureUndoOnFocus } from "./state";
import { DEVICE_SPECS } from "./device-registry";
import { dom } from "./dom";
import { escapeHtml, isValidIpv4, isValidMac, normaliseMacAddress, randomMac, parseIpv4Token, prefixOf, networkOf, normaliseSsid, normaliseWifiPassword } from "./utils";
import { ensureConfig, normaliseVlans, normaliseDnsRecords, normaliseDhcpLeases, normaliseRadiusUsers } from "./normalise";
import {
  getDevice, isVisibleDevice, connectedIds, linkedPortsFor, linksFor, wifiLinkAuthenticated,
  routerInterfacesWithNames, routerInterfaceFor, routerInterfaceForName, switchInterfacesWithNames,
  deleteSelection, deleteLink, collapseLan, expandLan, configureDevice, hasHostname
} from "./devices";
import {
  openTerminalFor, syncTerminal, runDeviceCommand,
  addSwitchVlan, removeSwitchVlan, setSwitchPortVlan, setSwitchPortMode, setSwitchTrunkNative, setSwitchStp, setSwitchMirror
} from "./terminal";
import { resizeCanvas } from "./canvas";
import { frameLabel } from "./frame";
import { syncSimLog, startSimulation } from "./engine";
import { buildAssociationEvents } from "./simulation";

export function syncOptionControls(): void {
  dom.showDeviceNames.checked = state.options.showDeviceNames;
  dom.showIpAddresses.checked = state.options.showIpAddresses;
  dom.showMacAddresses.checked = state.options.showMacAddresses;
  dom.optAutoDhcp.checked = state.options.autoDhcp;
  dom.optApipa.checked = state.options.apipaFallback;
  dom.optSilentArp.checked = state.options.silentArp;
  dom.optSilentDhcp.checked = state.options.silentDhcp;
  dom.optSilentDns.checked = state.options.silentDns;
  dom.optSilentWifi.checked = state.options.silentWifi;
  dom.optSilentStp.checked = state.options.silentStp;
  dom.optInstantDns.checked = state.options.instantDns;
}

// The address-source pill shown beside a host's IP field: how the current
// address was assigned, or "unassigned" when there's none. A configured IP with
// no recorded source reads as static.
export function ipSourceInfo(config: any): { cls: string; text: string } {
  if (!config?.ipv4Address) return { cls: "none", text: "unassigned" };
  if (config.ipSource === "dhcp") return { cls: "dhcp", text: "DHCP" };
  if (config.ipSource === "apipa") return { cls: "apipa", text: "APIPA" };
  return { cls: "static", text: "static" };
}

function ipSourceBadge(config: any): string {
  const info = ipSourceInfo(config);
  return `<span class="ip-source ip-source-${info.cls}" id="ipSourceBadge">${info.text}</span>`;
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

// The SSID + optional-password fields, shared by the laptop and access-point
// inspector sections. `hint` tailors the help note to the device's role.
function renderWifiFields(config: any, hint: string): string {
  return `
      <div class="field">
        <label for="selectedSsid">SSID (network name)</label>
        <input id="selectedSsid" value="${escapeHtml(config?.ssid || "")}" placeholder="RouteSim" maxlength="32" autocomplete="off">
        <p class="field-note">${hint}</p>
      </div>
      <div class="field">
        <label for="selectedWifiPassword">Password (optional)</label>
        <div class="input-with-button">
          <input id="selectedWifiPassword" value="${escapeHtml(config?.wifiPassword || "")}" placeholder="(open network)" maxlength="63" autocomplete="off">
          <button class="inline-button" id="clearWifiPassword" type="button" title="Clear password (open network)">&times;</button>
        </div>
      </div>`;
}

export function renderSwitchPorts(device: any): string {
  const interfaces = switchInterfacesWithNames(device);
  const isManaged = Boolean(device.config?.managed);
  const stpOn = isManaged && (device.config?.stp ? device.config.stp.enabled !== false : true);
  const stpPorts = stpOn ? (device.config?.stp?.ports || {}) : {};
  const ports = linkedPortsFor(device.id);
  return interfaces.map((iface: any, index: number) => {
    const port = ports[index];
    const peer = port?.peer;
    const si = peer ? stpPorts[iface.name] : null;
    const stpBadge = si
      ? `<span class="port-stp port-stp-${si.state === "blocking" ? "block" : si.role}" title="Spanning tree: ${si.role} port, ${si.state}">${si.state === "blocking" ? "Block" : si.role === "root" ? "Root" : "Desig"}</span>`
      : "";
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
        ${stpBadge}
        ${removeButton}
      </div>
    `;
  }).join("");
}

// The managed-switch spanning-tree control: an enable toggle, the bridge
// priority, and a one-line status (root bridge, or root id + cost). Wired by
// bindStpControls; the mutations run through setSwitchStp (pushUndo + reconverge).
export function renderStpSection(device: any): string {
  const stp = device.config?.stp;
  const enabled = stp ? stp.enabled !== false : true;
  const priority = stp?.priority ?? 32768;
  const isRoot = enabled && !!stp?.bridgeId && stp.bridgeId === stp.rootId;
  const status = !enabled ? "disabled"
    : isRoot ? "this switch is the root bridge"
    : stp?.rootId ? `root ${escapeHtml(stp.rootId)} · path cost ${stp?.rootCost ?? "?"}`
    : "no loop to resolve";
  return `
    <div class="field">
      <label>Spanning tree</label>
      <div class="stp-row">
        <label class="stp-check"><input id="selectedStp" type="checkbox" ${enabled ? "checked" : ""}> Enabled</label>
        <span class="stp-status">${status}</span>
      </div>
      ${enabled ? `<div class="stp-row">
        <label class="stp-priolabel" for="selectedStpPriority">Bridge priority</label>
        <input id="selectedStpPriority" class="stp-prio" type="number" min="0" max="61440" step="4096" value="${priority}">
      </div>` : ""}
    </div>
  `;
}

export function renderRouterInterfaces(device: any): string {
  const interfaces = routerInterfacesWithNames(device);
  return `
    <div class="interface-list">
      ${interfaces.map((iface: any) => {
        const vlanAttr = iface.config.vlanTag != null ? ` data-vlan-tag="${iface.config.vlanTag}"` : "";
        const peerLabel = iface.peer?.name || "not connected";
        // Empty ports persist an IP by name; connected ports key by peer.
        const ipAttrs = iface.peer
          ? `data-peer-id="${escapeHtml(iface.peerId)}"${vlanAttr}`
          : `data-iface-name="${escapeHtml(iface.name)}"`;
        return `
          <div class="interface-row">
            <div class="interface-head">
              <span class="interface-name">${escapeHtml(iface.name)}</span>
              <span class="interface-peer ${iface.peer ? "" : "empty"}" title="${escapeHtml(peerLabel)}">${escapeHtml(peerLabel)}</span>
              ${iface.peer ? `<button class="inline-button iface-unlink" data-peer-id="${escapeHtml(iface.peerId)}" type="button" title="Delete link to ${escapeHtml(iface.peer.name)}" aria-label="Delete link to ${escapeHtml(iface.peer.name)}">&times;</button>` : ""}
            </div>
            <input class="router-interface-ip" ${ipAttrs} value="${escapeHtml(iface.config.ipv4Address ? `${iface.config.ipv4Address}/${prefixOf(iface.config)}` : "")}" placeholder="192.168.1.1/24" title="${escapeHtml(iface.config.ipv4Address ? `Subnet: ${networkOf(iface.config.ipv4Address, prefixOf(iface.config))}` : "")}" autocomplete="off" inputmode="decimal">
          </div>
        `;
      }).join("")}
    </div>
  `;
}

// The detailsPanel heading: the title plus the inspector close button, kept on
// one line and sticky so the close affordance sits in line with the heading.
function panelHeading(title: string): string {
  return `
    <div class="panel-heading">
      <h2>${title}</h2>
      <button class="panel-toggle" id="inspectorCloseButton" type="button" title="Close panel" aria-label="Close inspector panel">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>
      </button>
    </div>`;
}

export function renderFirewallRules(device: any): string {
  const rules = (device.config?.rules || []);
  if (!rules.length) return `<p class="empty-state">No rules — the default policy applies to all traffic.</p>`;
  return `<ol class="fw-rule-list">${rules.map((r: any, index: number) => {
    const match = [
      r.protocol ? `-p ${escapeHtml(r.protocol)}` : "",
      r.src ? `-s ${escapeHtml(r.src)}` : "",
      r.dst ? `-d ${escapeHtml(r.dst)}` : "",
      r.icmpType ? `--icmp-type ${escapeHtml(r.icmpType)}` : "",
      r.dport ? `--dport ${escapeHtml(String(r.dport))}` : "",
    ].filter(Boolean).join(" ");
    return `<li><span class="fw-target fw-${escapeHtml(r.target)}">${escapeHtml(String(r.target).toUpperCase())}</span> ${escapeHtml(String(r.chain || "forward").toUpperCase())} ${match || "(any)"}<button class="inline-button fw-rule-del" type="button" data-fw-del="${index}" title="Delete this rule" aria-label="Delete rule">&times;</button></li>`;
  }).join("")}</ol>`;
}

// The editable netfilter panel shown under Configure for routers (INPUT +
// FORWARD) and the transparent firewall (FORWARD only): the rule list (each row
// deletable), a per-chain default-policy select, and an add-rule form. It writes
// the same `config.rules`/`config.policy` the iptables CLI does.
export function renderFirewallControls(device: any, chains: string[]): string {
  const policy = device.config?.policy || {};
  const policyRows = chains.map(chain => `
      <div class="field-row fw-policy-row">
        <label for="fwPolicy-${chain}">${escapeHtml(chain.toUpperCase())} policy</label>
        <select id="fwPolicy-${chain}" class="fw-select" data-fw-policy="${chain}">
          ${["accept", "drop"].map(p => `<option value="${p}"${(policy[chain] || "accept") === p ? " selected" : ""}>${p.toUpperCase()}</option>`).join("")}
        </select>
      </div>`).join("");
  const chainField = chains.length > 1 ? `
        <select id="fwAddChain" class="fw-select" title="Chain">
          ${chains.map(c => `<option value="${c}">${escapeHtml(c.toUpperCase())}</option>`).join("")}
        </select>` : "";
  return `
      ${policyRows}
      <label>Rules</label>
      ${renderFirewallRules(device)}
      <div class="fw-add-form">
        <select id="fwAddTarget" class="fw-select" title="Target">
          ${["accept", "drop", "reject"].map(t => `<option value="${t}">${t.toUpperCase()}</option>`).join("")}
        </select>${chainField}
        <select id="fwAddProto" class="fw-select" title="Protocol">
          ${[["", "any proto"], ["icmp", "icmp"], ["tcp", "tcp"], ["udp", "udp"]].map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
        </select>
        <input id="fwAddSrc" placeholder="source (any)" autocomplete="off" inputmode="decimal">
        <input id="fwAddDst" placeholder="dest (any)" autocomplete="off" inputmode="decimal">
        <input id="fwAddDport" placeholder="dport" autocomplete="off" inputmode="numeric">
        <button class="inline-button" id="fwAddRule" type="button">Add rule</button>
      </div>
      <p class="field-note" id="fwAddError"></p>`;
}

// The dnsmasq service panel on a server: daemon state, DNS A-records (with
// add/remove), the DHCP range + router option, and current leases.
function renderDnsmasqSection(device: any): string {
  const config = device.config || {};
  const records = normaliseDnsRecords(config.dnsRecords || []);
  const leases = normaliseDhcpLeases(config.dhcpLeases || []);
  const radiusUsers = normaliseRadiusUsers(config.radius?.users || []);
  const ports = Array.isArray(config.openPorts) ? config.openPorts : [];
  return `
    <div class="field">
      <label for="dnsmasqRunning">dnsmasq service running</label>
      <input id="dnsmasqRunning" type="checkbox" ${config.dnsmasqRunning !== false ? "checked" : ""}>
    </div>
    <div class="field">
      <label>DNS records (address=/name/ip)</label>
      ${records.length ? `
      <table class="data-table">
        <thead><tr><th>Name</th><th>IPv4</th><th></th></tr></thead>
        <tbody>
          ${records.map((r: any, i: number) => `
            <tr>
              <td>${escapeHtml(r.name)}</td>
              <td>${escapeHtml(r.ip)}</td>
              <td><button class="inline-button dns-record-remove" data-index="${i}" type="button" title="Remove record">&times;</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>` : `<p class="empty-state">No records — queries answer NXDOMAIN.</p>`}
      <div class="input-with-button">
        <input id="dnsRecordName" placeholder="web.corp" autocomplete="off">
        <input id="dnsRecordIp" placeholder="192.168.1.80" autocomplete="off" inputmode="decimal">
        <button class="inline-button" id="dnsRecordAdd" type="button" title="Add record">Add</button>
      </div>
    </div>
    <div class="field">
      <label for="dhcpRangeStart">DHCP range (empty = DHCP off)</label>
      <div class="input-with-button">
        <input id="dhcpRangeStart" value="${escapeHtml(config.dhcpRangeStart || "")}" placeholder="192.168.1.100" autocomplete="off" inputmode="decimal">
        <input id="dhcpRangeEnd" value="${escapeHtml(config.dhcpRangeEnd || "")}" placeholder="192.168.1.200" autocomplete="off" inputmode="decimal">
      </div>
    </div>
    <div class="field">
      <label for="dhcpRouterIp">DHCP router option (default: this server)</label>
      <input id="dhcpRouterIp" value="${escapeHtml(config.dhcpRouterIp || "")}" placeholder="192.168.1.1" autocomplete="off" inputmode="decimal">
    </div>
    ${leases.length ? `
    <div class="field">
      <label>DHCP leases</label>
      <table class="data-table">
        <thead><tr><th>MAC</th><th>IPv4</th></tr></thead>
        <tbody>
          ${leases.map((l: any) => `<tr><td>${escapeHtml(l.macAddress)}</td><td>${escapeHtml(l.ipv4Address)}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>` : ""}
    <div class="field">
      <label>RADIUS users (802.1X)</label>
      ${radiusUsers.length ? `
      <table class="data-table">
        <thead><tr><th>Identity</th><th>Password</th><th></th></tr></thead>
        <tbody>
          ${radiusUsers.map((u: any, i: number) => `
            <tr>
              <td>${escapeHtml(u.identity)}</td>
              <td>${escapeHtml(u.password)}</td>
              <td><button class="inline-button radius-user-remove" data-index="${i}" type="button" title="Remove user">&times;</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>` : `<p class="empty-state">No accounts yet — add one to use this server as an 802.1X (RADIUS) back end.</p>`}
      <div class="input-with-button">
        <input id="radiusUserId" placeholder="alice" autocomplete="off">
        <input id="radiusUserPw" placeholder="secret" autocomplete="off">
        <button class="inline-button" id="radiusUserAdd" type="button" title="Add user">Add</button>
      </div>
    </div>
    <div class="field">
      <label for="listenPorts">Listening TCP ports</label>
      <input id="listenPorts" value="${escapeHtml(ports.join(", "))}" placeholder="80, 443" autocomplete="off" inputmode="numeric">
    </div>
  `;
}

// Wire the dnsmasq panel controls (no-ops when the selection isn't a server —
// the elements simply aren't in the DOM).
function bindDnsmasqControls(selected: any): void {
  const runningInput = document.getElementById("dnsmasqRunning") as HTMLInputElement | null;
  if (runningInput) {
    runningInput.addEventListener("change", (event: any) => {
      pushUndo();
      ensureConfig(selected);
      selected.config.dnsmasqRunning = event.target.checked;
      syncPanel();
    });
  }
  const addButton = document.getElementById("dnsRecordAdd");
  if (addButton) {
    addButton.addEventListener("click", () => {
      const nameInput = document.getElementById("dnsRecordName") as HTMLInputElement;
      const ipInput = document.getElementById("dnsRecordIp") as HTMLInputElement;
      const name = nameInput.value.trim().toLowerCase();
      const ip = ipInput.value.trim();
      if (!name || !isValidIpv4(ip)) {
        ipInput.setCustomValidity("Enter a name and a valid IPv4 address.");
        ipInput.reportValidity?.();
        return;
      }
      pushUndo();
      ensureConfig(selected);
      const records = normaliseDnsRecords(selected.config.dnsRecords || []);
      const existing = records.find((r: any) => r.name === name);
      if (existing) existing.ip = ip;
      else records.push({ name, ip });
      selected.config.dnsRecords = records;
      syncPanel();
    });
  }
  document.querySelectorAll(".dns-record-remove").forEach(button => {
    button.addEventListener("click", (event: any) => {
      const index = Number(event.currentTarget.dataset.index);
      pushUndo();
      ensureConfig(selected);
      const records = normaliseDnsRecords(selected.config.dnsRecords || []);
      records.splice(index, 1);
      selected.config.dnsRecords = records;
      syncPanel();
    });
  });
  const bindIpField = (id: string, field: string) => {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (!input) return;
    captureUndoOnFocus(input);
    input.addEventListener("input", (event: any) => {
      const value = event.target.value.trim();
      if (!isValidIpv4(value) && value !== "") {
        event.target.setCustomValidity("Enter a valid IPv4 address.");
      } else {
        event.target.setCustomValidity("");
        ensureConfig(selected);
        (selected.config as any)[field] = value;
      }
    });
  };
  bindIpField("dhcpRangeStart", "dhcpRangeStart");
  bindIpField("dhcpRangeEnd", "dhcpRangeEnd");
  bindIpField("dhcpRouterIp", "dhcpRouterIp");

  const radiusAdd = document.getElementById("radiusUserAdd");
  if (radiusAdd) {
    radiusAdd.addEventListener("click", () => {
      const idInput = document.getElementById("radiusUserId") as HTMLInputElement | null;
      const pwInput = document.getElementById("radiusUserPw") as HTMLInputElement | null;
      if (!idInput || !pwInput) return;
      const identity = idInput.value.trim();
      const password = pwInput.value;
      if (!identity) { idInput.setCustomValidity("Enter an identity."); idInput.reportValidity?.(); return; }
      pushUndo();
      ensureConfig(selected);
      const users = normaliseRadiusUsers(selected.config.radius?.users || []);
      const existing = users.find((u: any) => u.identity === identity);
      if (existing) existing.password = password;
      else users.push({ identity, password });
      selected.config.radius = { users };
      syncPanel();
    });
  }
  document.querySelectorAll(".radius-user-remove").forEach(button => {
    button.addEventListener("click", (event: any) => {
      const index = Number(event.currentTarget.dataset.index);
      pushUndo();
      ensureConfig(selected);
      const users = normaliseRadiusUsers(selected.config.radius?.users || []);
      users.splice(index, 1);
      selected.config.radius = { users };
      syncPanel();
    });
  });

  const portsInput = document.getElementById("listenPorts") as HTMLInputElement | null;
  if (portsInput) {
    captureUndoOnFocus(portsInput);
    portsInput.addEventListener("input", (event: any) => {
      const raw = event.target.value.trim();
      const parts = raw ? raw.split(",").map((s: string) => s.trim()).filter(Boolean) : [];
      const ports = parts.map(Number);
      const valid = ports.every((p: number) => Number.isInteger(p) && p >= 1 && p <= 65535);
      if (!valid) { event.target.setCustomValidity("Enter comma-separated ports (1–65535)."); return; }
      event.target.setCustomValidity("");
      ensureConfig(selected);
      selected.config.openPorts = [...new Set(ports)];
    });
  }
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

// SPAN port mirroring control (managed switches): a dropdown to pick the monitor
// port that an IDS listens on, or "off".
export function renderMirrorSection(device: any): string {
  const dest = device.config?.mirror?.dest || "";
  const ports = switchInterfacesWithNames(device);
  return `
    <div class="field">
      <label for="selectedMirror">Port mirroring (SPAN)</label>
      <select id="selectedMirror" class="mirror-select">
        <option value="">off</option>
        ${ports.map((p: any) => `<option value="${escapeHtml(p.name)}" ${p.name === dest ? "selected" : ""}>${escapeHtml(p.name)}${p.peer ? ` &rarr; ${escapeHtml(p.peer.name)}` : ""}</option>`).join("")}
      </select>
      <span class="field-note">Copy all traffic to this monitor port (cable an IDS sensor there).</span>
    </div>
  `;
}

// The IDS sensor panel: the Snort rule set (editable as local.rules) and the
// alert log. Wired by bindIdsControls.
export function renderIdsSection(device: any): string {
  const rules = (device.config?.idsRules || []).join("\n");
  const alerts: string[] = device.config?.alerts || [];
  return `
    <p class="field-note">A passive Snort sensor. Cable it to a switch SPAN/monitor port; it inspects the mirrored copy of traffic and raises alerts on rule matches. It is not in the data path, so it can watch but never block.</p>
    <div class="field">
      <label for="selectedIdsRules">Rules (/etc/snort/rules/local.rules)</label>
      <textarea id="selectedIdsRules" class="ids-rules" spellcheck="false" rows="6">${escapeHtml(rules)}</textarea>
      <span class="field-note">One Snort rule per line, e.g. <code>alert tcp any any -&gt; any 23 (msg:"Telnet"; sid:1000002;)</code></span>
    </div>
    <div class="field">
      <label>Alerts (${alerts.length})</label>
      <pre class="ids-alerts">${alerts.length ? escapeHtml(alerts.slice(-50).join("\n")) : "(none yet — run a simulation through the monitored switch)"}</pre>
      ${alerts.length ? `<button class="wide-button" id="clearIdsAlerts">Clear alerts</button>` : ""}
    </div>
  `;
}

// Wires the IDS rule editor (commit on blur) and the clear-alerts button.
export function bindIdsControls(device: any): void {
  const rules = document.getElementById("selectedIdsRules") as HTMLTextAreaElement | null;
  if (rules) {
    captureUndoOnFocus(rules as any);
    rules.addEventListener("change", () => {
      device.config.idsRules = rules.value.split("\n").map(l => l.trim()).filter(Boolean);
    });
  }
  document.getElementById("clearIdsAlerts")?.addEventListener("click", () => {
    device.config.alerts = [];
    syncPanel();
  });
}

// Wires the managed-switch SPAN mirror dropdown.
export function bindMirrorControl(device: any): void {
  const sel = document.getElementById("selectedMirror") as HTMLSelectElement | null;
  if (sel) sel.addEventListener("change", () => setSwitchMirror(device, sel.value ? { dest: sel.value } : null));
}

// Wires the spanning-tree enable toggle and bridge-priority field (managed
// switches). setSwitchStp pushUndo()s, reconverges, and re-syncs the panel.
export function bindStpControls(device: any): void {
  const toggle = document.getElementById("selectedStp") as HTMLInputElement | null;
  if (toggle) toggle.addEventListener("change", () => setSwitchStp(device, { enabled: toggle.checked }));
  const prio = document.getElementById("selectedStpPriority") as HTMLInputElement | null;
  if (prio) {
    captureUndoOnFocus(prio);
    prio.addEventListener("change", () => {
      const n = Number(prio.value);
      if (!Number.isInteger(n) || n < 0 || n > 61440 || n % 4096 !== 0) { sync().syncPanel(); return; }
      setSwitchStp(device, { priority: n });
    });
  }
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

// Wires the editable netfilter panel (renderFirewallControls): per-chain policy
// selects, per-rule delete buttons, and the add-rule form. Mutates the same
// config.rules / config.policy as the iptables CLI, with the same validation
// (a --dport needs -p tcp; src/dst must be a valid IPv4 or CIDR).
export function bindFirewallControls(device: any, chains: string[]): void {
  document.querySelectorAll("[data-fw-policy]").forEach(el => {
    el.addEventListener("change", (event: any) => {
      pushUndo();
      ensureConfig(device);
      device.config.policy = device.config.policy || {};
      device.config.policy[event.target.dataset.fwPolicy] = event.target.value;
      syncPanel();
    });
  });
  document.querySelectorAll("[data-fw-del]").forEach(el => {
    el.addEventListener("click", (event: any) => {
      const index = Number(event.currentTarget.dataset.fwDel);
      if (!Array.isArray(device.config?.rules) || !device.config.rules[index]) return;
      pushUndo();
      device.config.rules.splice(index, 1);
      syncPanel();
    });
  });
  const addBtn = document.getElementById("fwAddRule");
  if (!addBtn) return;
  addBtn.addEventListener("click", () => {
    const val = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value.trim() || "";
    const errEl = document.getElementById("fwAddError");
    const fail = (msg: string) => { if (errEl) errEl.textContent = msg; };
    const target = val("fwAddTarget") || "accept";
    const chain = (document.getElementById("fwAddChain") as HTMLSelectElement | null)?.value || chains[0];
    const protocol = val("fwAddProto");
    const src = val("fwAddSrc"), dst = val("fwAddDst"), dportRaw = val("fwAddDport");
    if (src && !parseIpv4Token(src)) return fail("Source must be a valid IPv4 address or CIDR.");
    if (dst && !parseIpv4Token(dst)) return fail("Destination must be a valid IPv4 address or CIDR.");
    let dport: number | undefined;
    if (dportRaw) {
      const n = Number(dportRaw);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return fail("Port must be 1–65535.");
      if (protocol !== "tcp") return fail("A destination port needs protocol tcp.");
      dport = n;
    }
    pushUndo();
    ensureConfig(device);
    device.config.rules = device.config.rules || [];
    device.config.rules.push({
      chain, target,
      ...(protocol ? { protocol } : {}),
      ...(src ? { src } : {}),
      ...(dst ? { dst } : {}),
      ...(dport != null ? { dport } : {}),
    });
    syncPanel();
  });
}

// Renders the inspector panel for a selected link (frame history + clear).
function renderLinkPanel(link: Link): void {
  const fromDev = getDevice(link.from);
  const toDev = getDevice(link.to);
  const history = link.frameHistory || [];
  const defaultName = `${fromDev?.name ?? link.from} ↔ ${toDev?.name ?? link.to}`;
  dom.detailsPanel.innerHTML = `
    ${panelHeading("Link")}
    <div class="field">
      <label for="selectedLinkName">Name</label>
      <div class="input-with-button">
        <input id="selectedLinkName" value="${escapeHtml(link.name || "")}" placeholder="${escapeHtml(defaultName)}" autocomplete="off">
        <button class="inline-button" id="clearLinkName" type="button" title="Revert to the default name">&times;</button>
      </div>
    </div>
    <div class="field">
      <label for="selectedLinkShutdown">Administratively down (shut)</label>
      <input id="selectedLinkShutdown" type="checkbox" ${link.shutdown ? "checked" : ""}>
      <p class="field-note">A shut link stays in the topology but carries no traffic.</p>
    </div>
    <div class="field-row">
      <div class="field">
        <label for="selectedLinkBandwidth">Bandwidth (Mbps)</label>
        <input id="selectedLinkBandwidth" type="number" min="0" step="1" value="${escapeHtml(link.bandwidth ?? "")}" placeholder="—" inputmode="decimal">
      </div>
      <div class="field">
        <label for="selectedLinkLatency">Latency (ms)</label>
        <input id="selectedLinkLatency" type="number" min="0" step="1" value="${escapeHtml(link.latency ?? "")}" placeholder="—" inputmode="decimal">
      </div>
    </div>
    <div class="field">
      <label for="selectedLinkLoss">Packet loss (%)</label>
      <input id="selectedLinkLoss" type="number" min="0" max="100" step="1" value="${escapeHtml(link.loss ?? "")}" placeholder="0" inputmode="decimal">
      <p class="field-note">Latency slows this wire's animation; loss randomly drops frames (watch a ping fail). Bandwidth feeds the streams sim.</p>
    </div>
    <div class="pill-row">
      <span class="pill">${escapeHtml(fromDev?.name || link.from)}</span>
      <span class="pill">${escapeHtml(toDev?.name || link.to)}</span>
      <span class="pill ${link.shutdown ? "pill-down" : ""}">${link.shutdown ? "DOWN" : "UP"}</span>
    </div>
    <div style="height: 12px"></div>
    <div class="field">
      <label>Frame History (${history.length})</label>
      ${history.length ? `
        <div class="frame-history-list">
          ${history.map((entry: any) => {
            const dir = getDevice(entry.fromDeviceId)?.name || entry.fromDeviceId;
            const label = frameLabel(entry.frame);
            const p = entry.frame.payload;
            const kind = entry.frame.etherType === 0x0806 ? "arp"
              : (p.type === "ipv4" && p.payload.type === "dhcp" ? "dhcp" : "icmp");
            return `<div class="frame-history-entry ${kind}">
              <span class="frame-step">Step ${entry.step}</span>
              <span class="frame-label">${escapeHtml(label)}</span>
              <span class="frame-dir">${escapeHtml(dir)} &rarr;</span>
            </div>`;
          }).join("")}
        </div>
      ` : `<p class="empty-state">No frames recorded.</p>`}
    </div>
    <button class="wide-button danger" id="deleteLink">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path></svg>
      Delete link
    </button>
    <div style="height: 8px"></div>
    <button class="wide-button" id="clearLinkHistory">Clear history</button>
  `;
  const deleteLinkBtn = document.getElementById("deleteLink");
  if (deleteLinkBtn) deleteLinkBtn.addEventListener("click", () => deleteLink(link.id));
  const clearBtn = document.getElementById("clearLinkHistory");
  if (clearBtn) clearBtn.addEventListener("click", () => {
    link.frameHistory = [];
    syncPanel();
  });
  const nameInput = document.getElementById("selectedLinkName") as HTMLInputElement | null;
  if (nameInput) {
    captureUndoOnFocus(nameInput);
    nameInput.addEventListener("input", (event: any) => {
      const value = event.target.value.trim();
      if (value) link.name = value;
      else delete link.name; // empty reverts to the derived default
      syncSimLog(); // the packet list's Link column shows this name
    });
  }
  const clearNameBtn = document.getElementById("clearLinkName");
  if (clearNameBtn && nameInput) {
    clearNameBtn.addEventListener("click", () => {
      pushUndo();
      delete link.name;
      nameInput.value = "";
      syncSimLog();
    });
  }
  const shutdownInput = document.getElementById("selectedLinkShutdown") as HTMLInputElement | null;
  if (shutdownInput) {
    shutdownInput.addEventListener("change", (event: any) => {
      pushUndo();
      if (event.target.checked) link.shutdown = true; else delete link.shutdown;
      syncPanel();
      sync().render(); // redraw the link's down/up styling
    });
  }
  // Bandwidth / latency / loss: a positive number sets the property; blank or
  // ≤0 clears it (back to default). They take effect on the next simulation.
  const linkNumberField = (id: string, key: "bandwidth" | "latency" | "loss", max?: number) => {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (!input) return;
    captureUndoOnFocus(input);
    input.addEventListener("input", (event: any) => {
      let value = Number(event.target.value);
      if (max != null && value > max) value = max;
      if (Number.isFinite(value) && value > 0) (link as any)[key] = value;
      else delete (link as any)[key];
    });
  };
  linkNumberField("selectedLinkBandwidth", "bandwidth");
  linkNumberField("selectedLinkLatency", "latency");
  linkNumberField("selectedLinkLoss", "loss", 100);
}

// Click-a-packet inspector: a full field breakdown of one captured frame.
export function renderFramePanel(frame: any): void {
  const etherTypeLabel: Record<number, string> = {
    0x0806: "0x0806 (ARP)", 0x0800: "0x0800 (IPv4)",
    0x888e: "0x888e (802.1X / EAPOL / 802.11)", 0x0802: "0x0802 (Spanning Tree / BPDU)",
  };
  const rows: [string, string][] = [
    ["Frame id", frame.id],
    ["Src MAC", frame.srcMac],
    ["Dst MAC", frame.dstMac],
    ["EtherType", etherTypeLabel[frame.etherType] || `0x${Number(frame.etherType).toString(16).padStart(4, "0")}`],
    ["802.1Q VLAN", frame.vlanTag != null ? String(frame.vlanTag) : "untagged"],
  ];
  const p = frame.payload;
  if (p.type === "arp") {
    rows.push(["ARP operation", p.operation], ["Sender MAC", p.senderMac], ["Sender IP", p.senderIp],
      ["Target MAC", p.targetMac], ["Target IP", p.targetIp]);
  } else if (p.type === "dot11") {
    rows.push(["802.11 subtype", p.subtype], ["SSID", p.ssid || "(none)"]);
  } else if (p.type === "dot1x") {
    rows.push(["802.1X subtype", p.subtype]);
    if (p.identity) rows.push(["Identity", p.identity]);
  } else if (p.type === "bpdu") {
    rows.push(["BPDU", p.flavour === "tcn" ? "Topology Change Notification" : "Configuration"],
      ["Root bridge id", p.rootId], ["Sending bridge id", p.bridgeId],
      ["Root path cost", String(p.rootCost)], ["Sending port", p.portId]);
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
      if (inner.dnsServerIp) rows.push(["DNS server", inner.dnsServerIp]);
    } else if (inner.type === "dns") {
      rows.push(["DNS", inner.op], ["Transaction id", String(inner.id)], ["Name", inner.name]);
      if (inner.op === "response") rows.push(["Answer", inner.address || "NXDOMAIN"]);
    }
  }
  dom.detailsPanel.innerHTML = `
    ${panelHeading("Frame")}
    <p class="empty-state">Captured frame — a running simulation pauses while you inspect. Click elsewhere or press Close to dismiss.</p>
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
    state.inspectedCapture = null;
    syncPanel();
    sync().render();
    syncSimLog(); // clear the packet-list row highlight
  });
}

export function syncPanel(): void {
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
        ${panelHeading("Selection")}
        <p class="empty-state">No device selected.</p>
      `;
    }
  } else if (!selected) {
    dom.detailsPanel.innerHTML = `
      ${panelHeading("Selection")}
      <p class="empty-state">No device selected.</p>
    `;
  } else {
    const neighbors = connectedIds(selected.id).map((id: string) => getDevice(id)).filter(isVisibleDevice);
    const selectedType = DEVICE_SPECS[selected.type]?.label ?? "Device";
    const isHost = selected.type === "computer" || selected.type === "laptop" || selected.type === "server";
    const pcConfigFields = isHost ? `
      <div class="field">
        <label class="label-with-badge" for="selectedIpv4">IPv4 address / prefix ${ipSourceBadge(selected.config)}</label>
        <div class="input-with-button">
          <input id="selectedIpv4" value="${escapeHtml(selected.config?.ipv4Address ? `${selected.config.ipv4Address}/${prefixOf(selected.config)}` : "")}" placeholder="0.0.0.0" autocomplete="off" inputmode="decimal">
          <button class="inline-button" id="clearIpv4" type="button" title="Clear IPv4 address">&times;</button>
        </div>
        <p class="field-note" id="hostSubnet">${selected.config?.ipv4Address ? `Subnet: ${escapeHtml(networkOf(selected.config.ipv4Address, prefixOf(selected.config)))}` : ""}</p>
      </div>
      <div class="field">
        <label for="selectedGateway">Default gateway</label>
        <div class="input-with-button">
          <input id="selectedGateway" value="${escapeHtml(selected.config?.gatewayIpv4Address || "")}" placeholder="192.168.1.1" autocomplete="off" inputmode="decimal">
          <button class="inline-button" id="clearGateway" type="button" title="Clear default gateway">&times;</button>
        </div>
      </div>
      <div class="field">
        <label for="selectedDns">DNS nameserver</label>
        <div class="input-with-button">
          <input id="selectedDns" value="${escapeHtml(selected.config?.dnsServerIp || "")}" placeholder="192.168.1.53" autocomplete="off" inputmode="decimal">
          <button class="inline-button" id="clearDns" type="button" title="Clear nameserver">&times;</button>
        </div>
      </div>
      <div class="field">
        <label for="selectedMac">MAC address</label>
        <div class="input-with-button">
          <input id="selectedMac" value="${escapeHtml(selected.config?.macAddress || "")}" placeholder="02:00:00:00:00:01" autocomplete="off">
          <button class="inline-button" id="randomMac" type="button" title="Generate random MAC">Random</button>
        </div>
      </div>
      ${selected.type === "laptop" ? renderWifiFields(selected.config, "The WiFi network this laptop associates to (must match an access point).") + (() => {
        const wlink = state.links.find((l: any) => l.wireless && (l.from === selected.id || l.to === selected.id));
        const warn = wlink && !wifiLinkAuthenticated(wlink) ? `<p class="field-note" style="color: var(--danger)">Associated but not authenticated — the password does not match the access point, so no traffic passes.</p>` : "";
        return `${warn}<div class="field"><button class="wide-button" id="associateLaptop" type="button">Show association handshake</button></div>`;
      })() : ""}
      ${selected.type === "server" ? renderDnsmasqSection(selected) : ""}
      <div class="field">
        <label>ARP table</label>
        ${renderArpTable(selected)}
      </div>
    ` : "";
    const apConfigFields = selected.type === "access-point" ? `
      <p class="field-note">A transparent bridge: it joins its wireless clients to the wired uplink (no MAC learning shown — it forwards like an unmanaged switch).</p>
      <div style="height: 10px"></div>
      ${renderWifiFields(selected.config, "The network this access point broadcasts. A laptop joins only if its SSID — and password, if set — match.")}
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
      ${renderStpSection(selected)}
      ${renderMirrorSection(selected)}
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
      <div class="field-row">
        <div class="field">
          <label for="selectedRouterEthernetPorts">Ethernet ports</label>
          <input id="selectedRouterEthernetPorts" type="number" min="0" max="12" step="1" value="${escapeHtml(selected.config?.ethernetPorts ?? 4)}">
        </div>
        <div class="field">
          <label for="selectedRouterSerialPorts">Serial ports</label>
          <input id="selectedRouterSerialPorts" type="number" min="0" max="12" step="1" value="${escapeHtml(selected.config?.serialPorts ?? 4)}">
        </div>
      </div>
      <div class="field">
        <label>Interfaces</label>
        <div id="routerInterfaceList">
        ${renderRouterInterfaces(selected)}
        </div>
      </div>
      <div class="field">
        <label>Netfilter (iptables INPUT + FORWARD)</label>
        ${renderFirewallControls(selected, ["forward", "input"])}
      </div>
      ${(selected.config?.natTranslations?.length) ? `
      <div class="field">
        <label>NAT translations</label>
        <p class="empty-state">${selected.config.natTranslations.length} active flow(s) — see <code>show ip nat translations</code>.</p>
      </div>` : ""}
    ` : "";
    const firewallConfigFields = selected.type === "firewall" ? `
      <div class="field">
        <label for="selectedFwPorts">Ethernet ports</label>
        <input id="selectedFwPorts" type="number" min="2" max="8" step="1" value="${escapeHtml(selected.config?.ethernetPorts ?? 2)}">
      </div>
      <div class="field">
        <label>Netfilter (iptables FORWARD)</label>
        ${renderFirewallControls(selected, ["forward"])}
      </div>
    ` : "";
    const idsConfigFields = selected.type === "ids" ? renderIdsSection(selected) : "";
    const hubConfigFields = selected.type === "hub" ? `
      <p class="field-note">A hub is a layer-1 repeater: it copies every frame out all other ports (no MAC learning, one collision domain).</p>
      <div style="height: 10px"></div>
      <div class="field">
        <label for="selectedPorts">Ethernet ports</label>
        <input id="selectedPorts" type="number" min="4" max="24" step="1" value="${escapeHtml(selected.config?.ethernetPorts || 4)}">
      </div>
      <div class="field">
        <label>Ports</label>
        <div class="port-list" id="switchPortList">
          ${renderSwitchPorts(selected)}
        </div>
      </div>
    ` : "";
    dom.detailsPanel.innerHTML = `
      ${panelHeading(isConfiguring ? "Configure" : "Selection")}
      <div class="field">
        <label for="selectedName">${hasHostname(selected) ? "Hostname" : "Name"}</label>
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
      ${(isHost || selected.type === "router" || selected.type === "firewall" || selected.type === "ids" || (selected.type === "switch" && selected.config?.managed)) ? `
        <button class="wide-button" id="openSelectedTerminal">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17l6 -6l-6 -6"></path><path d="M12 19h8"></path></svg>
          Terminal
        </button>
        <div style="height: 10px"></div>
      ` : ""}
      ${selected.type !== "lan" ? `
        <div class="button-row">
          <button class="row-button ${selected.poweredOff ? "" : "danger"}" id="togglePower">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 6a7.75 7.75 0 1 0 10 0"></path><path d="M12 2v6"></path></svg>
            ${selected.poweredOff ? "Power On" : "Power Off"}
          </button>
          <button class="row-button danger" id="deleteSelected">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path></svg>
            Delete
          </button>
        </div>
        <div style="height: 14px"></div>
      ` : ""}
      ${pcConfigFields}
      ${apConfigFields}
      ${switchConfigFields}
      ${routerConfigFields}
      ${firewallConfigFields}
      ${idsConfigFields}
      ${hubConfigFields}
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
    // Static assignments drive the host's CLI: each committed field (on blur /
    // Enter) runs the matching command in the device's terminal, flagged as
    // simulator-issued. No client-side clipping — an invalid value runs the
    // real command and shows its failure; the panel then re-renders to the
    // device's actual config. (Commands themselves push undo + re-sync.)
    const commitField = (id: string, toCommand: (value: string) => string | null) => {
      const input = document.getElementById(id) as HTMLInputElement | null;
      if (!input) return;
      input.addEventListener("change", () => {
        const command = toCommand(input.value.trim());
        if (command) runDeviceCommand(selected, command);
      });
      input.addEventListener("keydown", (event: any) => { if (event.key === "Enter") input.blur(); });
    };
    commitField("selectedIpv4", v => v ? `ip addr add ${v} dev eth0` : "ip addr flush dev eth0");
    commitField("selectedGateway", v => v ? `ip route add default via ${v}` : "ip route del default");
    commitField("selectedDns", v => v ? `echo nameserver ${v} > /etc/resolv.conf` : "rm /etc/resolv.conf");
    commitField("selectedMac", v => v ? `ip link set dev eth0 address ${v}` : null);

    // The clear (×) and random-MAC buttons run their commands too.
    const runOnClick = (id: string, command: string | (() => string)) => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener("click", () => runDeviceCommand(selected, typeof command === "function" ? command() : command));
    };
    runOnClick("clearIpv4", "ip addr flush dev eth0");
    runOnClick("clearGateway", "ip route del default");
    runOnClick("clearDns", "rm /etc/resolv.conf");
    runOnClick("randomMac", () => `ip link set dev eth0 address ${randomMac()}`);
    bindDnsmasqControls(selected);
    // WiFi SSID / password (laptop joins, access point broadcasts). Set directly
    // on the config — these aren't terminal-driven — committing on change so the
    // normalised value (and any association the canvas draws) re-renders.
    const bindWifiField = (id: string, field: "ssid" | "wifiPassword", normalise: (v: string) => string) => {
      const input = document.getElementById(id) as HTMLInputElement | null;
      if (!input) return;
      captureUndoOnFocus(input);
      input.addEventListener("change", (event: any) => {
        ensureConfig(selected);
        selected.config[field] = normalise(event.target.value);
        syncPanel();
        sync().render();
      });
      input.addEventListener("keydown", (event: any) => { if (event.key === "Enter") input.blur(); });
    };
    bindWifiField("selectedSsid", "ssid", normaliseSsid);
    bindWifiField("selectedWifiPassword", "wifiPassword", normaliseWifiPassword);
    document.getElementById("associateLaptop")?.addEventListener("click", () => {
      const setup = buildAssociationEvents(selected);
      if (typeof setup === "string") { dom.modeLabel.textContent = setup; return; }
      startSimulation(setup, selected.id, selected.config?.ssid || "", "associate");
    });
    document.getElementById("clearWifiPassword")?.addEventListener("click", () => {
      pushUndo();
      ensureConfig(selected);
      selected.config.wifiPassword = "";
      syncPanel();
      sync().render();
    });
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
        const { peerId, ifaceName } = event.target.dataset;
        if (!peerId && !ifaceName) return;
        const value = event.target.value.trim();
        const parsed = value === "" ? null : parseIpv4Token(value);
        if (value !== "" && !parsed) {
          event.target.setCustomValidity("Enter a valid IPv4 address (optionally with /prefix).");
          return;
        }
        event.target.setCustomValidity("");
        const vlanTag = event.target.dataset.vlanTag != null ? Number(event.target.dataset.vlanTag) : undefined;
        // Connected ports key by peer; unconnected ports key by interface name.
        const iface = peerId ? routerInterfaceFor(selected, peerId, vlanTag) : routerInterfaceForName(selected, ifaceName);
        iface.ipv4Address = parsed ? parsed.address : "";
        if (parsed?.prefixLength != null) iface.prefixLength = parsed.prefixLength;
        event.target.title = iface.ipv4Address ? `Subnet: ${networkOf(iface.ipv4Address, prefixOf(iface))}` : "";
      });
    });
    // The per-interface unlink (×) removes that port's cable.
    document.querySelectorAll(".iface-unlink").forEach(button => {
      button.addEventListener("click", (event: any) => {
        const peerId = event.currentTarget.dataset.peerId;
        const link = linksFor(selected.id).find((l: Link) => l.from === peerId || l.to === peerId);
        if (link && deleteLink(link.id)) {
          state.selectedId = selected.id; // deleteLink clears link selection only; keep the router selected
          syncPanel();
          sync().render();
        }
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
    bindStpControls(selected);
    bindMirrorControl(selected);
    if (selected.type === "ids") bindIdsControls(selected);
    if (selected.type === "router") bindFirewallControls(selected, ["forward", "input"]);
    if (selected.type === "firewall") bindFirewallControls(selected, ["forward"]);
    const terminalButton = document.getElementById("openSelectedTerminal");
    if (terminalButton) terminalButton.addEventListener("click", () => openTerminalFor(selected));
    const powerButton = document.getElementById("togglePower");
    if (powerButton) powerButton.addEventListener("click", () => {
      pushUndo();
      selected.poweredOff = !selected.poweredOff;
      // Power state only — an unconfigured host stays "unassigned" until the
      // simulation is started (Play boots it via animated DHCP).
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
  if (state.dock.open) syncTerminal();
}

export function syncDeviceList(): void {
  if (!state.devices.length) {
    dom.deviceList.innerHTML = "";
    return;
  }
  const visibleDevices = state.devices.filter(isVisibleDevice);
  dom.deviceList.innerHTML = visibleDevices.map(device => `
    <button class="device-row ${device.id === state.selectedId ? "active" : ""}" data-id="${escapeHtml(device.id)}">
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
