/**
 * Stamps build-derived figures into the Markdown docs so they can't drift from
 * the source of truth. A doc marks a spot with an HTML comment pair:
 *
 *     the <!--param:SCENARIO_COUNT-->28<!--/param-->-scenario curriculum
 *
 * The comments are invisible when GitHub renders the Markdown; only the value
 * between them shows. `stampDoc` rewrites that value from `params`, so editing
 * the number by hand is pointless — the next build (or the drift test) resets
 * it to whatever the code says. Markers must sit in prose, not inside a ``` code
 * fence, where HTML comments render literally.
 *
 * Usage:
 *   bun stamp-docs.ts            # rewrite the docs in place
 *   bun stamp-docs.ts --check    # exit non-zero if any doc is out of date
 *
 * `stampDoc` is a pure, exported function so tests can pin it and assert the
 * committed docs are already stamped (tests/stamp-docs.test.ts); the file I/O
 * and the parameter sources run only as the entry point.
 */

export type DocParams = Record<string, string | number>;

const MARKER = /<!--param:([A-Za-z0-9_]+)-->.*?<!--\/param-->/gs;
const DOCS = ["README.md", "ROADMAP.md"] as const;

/**
 * Replace the text between every `<!--param:NAME-->…<!--/param-->` pair with
 * `params[NAME]`, keeping the markers. Throws — so the build fails rather than
 * ship a wrong or silently unfilled figure — on a marker whose name has no
 * parameter, or an opening marker with no matching close.
 */
export function stampDoc(text: string, params: DocParams): string {
  let matched = 0;
  const out = text.replace(MARKER, (_full, name: string) => {
    matched++;
    if (!(name in params)) throw new Error(`doc references an unknown build parameter: {${name}}`);
    return `<!--param:${name}-->${params[name]}<!--/param-->`;
  });
  const opens = (text.match(/<!--param:/g) ?? []).length;
  if (matched !== opens) throw new Error("a <!--param:…--> marker is missing its <!--/param--> close.");
  return out;
}

if (import.meta.main) {
  const { CURRICULUM } = await import("./src/scenario-library");
  const params: DocParams = { SCENARIO_COUNT: CURRICULUM.length };
  const check = Bun.argv.includes("--check");

  const stale: string[] = [];
  for (const file of DOCS) {
    const before = await Bun.file(file).text();
    const after = stampDoc(before, params);
    if (before === after) continue;
    stale.push(file);
    if (!check) { await Bun.write(file, after); console.log(`Stamped ${file}.`); }
  }
  // In --check, a stale doc is a build break (throwing exits non-zero): a figure
  // changed in the code but the committed Markdown wasn't rebuilt.
  if (check && stale.length) throw new Error(`out of date, run \`bun stamp-docs.ts\`: ${stale.join(", ")}`);
  if (!stale.length) console.log("Docs already up to date.");
}
