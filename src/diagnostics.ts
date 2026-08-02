import { state } from "./state";
import type { AppState } from "./types";

/**
 * Fast, read-only consistency checks for browser automation and bug reports.
 * An empty array means the live model has no structural problems.
 */
export function diagnoseState(app: AppState): string[] {
  const issues: string[] = [];
  const deviceIds = new Set<string>();
  const linkIds = new Set<string>();

  for (const device of app.devices) {
    if (!device.id) issues.push("A device has an empty id.");
    else if (deviceIds.has(device.id)) issues.push(`Duplicate device id: ${device.id}.`);
    deviceIds.add(device.id);

    if (!Number.isFinite(device.x) || !Number.isFinite(device.y)) {
      issues.push(`Device ${device.id || "(unknown)"} has non-finite coordinates.`);
    }
  }

  for (const link of app.links) {
    if (!link.id) issues.push("A link has an empty id.");
    else if (linkIds.has(link.id)) issues.push(`Duplicate link id: ${link.id}.`);
    linkIds.add(link.id);

    if (!deviceIds.has(link.from)) issues.push(`Link ${link.id} has missing endpoint ${link.from}.`);
    if (!deviceIds.has(link.to)) issues.push(`Link ${link.id} has missing endpoint ${link.to}.`);
    if (link.from === link.to) issues.push(`Link ${link.id} connects ${link.from} to itself.`);
  }

  const checkDeviceRef = (label: string, id: string | null) => {
    if (id && !deviceIds.has(id)) issues.push(`${label} references missing device ${id}.`);
  };
  checkDeviceRef("Selection", app.selectedId);
  checkDeviceRef("Configuration panel", app.configuringId);
  checkDeviceRef("Link start", app.linkStartId);
  checkDeviceRef("Active terminal", app.terminal.deviceId);
  for (const session of app.terminalSessions) checkDeviceRef("Terminal session", session.deviceId);

  if (app.selectedLinkId && !linkIds.has(app.selectedLinkId)) {
    issues.push(`Selection references missing link ${app.selectedLinkId}.`);
  }

  if (!Number.isFinite(app.pan.x) || !Number.isFinite(app.pan.y)) {
    issues.push("Canvas pan contains a non-finite value.");
  }
  if (!Number.isFinite(app.scale) || app.scale <= 0) issues.push("Canvas scale is not positive and finite.");

  const sim = app.simulation;
  // Completed runs are historical records and may legitimately outlive an
  // endpoint edit. Active work, queues, and transits must only reference the
  // live topology.
  if (sim.status === "running" || sim.status === "paused") {
    checkDeviceRef("Simulation origin", sim.originDeviceId);
  }
  if (!Number.isFinite(sim.speed) || sim.speed <= 0) issues.push("Simulation speed is not positive and finite.");
  if (!Number.isFinite(sim.stepIndex) || sim.stepIndex < 0) issues.push("Simulation step index is invalid.");

  for (const event of sim.events) {
    checkDeviceRef("Queued event target", event.deviceId);
    checkDeviceRef("Queued event source", event.fromDeviceId);
    if (event.linkId && !linkIds.has(event.linkId)) issues.push(`Queued event references missing link ${event.linkId}.`);
  }

  for (const transit of sim.transits) {
    checkDeviceRef("Transit source", transit.fromDeviceId);
    checkDeviceRef("Transit target", transit.toDeviceId);
    if (!linkIds.has(transit.linkId)) issues.push(`Transit references missing link ${transit.linkId}.`);
    if (!Number.isFinite(transit.progress) || !Number.isFinite(transit.startTime)) {
      issues.push(`Transit on ${transit.linkId} has invalid animation values.`);
    }
  }

  if (sim.status === "running" || sim.status === "paused") {
    for (const capture of sim.capture) {
      checkDeviceRef("Capture source", capture.fromDeviceId);
      checkDeviceRef("Capture target", capture.toDeviceId);
      if (!linkIds.has(capture.linkId)) issues.push(`Capture references missing link ${capture.linkId}.`);
    }
  }

  return [...new Set(issues)];
}

export function diagnoseRuntimeState(): string[] {
  return diagnoseState(state);
}
