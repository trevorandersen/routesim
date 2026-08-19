/**
 * The console command language's quote-aware tokenizer (src/tokenize.ts).
 * Before it, the engine split on bare whitespace, so any value containing a
 * space was unrepresentable — a device named "My PC", an SSID of "Guest WiFi".
 */
import { describe, it, expect } from "bun:test";
import { tokenizeCommand, quoteArg } from "../src/tokenize";

describe("tokenizeCommand", () => {
  it("splits on whitespace like the old parser did", () => {
    expect(tokenizeCommand("add computer PC1 at 10 20").args)
      .toEqual(["add", "computer", "PC1", "at", "10", "20"]);
  });

  it("keeps a quoted value as one token", () => {
    expect(tokenizeCommand('add computer "My PC" at 0 0').args)
      .toEqual(["add", "computer", "My PC", "at", "0", "0"]);
    expect(tokenizeCommand("ssid AP1 'Guest WiFi' secret").args)
      .toEqual(["ssid", "AP1", "Guest WiFi", "secret"]);
  });

  it("resolves \\\" and \\\\ escapes inside double quotes only", () => {
    expect(tokenizeCommand('rename A "say \\"hi\\""').args).toEqual(["rename", "A", 'say "hi"']);
    expect(tokenizeCommand('rename A "back\\\\slash"').args).toEqual(["rename", "A", "back\\slash"]);
    expect(tokenizeCommand("rename A 'raw\\\\path'").args).toEqual(["rename", "A", "raw\\\\path"]);
  });

  it("supports an empty quoted token and mid-token quoting", () => {
    expect(tokenizeCommand('linkset A B name ""').args).toEqual(["linkset", "A", "B", "name", ""]);
    expect(tokenizeCommand('web S on pre"fix post"fix').args).toEqual(["web", "S", "on", "prefix postfix"]);
  });

  it("reports an unterminated quote rather than silently truncating", () => {
    const t = tokenizeCommand('add computer "My PC');
    expect(t.error).toContain("Unterminated");
    expect(t.args).toEqual([]);
  });

  it("records where each token ends so a raw tail can be recovered", () => {
    const line = 'idsrule "My IDS" alert tcp any any -> any 80';
    const t = tokenizeCommand(line);
    expect(t.args[1]).toBe("My IDS");
    // the tail after the sensor token is the rule text, exactly as typed
    expect(line.slice(t.ends[1]).trim()).toBe("alert tcp any any -> any 80");
  });
});

describe("quoteArg", () => {
  it("leaves a bare-safe value alone", () => {
    expect(quoteArg("PC1")).toBe("PC1");
    expect(quoteArg("10.0.0.1/24")).toBe("10.0.0.1/24");
  });

  it("quotes anything that would not survive a round-trip bare", () => {
    expect(quoteArg("My PC")).toBe('"My PC"');
    expect(quoteArg("")).toBe('""');
    expect(quoteArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteArg("back\\slash")).toBe('"back\\\\slash"');
  });

  it("round-trips through the tokenizer for awkward values", () => {
    for (const value of ["My PC", "Guest WiFi", 'say "hi"', "back\\slash", "trailing ", ""]) {
      expect(tokenizeCommand(quoteArg(value)).args).toEqual([value]);
    }
  });
});
