/**
 * Red Team host terminal — a Kali-Linux-style shell. The attack commands map to
 * the real tools: `nmap -sS` (SYN scan), `nmap -sn` (ping sweep), `arpspoof`
 * (ARP cache poisoning). Each launches the matching simulated attack; results
 * land in this session when the animated run completes (finishSimulation).
 */
import type { Device } from "../types";
import { state } from "../state";
import { buildScanEvents, buildSweepEvents, buildArpSpoofEvents } from "../security/offensive/attacks";
import { startSimulation, animatedRunBlockReason } from "../engine";
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

// `build` is deferred so a refused launch builds nothing: building reseeds the
// run PRNG, which would perturb the run already in flight (engine beginRun).
function launch(device: Device, build: () => PingSetup | string, kind: string): void {
  const busy = animatedRunBlockReason();
  if (busy) { terminalLine("error", busy); return; }
  const setup = build();
  if (typeof setup === "string") { terminalLine("error", setup); return; }
  startSimulation(setup, device.id, "", "attack");
  terminalLine("", `Starting Nmap-style ${kind}... (results appear here when the run finishes).`);
}

export function runAttackerTerminalCommand(device: Device, command: string): void {
  const lower = command.toLowerCase().trim();
  if (lower === "?" || lower === "help") {
    terminalLine("muted", [
      "nmap -sS <target>          TCP SYN port scan",
      "nmap -sn <subnet>          ping sweep (host discovery)",
      "arpspoof [-r] [-t <victim>] <gateway-ip>   ARP cache poisoning (MITM; -t one victim, -r both ways)",
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
  if (sweep) { launch(device, () => buildSweepEvents(device, sweep[1]), `ping sweep of ${sweep[1]}`); return; }

  // nmap [-sS] <target>  — SYN scan.
  const scan = command.match(/^(?:sudo\s+)?nmap\s+(?:-sS\s+)?(\S+)\s*$/i);
  if (scan) { launch(device, () => buildScanEvents(device, scan[1]), `SYN scan of ${scan[1]}`); return; }

  // arpspoof [-r] [-t <victim>] <gateway> — impersonate the gateway IP (the last
  // positional). -t targets one victim (unicast); -r also poisons the gateway so
  // return traffic crosses us too. Flags may come in any order.
  if (/^(?:sudo\s+)?arpspoof\b/i.test(command)) {
    const toks = command.replace(/^(?:sudo\s+)?arpspoof\s*/i, "").trim().split(/\s+/).filter(Boolean);
    let reverse = false, victim: string | undefined, gateway: string | undefined;
    for (let i = 0; i < toks.length; i++) {
      if (toks[i] === "-r") reverse = true;
      else if (toks[i] === "-t") { victim = toks[++i]; }
      else gateway = toks[i];
    }
    if (reverse && !victim) { terminalLine("error", "arpspoof: -r (reverse) needs a victim: arpspoof -r -t <victim> <gateway>"); return; }
    if (!gateway) { terminalLine("error", "arpspoof: usage: arpspoof [-r] [-t <victim>] <gateway-ip>"); return; }
    const label = victim ? `ARP spoof of ${gateway}${reverse ? " ⇄ " : " → "}${victim}` : `ARP spoof of ${gateway}`;
    launch(device, () => buildArpSpoofEvents(device, gateway, { victim, reverse }), label);
    return;
  }

  // An nmap invocation we don't model — say so, rather than handing a scanner
  // command to the host shell (which would only call it an unknown command).
  if (/^(?:sudo\s+)?nmap\b/i.test(command)) {
    terminalLine("error", "nmap: only `-sS <target>` (SYN scan), `-sn <subnet>` (ping sweep) and `-V` are modelled here — other scan types and options (-sT, -sU, -p, -A, …) are not.");
    return;
  }

  // Anything else is an ordinary Linux command — Kali is a full host, so fall
  // through to the shared host shell (ip addr / ip route / ping / traceroute /
  // nc / hostname / resolv.conf). This is also what drives the inspector's
  // IP / gateway / DNS / MAC fields, which commit via the device terminal.
  runHostTerminalCommand(device, command);
}
