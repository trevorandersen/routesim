/**
 * Tab completion for the Linux host and server shells. Pure — no DOM: the
 * input line goes in, the completed line and the candidates come out; the
 * keydown wiring (and bash's "second Tab lists them") lives in core.ts.
 *
 * Nothing here is a second command list. The words come from the shell's own
 * `help` (hostHelpLines / serverHelpLines), read as a small grammar:
 *
 *   - each usage line's literal words form a path in a word tree
 *     (`ip addr show` → ip → addr → show), `a|b` giving alternatives;
 *     the tree stops at the first placeholder (`<ipv4>`, `[name]`);
 *   - a placeholder with literal text in front of it (`dhcp-range=<start>,…`)
 *     leaves that text as a stem, completed without a trailing space;
 *   - a command whose first non-flag argument is a `<name…>` placeholder
 *     (`ping <name|ipv4>`, `nc -z <name|ipv4> <port>`) takes a device name there;
 *   - every literal `/path` in the help is a file the shell understands.
 *
 * HOST_COMMAND_ALIASES (host.ts) adds the accepted spellings `help` omits.
 * The router keeps its own `?` help and abbreviation (ROUTER_COMMANDS); the
 * Kali shells get host completion for the host commands they fall through to,
 * and nothing for their attack commands.
 */
import type { Device } from "../types";
import { state } from "../state";
import { isHost } from "../device-registry";
import { hostHelpLines, HOST_COMMAND_ALIASES } from "./host";
import { serverHelpLines } from "./server";

export interface Completion {
  line: string;          // the input line after completion (unchanged if nothing to add)
  candidates: string[];  // every word that fits at the cursor, sorted
}

interface WordNode {
  words: Map<string, WordNode>;
  stems: Set<string>;    // partial words ending at a placeholder: no trailing space
}

interface ShellGrammar {
  root: WordNode;
  targets: Set<string>;  // commands whose first argument is a device name
  paths: string[];
}

const wordNode = (): WordNode => ({ words: new Map(), stems: new Set() });

// The help a device's Linux shell prints, or null when it has no Linux shell
// (router, switch, firewall, IDS sensor). Hosts are the registry's `host`
// role; the server adds dnsmasq.
export function hostShellHelpLines(device: Device): string[] | null {
  if (device.type === "server") return serverHelpLines();
  return isHost(device.type) ? hostHelpLines() : null;
}

// Read help lines as a grammar. Exported for the drift test.
export function shellGrammar(helpLines: string[]): ShellGrammar {
  const root = wordNode();
  const targets = new Set<string>();
  const paths = new Set<string>();
  for (const raw of helpLines) {
    if (!/^\s+\S/.test(raw)) continue;   // a heading ("Commands:"), not a usage line
    // The usage is what precedes the column-aligned note: "hostname [name]   (show …)".
    const tokens = raw.trim().split(/\s{2,}/)[0].split(/\s+/);
    for (const t of tokens) if (/^\/[\w./-]+$/.test(t)) paths.add(t);
    if (tokens.slice(1).find(t => !t.startsWith("-"))?.includes("<name")) targets.add(tokens[0]);
    let at = [root];
    for (const token of tokens) {
      const open = token.search(/[<[(]/);
      if (open === 0) break;
      if (open > 0) { at.forEach(n => n.stems.add(token.slice(0, open))); break; }
      const next: WordNode[] = [];
      for (const word of token.split("|")) {
        for (const n of at) {
          let child = n.words.get(word);
          if (!child) { child = wordNode(); n.words.set(word, child); }
          next.push(child);
        }
      }
      at = next;
    }
  }
  for (const [alias, twin] of Object.entries(HOST_COMMAND_ALIASES)) {
    if (root.words.has(alias)) continue;
    root.words.set(alias, (twin && root.words.get(twin)) || wordNode());
    if (twin && targets.has(twin)) targets.add(alias);
  }
  return { root, targets, paths: [...paths] };
}

// The names a target argument can take: hosts, as findPingTarget resolves them.
function deviceNames(): string[] {
  return state.devices.filter(d => isHost(d.type) && /^\S+$/.test(d.name)).map(d => d.name);
}

// Longest common prefix, ignoring case; the spelling is the first word's.
function commonPrefix(words: string[]): string {
  let prefix = words[0];
  for (const w of words.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < w.length && prefix[i].toLowerCase() === w[i].toLowerCase()) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

// Complete the last word of `line` (the cursor is at its end), as bash does:
// one candidate completes it, with a trailing space; several complete their
// common prefix; none leaves the line as it is. Matching ignores case (device
// names resolve case-insensitively) and completes to the candidate's spelling.
export function completeShellLine(device: Device, line: string): Completion {
  const help = hostShellHelpLines(device);
  if (!help) return { line, candidates: [] };
  const grammar = shellGrammar(help);
  const start = line.search(/\S*$/);
  const before = line.slice(0, start);
  let current = line.slice(start);
  const previous = before.trim() ? before.trim().split(/\s+/) : [];

  let prefix = "";   // text kept in front of the completed part (a URL scheme)
  const options: string[] = [];
  const stems = new Set<string>();
  if (previous.length === 0) {
    options.push(...grammar.root.words.keys());
  } else if (current.startsWith("/")) {
    options.push(...grammar.paths);
  } else {
    let node: WordNode | undefined = grammar.root;
    for (const w of previous) node = node?.words.get(w.toLowerCase());
    if (node) {
      options.push(...node.words.keys(), ...node.stems);
      node.stems.forEach(s => stems.add(s));
    }
    const command = previous[0].toLowerCase();
    if (grammar.targets.has(command) && previous.slice(1).every(w => w.startsWith("-")) && !current.startsWith("-")) {
      const scheme = current.match(/^https?:\/\//i);
      if (scheme) { prefix = scheme[0]; current = current.slice(prefix.length); }
      options.push(...deviceNames());
    }
  }

  const typed = current.toLowerCase();
  const candidates = [...new Set(options.filter(o => o.toLowerCase().startsWith(typed)))]
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  if (!candidates.length) return { line, candidates };
  const word = candidates.length === 1
    ? candidates[0] + (stems.has(candidates[0]) ? "" : " ")
    : commonPrefix(candidates);
  return { line: before + prefix + word, candidates: candidates.map(c => prefix + c) };
}
