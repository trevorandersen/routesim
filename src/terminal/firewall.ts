/**
 * Firewall terminal — the transparent inline packet filter speaks iptables on
 * its FORWARD chain only (it bridges, it doesn't route, so INPUT/OUTPUT never
 * apply). The command engine itself is shared with routers — see iptables.ts.
 */
import type { Device } from "../types";
import { state } from "../state";
import { terminalLine } from "./core";
import { runIptablesCommand, iptablesHelpLines, ruleLangOf } from "./iptables";
import { runNftCommand, nftHelpLines } from "./nftables";

const FIREWALL_CHAINS = ["forward"];

export function runFirewallTerminalCommand(device: Device, command: string): void {
  const lower = command.toLowerCase().trim();
  if (lower === "clear") { state.terminal.lines = []; return; }
  if (lower === "help" || lower === "?") {
    // Both front doors always work; lead with the device's chosen language.
    const nftFirst = ruleLangOf(device) === "nftables";
    const ipt = [...iptablesHelpLines(FIREWALL_CHAINS)];
    const nft = [...nftHelpLines(FIREWALL_CHAINS)];
    terminalLine("muted", [
      ...(nftFirst ? nft : ipt),
      "",
      `  Or ${nftFirst ? "iptables" : "nft"} (same ruleset): ${nftFirst ? "iptables -L" : "nft list ruleset"}`,
      "  Note: transparent mode filters the FORWARD chain only.",
      "clear",
    ].join("\n"));
    return;
  }
  // nft and iptables are two front doors onto one ruleset — accept either.
  if (runNftCommand(device, command, FIREWALL_CHAINS)) return;
  if (runIptablesCommand(device, command, FIREWALL_CHAINS)) return;
  terminalLine("error", `${command}: command not found (try "nft ..." / "iptables ..." or "help")`);
}
