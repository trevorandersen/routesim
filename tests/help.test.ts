/**
 * The in-app reference (Help → Guide) must stay in lockstep with the app:
 * every user-addable device type and every Settings-pane toggle has to be
 * documented in help.ts. These tests are the enforcement — add a device or a
 * setting and forget the doc, and the suite fails.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { DEVICE_DOCS, SETTING_GROUPS, buildHelpHtml } from "../src/help";
import { USER_ADDABLE_TYPES, DEVICE_SPECS } from "../src/device-registry";

describe("help — device coverage", () => {
  const documented = new Set(DEVICE_DOCS.map(d => d.type));

  it("documents exactly the user-addable device types (no gaps, no strays)", () => {
    for (const type of USER_ADDABLE_TYPES) {
      expect(documented.has(type)).toBe(true);   // a new device must be documented
    }
    for (const doc of DEVICE_DOCS) {
      expect(USER_ADDABLE_TYPES).toContain(doc.type);   // no doc for a non-placeable type
    }
    expect(documented.size).toBe(USER_ADDABLE_TYPES.length);   // one entry each, no dupes
  });

  it("every device doc has real prose", () => {
    for (const doc of DEVICE_DOCS) expect(doc.body.trim().length).toBeGreaterThan(20);
  });
});

describe("help — settings coverage", () => {
  const template = readFileSync("template.html", "utf8");
  // Every settings toggle in the pane is an <input id="opt…">.
  const toggleIds = [...template.matchAll(/id="(opt[A-Za-z0-9]+)"/g)].map(m => m[1]);
  const documentedIds = new Set(SETTING_GROUPS.flatMap(g => g.items.map(i => i.id)));

  it("finds the pane's toggles (guards against a broken scrape)", () => {
    expect(toggleIds.length).toBeGreaterThanOrEqual(5);
    expect(toggleIds).toContain("optAutoDhcp");
  });

  it("documents every Settings-pane toggle by its checkbox id", () => {
    for (const id of toggleIds) expect(documentedIds.has(id)).toBe(true);
  });

  it("every setting doc has a title and real prose", () => {
    for (const g of SETTING_GROUPS) for (const i of g.items) {
      expect(i.title.trim().length).toBeGreaterThan(0);
      expect(i.body.trim().length).toBeGreaterThan(20);
    }
  });
});

describe("help — rendering", () => {
  const html = buildHelpHtml();

  it("names every device (label from DEVICE_SPECS) and every setting", () => {
    for (const doc of DEVICE_DOCS) expect(html).toContain(DEVICE_SPECS[doc.type].label);
    for (const g of SETTING_GROUPS) {
      expect(html).toContain(g.title);
      for (const i of g.items) expect(html).toContain(i.title);
    }
  });

  it("renders a device icon per documented device", () => {
    const icons = (html.match(/<svg /g) || []).length;
    expect(icons).toBeGreaterThanOrEqual(DEVICE_DOCS.length);
  });
});
