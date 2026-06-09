/**
 * Parity tests — assert that hand-maintained parallel structures stay in sync:
 *
 * 1. Theme CSS vars: every theme block must define the identical var set, and
 *    the base :root may only carry extra vars from a documented exempt list
 *    (aliases + layout). Catches "added a colour var to one theme, forgot the
 *    others" drift (e.g. the --fw-* device palette).
 * 2. Ribbon actions: every data-action in template.html must have a handler in
 *    ui.ts's ribbonActions map, and vice versa (no dead buttons, no dead code).
 * 3. Tools: every data-tool button has toolCopy text.
 * 4. Theme buttons: data-theme-id buttons match the THEMES registry.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { THEMES, toolCopy } from "../src/state";

const root = join(import.meta.dir, "..");
const css = readFileSync(join(root, "styles.css"), "utf8");
const template = readFileSync(join(root, "template.html"), "utf8");
const uiSrc = readFileSync(join(root, "src/ui.ts"), "utf8");

function cssBlock(selector: string): string {
  const i = css.indexOf(selector);
  expect(i, `selector ${selector} present in styles.css`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", i);
  return css.slice(open, css.indexOf("}", open));
}

const varsIn = (block: string): Set<string> =>
  new Set([...block.matchAll(/--([a-z0-9-]+)\s*:/g)].map(m => m[1]));

describe("parity — theme CSS variables", () => {
  // Vars that intentionally live only on the base :root: theme-independent
  // aliases (var() references) and layout dimensions. Adding to this list is a
  // conscious decision; a colour var landing here means a theme was forgotten.
  const ROOT_ONLY_EXEMPT = new Set(["fg", "border", "panel-bg", "inspector-width", "terminal-height"]);

  const rootVars = varsIn(cssBlock(":root {"));
  const themeVars = new Map(
    THEMES.filter(t => t.id !== "dark") // dark IS the base :root
      .map(t => [t.id, varsIn(cssBlock(`:root[data-theme="${t.id}"]`))])
  );

  it("every non-base theme defines the identical var set", () => {
    const [first, ...rest] = [...themeVars.entries()];
    for (const [id, vars] of rest) {
      expect([...vars].filter(v => !first[1].has(v)), `${id} has vars missing from ${first[0]}`).toEqual([]);
      expect([...first[1]].filter(v => !vars.has(v)), `${first[0]} has vars missing from ${id}`).toEqual([]);
    }
  });

  it("base :root only adds documented exempt vars beyond the themes", () => {
    for (const [id, vars] of themeVars) {
      const extra = [...rootVars].filter(v => !vars.has(v) && !ROOT_ONLY_EXEMPT.has(v));
      expect(extra, `:root vars missing from theme "${id}" (add them or exempt them)`).toEqual([]);
    }
  });

  it("themes do not invent vars absent from :root", () => {
    for (const [id, vars] of themeVars) {
      const orphans = [...vars].filter(v => !rootVars.has(v));
      expect(orphans, `theme "${id}" defines vars that :root lacks`).toEqual([]);
    }
  });
});

describe("parity — ribbon actions", () => {
  const templateActions = new Set(
    [...template.matchAll(/data-action="([^"]+)"/g)].map(m => m[1])
  );
  const mapSrc = uiSrc.slice(uiSrc.indexOf("const ribbonActions"), uiSrc.indexOf("};", uiSrc.indexOf("const ribbonActions")));
  const handlerKeys = new Set([...mapSrc.matchAll(/"([a-z-]+)":/g)].map(m => m[1]));

  it("every data-action button has a handler", () => {
    expect([...templateActions].filter(a => !handlerKeys.has(a))).toEqual([]);
  });

  it("every handler has a button (no dead handlers)", () => {
    expect([...handlerKeys].filter(a => !templateActions.has(a))).toEqual([]);
  });
});

describe("parity — tools & themes in the template", () => {
  it("every data-tool button has toolCopy text", () => {
    const tools = [...template.matchAll(/data-tool="([^"]+)"/g)].map(m => m[1]);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.filter(t => !toolCopy[t])).toEqual([]);
  });

  it("data-theme-id buttons match the THEMES registry exactly", () => {
    const buttons = new Set([...template.matchAll(/data-theme-id="([^"]+)"/g)].map(m => m[1]));
    expect([...buttons].sort()).toEqual(THEMES.map(t => t.id).sort());
  });
});
