/**
 * The dev server's pure decision helpers (test-server.ts exports them and only
 * starts Bun.serve under import.meta.main). The exposure findings were:
 * served dotfiles/.git, an arbitrary `file` handed to `bun test`, and a
 * wildcard listener — the first two are decided here.
 */
import { describe, it, expect } from "bun:test";
import { isServablePath, isAllowedTestFile } from "../test-server";

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
