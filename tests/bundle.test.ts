/**
 * Bundle smoke test (review R66). Every other test imports source modules one
 * at a time; none executes what actually ships — esbuild's single IIFE, where
 * all modules share one scope and evaluate in one fixed order. In that file a
 * top-level `const` is lowered to `var`, so a use of a not-yet-evaluated import
 * across a cycle does not throw: it is silently `undefined`, and fails later,
 * far from its cause. This suite builds the bundle exactly as build.sh does,
 * evaluates it against the stub DOM, and drives the public API end to end.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
let bundle = "";
let api: any;

beforeAll(() => {
  // The same esbuild invocation as build.sh, written to stdout instead of a file.
  const built = Bun.spawnSync(["esbuild", "src/app.ts", "--bundle", "--format=iife", "--target=es2022", "--log-level=error"], { cwd: ROOT });
  if (built.exitCode !== 0) throw new Error(`esbuild failed (it is one of the project's two build tools and must be on PATH):\n${built.stderr.toString()}`);
  bundle = built.stdout.toString();
  const scope = globalThis as any;
  const previous = { routesim: scope.window.routesim, location: scope.window.location };
  delete scope.window.routesim;
  scope.window.location = { search: "", href: "http://localhost/rs-web.html", hash: "" };   // what a page always has
  try {
    // Evaluate it as the page's <script> would: one program, global scope.
    new Function(bundle)();
    api = scope.window.routesim;
  } finally {
    scope.window.routesim = previous.routesim;
    scope.window.location = previous.location;
  }
});

describe("the built bundle (R66)", () => {
  it("builds to one self-contained IIFE", () => {
    expect(bundle.length).toBeGreaterThan(200_000);
    expect(bundle.trimStart().startsWith("\"use strict\";\n(() => {") || bundle.trimStart().startsWith("(() => {")).toBe(true);
    expect(bundle).not.toMatch(/\brequire\(|\bimport\s*\(|^import /m);       // nothing left to load at run time
    expect(bundle).not.toMatch(/<\/script/i);                               // safe to inline (build-inline.ts checks this too)
  });

  it("evaluates without throwing and publishes window.routesim", () => {
    expect(api).toBeDefined();
    for (const name of ["exec", "run", "snapshot", "diagnose", "exportConfig", "importConfig", "exportScript", "importScript"]) {
      expect(typeof api[name], name).toBe("function");
    }
  });

  it("boots with the default topology loaded and no invariant violations", () => {
    const snap = api.snapshot();
    expect(snap.devices.length).toBeGreaterThan(0);
    expect(snap.links.length).toBeGreaterThan(0);
    expect(api.diagnose()).toEqual([]);
  });

  it("builds a network from a script and pings across a router", () => {
    const results = api.run(`
      clear
      add computer PC-A at 100 100
      add switch SW-A at 300 100
      add router R1 at 500 100
      add switch SW-B at 700 100
      add computer PC-B at 900 100
      link PC-A SW-A
      link SW-A R1
      link R1 SW-B
      link SW-B PC-B
      ip PC-A 10.0.1.10/24
      gateway PC-A 10.0.1.1
      ip PC-B 10.0.2.10/24
      gateway PC-B 10.0.2.1
      interface R1 SW-A ip 10.0.1.1/24
      interface R1 SW-B ip 10.0.2.1/24
    `);
    expect(results.filter((r: any) => !r.ok).map((r: any) => r.output.join(" "))).toEqual([]);
    const ping = api.exec("run ping PC-A PC-B");
    expect(ping.ok).toBe(true);
    expect(ping.output.join(" ")).toContain("reachable");
    expect(api.diagnose()).toEqual([]);
  });

  it("reaches every layer through the bundle: device shells, routing, spanning tree, scenarios, export", () => {
    expect(api.exec("cli R1 enable").ok).toBe(true);
    expect(api.exec("cli R1 show ip route").output.join(" ")).toContain("10.0.1.0/24 is directly connected");
    expect(api.exec("managed SW-A on").ok).toBe(true);
    expect(api.exec("cli SW-A show spanning-tree").output.join(" ")).toContain("this bridge is the root");
    const trace = api.exec("traceroute PC-A PC-B");
    expect(trace.ok).toBe(true);
    expect(trace.output.join(" ")).toContain("10.0.2.10");
    const list = api.exec("scenario list");
    expect(list.ok).toBe(true);
    expect(list.output.length).toBeGreaterThan(10);
    expect(api.exec("undo").ok).toBe(true);
    expect(api.exec("help").output.length).toBeGreaterThan(20);
  });

  it("loads and checks a scenario inside the bundle (the curriculum is compiled in)", () => {
    const first = api.exec("scenario list").output.map((line: string) => line.trim().split(/\s+/)[0]).find((id: string) => /^[a-z0-9-]+$/.test(id) && id.includes("-"));
    expect(first).toBeDefined();
    expect(api.exec(`scenario load ${first}`).ok).toBe(true);
    const check = api.exec("scenario check");
    expect(check.output.length).toBeGreaterThan(0);                           // it ran; a fresh scenario starts unsolved
    expect(api.diagnose()).toEqual([]);
  });

  it("a failing command still fails inside the bundle (errors are not swallowed)", () => {
    expect(api.exec("link NOPE NADA").ok).toBe(false);
    expect(api.exec("definitely-not-a-command").ok).toBe(false);
  });
});
