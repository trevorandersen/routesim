import type { Device, Link, DeviceType } from "./types";
import { state, sync, pushUndo, captureUndoOnFocus, captureUndoOnFocusWithin, linksChanged } from "./state";
import { DEVICE_SPECS, isHost, offersTerminal, defaultPortCount } from "./device-registry";
import { dom } from "./dom";
import { dhcpXidText } from "./frame";
import { escapeHtml, isValidIpv4, isValidMac, normaliseMacAddress, randomMac, parseIpv4Token, prefixOf, networkOf, normaliseSsid, normaliseWifiPassword, mutationText, clampFirewallPortCount, FIREWALL_PORT_RANGE } from "./utils";
import { ensureConfig, normaliseVlans, normaliseDnsRecords, normaliseDhcpLeases, normaliseRadiusUsers } from "./normalise";
import { snortRuleIssue } from "./snort";
import {
  getDevice, isVisibleDevice, connectedIds, linkedPortsFor, linksFor, wifiLinkAuthenticated,
  linkName, isPhysicalLink,
  routerInterfacesWithNames, routerInterfaceFor, routerInterfaceForName, switchInterfacesWithNames,
  deleteSelection, deleteLink, collapseLan, expandLan, configureDevice, hasHostname, applyHostname, deviceNameBlockReason,
  setLinkShutdown, setDevicePower, setSwitchManaged
} from "./devices";
import {
  openTerminalFor, syncTerminal, runDeviceCommand, openDock,
  addSwitchVlan, removeSwitchVlan, setSwitchPortVlan, setSwitchPortMode, setSwitchTrunkNative, setSwitchStp, setSwitchMirror,
  setDhcpRange, setDhcpRouterOption, setListeningPorts, stpPriorityError, appendFirewallRule,
  showFirewallRules, showNftRuleset, ruleLangOf, ruleToNft
} from "./terminal";
import { resizeCanvas } from "./canvas";
import { startSimulation, animatedRunBlockReason } from "./engine";
import { syncSimLog } from "./simlog-view";
import { buildAssociationEvents } from "./simulation";
import { buildAttackEvents } from "./security/offensive/attacks";

