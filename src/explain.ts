/**
 * "Why?" — turn what the engine already records into an explanation a learner
 * can read (the *Explain, don't just show* principle, made mechanical).
 *
 * The engine logs a plain-language reason for every decision (`logStep`), and
 * tags each captured frame with three things as the run goes:
 *   - `why`     — what its sender logged while deciding to send it;
 *   - `outcome` — what its receiver logged while handling it;
 *   - `cause`   — the capture number of the frame whose arrival made the sender
 *                 act (absent for the frames a command itself puts on the wire).
 * Following `cause` back gives the chain that led to a frame — "PC-A had no ARP
 * entry → asked → R1 answered → the echo went out" — without re-deriving any
 * protocol logic here. This module only composes; it never simulates.
 *
 * Pure: no DOM, no engine, no state. The inspector renders an `Explanation`,
 * the console prints it (`why <no>`), and a failed scenario check uses
 * `explainFailedRun` over the headless run's own log.
 */
import type { CaptureEntry, EthernetFrame, ExplainLine, SimLogEntry } from "./types";
import { packetColumns } from "./frame";

// One frame on one wire, with the reasons its sender gave for sending it.
export interface ExplainHop {
  no: number | null;      // its packet-list number (null for a frame still in flight)
  from: string;           // device names
  to: string;
  label: string;          // "ARP Who has 10.0.0.2? Tell 10.0.0.1" — the packet list's own words
  why: ExplainLine[];
}

export interface Explanation {
  hops: ExplainHop[];     // the chain, oldest first; the last hop is the frame asked about
  outcome: ExplainLine[]; // what its receiver did with it ([] while it is still in flight)
  receiver: string;
  truncated: boolean;     // the chain was longer than CHAIN_LIMIT (the oldest hops are dropped)
}

// How far back a chain is followed. A routed ping with cold ARP caches is about
// eight links; this leaves room without letting a flood's history run away.
export const CHAIN_LIMIT = 14;

// MAC learning and similar bookkeeping is true but is not a reason for
// anything: it is left out of a "why" when the device also said something else.
function reasons(lines: ExplainLine[] | undefined): ExplainLine[] {
  const all = lines || [];
  const decisive = all.filter(line => line.kind !== "sim-learn");
  return decisive.length ? decisive : all;
}

export function frameWords(frame: EthernetFrame): string {
  const cols = packetColumns(frame);
  return `${cols.protocol} ${cols.info}`.replace(/\s+/g, " ").trim();
}

/**
 * The chain that led to `entry`, and what happened to it. `entries` is the
 * capture it belongs to (the live run or a saved one); `nameOf` resolves a
 * device id to its name (a device since deleted reads as "a removed device").
 */
export function explainCapture(
  entry: Pick<CaptureEntry, "frame" | "fromDeviceId" | "toDeviceId" | "why" | "outcome" | "cause"> & { no?: number },
  entries: readonly CaptureEntry[],
  nameOf: (deviceId: string) => string
): Explanation {
  const byNo = new Map(entries.map(e => [e.no, e] as const));
  const hop = (e: typeof entry): ExplainHop => ({
    no: e.no ?? null,
    from: nameOf(e.fromDeviceId),
    to: nameOf(e.toDeviceId),
    label: frameWords(e.frame),
    why: reasons(e.why),
  });
  const hops: ExplainHop[] = [hop(entry)];
  const seen = new Set<number>(entry.no != null ? [entry.no] : []);
  let cause = entry.cause;
  let truncated = false;
  while (cause != null) {
    const parent = byNo.get(cause);
    if (!parent || seen.has(parent.no)) break;        // scrolled out of the 1000-row capture, or a cycle
    if (hops.length >= CHAIN_LIMIT) { truncated = true; break; }
    seen.add(parent.no);
    hops.unshift(hop(parent));
    cause = parent.cause;
  }
  return { hops, outcome: reasons(entry.outcome), receiver: nameOf(entry.toDeviceId), truncated };
}

// The frame a bare `why` explains for a traced run: where the story ended — the
// last frame something stopped, else simply the last frame.
export function storyEnd(entries: readonly CaptureEntry[]): CaptureEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].outcome?.some(line => line.kind === "sim-drop")) return entries[i];
  }
  return entries[entries.length - 1];
}

const sentence = (text: string) => text.replace(/[.\s]+$/, "");

/**
 * The explanation in a sentence or two, for the top of the view: what set this
 * frame off, how far back the chain goes, and how the frame ended. The chain
 * below it is the evidence; this is the answer a learner reads first.
 */
