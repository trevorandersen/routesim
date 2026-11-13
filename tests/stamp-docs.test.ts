/**
 * The docs stamp build-derived figures (currently the scenario count) from the
 * code, so the Markdown can't drift from the source of truth. These tests pin
 * `stampDoc`'s substitution and guards, and — the point of the whole exercise —
 * assert the committed README and ROADMAP already carry the live count, so a
 * new scenario that isn't re-stamped fails CI instead of shipping a stale "28".
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stampDoc } from "../stamp-docs";
import { CURRICULUM } from "../src/scenario-library";

describe("stamp-docs — figures build from the code", () => {
  it("replaces the value between markers and keeps the markers", () => {
    expect(stampDoc("the <!--param:N-->0<!--/param--> cases", { N: 7 }))
      .toBe("the <!--param:N-->7<!--/param--> cases");
  });

  it("is idempotent — stamping twice changes nothing", () => {
    const once = stampDoc("x <!--param:N-->0<!--/param-->", { N: 7 });
    expect(stampDoc(once, { N: 7 })).toBe(once);
  });

  it("fills every occurrence of a repeated marker", () => {
    expect(stampDoc("<!--param:N-->1<!--/param--> … <!--param:N-->2<!--/param-->", { N: 9 }))
      .toBe("<!--param:N-->9<!--/param--> … <!--param:N-->9<!--/param-->");
  });

  it("throws on a marker nothing fills", () => {
    expect(() => stampDoc("<!--param:NOPE-->1<!--/param-->", {})).toThrow("unknown build parameter: {NOPE}");
  });

  it("throws on an opening marker with no close", () => {
    expect(() => stampDoc("<!--param:N-->1 and on", { N: 7 })).toThrow("missing its <!--/param--> close");
  });

  it("the committed docs already carry the live scenario count", () => {
    const root = join(import.meta.dir, "..");
    const params = { SCENARIO_COUNT: CURRICULUM.length };
    for (const file of ["README.md", "ROADMAP.md"]) {
      const text = readFileSync(join(root, file), "utf8");
      expect(stampDoc(text, params)).toBe(text);
    }
  });
});