export function syncOptionControls(): void {
  dom.showDeviceNames.checked = state.options.showDeviceNames;
  dom.showIpAddresses.checked = state.options.showIpAddresses;
  dom.showMacAddresses.checked = state.options.showMacAddresses;
  dom.packetCallouts.checked = state.options.packetCallouts;
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

function ipSourceBadge(config: unknown): string {
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

function vlanOptions(device: Device, current: number): string {
  const vlans = normaliseVlans(device.config?.vlans || []);
  if (!vlans.some((v) => v.id === current)) vlans.push({ id: current, name: current === 1 ? "default" : `Vlan${current}` });
  return vlans
    .sort((a, b) => a.id - b.id)
    .map((v) => `<option value="${v.id}" ${v.id === current ? "selected" : ""}>VLAN ${v.id}</option>`)
    .join("");
}

export function renderSwitchVlans(device: Device): string {
  const vlans = normaliseVlans(device.config?.vlans || []);
  const chips = vlans.map((v) => `
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

export function renderSwitchPorts(device: Device): string {
  const interfaces = switchInterfacesWithNames(device);
  const isManaged = Boolean(device.config?.managed);
  const stpOn = isManaged && (device.config?.stp ? device.config.stp.enabled !== false : true);
  const stpPorts = stpOn ? (device.config?.stp?.ports || {}) : {};
  const ports = linkedPortsFor(device.id);
  return interfaces.map((iface, index: number) => {
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
export function renderStpSection(device: Device): string {
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

export function renderRouterInterfaces(device: Device): string {
  const interfaces = routerInterfacesWithNames(device);
  return `
    <div class="interface-list">
      ${interfaces.map((iface) => {
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

export function renderFirewallRules(device: Device): string {
  const rules = (device.config?.rules || []);
  if (!rules.length) return `<p class="empty-state">No rules — the default policy applies to all traffic.</p>`;
  const nft = ruleLangOf(device) === "nftables";
  const del = (index: number) => `<button class="inline-button fw-rule-del" type="button" data-fw-del="${index}" title="Delete this rule" aria-label="Delete rule">&times;</button>`;
  // In nftables mode the whole rule is one statement (verdict last), coloured on
  // the device's chosen class; in iptables mode the TARGET leads, as `-L` shows.
  return `<ol class="fw-rule-list">${rules.map((r, index: number) => {
    if (nft) {
      return `<li class="fw-nft-row fw-${escapeHtml(r.target)}">${escapeHtml(String(r.chain || "forward"))} ${escapeHtml(ruleToNft(r))}${del(index)}</li>`;
    }
    const match = [
      r.protocol ? `-p ${escapeHtml(r.protocol)}` : "",
      r.src ? `-s ${escapeHtml(r.src)}` : "",
      r.dst ? `-d ${escapeHtml(r.dst)}` : "",
      r.icmpType ? `--icmp-type ${escapeHtml(r.icmpType)}` : "",
      r.dport ? `--dport ${escapeHtml(String(r.dport))}` : "",
      r.states?.length ? `--state ${escapeHtml(r.states.map((s: string) => s.toUpperCase()).join(","))}` : "",
      r.rejectWith ? `--reject-with ${escapeHtml(r.rejectWith)}` : "",
    ].filter(Boolean).join(" ");
    return `<li><span class="fw-target fw-${escapeHtml(r.target)}">${escapeHtml(String(r.target).toUpperCase())}</span> ${escapeHtml(String(r.chain || "forward").toUpperCase())} ${match || "(any)"}${del(index)}</li>`;
  }).join("")}</ol>`;
}

// The editable netfilter panel shown under Configure for routers (INPUT +
// FORWARD) and the transparent firewall (FORWARD only): the rule list (each row
// deletable), a per-chain default-policy select, and an add-rule form. It writes
// the same `config.rules`/`config.policy` the iptables CLI does.
// The router's live PAT table (issue #2). Lists every translation — Cisco's
// Inside local (the original inside endpoint) → Inside global (the outside
// address it is translated to) → Outside (the destination) — and **flashes** the
// entry a frame most recently created or used (`NatEntry.lastStep`, refreshed
// live by `touchNat` while this panel is open). The flash is a highlighted row
// plus a "●" marker, so the signal is not carried by colour alone.
export function renderNatTranslations(device: Device): string {
  const translations = (device.config?.natTranslations || []) as any[];
  if (!translations.length) return "";
  const maxStep = Math.max(-1, ...translations.map(t => t.lastStep ?? -1));
  const endpoint = (ip: string, port: number, proto: string) => proto === "tcp" ? `${ip}:${port}` : `${ip} #${port}`;
  const rows = translations.map(t => {
    const flash = t.lastStep != null && t.lastStep === maxStep;
    return `<tr class="nat-row${flash ? " nat-flash" : ""}">
      <td class="nat-mark">${flash ? '<span title="just used">●</span>' : ""}</td>
      <td>${escapeHtml(t.protocol)}</td>
      <td>${escapeHtml(endpoint(t.insideIp, t.insidePort, t.protocol))}</td>
      <td>${escapeHtml(endpoint(t.outsideIp, t.outsidePort, t.protocol))}</td>
      <td>${escapeHtml(t.destIp)}</td>
    </tr>`;
  }).join("");
  return `
      <div class="field">
        <label>NAT translations (${translations.length})</label>
        <table class="nat-table">
          <thead><tr><th></th><th>Pro</th><th>Inside</th><th>Outside</th><th>Dest</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
}

export function renderFirewallControls(device: Device, chains: string[]): string {
  const policy = device.config?.policy || {};
  const lang = ruleLangOf(device);
  // Language selector + the native ruleset view it picks. Both front doors parse
  // into one model, so this only switches the dialect the device presents its
  // rules in (and that the script export speaks). See docs/src/firewall.md.
  const langRow = `
      <div class="field-row fw-policy-row">
        <label for="fwRuleLang">Rule language</label>
        <select id="fwRuleLang" class="fw-select" data-fw-rulelang>
          ${[["iptables", "iptables"], ["nftables", "nftables"]].map(([v, l]) => `<option value="${v}"${lang === v ? " selected" : ""}>${l}</option>`).join("")}
        </select>
      </div>`;
  const native = lang === "nftables" ? showNftRuleset(device, chains) : showFirewallRules(device, false, chains);
  const nativeView = `
      <details class="fw-native-view">
        <summary>${lang === "nftables" ? "nft list ruleset" : "iptables-save"}</summary>
        <pre class="fw-native">${escapeHtml(native)}</pre>
      </details>`;
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
      ${langRow}
      ${policyRows}
      <label>Rules</label>
      ${renderFirewallRules(device)}
      ${nativeView}
      <div class="fw-add-form">
        <select id="fwAddTarget" class="fw-select" title="Target">
          ${["accept", "drop", "reject"].map(t => `<option value="${t}">${t.toUpperCase()}</option>`).join("")}
        </select>${chainField}
        <select id="fwAddProto" class="fw-select" title="Protocol">
          ${[["", "any proto"], ["icmp", "icmp"], ["tcp", "tcp"], ["udp", "udp"]].map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
        </select>
        <select id="fwAddState" class="fw-select" title="Connection state (-m state)">
          ${[["", "any state"], ["new", "NEW"], ["established,related", "ESTABLISHED,RELATED"], ["new,established", "NEW,ESTABLISHED"]].map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
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
function renderDnsmasqSection(device: Device): string {
  const config = device.config || {};
  const records = normaliseDnsRecords(config.dnsRecords || []);
  const leases = normaliseDhcpLeases(config.dhcpLeases || []);
  const radiusUsers = normaliseRadiusUsers(config.radius?.users || []);
  // Three listener states, each shown as itself: no list = any port (an empty
  // field), a list = those ports, an EMPTY list = nothing (the word `closed`).
  // The field used to render both "any" and "nothing" as empty, so refuse-all
  // could not be seen — and committing the field flipped it to accept-all.
  const portsValue = !Array.isArray(config.openPorts) ? "" : config.openPorts.length ? config.openPorts.join(", ") : "closed";
  const portsNote = !Array.isArray(config.openPorts) ? "Accepts a connection on any port. List ports to limit it, or type closed to refuse them all."
    : config.openPorts.length ? `Accepts on ${config.openPorts.join(", ")}; every other port is refused (RST).`
    : "Closed: every connection is refused (RST). Clear the field to accept on any port.";
  return `
    <div class="field">
      <label for="dnsmasqRunning">dnsmasq service running</label>
      <input id="dnsmasqRunning" type="checkbox" ${config.dnsmasqRunning !== false ? "checked" : ""}>
    </div>
    <div class="field">
      <label for="httpEnabled">HTTP service (answer GET with 200 OK)</label>
      <input id="httpEnabled" type="checkbox" ${config.httpEnabled ? "checked" : ""}>
    </div>
    ${config.httpEnabled ? `
    <div class="field">
      <label for="httpTitle">Web page title</label>
      <input id="httpTitle" value="${escapeHtml(config.httpTitle || "")}" placeholder="${escapeHtml(device.name)} — RouteSim web server" autocomplete="off">
    </div>` : ""}
    <div class="field">
      <label>DNS records (address=/name/ip)</label>
      ${records.length ? `
      <table class="data-table">
        <thead><tr><th>Name</th><th>IPv4</th><th></th></tr></thead>
        <tbody>
          ${records.map((r, i: number) => `
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
          ${leases.map((l) => `<tr><td>${escapeHtml(l.macAddress)}</td><td>${escapeHtml(l.ipv4Address)}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>` : ""}
    <div class="field">
      <label>RADIUS users (802.1X)</label>
      ${radiusUsers.length ? `
      <table class="data-table">
        <thead><tr><th>Identity</th><th>Password</th><th></th></tr></thead>
        <tbody>
          ${radiusUsers.map((u, i: number) => `
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
      <input id="listenPorts" value="${escapeHtml(portsValue)}" placeholder="any port — or 80, 443 — or closed" autocomplete="off">
      <p class="field-note" id="listenPortsNote">${escapeHtml(portsNote)}</p>
    </div>
  `;
}

// Wire the dnsmasq panel controls (no-ops when the selection isn't a server —
// the elements simply aren't in the DOM).
function bindDnsmasqControls(selected: Device): void {
  const runningInput = document.getElementById("dnsmasqRunning") as HTMLInputElement | null;
  if (runningInput) {
    runningInput.addEventListener("change", (event: any) => {
      pushUndo();
      ensureConfig(selected);
      selected.config.dnsmasqRunning = event.target.checked;
      syncPanel();
    });
  }
  const httpInput = document.getElementById("httpEnabled") as HTMLInputElement | null;
  if (httpInput) {
    httpInput.addEventListener("change", (event: any) => {
      pushUndo();
      ensureConfig(selected);
      selected.config.httpEnabled = event.target.checked;
      syncPanel(); // reveal/hide the title field
    });
  }
  const httpTitleInput = document.getElementById("httpTitle") as HTMLInputElement | null;
  if (httpTitleInput) {
    httpTitleInput.addEventListener("change", (event: any) => {
      pushUndo();
      ensureConfig(selected);
      selected.config.httpTitle = event.target.value.replace(/\s+/g, " ").trim().slice(0, 200);
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
      const existing = records.find((r) => r.name === name);
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
  // The DHCP range and router option commit through the dnsmasq mutators the
  // shell uses (setDhcpRange / setDhcpRouterOption), on change — not per
  // keystroke and per field, which could store half a range or an inverted one
  // the shell refuses. Both bounds are committed together; a rejected value
  // stays in the field with the reason on it and on the status line.
  const commitField = (input: HTMLInputElement, result: { ok: boolean; error?: string; message?: string; warnings: string[] }) => {
    input.setCustomValidity(result.ok ? "" : (result.error || "Invalid value."));
    if (!result.ok) input.reportValidity?.();
    dom.modeLabel.textContent = mutationText(result);
  };
  const rangeStart = document.getElementById("dhcpRangeStart") as HTMLInputElement | null;
  const rangeEnd = document.getElementById("dhcpRangeEnd") as HTMLInputElement | null;
  if (rangeStart && rangeEnd) {
    const commitRange = (edited: HTMLInputElement) => {
      const start = rangeStart.value.trim(), end = rangeEnd.value.trim();
      rangeStart.setCustomValidity(""); rangeEnd.setCustomValidity("");
      // One bound typed, the other still empty: the learner is mid-edit — wait
      // for the second field rather than rejecting (or storing) half a range.
      if (!!start !== !!end && !selected.config?.dhcpRangeStart) return;
      commitField(edited, setDhcpRange(selected, start, end));
    };
    rangeStart.addEventListener("change", () => commitRange(rangeStart));
    rangeEnd.addEventListener("change", () => commitRange(rangeEnd));
  }
  const routerOption = document.getElementById("dhcpRouterIp") as HTMLInputElement | null;
  if (routerOption) routerOption.addEventListener("change", () => commitField(routerOption, setDhcpRouterOption(selected, routerOption.value)));

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
      const existing = users.find((u) => u.identity === identity);
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

  // Listening ports commit through setListeningPorts, the `ports` command's
  // mutator, and take the same three forms as the command: an empty field (or
  // `none`/`any`) clears the list (accept on any port); `closed` is the empty
  // list ("listen on nothing" — refuses everything); otherwise the ports.
  const portsInput = document.getElementById("listenPorts") as HTMLInputElement | null;
  if (portsInput) {
    portsInput.addEventListener("change", () => {
      const text = portsInput.value.trim();
      const parts = text.split(/[\s,]+/).filter(Boolean);
      const ports = !parts.length || /^(none|any|off|clear)$/i.test(text) ? null
        : /^closed$/i.test(text) ? []
        : parts.map(Number);
      const result = setListeningPorts(selected, ports);
      portsInput.setCustomValidity(result.ok ? "" : "Enter comma-separated ports (1–65535), closed, or leave it empty for any port.");
      if (!result.ok) portsInput.reportValidity?.();
      dom.modeLabel.textContent = mutationText(result);
    });
  }
}

export function renderArpTable(device: Device): string {
  const entries = Array.isArray(device.config?.arpTable) ? device.config.arpTable : [];
  return `
    <table class="data-table">
      <thead>
        <tr><th>IPv4</th><th>MAC</th></tr>
      </thead>
      <tbody>
        ${entries.length ? entries.map((entry) => `
          <tr>
            <td>${escapeHtml(entry.ipv4Address || "")}</td>
            <td>${escapeHtml(entry.macAddress || "")}</td>
          </tr>
        `).join("") : `<tr><td class="table-empty" colspan="2">Empty</td></tr>`}
      </tbody>
    </table>
  `;
}

export function renderMacAddressTable(device: Device): string {
  const entries = Array.isArray(device.config?.macTable) ? device.config.macTable : [];
  const isManaged = Boolean(device.config?.managed);
  const columns = isManaged ? 4 : 3;
  return `
    <table class="data-table">
      <thead>
        <tr>${isManaged ? "<th>VLAN</th>" : ""}<th>MAC Address</th><th>Type</th><th>Port</th></tr>
      </thead>
      <tbody>
        ${entries.length ? entries.map((entry) => `
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

// SPAN port mirroring control (managed switches): a dropdown to pick the monitor
// port that an IDS listens on (or "off"), plus per-port source checkboxes to
// choose which ports' traffic is mirrored (all ticked = the whole switch).
export function renderMirrorSection(device: Device): string {
  const mirror = device.config?.mirror;
  const dest = mirror?.dest || "";
  const ports = switchInterfacesWithNames(device);
  const destField = `
    <div class="field">
      <label for="selectedMirror">Port mirroring (SPAN)</label>
      <select id="selectedMirror" class="mirror-select">
        <option value="">off</option>
        ${ports.map((p) => `<option value="${escapeHtml(p.name)}" ${p.name === dest ? "selected" : ""}>${escapeHtml(p.name)}${p.peer ? ` &rarr; ${escapeHtml(p.peer.name)}` : ""}</option>`).join("")}
      </select>
      <span class="field-note">Copy traffic to this monitor port (cable an IDS sensor there).</span>
    </div>`;
  if (!dest) return destField;
  // Source-port selection: which cabled ports get mirrored. All ticked = the
  // whole switch (sources omitted); untick to mirror only specific ports.
  const sources: string[] | undefined = mirror?.sources;
  const eligible = ports.filter((p) => p.peer && p.name !== dest);
  const sourceField = eligible.length
    ? `
    <div class="field">
      <label>Mirror sources</label>
      <div class="mirror-sources">
        ${eligible.map((p) => {
          const checked = !sources || sources.includes(p.name);
          return `<label class="mirror-source"><input type="checkbox" class="mirror-source-cb" data-port="${escapeHtml(p.name)}"${checked ? " checked" : ""}> <span>${escapeHtml(p.name)} &rarr; ${escapeHtml(p.peer.name)}</span></label>`;
        }).join("")}
      </div>
      <span class="field-note">All ticked mirrors the whole switch; untick to mirror only specific ports.</span>
    </div>`
    : `
    <div class="field"><span class="field-note">No other cabled ports to mirror — cable a host to mirror its traffic.</span></div>`;
  return destField + sourceField;
}

// The IDS sensor panel: the Snort rule set (editable as local.rules) and the
// alert log. Wired by bindIdsControls.
export function renderIdsSection(device: Device): string {
  const ruleLines: string[] = device.config?.idsRules || [];
  const rules = ruleLines.join("\n");
  const alerts: string[] = device.config?.alerts || [];
  // Surface any rule that won't load (and why), so a silently-inert rule — a
  // bad protocol, IP spec, port or unsupported option — is explained (R26).
  const issues = ruleLines.map(r => ({ r, issue: snortRuleIssue(r) })).filter((x): x is { r: string; issue: string } => !!x.issue);
  return `
    <p class="field-note">A passive Snort sensor. Cable it to a switch SPAN/monitor port; it inspects the mirrored copy of traffic and raises alerts on rule matches. It is not in the data path, so it can watch but never block.</p>
    <div class="field">
      <label for="selectedIdsRules">Rules (/etc/snort/rules/local.rules)</label>
      <textarea id="selectedIdsRules" class="ids-rules" spellcheck="false" rows="6">${escapeHtml(rules)}</textarea>
      <span class="field-note">One Snort rule per line, e.g. <code>alert tcp any any -&gt; any 23 (msg:"Telnet"; sid:1000002;)</code></span>
      ${issues.length ? `<span class="field-note error">${issues.length} rule${issues.length === 1 ? "" : "s"} won't load:${issues.map(x => `<br>• <code>${escapeHtml(x.r)}</code> — ${escapeHtml(x.issue)}`).join("")}</span>` : ""}
    </div>
    <div class="field">
      <label>Alerts (${alerts.length})</label>
      <pre class="ids-alerts">${alerts.length ? escapeHtml(alerts.slice(-50).join("\n")) : "(none yet — run a simulation through the monitored switch)"}</pre>
      ${alerts.length ? `<button class="wide-button" id="clearIdsAlerts">Clear alerts</button>` : ""}
    </div>
  `;
}

// Wires the IDS rule editor (commit on blur) and the clear-alerts button.
export function bindIdsControls(device: Device): void {
  const rules = document.getElementById("selectedIdsRules") as HTMLTextAreaElement | null;
  if (rules) {
    captureUndoOnFocus(rules as any);
    rules.addEventListener("change", () => {
      device.config.idsRules = rules.value.split("\n").map(l => l.trim()).filter(Boolean);
      syncPanel();   // re-render so the "won't load" note reflects the edited rules
    });
  }
  document.getElementById("clearIdsAlerts")?.addEventListener("click", () => {
    device.config.alerts = [];
    syncPanel();
  });
}

// The Red Team panel: a target, the enabled attacks, a Launch button, and the
// last run's findings. Wired by bindAttackerControls.
export function renderAttackerSection(device: any): string {
  const cfg = device.config || {};
  const has = (k: string) => (cfg.attacks || []).includes(k);
  const log: string[] = cfg.attackLog || [];
  return `
    <p class="field-note">A Red Team (Kali) host. Set a target, choose attacks, then Launch (or just press Play). It generates real attack traffic an IDS can detect; a passive victim can't steer it.</p>
    <div class="field">
      <label for="selectedAttackTarget">Target (IP or device)</label>
      <input id="selectedAttackTarget" value="${escapeHtml(cfg.attackTarget || "")}" placeholder="e.g. 10.0.0.10 or SRV" autocomplete="off">
    </div>
    <div class="field">
      <label>Attacks</label>
      <div class="attack-checks">
        <label class="stp-check"><input type="checkbox" class="attack-check" data-attack="scan" ${has("scan") ? "checked" : ""}> Port scan</label>
        <label class="stp-check"><input type="checkbox" class="attack-check" data-attack="sweep" ${has("sweep") ? "checked" : ""}> Ping sweep</label>
        <label class="stp-check"><input type="checkbox" class="attack-check" data-attack="arp-spoof" ${has("arp-spoof") ? "checked" : ""}> ARP spoof</label>
      </div>
    </div>
    <button class="wide-button" id="launchAttack">Launch attacks</button>
    ${log.length ? `<div class="field"><label>Last run</label><pre class="ids-alerts attack-log">${escapeHtml(log.join("\n"))}</pre></div>` : ""}
  `;
}

// Wires the Red Team target field, attack checkboxes, and Launch button.
export function bindAttackerControls(device: any): void {
  const target = document.getElementById("selectedAttackTarget") as HTMLInputElement | null;
  if (target) {
    captureUndoOnFocus(target);
    target.addEventListener("change", () => { device.config.attackTarget = target.value.trim(); });
  }
  document.querySelectorAll(".attack-check").forEach(el => el.addEventListener("change", () => {
    pushUndo();   // ticking an attack is an edit like any other — it had no undo point
    ensureConfig(device);
    device.config.attacks = Array.from(document.querySelectorAll<HTMLInputElement>(".attack-check"))
      .filter(c => c.checked).map(c => c.dataset.attack);
  }));
  document.getElementById("launchAttack")?.addEventListener("click", () => {
    const busy = animatedRunBlockReason();   // another run owns the simulator (engine beginRun)
    if (busy) { dom.modeLabel.textContent = busy; return; }
    if (target) device.config.attackTarget = target.value.trim();   // commit before launching
    const setup = buildAttackEvents(device);
    if (typeof setup === "string") { dom.modeLabel.textContent = setup; return; }
    startSimulation(setup, device.id, "", "attack");
  });
}

// Wires the managed-switch SPAN mirror dropdown + the source-port checkboxes.
export function bindMirrorControl(device: Device): void {
  const name = device.config?.mirror?.name;
  const sel = document.getElementById("selectedMirror") as HTMLSelectElement | null;
  // Changing the monitor port resets the mirror to the whole switch (the new
  // dest can't also be a source); pick specific ports with the checkboxes below.
  if (sel) sel.addEventListener("change", () => setSwitchMirror(device, sel.value ? { name, dest: sel.value } : null));
  const dest = device.config?.mirror?.dest;
  const cbs = Array.from(document.querySelectorAll<HTMLInputElement>(".mirror-source-cb"));
  if (dest && cbs.length) {
    const apply = (changed: HTMLInputElement) => {
      const all = cbs.map(cb => cb.dataset.port!);
      const checked = cbs.filter(cb => cb.checked).map(cb => cb.dataset.port!);
      // A SPAN session with no source ports would fall through to the engine's
      // "empty sources = mirror every port" and silently monitor the whole
      // switch. Keep at least one source and explain, rather than flip it (R95).
      if (checked.length === 0) {
        changed.checked = true;
        dom.modeLabel.textContent = "A mirror session needs at least one source port — change the monitor port to reset it to the whole switch.";
        return;
      }
      // All ticked → mirror the whole switch (omit sources); a subset → that list.
      const sources = checked.length === all.length ? undefined : checked;
      setSwitchMirror(device, { name, dest, sources });
    };
    cbs.forEach(cb => cb.addEventListener("change", () => apply(cb)));
  }
}

// Wires the spanning-tree enable toggle and bridge-priority field (managed
// switches). setSwitchStp pushUndo()s, reconverges, and re-syncs the panel.
export function bindStpControls(device: Device): void {
  const toggle = document.getElementById("selectedStp") as HTMLInputElement | null;
  if (toggle) toggle.addEventListener("change", () => setSwitchStp(device, { enabled: toggle.checked }));
  const prio = document.getElementById("selectedStpPriority") as HTMLInputElement | null;
  if (prio) {
    captureUndoOnFocus(prio);
    prio.addEventListener("change", () => {
      // A bad priority used to snap back to the old value without a word. It
      // now stays in the field with the reason on it and on the status line.
      const bad = stpPriorityError(prio.value);
      prio.setCustomValidity(bad || "");
      if (bad) { prio.reportValidity?.(); dom.modeLabel.textContent = bad; return; }
      dom.modeLabel.textContent = setSwitchStp(device, { priority: Number(prio.value) });
    });
  }
}

// The element under a delegated event that matches `selector`, or null — the
// click may land on a child (the port-remove button's SVG), so walk up.
function delegateTarget<E extends HTMLElement>(event: Event, selector: string): E | null {
  return (event.target as HTMLElement | null)?.closest<E>(selector) ?? null;
}

// Wires the switch/hub port rows (the link-remove × and, when managed, the
// mode/VLAN/native selects) and the managed-switch VLAN chips + Add control.
// Bound by delegation on the stable #switchPortList / #switchVlanList
// containers, so the port-count spinner can re-render the rows without a
// rebind: per-element listeners were lost on re-render, and re-binding them
// stacked a second Add-VLAN listener on the untouched VLAN list (R90). Each
// handler goes through the terminal mutators (or deleteLink), which validate,
// pushUndo(), and re-sync — so the inspector edit and the CLI share one path.
export function bindSwitchPortControls(device: Device): void {
  const portList = document.getElementById("switchPortList");
  if (portList) {
    portList.addEventListener("change", event => {
      const select = delegateTarget<HTMLSelectElement>(event, ".port-mode-select, .port-vlan-select, .port-native-select");
      const port = select?.dataset.port;
      if (!select || !port) return;
      if (select.classList.contains("port-mode-select")) setSwitchPortMode(device, port, select.value);
      else if (select.classList.contains("port-vlan-select")) setSwitchPortVlan(device, port, select.value);
      else setSwitchTrunkNative(device, port, select.value);
    });
    portList.addEventListener("click", event => {
      // Route through deleteLink (undo + selection clear + recomputeStp) — a bare
      // state.links filter left spanning tree stale, leaving the survivor of a
      // redundant loop wrongly blocked until the next run.
      const id = delegateTarget(event, ".port-remove")?.dataset.linkId;
      if (id && deleteLink(id)) sync().render();
    });
  }
  const vlanList = document.getElementById("switchVlanList");
  if (!vlanList) return;
  const add = () => {
    const addVlanId = document.getElementById("addVlanId") as HTMLInputElement | null;
    if (!addVlanId || !addVlanId.value.trim()) return;
    // The mutator's answer goes on the status line; "Invalid VLAN ID: …" was
    // discarded, so a bad id looked like a button that did nothing.
    const message = addSwitchVlan(device, addVlanId.value);
    const invalid = message.startsWith("Invalid");
    addVlanId.setCustomValidity(invalid ? `${message} — a VLAN id is a whole number from 1 to 4094.` : "");
    if (invalid) addVlanId.reportValidity?.();
    dom.modeLabel.textContent = invalid ? `${message} — a VLAN id is a whole number from 1 to 4094.` : message;
  };
  vlanList.addEventListener("click", event => {
    if (delegateTarget(event, "#addVlanBtn")) { add(); return; }
    const vlan = delegateTarget(event, ".vlan-remove")?.dataset.vlan;
    if (vlan) removeSwitchVlan(device, vlan);
  });
  vlanList.addEventListener("keydown", event => {
    if ((event as KeyboardEvent).key === "Enter" && delegateTarget(event, "#addVlanId")) { event.preventDefault(); add(); }
  });
}

// Wires the router interface rows (the address/prefix inputs and the per-port
// unlink ×) by delegation on the stable #routerInterfaceList container. The
// Ethernet/Serial port-count spinners re-render the rows in place, and the
// per-row listeners used to be bound only by syncPanel — so after a port-count
// change every interface edit was silently dropped (R6). Delegation makes the
// rows' wiring independent of who renders them.
export function bindRouterInterfaceList(device: Device): void {
  const list = document.getElementById("routerInterfaceList");
  if (!list) return;
  captureUndoOnFocusWithin(list, ".router-interface-ip");
  list.addEventListener("input", event => {
    const input = delegateTarget<HTMLInputElement>(event, ".router-interface-ip");
    if (!input) return;
    const { peerId, ifaceName } = input.dataset;
    if (!peerId && !ifaceName) return;
    const value = input.value.trim();
    const parsed = value === "" ? null : parseIpv4Token(value);
    if (value !== "" && !parsed) {
      input.setCustomValidity("Enter a valid IPv4 address (optionally with /prefix).");
      return;
    }
    input.setCustomValidity("");
    const vlanTag = input.dataset.vlanTag != null ? Number(input.dataset.vlanTag) : undefined;
    // Connected ports key by peer; unconnected ports key by interface name.
    const iface = peerId ? routerInterfaceFor(device, peerId, vlanTag) : routerInterfaceForName(device, ifaceName!);
    iface.ipv4Address = parsed ? parsed.address : "";
    if (parsed?.prefixLength != null) iface.prefixLength = parsed.prefixLength;
    input.title = iface.ipv4Address ? `Subnet: ${networkOf(iface.ipv4Address, prefixOf(iface))}` : "";
  });
  // The per-interface unlink (×) removes that port's cable.
  list.addEventListener("click", event => {
    const peerId = delegateTarget(event, ".iface-unlink")?.dataset.peerId;
    if (!peerId) return;
    const link = linksFor(device.id).find((l: Link) => l.from === peerId || l.to === peerId);
    if (link && deleteLink(link.id)) {
      state.selectedId = device.id; // deleteLink clears link selection only; keep the router selected
      syncPanel();
      sync().render();
    }
  });
}

// Wires the editable netfilter panel (renderFirewallControls): per-chain policy
// selects, per-rule delete buttons, and the add-rule form. Mutates the same
// config.rules / config.policy as the iptables CLI, with the same validation
// (a --dport needs -p tcp; src/dst must be a valid IPv4 or CIDR).
export function bindFirewallControls(device: Device, chains: string[]): void {
  const langSel = document.querySelector("[data-fw-rulelang]") as HTMLSelectElement | null;
  langSel?.addEventListener("change", () => {
    pushUndo();
    ensureConfig(device);
    if (langSel.value === "nftables") device.config.ruleLang = "nftables";
    else delete device.config.ruleLang;   // iptables is the plain default
    syncPanel();   // re-renders the native view and (re-labels) the form
  });
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
    const stateRaw = (document.getElementById("fwAddState") as HTMLSelectElement | null)?.value || "";
    const states = stateRaw ? stateRaw.split(",") : undefined;
    const src = val("fwAddSrc"), dst = val("fwAddDst"), dport = val("fwAddDport");
    // The form states the rule as iptables flags and hands it to the shell's
    // own parser (appendFirewallRule) — one validation for both front doors.
    // A refusal shows the shell's message, the one `iptables -A` would print.
    const flags = [
      ...(protocol ? ["-p", protocol] : []),
      ...(src ? ["-s", src] : []),
      ...(dst ? ["-d", dst] : []),
      ...(dport ? ["--dport", dport] : []),
      ...(states ? ["-m", "state", "--state", states.join(",")] : []),
      "-j", target,
    ];
    const result = appendFirewallRule(device, chain, flags, chains);
    if (!result.ok) return fail(result.error || "Invalid rule.");
    dom.modeLabel.textContent = mutationText(result);
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
      <label>Frame history</label>
      <p class="field-note">This wire has carried ${history.length} frame${history.length === 1 ? "" : "s"}. Open the packet log to see each one, filtered to this link.</p>
      <button class="wide-button" id="viewLinkInLog" type="button">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16"></path><path d="M4 12h16"></path><path d="M4 18h10"></path></svg>
        View frames in the packet log
      </button>
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
  const viewLogBtn = document.getElementById("viewLinkInLog");
  if (viewLogBtn) viewLogBtn.addEventListener("click", () => {
    // Jump to the packet log filtered to just this wire's frames.
    state.dock.logFilter = { protocols: [], device: "", link: link.id, expr: "" };
    state.dock.logView = "packets";
    openDock("simlog");
    syncSimLog();
  });
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
      dom.modeLabel.textContent = mutationText(setLinkShutdown(link, event.target.checked));
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
      if (Number.isFinite(value) && value > 0) (link)[key] = value;
      else delete (link)[key];
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
      const names: Record<number, string> = { 8: "echo request", 0: "echo reply", 11: "time exceeded", 3: "destination unreachable" };
      rows.push(["ICMP type", `${inner.icmpType} (${names[inner.icmpType] || "?"})`], ["Sequence", String(inner.sequence)]);
      // An ICMP error quotes the offending datagram (real ICMP embeds the
      // original header) — show the flow the error refers to.
      if (inner.original) {
        rows.push(["Original datagram", `${inner.original.proto.toUpperCase()} ${inner.original.srcIp} → ${inner.original.dstIp} (flow id ${inner.original.flowId})`]);
      }
    } else if (inner.type === "tcp") {
      rows.push(["Src port", String(inner.srcPort)], ["Dst port", String(inner.dstPort)], ["TCP flags", inner.flags.toUpperCase()]);
      // The application data the segment carries — the packet list calls the
      // row HTTP, so the breakdown shows the HTTP fields, not just the TCP ones.
      if (inner.http?.kind === "request") {
        rows.push(["HTTP request", `${inner.http.method || "GET"} ${inner.http.path || "/"} HTTP/1.1`], ["Host", inner.http.host || "(none)"]);
      } else if (inner.http?.kind === "response") {
        rows.push(["HTTP response", `HTTP/1.1 ${inner.http.status ?? ""} ${inner.http.statusText || ""}`.trim()]);
        if (inner.http.title) rows.push(["Page title", inner.http.title]);
      }
    } else if (inner.type === "dhcp") {
      rows.push(["DHCP message", inner.messageType], ["Transaction id", dhcpXidText(inner.transactionId)], ["Client MAC", inner.clientMac]);
      // What the client asks for (Request) and which server it is talking to
      // — the fields that tell two competing servers' exchanges apart.
      if (inner.requestedIp) rows.push(["Requested IP", inner.requestedIp]);
      if (inner.serverIp) rows.push(["Server identifier", inner.serverIp]);
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

// ─── Inspector sections ───────────────────────────────────────────────────────
// A device's panel is an ordered list of sections. Each section says which
// devices it applies to, renders its own HTML, and wires its own controls.
// syncPanel renders every section that applies, in order, then binds them.
//
// This replaced one 444-line render-and-bind function with a branch per device
// type scattered through both halves (review R108): to change what a device
// shows, edit its section; to add a device type, add a section here — nothing
// else in syncPanel changes.
export interface InspectorSection {
  id: string;
  applies(device: Device): boolean;
  render(selected: Device): string;
  bind?(selected: Device): void;
}

// The SSID / password pair a laptop joins with and an access point broadcasts.
// Set directly on the config — these aren't terminal-driven — committing on
// change so the normalised value (and any association the canvas draws) re-renders.
function bindWifiControls(selected: Device): void {
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
      input.addEventListener("keydown", (event) => { if (event.key === "Enter") input.blur(); });
    };
    bindWifiField("selectedSsid", "ssid", normaliseSsid);
    bindWifiField("selectedWifiPassword", "wifiPassword", normaliseWifiPassword);
    document.getElementById("clearWifiPassword")?.addEventListener("click", () => {
      pushUndo();
      ensureConfig(selected);
      selected.config.wifiPassword = "";
      syncPanel();
      sync().render();
    });
}

// The Ethernet port-count field a switch and a hub share.
function bindPortCountField(selected: Device): void {
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
          // The rows' listeners are delegated on the list (bindSwitchPortControls),
          // so re-rendering them needs no rebind — and must not stack one.
          document.getElementById("switchPortList")!.innerHTML = renderSwitchPorts(selected);
        }
      });
    }
}

export const INSPECTOR_SECTIONS: InspectorSection[] = [
  {
    id: "identity",
    applies: () => true,
    render: selected => `
      <div class="field">
        <label for="selectedName">${hasHostname(selected) ? "Hostname" : "Name"}</label>
        <input id="selectedName" value="${escapeHtml(selected.name)}" autocomplete="off">
      </div>
`,
    bind(selected) {
      const nameInput = document.getElementById("selectedName") as HTMLInputElement;
      if (hasHostname(selected)) {
        // For these types the field is labelled Hostname and the name IS the
        // hostname — the terminal prompt, the DNS auto-zone, the script export —
        // so it must satisfy the same RFC-1123 rule the CLIs enforce rather than
        // accept free text. Commit on change/Enter like the other device fields
        // (validating each keystroke would reject every prefix of a valid name),
        // and route through applyHostname so the CLI and the panel agree.
        // No captureUndoOnFocus here: applyHostname pushes undo itself, and
        // pairing the two would stack a second entry on every rename.
        nameInput.addEventListener("change", () => {
          const problem = applyHostname(selected, nameInput.value);
          if (problem) {
            nameInput.setCustomValidity(problem);
            nameInput.reportValidity();
            nameInput.value = selected.name;      // revert to the device's actual name
            return;
          }
          nameInput.setCustomValidity("");
        });
        nameInput.addEventListener("keydown", (event) => { if (event.key === "Enter") nameInput.blur(); });
      } else {
        // Everything else (LAN, hub, unmanaged switch, AP, cloud) keeps a plain
        // label with no hostname semantics, so free text stays fine.
        // The name must still be unique (ignoring case) — it is how commands
        // and scripts address the device (R38). A colliding value is not
        // applied; the field says why, and reverts when it is left.
        captureUndoOnFocus(nameInput);
        nameInput.addEventListener("input", (event: any) => {
          const typed = event.target.value;
          const problem = typed ? deviceNameBlockReason(typed, selected) : null;
          nameInput.setCustomValidity(problem || "");
          if (problem) { nameInput.reportValidity(); return; }
          selected.name = typed || selected.name;
          syncDeviceList();
          syncTerminal();
          sync().render();
        });
        nameInput.addEventListener("change", () => {
          nameInput.setCustomValidity("");
          nameInput.value = selected.name;        // a refused (or emptied) value reverts to the real name
        });
      }
    },
  },
  {
    id: "actions",   // collapse / expand / terminal / power / delete
    applies: () => true,
    render: selected => `      ${selected.type === "switch" ? `
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
      ${offersTerminal(selected) ? `
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
`,
    bind(selected) {
      const terminalButton = document.getElementById("openSelectedTerminal");
      if (terminalButton) terminalButton.addEventListener("click", () => openTerminalFor(selected));
      const powerButton = document.getElementById("togglePower");
      if (powerButton) powerButton.addEventListener("click", () => {
        dom.modeLabel.textContent = mutationText(setDevicePower(selected, !!selected.poweredOff));
      });
      const collapseButton = document.getElementById("collapseSelectedLan");
      if (collapseButton) collapseButton.addEventListener("click", () => { dom.modeLabel.textContent = mutationText(collapseLan(selected)); });
      const expandButton = document.getElementById("expandSelectedLan");
      if (expandButton) expandButton.addEventListener("click", () => { dom.modeLabel.textContent = mutationText(expandLan(selected)); });
      const deleteButton = document.getElementById("deleteSelected");
      if (deleteButton) deleteButton.addEventListener("click", deleteSelection);
    },
  },
  {
    id: "host",      // every IP end-system: PC, laptop, server, Kali PC, Red Team actor
    applies: device => isHost(device.type),
    render: selected => `
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
        const wlink = state.links.find((l) => l.wireless && (l.from === selected.id || l.to === selected.id));
        const warn = wlink && !wifiLinkAuthenticated(wlink) ? `<p class="field-note" style="color: var(--danger)">Associated but not authenticated — the password does not match the access point, so no traffic passes.</p>` : "";
        return `${warn}<div class="field"><button class="wide-button" id="associateLaptop" type="button">Show association handshake</button></div>`;
      })() : ""}
      ${selected.type === "server" ? renderDnsmasqSection(selected) : ""}
      <div class="field">
        <label>ARP table</label>
        ${renderArpTable(selected)}
      </div>
    `,
    bind(selected) {
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
        input.addEventListener("keydown", (event) => { if (event.key === "Enter") input.blur(); });
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
      if (selected.type === "server") bindDnsmasqControls(selected);
      if (selected.type === "laptop") {
        bindWifiControls(selected);
        document.getElementById("associateLaptop")?.addEventListener("click", () => {
          const busy = animatedRunBlockReason();
          if (busy) { dom.modeLabel.textContent = busy; return; }
          const setup = buildAssociationEvents(selected);
          if (typeof setup === "string") { dom.modeLabel.textContent = setup; return; }
          startSimulation(setup, selected.id, selected.config?.ssid || "", "associate");
        });
      }
    },
  },
  {
    id: "access-point",
    applies: device => device.type === "access-point",
    render: selected => `
      <p class="field-note">A transparent bridge: it joins its wireless clients to the wired uplink (no MAC learning shown — it forwards like an unmanaged switch).</p>
      <div style="height: 10px"></div>
      ${renderWifiFields(selected.config, "The network this access point broadcasts. A laptop joins only if its SSID — and password, if set — match.")}
    `,
    bind: bindWifiControls,
  },
  {
    id: "switch",
    applies: device => device.type === "switch",
    render: selected => `
      <div class="field">
        <label for="selectedManaged">Managed switch</label>
        <input id="selectedManaged" type="checkbox" ${selected.config?.managed ? "checked" : ""}>
      </div>
      <div class="field">
        <label for="selectedPorts">Ethernet ports</label>
        <input id="selectedPorts" type="number" min="4" max="24" step="1" value="${escapeHtml(selected.config?.ethernetPorts || defaultPortCount(selected.type))}">
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
    `,
    bind(selected) {
      const managedInput = document.getElementById("selectedManaged") as HTMLInputElement;
      if (managedInput) {
        managedInput.addEventListener("change", (event: any) => {
          dom.modeLabel.textContent = mutationText(setSwitchManaged(selected, event.target.checked));
        });
      }
      bindPortCountField(selected);
      bindSwitchPortControls(selected);
      bindStpControls(selected);
      bindMirrorControl(selected);
    },
  },
  {
    id: "router",
    applies: device => device.type === "router",
    render: selected => `
      <div class="field">
        <label for="selectedRouterRole">Role</label>
        <select id="selectedRouterRole">
          <option value="internal" ${selected.config?.role === "border" ? "" : "selected"}>Internal / core (interior forwarding)</option>
          <option value="border" ${selected.config?.role === "border" ? "selected" : ""}>Border / edge (faces the outside)</option>
        </select>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="selectedRouterEthernetPorts">Ethernet ports</label>
          <input id="selectedRouterEthernetPorts" type="number" min="0" max="12" step="1" value="${escapeHtml(selected.config?.ethernetPorts ?? defaultPortCount(selected.type))}">
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
        <label>Netfilter (${ruleLangOf(selected)} INPUT + FORWARD)</label>
        ${renderFirewallControls(selected, ["forward", "input"])}
      </div>
      ${renderNatTranslations(selected)}
    `,
    bind(selected) {
      const routerRole = document.getElementById("selectedRouterRole") as HTMLSelectElement | null;
      if (routerRole) {
        routerRole.addEventListener("change", (event: any) => {
          pushUndo();
          ensureConfig(selected);
          if (event.target.value === "border") selected.config.role = "border";
          else delete selected.config.role; // internal is the plain default
          syncPanel();
          sync().render(); // redraw the border badge
        });
      }
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
          // Delegated on the list (bindRouterInterfaceList): the new rows are live.
          document.getElementById("routerInterfaceList")!.innerHTML = renderRouterInterfaces(selected);
        });
      });
      bindRouterInterfaceList(selected);
      bindFirewallControls(selected, ["forward", "input"]);
    },
  },
  {
    id: "firewall",
    applies: device => device.type === "firewall",
    render: selected => `
      <div class="field">
        <label for="selectedFwPorts">Ethernet ports</label>
        <input id="selectedFwPorts" type="number" min="${FIREWALL_PORT_RANGE.min}" max="${FIREWALL_PORT_RANGE.max}" step="1" value="${escapeHtml(selected.config?.ethernetPorts ?? defaultPortCount(selected.type))}">
      </div>
      <div class="field">
        <label>Netfilter (${ruleLangOf(selected)} FORWARD)</label>
        ${renderFirewallControls(selected, ["forward"])}
      </div>
    `,
    bind(selected) {
      const fwPortsInput = document.getElementById("selectedFwPorts") as HTMLInputElement;
      if (fwPortsInput) {
        captureUndoOnFocus(fwPortsInput);
        fwPortsInput.addEventListener("input", (event: any) => {
          const value = Number(event.target.value);
          if (clampFirewallPortCount(value) !== value) {
            event.target.setCustomValidity(`Enter a port count from ${FIREWALL_PORT_RANGE.min} to ${FIREWALL_PORT_RANGE.max}.`);
          } else {
            event.target.setCustomValidity("");
            ensureConfig(selected);
            selected.config.ethernetPorts = value;
            sync().render();
          }
        });
      }
      bindFirewallControls(selected, ["forward"]);
    },
  },
  {
    id: "ids",
    applies: device => device.type === "ids",
    render: renderIdsSection,
    bind: bindIdsControls,
  },
  {
    id: "red-team",  // the autonomous actor's plan (a Kali PC is driven from its terminal)
    applies: device => device.type === "attacker",
    render: renderAttackerSection,
    bind: bindAttackerControls,
  },
  {
    id: "hub",
    applies: device => device.type === "hub",
    render: selected => `
      <p class="field-note">A hub is a layer-1 repeater: it copies every frame out all other ports (no MAC learning, one collision domain).</p>
      <div style="height: 10px"></div>
      <div class="field">
        <label for="selectedPorts">Ethernet ports</label>
        <input id="selectedPorts" type="number" min="4" max="24" step="1" value="${escapeHtml(selected.config?.ethernetPorts || defaultPortCount(selected.type))}">
      </div>
      <div class="field">
        <label>Ports</label>
        <div class="port-list" id="switchPortList">
          ${renderSwitchPorts(selected)}
        </div>
      </div>
    `,
    bind(selected) {
      bindPortCountField(selected);
      bindSwitchPortControls(selected);
    },
  },
  {
    id: "summary",   // the type and link-count pills
    applies: () => true,
    render(selected) {
      const neighbors = connectedIds(selected.id).map((id: string) => getDevice(id)).filter(isVisibleDevice);
      const selectedType = DEVICE_SPECS[selected.type]?.label ?? "Device";
      return `      <div class="pill-row">
        <span class="pill">${selectedType}</span>
        <span class="pill">${neighbors.length} links</span>
      </div>
    `;
    },
  },
];

// The sections a device's panel is made of, in order.
export function inspectorSectionsFor(device: Device): InspectorSection[] {
  return INSPECTOR_SECTIONS.filter(section => section.applies(device));
}

// Commit whatever the learner is still typing before the panel is rebuilt.
// A rebuild replaces the panel's HTML; Firefox and Safari fire neither `blur`
// nor `change` on a focused field removed that way, so an address typed into
// PC-A and followed by a click on PC-B (or by a run finishing) was silently
// discarded, and the undo snapshot taken on focus was orphaned. Blurring first
// fires both, in every browser, so the field commits through its own handler.
function commitFocusedField(): void {
  const active = (typeof document !== "undefined" ? document.activeElement : null) as HTMLElement | null;
  if (!active || typeof active.blur !== "function") return;
  if (!dom.detailsPanel.contains?.(active)) return;
  active.blur();
}

export function syncPanel(): void {
  commitFocusedField();
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
    const sections = inspectorSectionsFor(selected);
    dom.detailsPanel.innerHTML = `
      ${panelHeading(isConfiguring ? "Configure" : "Selection")}${sections.map(section => section.render(selected)).join("")}`;
    for (const section of sections) section.bind?.(selected);
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
    <button class="device-row ${device.id === state.selectedId ? "active" : ""}" data-id="${escapeHtml(device.id)}" type="button" aria-pressed="${device.id === state.selectedId}">
      <span class="device-name">${escapeHtml(device.name)}</span>
      <span class="device-type">${DEVICE_SPECS[device.type as DeviceType]?.label ?? "Device"}</span>
    </button>
  `).join("");
  // Cables, listed under the devices: a link could only be selected by clicking
  // it on the canvas, so its inspector (name, shut, bandwidth, delete) had no
  // keyboard path at all. Each row selects its link, as the canvas click does.
  const cables = state.links.filter(link => isPhysicalLink(link) && !link.hidden);
  if (cables.length) {
    dom.deviceList.innerHTML += `<p class="device-list-heading" id="linkListHeading">Cables</p>` + cables.map(link => `
    <button class="device-row link-row ${link.id === state.selectedLinkId ? "active" : ""}" data-link-id="${escapeHtml(link.id)}" type="button" aria-pressed="${link.id === state.selectedLinkId}">
      <span class="device-name">${escapeHtml(linkName(link))}</span>
      <span class="device-type">${link.shutdown ? "Down" : link.wireless ? "Wireless" : "Cable"}</span>
    </button>`).join("");
  }
  [...dom.deviceList.querySelectorAll(".link-row")].forEach((row: any) => {
    row.addEventListener("click", () => {
      state.selectedId = null;
      state.selectedLinkId = row.dataset.linkId;
      state.configuringId = null;
      syncPanel();
      sync().render();
    });
  });
  [...dom.deviceList.querySelectorAll(".device-row:not(.link-row)")].forEach((row: any) => {
    row.addEventListener("click", () => {
      state.selectedId = row.dataset.id;
      state.selectedLinkId = null;
      if (state.configuringId && state.configuringId !== state.selectedId) state.configuringId = null;
      syncPanel();
      sync().render();
    });
  });
}
