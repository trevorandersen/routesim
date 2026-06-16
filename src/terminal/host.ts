/**
 * Host (PC) terminal — a Linux-ish shell: ip addr/route, arp, ping, traceroute,
 * dhcp. Display/mutator helpers are shared with the inspector GUI.
 */
import type { Device } from "../types";
import { state, sync, pushUndo } from "../state";
import { dom } from "../dom";
import { isValidIpv4, parseIpv4Token, prefixOf, clampPrefixLength } from "../utils";
import { normaliseArpTable, ensureConfig } from "../normalise";
import { buildPingEvents, buildDhcpEvents, buildConnectEvents, buildResolveEvents } from "../simulation";
import { startSimulation, runTraceroute } from "../engine";
import { terminalLine } from "./core";

export function showHostIp(device: Device): string {
  const ipv4 = device.config?.ipv4Address || "unassigned";
  const mac = device.config?.macAddress || "unassigned";
  const inetLine = device.config?.ipv4Address ? `    inet ${ipv4}/${prefixOf(device.config)} scope global eth0` : "    inet unassigned";
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
  device.config.ipSource = "static"; // hand-configured via the CLI
  if (parsed.prefixLength != null) device.config.prefixLength = clampPrefixLength(parsed.prefixLength);
  sync().syncPanel();
  sync().render();
  return `Assigned ${parsed.address}/${prefixOf(device.config)} to eth0.`;
}

export function flushHostIp(device: Device): string {
  if (!device.config?.ipv4Address) return "No IPv4 address configured on eth0.";
  pushUndo();
  ensureConfig(device);
  device.config.ipv4Address = "";
  delete device.config.ipSource; // unassigned again
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

// The resolver address (/etc/resolv.conf). Shared with the inspector GUI and
// the console `nameserver` command.
export function setHostDns(device: Device, address: string): string {
  const parsed = parseIpv4Token(address);
  if (!parsed) return `Invalid IPv4 address: ${address}`;
  pushUndo();
  ensureConfig(device);
  device.config.dnsServerIp = parsed.address;
  sync().syncPanel();
  return `nameserver ${parsed.address} > /etc/resolv.conf`;
}

export function showResolvConf(device: Device): string {
  const ns = device.config?.dnsServerIp;
  return ns ? `nameserver ${ns}` : "# /etc/resolv.conf is empty (no nameserver configured)";
}

export function runHostTerminalCommand(host: Device, command: string): void {
  const lower = command.toLowerCase();
  if (lower === "clear") {
    state.terminal.lines = [];
    return;
  }
  if (lower === "help") {
    terminalLine("muted", hostHelpLines().join("\n"));
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

  if (lower === "cat /etc/resolv.conf") {
    terminalLine("", showResolvConf(host));
    return;
  }

  const nsSetMatch = command.match(/^echo\s+['"]?nameserver\s+(\S+?)['"]?\s*>{1,2}\s*\/etc\/resolv\.conf$/i)
    || command.match(/^set\s+nameserver\s+(\S+)$/i);
  if (nsSetMatch) {
    const result = setHostDns(host, nsSetMatch[1]);
    terminalLine(result.startsWith("Invalid") ? "error" : "", result);
    return;
  }

  const lookupMatch = command.match(/^(?:nslookup|host|dig)\s+(\S+)$/i);
  if (lookupMatch) {
    const result = buildResolveEvents(host, lookupMatch[1], null, null);
    if (typeof result === "string") {
      terminalLine("error", result);
    } else {
      startSimulation(result, host.id, lookupMatch[1], "dns");
      dom.terminalInput.disabled = true;
    }
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

  const ncMatch = command.match(/^nc\s+(?:-z\s+)?(\S+)\s+(\d+)$/i);
  if (ncMatch) {
    const port = Number(ncMatch[2]);
    const result = buildConnectEvents(host, ncMatch[1], port);
    if (typeof result === "string") {
      terminalLine("error", result);
    } else {
      startSimulation(result, host.id, resolvePingTargetIp(ncMatch[1]), "tcp", port);
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

// Shared host command list — the server terminal appends its dnsmasq commands.
export function hostHelpLines(): string[] {
  return [
    "Commands:",
    "  ip addr show",
    "  ip addr add <ipv4>/24 dev eth0",
    "  ip addr flush dev eth0",
    "  ip route show",
    "  ip route add default via <ipv4> dev eth0",
    "  arp -n",
    "  cat /etc/resolv.conf",
    "  echo nameserver <ipv4> > /etc/resolv.conf",
    "  ping <name|ipv4>",
    "  traceroute <name|ipv4>",
    "  nslookup <name>               (DNS lookup)",
    "  nc -z <name|ipv4> <port>      (TCP connection test)",
    "  dhcp",
    "  clear"
  ];
}

function resolvePingTargetIp(targetText: string): string {
  // If it's already an IP, return it
  if (isValidIpv4(targetText)) return targetText;
  // Otherwise find the target device by name
  const target = state.devices.find(d =>
    (d.type === "computer" || d.type === "server") && d.name.toLowerCase() === targetText.toLowerCase()
  );
  return target?.config?.ipv4Address || targetText;
}
