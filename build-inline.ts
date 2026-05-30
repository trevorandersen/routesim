/**
 * Inlines CSS and bundled JS into template.html to produce index.html.
 * Called by build.sh after esbuild produces .bundle.js.
 */

const template = await Bun.file("template.html").text();
const css = await Bun.file("styles.css").text();
const js = await Bun.file(".bundle.js").text();
const html = template.replace("{{STYLES}}", css).replace("{{SCRIPT}}", js);
await Bun.write("index.html", html);
console.log(`Built index.html (${Math.round(html.length / 1024)} KB)`);
