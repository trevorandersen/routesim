/**
 * The dev server's pure decision helpers (test-server.ts exports them and only
 * starts Bun.serve under import.meta.main). The exposure findings were:
 * served dotfiles/.git, an arbitrary `file` handed to `bun test`, and a
 * wildcard listener — the first two are decided here.
 */
import { describe, it, expect } from "bun:test";
import { isServablePath, isAllowedTestFile, isAllowedHost, apiRequestBlockReason } from "../test-server";

describe("dev server — static path policy", () => {
  it("serves the app's static artefacts", () => {
    for (const p of ["/rs-web.html", "/test.html", "/benchmark.html", "/styles.css", "/docs/testing.md".replace(".md", ".html")]) {
      expect(isServablePath(p)).toBe(true);
    }
  });
  it("refuses dotfiles, Git metadata, traversal, and unknown types", () => {
    for (const p of ["/.git/HEAD", "/.gitignore", "/tests/../.git/config", "/%2e%2e/x.html", "/src/engine.ts", "/build.sh", "/README"]) {
      expect(isServablePath(p)).toBe(false);
    }
  });
});

describe("dev server — test-file policy", () => {
  const known = ["engine.test.ts", "frame.test.ts"];
  it("accepts only an enumerated test file", () => {
    expect(isAllowedTestFile("engine.test.ts", known)).toBe(true);
    expect(isAllowedTestFile("frame.test.ts", known)).toBe(true);
  });
  it("rejects paths, globs, and files that are not in the suite", () => {
    for (const f of ["../package.json", "engine.test.ts/../x", "*.test.ts", "evil.test.ts", "", null]) {
      expect(isAllowedTestFile(f as any, known)).toBe(false);
    }
  });
});

// R116: the server had no Host/Origin check and /api/run was a GET, so a page on
// another site could start test runs through the browser, and DNS rebinding
// could read their output.
describe("dev server — who may talk to it (R116)", () => {
  const LOOPBACK = "127.0.0.1";

  it("bound to loopback, answers only to loopback names", () => {
    for (const host of ["localhost:8767", "127.0.0.1:8767", "[::1]:8767", "localhost", "LOCALHOST:8767"]) {
      expect(isAllowedHost(host, LOOPBACK), host).toBe(true);
    }
    for (const host of ["evil.example:8767", "attacker.test", "192.168.1.20:8767", "localhost.evil.example", "127.0.0.1.evil.example:8767", "", null]) {
      expect(isAllowedHost(host as any, LOOPBACK), String(host)).toBe(false);
    }
  });

  it("deliberately shared, it is reached by address or its own name — never a foreign name (DNS rebinding)", () => {
    for (const host of ["192.168.1.20:8767", "10.0.0.5", "[fe80::1]:8767", "localhost:8767"]) {
      expect(isAllowedHost(host, "0.0.0.0"), host).toBe(true);
    }
    expect(isAllowedHost("build-box.lan:8767", "build-box.lan")).toBe(true);
    expect(isAllowedHost("evil.example:8767", "0.0.0.0")).toBe(false);
    expect(isAllowedHost("evil.example:8767", "build-box.lan")).toBe(false);
  });

  const request = (over: Partial<Parameters<typeof apiRequestBlockReason>[0]>) =>
    ({ method: "POST", path: "/api/run", host: "localhost:8767", origin: null, secFetchSite: null, ...over });

  it("allows the runner page's own same-origin POST, and a plain command-line client", () => {
    expect(apiRequestBlockReason(request({ origin: "http://localhost:8767", secFetchSite: "same-origin" }), LOOPBACK)).toBeNull();
    expect(apiRequestBlockReason(request({}), LOOPBACK)).toBeNull();                       // curl: no Origin, no Sec-Fetch-Site
    expect(apiRequestBlockReason(request({ method: "GET", path: "/api/tests", secFetchSite: "same-origin" }), LOOPBACK)).toBeNull();
    expect(apiRequestBlockReason(request({ method: "GET", path: "/api/tests", secFetchSite: "none" }), LOOPBACK)).toBeNull();   // typed into the address bar
  });

  it("a test run must be a POST (a cross-site image or link can only GET)", () => {
    expect(apiRequestBlockReason(request({ method: "GET" }), LOOPBACK)).toContain("must be a POST");
    expect(apiRequestBlockReason(request({ method: "HEAD" }), LOOPBACK)).toContain("must be a POST");
  });

  it("refuses a request the browser marks as cross-site", () => {
    expect(apiRequestBlockReason(request({ origin: "http://evil.example" }), LOOPBACK)).toBe("Cross-site requests are refused.");
    expect(apiRequestBlockReason(request({ origin: "http://localhost:9999" }), LOOPBACK)).toBe("Cross-site requests are refused.");   // another local port is another origin
    expect(apiRequestBlockReason(request({ origin: "null" }), LOOPBACK)).toBe("Cross-site requests are refused.");                  // file:// or sandboxed page
    expect(apiRequestBlockReason(request({ secFetchSite: "cross-site" }), LOOPBACK)).toBe("Cross-site requests are refused.");
    expect(apiRequestBlockReason(request({ secFetchSite: "same-site" }), LOOPBACK)).toBe("Cross-site requests are refused.");
    expect(apiRequestBlockReason(request({ origin: "not a url" }), LOOPBACK)).toBe("Malformed Origin header.");
  });

  it("refuses a rebinding request even when it looks same-origin to the browser", () => {
    const rebound = request({ host: "evil.example:8767", origin: "http://evil.example:8767", secFetchSite: "same-origin" });
    expect(apiRequestBlockReason(rebound, LOOPBACK)).toContain("unexpected Host header");
    expect(apiRequestBlockReason({ ...rebound, method: "GET", path: "/api/tests" }, LOOPBACK)).toContain("unexpected Host header");
  });
});
