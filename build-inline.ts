/**
 * Inlines CSS and bundled JS into template.html to produce the single portable
 * rs-web.html. Called by build.sh after esbuild produces .bundle.js.
 *
 * Usage: bun build-inline.ts <output.html>
 *
 * The inlining is a pure, exported function so tests can pin its guards
 * (tests/build-inline.test.ts); the file I/O runs only as the entry point.
 */

const PLACEHOLDERS = ["{{STYLES}}", "{{SCRIPT}}"] as const;

// How many times `needle` occurs in `text`.
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * Put the stylesheet and the bundle into the template. Throws — so build.sh
 * fails and nothing is written — when the result would be a broken page that
 * still looks like a successful build: a placeholder missing from the template
 * (the CSS or the whole app silently left out), one appearing twice, another
 * `{{NAME}}` nobody fills, an empty stylesheet or bundle, or content that would
 * close its own inline element early. Before this a renamed placeholder shipped
 * an artefact with no script in it, which the commit workflow would have pushed.
 */
export function inlineTemplate(template: string, css: string, js: string, version?: string): string {
  // {{VERSION}} is filled only when the build supplies a version (from
  // package.json). Passing no version leaves it in the "nothing fills" set, so
  // a template that references it without a version still fails loudly.
  const allowed: string[] = [...PLACEHOLDERS];
  const required: string[] = [...PLACEHOLDERS];
  if (version !== undefined) { allowed.push("{{VERSION}}"); required.push("{{VERSION}}"); }
  for (const placeholder of required) {
    const count = occurrences(template, placeholder);
    if (count !== 1) throw new Error(`template.html must contain ${placeholder} exactly once (found ${count}).`);
  }
  const unknown = (template.match(/\{\{[A-Z_]+\}\}/g) ?? []).filter(token => !allowed.includes(token));
  if (unknown.length) throw new Error(`template.html has a placeholder nothing fills: ${[...new Set(unknown)].join(", ")}.`);
  if (!css.trim()) throw new Error("styles.css is empty — refusing to build a page with no styles.");
  if (!js.trim()) throw new Error("The bundle is empty — refusing to build a page with no script.");
  if (/<\/style/i.test(css)) throw new Error("styles.css contains \"</style\", which would end the inline stylesheet early.");
  if (/<\/script/i.test(js)) throw new Error("The bundle contains \"</script\", which would end the inline script early.");
  // Replacer functions, so the inserted content is taken literally. A plain
  // string replacement would interpret `$\``, `$'`, `$&`, `$$` in css/js as
  // special patterns and corrupt the output.
  let out = template
    .replace("{{STYLES}}", () => css)
    .replace("{{SCRIPT}}", () => js);
  if (version !== undefined) out = out.replace("{{VERSION}}", () => version);
  return out;
}

if (import.meta.main) {
  const outfile = Bun.argv[2] ?? "rs-web.html";
  const template = await Bun.file("template.html").text();
  const css = await Bun.file("styles.css").text();
  const js = await Bun.file(".bundle.js").text();
  const pkg = JSON.parse(await Bun.file("package.json").text()) as { version?: string };
  if (!pkg.version) throw new Error("package.json has no version — refusing to build without a version to stamp.");
  const html = inlineTemplate(template, css, js, pkg.version);
  await Bun.write(outfile, html);
  console.log(`Built ${outfile} v${pkg.version} (${Math.round(html.length / 1024)} KB)`);
}
