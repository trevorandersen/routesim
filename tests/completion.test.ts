/**
 * Tab completion in the Linux host and server shells: the pure completer
 * (terminal/completion.ts) and its keydown wiring (handleTerminalKeydown in
 * terminal/core.ts) — including that Tab still leaves an empty input, so a
 * keyboard user is never held in the terminal.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { state } from "../src/state";
import { dom } from "../src/dom";
import { addDevice } from "../src/devices";
import type { Device, DeviceType } from "../src/types";
import { completeShellLine, shellGrammar } from "../src/terminal/completion";
import { hostHelpLines, HOST_COMMAND_ALIASES, runHostTerminalCommand } from "../src/terminal/host";
import { serverHelpLines, runServerTerminalCommand } from "../src/terminal/server";
import { handleTerminalKeydown } from "../src/terminal";
import { registerNoopCallbacks, resetState } from "./helpers";

beforeAll(() => registerNoopCallbacks());

let pc: Device, server: Device;
const add = (type: DeviceType, name: string) => addDevice(type, 0, 0, name);

// The DOM stub is shared by every test file (one process): leave the input as found.
function resetInput(): void {
  dom.terminalInput.value = "";
  dom.terminalInput.readOnly = false;
  dom.terminalInput.disabled = false;
  dom.terminalInput.selectionStart = null;
  dom.terminalInput.selectionEnd = null;
}
afterAll(resetInput);

beforeEach(() => {
  resetState();
  pc = add("computer", "PC-1");
  add("computer", "PC-2");
  add("laptop", "Laptop-1");
  server = add("server", "DNS-1");
  add("router", "R1");
  add("switch", "SW1");
  state.terminal.deviceId = pc.id;
  state.terminal.lines = [];
  resetInput();
});

const complete = (line: string, device: Device = pc) => completeShellLine(device, line);
const usageCommands = (lines: string[]) =>
  lines.filter(l => /^\s+\S/.test(l)).map(l => l.trim().split(/\s+/)[0]);

describe("completeShellLine — first word", () => {
  it("one match completes the command with a trailing space", () => {
    expect(complete("pi")).toEqual({ line: "ping ", candidates: ["ping"] });
    expect(complete("trace")).toEqual({ line: "tracer", candidates: ["traceroute", "tracert"] });
    expect(complete("tracero").line).toBe("traceroute ");
  });

  it("several matches complete their common prefix and list them all", () => {
    expect(complete("ho")).toEqual({ line: "host", candidates: ["host", "hostname", "hostnamectl"] });
  });

  it("no match leaves the line as it is", () => {
    expect(complete("xyz")).toEqual({ line: "xyz", candidates: [] });
  });

  it("every command help lists is completable (the words are read from help, so they cannot drift)", () => {
    const offered = complete("").candidates;
    for (const command of usageCommands(hostHelpLines())) expect(offered).toContain(command);
    const serverOffered = complete("", server).candidates;
    for (const command of usageCommands(serverHelpLines())) expect(serverOffered).toContain(command);
  });

  it("the accepted spellings help omits are offered, and the dispatcher really accepts each", () => {
    const offered = complete("").candidates;
    // A lone, unaddressed PC: every command refuses before it could animate a run.
    const lone = add("computer", "Lone");
    state.terminal.deviceId = lone.id;
    for (const alias of Object.keys(HOST_COMMAND_ALIASES)) {
      expect(offered).toContain(alias);
      const tries = [alias, `${alias} PC-2`, `${alias} -n`];
      const accepted = tries.some(command => {
        state.terminal.lines = [];
        runHostTerminalCommand(lone, command);
        return !state.terminal.lines.some(l => l.text.endsWith("command not found"));
      });
      expect({ alias, accepted }).toEqual({ alias, accepted: true });
    }
  });

  it("a server adds its dnsmasq commands; a PC does not have them", () => {
    expect(complete("sys", server).line).toBe("systemctl ");
    expect(complete("sys").candidates).toEqual([]);
  });
});

describe("completeShellLine — later words", () => {
  it("completes the ip subcommands the shell implements", () => {
    expect(complete("ip ").candidates).toEqual(["addr", "link", "neigh", "route"]);
    expect(complete("ip a").line).toBe("ip addr ");
    expect(complete("ip addr s").line).toBe("ip addr show ");
    expect(complete("ip route ").candidates).toEqual(["add", "del", "show"]);
    expect(complete("IP R").line).toBe("IP route ");
  });

  it("completes host names (not routers or switches) as the target of the network tools", () => {
    expect(complete("ping P")).toEqual({ line: "ping PC-", candidates: ["PC-1", "PC-2"] });
    expect(complete("ping pc-1").line).toBe("ping PC-1 ");
    expect(complete("ping ").candidates).toEqual(["DNS-1", "Laptop-1", "PC-1", "PC-2"]);
    for (const tool of ["traceroute", "tracert", "nslookup", "host", "dig", "curl", "wget"]) {
      expect(complete(`${tool} Lap`).line).toBe(`${tool} Laptop-1 `);
    }
    expect(complete("nc -z DN").line).toBe("nc -z DNS-1 ");
    expect(complete("nc DN").line).toBe("nc DNS-1 ");
    expect(complete("ping R").candidates).toEqual([]);
    expect(complete("ping SW").candidates).toEqual([]);
  });

  it("keeps a URL scheme in front of a curl target", () => {
    expect(complete("curl http://dn").line).toBe("curl http://DNS-1 ");
    expect(complete("wget https://Lap").line).toBe("wget https://Laptop-1 ");
  });

  it("does not offer a device name where something else belongs", () => {
    expect(complete("hostnamectl set-hostname P").candidates).toEqual([]);
    expect(complete("nc -z PC-1 8").candidates).toEqual([]);   // the port
    expect(complete("hostnamectl s").line).toBe("hostnamectl set-hostname ");
  });

  it("completes the files the shell understands, and a server's dnsmasq.conf only on a server", () => {
    expect(complete("cat /etc/r").line).toBe("cat /etc/resolv.conf ");
    expect(complete("cat ")).toEqual({ line: "cat /etc/", candidates: ["/etc/hostname", "/etc/resolv.conf"] });
    expect(complete("echo nameserver 10.0.0.53 > /etc/res").line).toBe("echo nameserver 10.0.0.53 > /etc/resolv.conf ");
    expect(complete("cat /etc/d").candidates).toEqual([]);
    expect(complete("cat /etc/d", server).line).toBe("cat /etc/dnsmasq.conf ");
  });

  it("completes the server's systemctl verbs and dnsmasq directives (a directive stem takes no space)", () => {
    expect(complete("systemctl st", server).candidates).toEqual(["start", "status", "stop"]);
    expect(complete("systemctl restart d", server).line).toBe("systemctl restart dnsmasq ");
    expect(complete("echo dhcp-r", server).line).toBe("echo dhcp-range=");
    expect(complete("echo a", server).line).toBe("echo address=/");
    expect(complete("echo n", server).line).toBe("echo nameserver ");
  });

  it("the grammar reads usage, not the aligned notes", () => {
    const grammar = shellGrammar(["Commands:", "  hostname [name]          (show / set it)"]);
    expect([...grammar.root.words.keys()]).toContain("hostname");
    expect(grammar.root.words.has("(show")).toBe(false);
  });
});

describe("completeShellLine — which shells complete", () => {
  it("a router, switch or IDS sensor has no Linux shell to complete", () => {
    const router = state.devices.find(d => d.name === "R1")!;
    expect(complete("pi", router)).toEqual({ line: "pi", candidates: [] });
    expect(complete("pi", add("ids", "IDS1"))).toEqual({ line: "pi", candidates: [] });
  });

  it("the Kali shells complete the host commands they fall through to, and not their attack commands", () => {
    for (const type of ["kali", "attacker"] as const) {
      const kali = add(type, `K-${type}`);
      expect(complete("pi", kali).line).toBe("ping ");
      expect(complete("nm", kali).candidates).toEqual([]);
      expect(complete("arps", kali).candidates).toEqual([]);
    }
  });
});

// ── The keydown wiring ───────────────────────────────────────────────────────

function press(key: string, mods: { shiftKey?: boolean; ctrlKey?: boolean } = {}): boolean {
  let prevented = false;
  handleTerminalKeydown({
    key, shiftKey: !!mods.shiftKey, ctrlKey: !!mods.ctrlKey, altKey: false, metaKey: false,
    preventDefault() { prevented = true; },
  } as unknown as KeyboardEvent);
  return prevented;
}
const type = (text: string) => { dom.terminalInput.value = text; };

describe("handleTerminalKeydown — Tab", () => {
  it("completes the line in a host shell and keeps focus in the input", () => {
    type("pi");
    expect(press("Tab")).toBe(true);
    expect(dom.terminalInput.value).toBe("ping ");
  });

  it("an empty (or blank) input lets Tab move focus as before", () => {
    type("");
    expect(press("Tab")).toBe(false);
    type("   ");
    expect(press("Tab")).toBe(false);
    expect(dom.terminalInput.value).toBe("   ");
  });

  it("Shift+Tab and Ctrl+Tab are never taken", () => {
    type("pi");
    expect(press("Tab", { shiftKey: true })).toBe(false);
    expect(press("Tab", { ctrlKey: true })).toBe(false);
    expect(dom.terminalInput.value).toBe("pi");
  });

  it("Tab is left alone when the caret is not at the end, or a selection is held", () => {
    type("pi");
    dom.terminalInput.selectionStart = 1; dom.terminalInput.selectionEnd = 1;
    expect(press("Tab")).toBe(false);
    dom.terminalInput.selectionStart = 0; dom.terminalInput.selectionEnd = 2;
    expect(press("Tab")).toBe(false);
    dom.terminalInput.selectionStart = 2; dom.terminalInput.selectionEnd = 2;
    expect(press("Tab")).toBe(true);
    expect(dom.terminalInput.value).toBe("ping ");
  });

  it("is not taken in a shell without completion (the router keeps ? and abbreviation)", () => {
    state.terminal.deviceId = state.devices.find(d => d.name === "R1")!.id;
    type("sh");
    expect(press("Tab")).toBe(false);
    expect(dom.terminalInput.value).toBe("sh");
  });

  it("is not taken while the shell is busy (read-only input)", () => {
    dom.terminalInput.readOnly = true;
    type("pi");
    expect(press("Tab")).toBe(false);
  });

  it("no match keeps the line and prints nothing", () => {
    type("xyz");
    expect(press("Tab")).toBe(true);
    expect(press("Tab")).toBe(true);
    expect(dom.terminalInput.value).toBe("xyz");
    expect(state.terminal.lines).toEqual([]);
  });

  it("a second Tab on an unchanged line prints the candidates; the first prints nothing", () => {
    type("ip ");
    press("Tab");
    expect(state.terminal.lines).toEqual([]);
    press("Tab");
    expect(state.terminal.lines.map(l => l.text)).toEqual(["PC-1$ ip ", "addr  link  neigh  route"]);
    expect(dom.terminalInput.value).toBe("ip ");
  });

  it("a Tab that completed something resets it: the next Tab on the new line lists", () => {
    type("ping P");
    press("Tab");
    expect(dom.terminalInput.value).toBe("ping PC-");
    expect(state.terminal.lines).toEqual([]);
    press("Tab");
    expect(state.terminal.lines.at(-1)!.text).toBe("PC-1  PC-2");
  });

  it("editing the line between Tabs starts over", () => {
    type("ip ");
    press("Tab");
    type("ip r");
    press("Tab");                       // completes to "ip route "
    type("ip ");
    press("Tab");                       // a fresh first Tab on this line
    expect(state.terminal.lines).toEqual([]);
  });

  it("other keys are not affected", () => {
    type("pi");
    expect(press("a")).toBe(false);
    expect(dom.terminalInput.value).toBe("pi");
  });
});
