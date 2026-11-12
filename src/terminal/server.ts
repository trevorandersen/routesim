/**
 * Server terminal — a Linux host shell (everything host.ts offers) plus
 * dnsmasq, configured the way real sysadmins do it: append lines to
 * /etc/dnsmasq.conf and manage the daemon with systemctl. Supported conf
 * directives mirror the real daemon:
 *
 *   address=/web.corp/192.168.1.80          DNS A-record
 *   dhcp-range=192.168.1.100,192.168.1.200  enable DHCP for this pool
 *   dhcp-option=option:router,192.168.1.1   gateway handed to clients
 *
 * One simplification, noted in docs/src/dns.md: conf lines take effect
 * immediately (the real daemon needs a restart to re-read its config).
 */
import type { Device, DnsRecord, MutationResult } from "../types";
import { sync, pushUndo } from "../state";
import { isValidIpv4, ipv4ToInt } from "../utils";
import { ensureConfig, normaliseDnsRecords } from "../normalise";
import { terminalLine } from "./core";
import { runHostTerminalCommand, hostHelpLines } from "./host";

export function showDnsmasqConf(device: Device): string {
  const config = device.config || {};
  const lines = [
    "# /etc/dnsmasq.conf — managed via `echo <line> >> /etc/dnsmasq.conf`",
    "domain-needed",
    "no-resolv",
  ];
  for (const r of (config.dnsRecords || [])) lines.push(`address=/${r.name}/${r.ip}`);
  if (config.dhcpRangeStart && config.dhcpRangeEnd) {
    lines.push(`dhcp-range=${config.dhcpRangeStart},${config.dhcpRangeEnd},12h`);
  }
  if (config.dhcpRouterIp) lines.push(`dhcp-option=option:router,${config.dhcpRouterIp}`);
  return lines.join("\n");
}

// ── Mutators shared by the dnsmasq shell and the inspector ────────────────────
// One validation for both front doors: the inspector used to write the range
// one field and one keystroke at a time with its own (weaker) check, so it
// could store an inverted range the shell refuses — the engine then reported
// "no addresses available", and the exported script would not replay.

// Set the DHCP pool. Both bounds are committed together; empty + empty turns
// DHCP off. An inverted range is refused, as real dnsmasq refuses it.
export function setDhcpRange(device: Device, startText: string, endText: string): MutationResult {
  const start = String(startText ?? "").trim();
  const end = String(endText ?? "").trim();
  if (!start && !end) {
    if (!device.config?.dhcpRangeStart && !device.config?.dhcpRangeEnd) return { ok: true, message: "DHCP is already off (no range).", warnings: [] };
    pushUndo();
    ensureConfig(device);
    delete device.config.dhcpRangeStart;
    delete device.config.dhcpRangeEnd;
    sync().syncPanel();
    return { ok: true, message: `${device.name}: DHCP range cleared — DHCP is off.`, warnings: [] };
  }
  if (!start || !end) return { ok: false, error: `A DHCP range needs both a start and an end address (got ${start ? "no end" : "no start"}).`, warnings: [] };
  if (!isValidIpv4(start)) return { ok: false, error: `bad dhcp-range: ${start} is not an IPv4 address`, warnings: [] };
  if (!isValidIpv4(end)) return { ok: false, error: `bad dhcp-range: ${end} is not an IPv4 address`, warnings: [] };
  if (ipv4ToInt(end) < ipv4ToInt(start)) return { ok: false, error: `dhcp-range end ${end} is before start ${start}`, warnings: [] };
  pushUndo();
  ensureConfig(device);
  device.config.dhcpRangeStart = start;
  device.config.dhcpRangeEnd = end;
  sync().syncPanel();
  return { ok: true, message: `${device.name}: DHCP range ${start} – ${end}.`, warnings: [] };
}

// Set (or, with an empty value, clear) the router option handed to DHCP clients.
export function setDhcpRouterOption(device: Device, ipText: string): MutationResult {
  const ip = String(ipText ?? "").trim();
  if (ip && !isValidIpv4(ip)) return { ok: false, error: `bad dhcp-option: ${ip} is not an IPv4 address`, warnings: [] };
  pushUndo();
  ensureConfig(device);
  if (ip) device.config.dhcpRouterIp = ip; else delete device.config.dhcpRouterIp;
  sync().syncPanel();
  return { ok: true, message: ip ? `${device.name}: DHCP router option ${ip}.` : `${device.name}: DHCP router option cleared (clients get this server).`, warnings: [] };
}

