/**
 * Firewall terminal — the transparent inline packet filter speaks iptables on
 * its FORWARD chain only (it bridges, it doesn't route, so INPUT/OUTPUT never
 * apply). The command engine itself is shared with routers — see iptables.ts.
 */
import type { Device } from "../types";
import { state } from "../state";
import { terminalLine } from "./core";
import { runIptablesCommand, iptablesHelpLines } from "./iptables";

const FIREWALL_CHAINS = ["forward"];

export function runFirewallTerminalCommand(device: Device, command: string): void {
  const lower = command.toLowerCase().trim();
  if (lower === "clear") { state.terminal.lines = []; return; }
  if (lower === "help" || lower === "?") {
    terminalLine("muted", [
      ...iptablesHelpLines(FIREWALL_CHAINS),
      "  Note: transparent mode filters the FORWARD chain only.",
      "clear",
    ].join("\n"));
    return;
  }
  if (runIptablesCommand(device, command, FIREWALL_CHAINS)) return;
  terminalLine("error", `${command}: command not found (try "iptables ..." or "help")`);
}
