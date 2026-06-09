/**
 * Host (PC) terminal — a Linux-ish shell: ip addr/route, arp, ping, traceroute,
 * dhcp. Display/mutator helpers are shared with the inspector GUI.
 */
import type { Device } from "../types";
import { state, sync, pushUndo } from "../state";
import { dom } from "../dom";
import { isValidIpv4, parseIpv4Token } from "../utils";
import { normaliseArpTable, ensureConfig } from "../normalise";
import { buildPingEvents, buildDhcpEvents } from "../simulation";
import { startSimulation, runTraceroute } from "../engine";
import { terminalLine } from "./core";

export function showHostIp(device: Device): string {
  const ipv4 = device.config?.ipv4Address || "unassigned";
  const mac = device.config?.macAddress || "unassigned";
  const inetLine = device.config?.ipv4Address ? `    inet ${ipv4}/24 scope global eth0` : "    inet unassigned";
  return [
    "1: eth0: <BROADCAST,MULTICAST,UP> mtu 1500",
    `    link/ether ${mac} brd ff:ff:ff:ff:ff:ff`,
    inetLine
  ].join("\n");
}

export function showHostRoute(device: Device): string {
  const gateway = device.config?.gatewayIpv4Address;
  return gateway ? `default via ${gateway} dev eth0` : "No default route configured.";
}

export function showHostArp(device: Device): string {
  const entries = normaliseArpTable(device.config?.arpTable || []);
  if (!entries.length) return "Address                  HWtype  HWaddress           Flags Mask            Iface";
  return [
    "Address                  HWtype  HWaddress           Flags Mask            Iface",
    ...entries.map((entry: any) => `${entry.ipv4Address.padEnd(24)}ether   ${entry.macAddress.padEnd(19)}C                     eth0`)
  ].join("\n");
}

export function setHostIp(device: Device, address: string): string {
  const parsed = parseIpv4Token(address);
  if (!parsed) return `Invalid IPv4 address: ${address}`;
  pushUndo();
  ensureConfig(device);
  device.config.ipv4Address = parsed.address;
  sync().syncPanel();
  sync().render();
  return `Assigned ${parsed.address}${parsed.prefixLength == null ? "" : `/${parsed.prefixLength}`} to eth0.`;
}

export function flushHostIp(device: Device): string {
  if (!device.config?.ipv4Address) return "No IPv4 address configured on eth0.";
  pushUndo();
  ensureConfig(device);
  device.config.ipv4Address = "";
  device.config.arpTable = [];
  sync().syncPanel();
  sync().render();
  return "Flushed IPv4 address and ARP table from eth0.";
}

export function setHostGateway(device: Device, address: string): string {
  const parsed = parseIpv4Token(address);
  if (!parsed) return `Invalid IPv4 address: ${address}`;
  pushUndo();
  ensureConfig(device);
  device.config.gatewayIpv4Address = parsed.address;
  sync().syncPanel();
  sync().render();
  return `Default gateway set to ${parsed.address}.`;
}

export function runHostTerminalCommand(host: Device, command: string): void {
  const lower = command.toLowerCase();
  if (lower === "clear") {
    state.terminal.lines = [];
    return;
  }
  if (lower === "help") {
    terminalLine("muted", [
      "Commands:",
      "  ip addr show",
      "  ip addr add <ipv4>/24 dev eth0",
      "  ip addr flush dev eth0",
      "  ip route show",
      "  ip route add default via <ipv4> dev eth0",
      "  arp -n",
      "  ping <pc-name|ipv4>",
      "  traceroute <pc-name|ipv4>",
      "  dhcp",
      "  clear"
    ].join("\n"));
    return;
  }
  if (lower === "ip" || lower === "ip addr" || lower === "ip address" || lower === "ip addr show" || lower === "ip address show" || lower === "ip addr show dev eth0" || lower === "ip address show dev eth0" || lower === "ip a") {
    terminalLine("", showHostIp(host));
    return;
  }

  if (lower === "ip route" || lower === "ip route show" || lower === "ip route show default" || lower === "ip r" || lower === "route" || lower === "route -n") {
    terminalLine("", showHostRoute(host));
    return;
  }

  if (lower === "arp" || lower === "arp -a" || lower === "arp -n" || lower === "ip neigh" || lower === "ip neigh show" || lower === "ip neighbour" || lower === "ip neighbour show") {
    terminalLine("", showHostArp(host));
    return;
  }

  const ipFlushMatch = command.match(/^ip\s+(?:addr|address)\s+flush\s+dev\s+eth0$/i);
  if (ipFlushMatch) {
    terminalLine("", flushHostIp(host));
    return;
  }

  const ipSetMatch = command.match(/^ip\s+(?:addr|address)\s+add\s+(\S+)\s+dev\s+eth0$/i) || command.match(/^ip\s+(?:addr|address)\s+(?:set|add)\s+(\S+)$/i) || command.match(/^set\s+ip\s+(\S+)$/i);
  if (ipSetMatch) {
    const result = setHostIp(host, ipSetMatch[1]);
    terminalLine(result.startsWith("Invalid") ? "error" : "", result);
    return;
  }

  const gatewayMatch = command.match(/^ip\s+route\s+(?:add|replace|change|set)\s+default\s+via\s+(\S+)(?:\s+dev\s+eth0)?$/i) || command.match(/^set\s+gateway\s+(\S+)$/i);
  if (gatewayMatch) {
    const result = setHostGateway(host, gatewayMatch[1]);
    terminalLine(result.startsWith("Invalid") ? "error" : "", result);
    return;
  }

  if (lower === "dhcp" || lower === "dhclient") {
    const result = buildDhcpEvents(host);
    if (typeof result === "string") {
      terminalLine("error", result);
    } else {
      startSimulation(result, host.id, "", "dhcp");
      dom.terminalInput.disabled = true;
    }
    return;
  }

  const traceMatch = command.match(/^(?:traceroute|tracert)\s+(.+)$/i);
  if (traceMatch) {
    const result = runTraceroute(host, traceMatch[1].trim());
    if (typeof result === "string") {
      terminalLine("error", result);
    } else {
      const lines = [`traceroute to ${result.targetIp}, 30 hops max`];
      for (const hop of result.hops) {
        lines.push(` ${String(hop.ttl).padStart(2)}  ${hop.ip || "* (no response)"}`);
      }
      if (!result.reached) lines.push("(destination not reached within 30 hops)");
      terminalLine("", lines.join("\n"));
    }
    return;
  }

  const pingMatch = command.match(/^ping(?:\s+-c\s+\d+)?\s+(.+)$/i);
  if (pingMatch) {
    const targetText = pingMatch[1].trim();
    const result = buildPingEvents(host, targetText);
    if (typeof result === "string") {
      // Validation error or instant result (self-ping)
      terminalLine(result.startsWith("ping:") ? "error" : "", result);
    } else {
      const targetIp = resolvePingTargetIp(targetText);
      startSimulation(result, host.id, targetIp);
      dom.terminalInput.disabled = true;
    }
    return;
  }

  terminalLine("error", `${command}: command not found`);
}

function resolvePingTargetIp(targetText: string): string {
  // If it's already an IP, return it
  if (isValidIpv4(targetText)) return targetText;
  // Otherwise find the target device by name
  const target = state.devices.find(d =>
    d.type === "computer" && d.name.toLowerCase() === targetText.toLowerCase()
  );
  return target?.config?.ipv4Address || targetText;
}
