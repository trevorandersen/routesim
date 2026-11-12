/**
 * The build's inlining step (review R117). `build-inline.ts` used to substitute
 * its two placeholders and write the result whatever happened — a template with
 * a renamed or missing placeholder produced a page with no script (or no
 * styles) and still printed "Built rs-web.html", which the auto-commit workflow
 * would have pushed. `inlineTemplate` now refuses to produce such a page.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inlineTemplate } from "../build-inline";

const TEMPLATE = "<html><head><style>\n{{STYLES}}\n</style></head><body><script>\n{{SCRIPT}}\n</script></body></html>";
const CSS = "body { color: red; }";
const JS = "console.log(1);";

describe("build — inlineTemplate guards the artefact (R117)", () => {
  it("inlines the stylesheet and the bundle", () => {
    const html = inlineTemplate(TEMPLATE, CSS, JS);
    expect(html).toContain(CSS);
    expect(html).toContain(JS);
    expect(html).not.toContain("{{");
  });

  it("takes the content literally — `$&`, `$'`, `$$` and backticks are not replacement patterns", () => {
    const js = "const a = '$&'; const b = \"$'\"; const c = `$$ $\\``;";
    expect(inlineTemplate(TEMPLATE, CSS, js)).toContain(js);
  });

  it("content may itself contain `{{` (template literals in the bundle do)", () => {
    const js = "const view = `${{ a: 1 }.a} {{NOT_A_PLACEHOLDER}}`;";
    expect(inlineTemplate(TEMPLATE, CSS, js)).toContain(js);
  });

  it("refuses a template missing a placeholder", () => {
    expect(() => inlineTemplate(TEMPLATE.replace("{{SCRIPT}}", "{{SCRIPTS}}"), CSS, JS)).toThrow("{{SCRIPT}} exactly once (found 0)");
    expect(() => inlineTemplate(TEMPLATE.replace("{{STYLES}}", ""), CSS, JS)).toThrow("{{STYLES}} exactly once (found 0)");
  });

  it("refuses a placeholder that appears twice", () => {
    expect(() => inlineTemplate(TEMPLATE + "{{SCRIPT}}", CSS, JS)).toThrow("{{SCRIPT}} exactly once (found 2)");
  });

  it("refuses a template placeholder nothing fills", () => {
    expect(() => inlineTemplate(TEMPLATE.replace("<body>", "<body>{{VERSION}}"), CSS, JS)).toThrow("nothing fills: {{VERSION}}");
  });

  it("refuses an empty stylesheet or bundle", () => {
    expect(() => inlineTemplate(TEMPLATE, "  \n", JS)).toThrow("styles.css is empty");
    expect(() => inlineTemplate(TEMPLATE, CSS, "")).toThrow("bundle is empty");
  });

  it("refuses content that would close its own inline element", () => {
    expect(() => inlineTemplate(TEMPLATE, CSS, "document.write('</script>')")).toThrow("</script");
    expect(() => inlineTemplate(TEMPLATE, "a::after { content: '</STYLE>' }", JS)).toThrow("</style");
  });

  it("the real template and stylesheet satisfy the guards", () => {
    const root = join(import.meta.dir, "..");
    const html = inlineTemplate(readFileSync(join(root, "template.html"), "utf8"), readFileSync(join(root, "styles.css"), "utf8"), JS);
    expect(html).toContain(JS);
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});