// Applies one dnsmasq.conf directive. Returns an error string, or "" when the
// line was accepted (a shell append prints nothing).
export function applyDnsmasqConfLine(device: Device, line: string): string {
  const trimmed = line.trim();

  const addressMatch = trimmed.match(/^address=\/([^/]+)\/(\S+)$/i);
  if (addressMatch) {
    const name = addressMatch[1].trim().toLowerCase();
    const ip = addressMatch[2].trim();
    if (!isValidIpv4(ip)) return `dnsmasq: bad address at line: ${trimmed}`;
    pushUndo();
    ensureConfig(device);
    const records: DnsRecord[] = normaliseDnsRecords(device.config.dnsRecords || []);
    const existing = records.find(r => r.name === name);
    if (existing) existing.ip = ip;  // editing the conf replaces the record
    else records.push({ name, ip });
    device.config.dnsRecords = records;
    sync().syncPanel();
    return "";
  }

  const rangeMatch = trimmed.match(/^dhcp-range=(\S+?),(\S+?)(?:,\S+)?$/i);
  if (rangeMatch) {
    // An inverted range is rejected at read time (as real dnsmasq does) rather
    // than accepted and silently handing out no leases at allocation time.
    const result = setDhcpRange(device, rangeMatch[1], rangeMatch[2]);
    return result.ok ? "" : `dnsmasq: ${result.error} (at line: ${trimmed})`;
  }

  const routerMatch = trimmed.match(/^dhcp-option=option:router,(\S+)$/i);
  if (routerMatch) {
    const result = setDhcpRouterOption(device, routerMatch[1]);
    return result.ok ? "" : `dnsmasq: ${result.error} (at line: ${trimmed})`;
  }

  return `dnsmasq: unsupported directive: ${trimmed} (use address=/name/ip, dhcp-range=start,end, dhcp-option=option:router,ip)`;
}

export function runServerTerminalCommand(server: Device, command: string): void {
  const lower = command.toLowerCase().trim();

  if (lower === "help") {
    terminalLine("muted", [
      ...hostHelpLines(),
      "dnsmasq (DNS + DHCP):",
      "  cat /etc/dnsmasq.conf",
      "  echo address=/<name>/<ipv4> >> /etc/dnsmasq.conf",
      "  echo dhcp-range=<start>,<end> >> /etc/dnsmasq.conf",
      "  echo dhcp-option=option:router,<ipv4> >> /etc/dnsmasq.conf",
      "  systemctl start|stop|status dnsmasq"
    ].join("\n"));
    return;
  }

  if (lower === "cat /etc/dnsmasq.conf") {
    terminalLine("", showDnsmasqConf(server));
    return;
  }

  const appendMatch = command.match(/^echo\s+['"]?(.+?)['"]?\s*>>\s*\/etc\/dnsmasq\.conf$/i);
  if (appendMatch) {
    const result = applyDnsmasqConfLine(server, appendMatch[1]);
    if (result) terminalLine("error", result);
    return;
  }

  const systemctlMatch = command.match(/^(?:sudo\s+)?systemctl\s+(start|stop|restart|status)\s+dnsmasq$/i);
  if (systemctlMatch) {
    const action = systemctlMatch[1].toLowerCase();
    ensureConfig(server);
    if (action === "status") {
      const running = server.config.dnsmasqRunning !== false;
      terminalLine(running ? "" : "error", running
        ? `dnsmasq.service - dnsmasq - A lightweight DHCP and caching DNS server\n   Active: active (running)`
        : `dnsmasq.service - dnsmasq - A lightweight DHCP and caching DNS server\n   Active: inactive (dead)`);
      return;
    }
    pushUndo();
    server.config.dnsmasqRunning = action !== "stop";
    sync().syncPanel();
    terminalLine("", action === "stop" ? "Stopped dnsmasq." : action === "restart" ? "Restarted dnsmasq." : "Started dnsmasq.");
    return;
  }

  // Everything else is plain Linux host behaviour.
  runHostTerminalCommand(server, command);
}
