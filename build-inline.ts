/**
 * Inlines CSS and bundled JS into template.html to produce a single HTML file.
 * Called by build.sh after esbuild produces .bundle.js.
 *
 * Usage: bun build-inline.ts <output.html> [--embed-config]
 *   --embed-config inlines config.json into the page (for the self-contained
 *   read-only web variant). Without it, the {{CONFIG}} slot is left empty and
 *   the app fetches ./config.json at runtime.
 */

const outfile = Bun.argv[2] ?? "rs-main.html";
const embedConfig = Bun.argv.includes("--embed-config");

const template = await Bun.file("template.html").text();
const css = await Bun.file("styles.css").text();
const js = await Bun.file(".bundle.js").text();
const config = embedConfig ? (await Bun.file("config.json").text()).trim() : "";

// Use replacer functions so the inserted content is taken literally. A plain
// string replacement would interpret `$\``, `$'`, `$&`, `$$` in css/js/config
// as special patterns and corrupt the output.
const html = template
  .replace("{{STYLES}}", () => css)
  .replace("{{CONFIG}}", () => config)
  .replace("{{SCRIPT}}", () => js);

await Bun.write(outfile, html);
const embedNote = embedConfig ? ", config embedded" : "";
console.log(`Built ${outfile} (${Math.round(html.length / 1024)} KB${embedNote})`);
