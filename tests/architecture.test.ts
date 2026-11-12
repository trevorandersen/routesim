/**
 * Import-graph guards. The layering in docs/architecture.md is a convention the
 * bundler does not enforce, and a cycle misused at module top level bites in the
 * built bundle as a silent `undefined` (see tests/bundle.test.ts) — which unit
 * tests, importing modules one at a time in other orders, may never see. These tests read the real import statements and pin the parts that were
 * hard-won:
 *   - engine.ts is in no import cycle and imports no presentation module (it sat
 *     at the centre of an 11-module cycle and rendered the sim log itself —
 *     review R106);
 *   - the model layer (state, devices, normalise) stays below the engine and UI;
 *   - only the two documented cycles remain.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, normalize } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);
}

// Runtime imports only: `import type` is erased and cannot form a cycle.
function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const match of text.matchAll(/^(?:import|export)\s+(type\s+)?[^;]*?from\s+"(\.[^"]+)"/gm)) {
    if (match[1]) continue;
    const base = normalize(join(dirname(file), match[2]));
    const target = [`${base}.ts`, join(base, "index.ts")].find(candidate => existsSync(candidate));
    if (target) found.push(target);
  }
  return found;
}

const files = sourceFiles(SRC);
const graph = new Map(files.map(file => [file, importsOf(file)]));
const short = (file: string) => file.slice(SRC.length + 1);

// Tarjan's strongly connected components; returns those with more than one module.
function cycles(): string[][] {
  const index = new Map<string, number>(), low = new Map<string, number>();
  const stack: string[] = [], onStack = new Set<string>(), found: string[][] = [];
  let counter = 0;
  const visit = (v: string) => {
    index.set(v, counter); low.set(v, counter); counter++;
    stack.push(v); onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do { w = stack.pop()!; onStack.delete(w); component.push(short(w)); } while (w !== v);
      if (component.length > 1) found.push(component.sort());
    }
  };
  for (const file of files) if (!index.has(file)) visit(file);
  return found.sort((a, b) => a[0].localeCompare(b[0]));
}

// Everything a module reaches by following imports.
function reach(start: string): Set<string> {
  const seen = new Set<string>();
  const walk = (file: string) => { for (const next of graph.get(file) ?? []) if (!seen.has(next)) { seen.add(next); walk(next); } };
  walk(join(SRC, start));
  return new Set([...seen].map(short));
}

const PRESENTATION = ["ui.ts", "inspector.ts", "canvas.ts", "simlog-view.ts", "port-picker.ts", "console.ts", "ribbon.ts", "scenario-ui.ts", "tutorial.ts", "app.ts"];
const isTerminal = (file: string) => file.startsWith("terminal/");

describe("import graph — the engine is out of the cycles (R106)", () => {
  it("engine.ts is in no import cycle", () => {
    expect(cycles().filter(component => component.includes("engine.ts"))).toEqual([]);
  });

  it("engine.ts reaches no presentation module and no device shell, even indirectly", () => {
    const reached = [...reach("engine.ts")];
    expect(reached.filter(file => PRESENTATION.includes(file) || isTerminal(file))).toEqual([]);
  });

  it("the sim-log view is a presentation module the engine does not import", () => {
    expect(existsSync(join(SRC, "simlog-view.ts"))).toBe(true);
    expect(readFileSync(join(SRC, "engine.ts"), "utf8")).not.toMatch(/dom\.simLog|function syncSimLog|renderPacketTable/);
    expect(reach("simlog-view.ts").has("engine.ts")).toBe(true);   // the view reads the engine's captures, not the reverse
  });

  it("the network logic below the engine stays below it", () => {
    for (const file of ["routing.ts", "stp.ts", "simulation.ts", "frame.ts", "snort.ts", "packet-filter.ts"]) {
      const reached = [...reach(file)];
      expect(reached.filter(f => f === "engine.ts" || PRESENTATION.includes(f) || isTerminal(f)), file).toEqual([]);
    }
  });

  it("the model layer imports neither the engine nor any UI", () => {
    for (const file of ["state.ts", "devices.ts", "normalise.ts", "device-registry.ts", "utils.ts", "types.ts"]) {
      const reached = [...reach(file)];
      expect(reached.filter(f => f === "engine.ts" || PRESENTATION.includes(f) || isTerminal(f)), file).toEqual([]);
    }
  });

  it("only the two documented cycles remain: the device shells, and the application layer", () => {
    const found = cycles();
    expect(found.length).toBe(2);
    expect(found.find(c => c.includes("terminal/core.ts"))!.every(isTerminal)).toBe(true);
    const app = found.find(c => c.includes("ui.ts"))!;
    expect(app.sort()).toEqual(["commands.ts", "config.ts", "console.ts", "io.ts", "ribbon.ts", "scenario-ui.ts", "scenarios.ts", "ui.ts"]);
  });
});
