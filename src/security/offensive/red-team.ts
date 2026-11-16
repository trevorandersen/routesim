/**
 * Autonomous Red Team launch (the `attacker` device on Play).
 *
 * `launchRedTeam` is the Play-button path for the Red Team actor: it finds the
 * first ready actor and starts its configured attack run. Kali PCs are excluded
 * — they are user-driven, never autonomous. Moved out of engine.ts with the rest
 * of the offensive code; engine.ts does not call it (ui.ts does on Play), so this
 * module imports the engine's startSimulation without forming a cycle.
 */
import type { Device } from "../../types";
import { state } from "../../state";
import { dom } from "../../dom";
import { isPhysicalLink } from "../../devices";
import { startSimulation } from "../../engine";
import { buildAttackEvents } from "./attacks";

// With Red Team actors placed but none ready, says why the first one can't go
// (rather than leaving "Nothing to boot" as the only word on it).
export function launchRedTeam(): boolean {
  const sim = state.simulation;
  if (sim.status === "running" || sim.status === "paused") return false;
  const actors = state.devices.filter(d => d.type === "attacker");
  const attacker = actors.find(d => !redTeamNotReadyReason(d));
  if (!attacker) {
    if (actors.length) dom.modeLabel.textContent = redTeamNotReadyReason(actors[0])!;
    return false;
  }
  const setup = buildAttackEvents(attacker);
  if (typeof setup === "string") { dom.modeLabel.textContent = setup; return false; }
  dom.modeLabel.textContent = `${attacker.name}: launching attacks...`;
  startSimulation(setup, attacker.id, "", "attack");
  return true;
}

// Why a Red Team actor can't launch on Play, or null when it's ready.
function redTeamNotReadyReason(actor: Device): string | null {
  if (actor.poweredOff) return `${actor.name} is powered off — power it on to launch its attacks.`;
  if (!actor.config?.ipv4Address) {
    const cabled = state.links.some(l => isPhysicalLink(l) && !l.shutdown && (l.from === actor.id || l.to === actor.id));
    return cabled
      ? `${actor.name} has no IP address — set a static IP, or turn on Auto-DHCP / APIPA fallback (Settings) so Play boots it.`
      : `${actor.name} has no IP address and no cable — connect it to the network first.`;
  }
  if (!(actor.config.attacks?.length)) return `${actor.name} has no attacks enabled — pick a scan, sweep or ARP spoof in its inspector.`;
  return null;
}
