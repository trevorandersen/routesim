/**
 * Red Team host terminal — a Kali-Linux-style shell. The attack commands map to
 * the real tools: `nmap -sS` (SYN scan), `nmap -sn` (ping sweep), `arpspoof`
 * (ARP cache poisoning). Each launches the matching simulated attack; results
 * land in this session when the animated run completes (finishSimulation).
 */
import type { Device } from "../types";
import { state } from "../state";
import { buildScanEvents, buildSweepEvents, buildArpSpoofEvents } from "../simulation";
import { startSimulation } from "../engine";
import { terminalLine } from "./core";
import { runHostTerminalCommand } from "./host";
import type { PingSetup } from "../simulation";

const NMAP_VERSION = [
  "Nmap version 7.94 ( https://nmap.org )",
  "Platform: x86_64-pc-linux-gnu",
  "Compiled with: liblua-5.4.6 openssl-3.0.13 libpcap-1.10.4 libz-1.3",
  "Compiled without:",
  "Available nsock engines: epoll poll select",
].join("\n");

function launch(device: Device, setup: PingSetup | string, kind: string): void {
  if (typeof setup === "string") { terminalLine("error", setup); return; }
  if (state.simulation.status === "running") { terminalLine("error", "A simulation is already running — stop it first."); return; }
  startSimulation(setup, device.id, "", "attack");
  terminalLine("", `Starting Nmap-style ${kind}... (results appear here when the run finishes).`);
}

export function runAttackerTerminalCommand(device: Device, command: string): void {
  const lower = command.toLowerCase().trim();
  if (lower === "?" || lower === "help") {
    terminalLine("muted", [
      "nmap -sS <target>          TCP SYN port scan",
      "nmap -sn <subnet>          ping sweep (host discovery)",
      "arpspoof [-t <victim>] <gateway-ip>   ARP cache poisoning (MITM)",
      "nmap -V                    version",
      "hostname [<name>]",
      "clear",
      "(standard Linux net tools also work: ip addr, ip route, ping, traceroute, nc, arp)",
    ].join("\n"));
    return;
  }
  if (lower === "clear") { state.terminal.lines = []; return; }
  if (lower === "nmap -v" || lower === "nmap --version") { terminalLine("", NMAP_VERSION); return; }

  // nmap -sn <subnet>  — ping sweep (check before -sS / bare scan).
  const sweep = command.match(/^(?:sudo\s+)?nmap\s+-sn\s+(\S+)\s*$/i);
  if (sweep) { launch(device, buildSweepEvents(device, sweep[1]), `ping sweep of ${sweep[1]}`); return; }

  // nmap [-sS] <target>  — SYN scan.
  const scan = command.match(/^(?:sudo\s+)?nmap\s+(?:-sS\s+)?(\S+)\s*$/i);
  if (scan) { launch(device, buildScanEvents(device, scan[1]), `SYN scan of ${scan[1]}`); return; }

  // arpspoof [-t victim] <gateway> — we impersonate the gateway IP (the last arg).
  const spoof = command.match(/^(?:sudo\s+)?arpspoof\s+(?:-t\s+\S+\s+)?(\S+)\s*$/i);
  if (spoof) { launch(device, buildArpSpoofEvents(device, spoof[1]), `ARP spoof of ${spoof[1]}`); return; }

  // Anything else is an ordinary Linux command — Kali is a full host, so fall
  // through to the shared host shell (ip addr / ip route / ping / traceroute /
  // nc / hostname / resolv.conf). This is also what drives the inspector's
  // IP / gateway / DNS / MAC fields, which commit via the device terminal.
  runHostTerminalCommand(device, command);
}