export function explanationSummary(explanation: Explanation): string {
  const hops = explanation.hops;
  const last = hops[hops.length - 1];
  const first = hops[0];
  const parts: string[] = [];
  if (hops.length === 1) {
    parts.push(last.why.length
      ? `${last.from} starts here: ${sentence(last.why[0].text)}.`
      : `${last.from} sent this to ${last.to}.`);
  } else {
    const prev = hops[hops.length - 2];
    parts.push(`${last.from} sent this in response to ${prev.no != null ? `packet #${prev.no}` : "the previous frame"} (${prev.label}).`);
    if (hops.length > 2) {
      parts.push(`${explanation.truncated ? "The chain goes back further than shown" : `It traces back ${hops.length - 1} packets to ${first.no != null ? `#${first.no}` : "the first frame"}, where ${first.from} began`}.`);
    }
  }
  const stop = explanation.outcome.find(line => line.kind === "sim-drop");
  if (stop) parts.push(`It stopped at ${stop.device}: ${sentence(stop.text)}.`);
  else if (explanation.outcome.length) parts.push(`${explanation.receiver} then: ${sentence(explanation.outcome[explanation.outcome.length - 1].text)}.`);
  else parts.push(last.no == null ? `It has not reached ${explanation.receiver} yet.` : `${explanation.receiver} has not handled it yet.`);
  return parts.join(" ");
}

// The explanation as plain lines — what the console's `why` verb prints, and
// the form the tests read: the summary, then the chain it summarises.
export function explanationText(explanation: Explanation): string[] {
  const lines: string[] = [explanationSummary(explanation)];
  if (explanation.truncated) lines.push(`(earlier steps omitted — showing the last ${explanation.hops.length})`);
  explanation.hops.forEach((h, index) => {
    const last = index === explanation.hops.length - 1;
    lines.push(`${last ? "→" : " "} ${h.no != null ? `#${h.no}` : "(in flight)"} ${h.from} → ${h.to}: ${h.label}`);
    for (const line of h.why) lines.push(`      ${line.device}: ${line.text}`);
  });
  if (explanation.outcome.length) {
    lines.push(`  Then, at ${explanation.receiver}:`);
    for (const line of explanation.outcome) lines.push(`      ${line.device}: ${line.text}`);
  }
  return lines;
}

/**
 * Why the origin put its first frame on the wire. The run's opening frames are
 * built by the command (`ping`, `nc`, `dhcp`, …) before any device has
 * processed anything, so no log line covers them; this says what the origin
 * was doing, in the voice of a log line (the view prefixes the device's name).
 * `waiting` is the frame it is holding back behind an ARP, if any.
 */
export function originReason(frame: EthernetFrame, waiting?: EthernetFrame | null): string {
  const p = frame.payload;
  if (p.type === "arp" && p.operation === "request") {
    const held = waiting ? ` before it can send its ${frameWords(waiting).split(" ").slice(0, 3).join(" ")}` : "";
    return `No ARP entry for ${p.targetIp}, so it must learn that MAC address${held} — broadcasting an ARP request`;
  }
  if (p.type === "arp") return `Announcing that ${p.senderIp} is at ${p.senderMac}`;
  if (p.type === "ipv4") {
    const inner = p.payload;
    if (inner.type === "dhcp") return "No address yet — broadcasting a DHCP Discover to find a server";
    if (inner.type === "dns") return `Must resolve ${inner.name} before it can reach it — asking its nameserver ${p.dstIp}`;
    return `Already knows the next hop's MAC address — sending straight to ${p.dstIp}`;
  }
  if (p.type === "dot11") return `Starting to join the wireless network${p.ssid ? ` "${p.ssid}"` : ""}`;
  if (p.type === "dot1x") return "Starting 802.1X authentication on its port";
  if (p.type === "bpdu") return "The root bridge originates the spanning-tree BPDU";
  return "Starting the run";
}

/**
 * Why a headless run failed, from its own log: the drops in the order they
 * happened (the first is usually the cause, later ones its consequences), then
 * the post-mortem's diagnosis. Empty for a run that succeeded. Capped so a
 * goal banner stays readable.
 */
export function explainFailedRun(result: { success: boolean; log: readonly SimLogEntry[]; diagnosis: readonly string[] }, limit = 4): string[] {
  if (result.success) return [];
  const out: string[] = [];
  const add = (text: string) => { if (text && !out.some(have => have === text || have.includes(text) || text.includes(have))) out.push(text); };
  for (const entry of result.log) if (entry.kind === "sim-drop") add(`${entry.deviceName}: ${entry.action}`);
  for (const line of result.diagnosis) add(line);
  return out.slice(0, limit);
}
