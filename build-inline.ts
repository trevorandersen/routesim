/**
 * Inlines CSS and bundled JS into template.html to produce a single HTML file.
 * Called by build.sh after esbuild produces .bundle.js.
 *
 * Usage: bun build-inline.ts [output.html]   (default: rs-main.html)
 */

const outfile = Bun.argv[2] ?? "rs-main.html";
const template = await Bun.file("template.html").text();
const css = await Bun.file("styles.css").text();
const js = await Bun.file(".bundle.js").text();
// Use replacer functions so the inserted content is taken literally. A plain
// string replacement would interpret `$\``, `$'`, `$&`, `$$` in css/js as
// special patterns and corrupt the output.
const html = template
  .replace("{{STYLES}}", () => css)
  .replace("{{SCRIPT}}", () => js);
await Bun.write(outfile, html);
console.log(`Built ${outfile} (${Math.round(html.length / 1024)} KB)`);
