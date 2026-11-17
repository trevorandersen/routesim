# Build process

The toolchain is two binaries: **`esbuild`** (bundler) and **`bun`** (runtime + inliner). No Node.js, npm install, `node_modules`, or Python. There is a `package.json`, but only as a manifest: it pins the app `version` (stamped into the About box at build time) and records the canonical commands as `scripts`; it declares no dependencies, so nothing is ever installed.

## Commands

```bash
bash build.sh            # build → rs-web.html
bash build.sh --minify   # minified build
```

## Pipeline

```
bun stamp-docs.ts
esbuild src/app.ts --bundle --format=iife --target=es2022 [--minify] --outfile=.bundle.js
bun build-inline.ts rs-web.html
rm .bundle.js
```

0. **`stamp-docs.ts`** rewrites build-derived figures in the Markdown docs from the code, so they can't drift. A doc marks a spot with an invisible HTML-comment pair — `the <!--param:SCENARIO_COUNT-->28<!--/param-->-scenario curriculum` — and `stampDoc` (pure, exported) replaces the value between the markers from its parameter map (today just `SCENARIO_COUNT` ← `CURRICULUM.length`). GitHub renders only the number; editing it by hand is pointless because the next build resets it. Markers must sit in prose — inside a ``` code fence the comments render literally. `bun stamp-docs.ts --check` fails instead of writing, and `tests/stamp-docs.test.ts` asserts the committed docs are already stamped (so a new scenario fails CI until the docs are rebuilt).
1. **esbuild** bundles `src/app.ts` and all its imports into a single IIFE (`.bundle.js`); it strips TypeScript types but does **not** type-check (run `bunx tsc --noEmit` for that).
2. **`build-inline.ts`** reads `template.html` and substitutes `{{STYLES}}` ← `styles.css`, `{{SCRIPT}}` ← the JS bundle, and `{{VERSION}}` ← `package.json`'s `version` (shown in the About box), producing the single portable **`rs-web.html`**.

> **Gotcha:** `build-inline.ts` uses `String.replace` **replacer functions** (`.replace("{{SCRIPT}}", () => js)`), not string replacements — a string replacement would interpret `` $` ``/`$'`/`$&`/`$$` in the bundle as special patterns and corrupt the output.

> **The inliner refuses a broken page.** `inlineTemplate(template, css, js, version?)` (exported from `build-inline.ts`; the file I/O runs only as the entry point) throws — so `build.sh` fails and nothing is written — if `{{STYLES}}` or `{{SCRIPT}}` is missing from the template or appears more than once, if any other `{{NAME}}` placeholder remains, if the stylesheet or bundle is empty, or if either contains its own closing tag (`</style`, `</script`). When a `version` is supplied, `{{VERSION}}` must likewise appear exactly once (and is filled with it); with no `version` argument, `{{VERSION}}` counts as an unfilled placeholder and fails the build. It used to substitute and write whatever it was given: a renamed placeholder produced a page with no script and still printed "Built rs-web.html" (review R117). `tests/build-inline.test.ts` pins each guard.

## One self-contained file

There is a **single** build output, `rs-web.html` — a self-contained portable file with **no runtime requests**. The default topologies (`defaultConfig`/`vlanRoasConfig`/`routerMeshConfig` in `state.ts`) and scenarios (`SCENARIOS` in `scenarios.ts`) are compiled in; on startup the app loads the Basic Network directly. There is no `config.json`, no fetch, and no File System Access API.

Persistence is **JSON import/export** (download + file picker) for configs, scenarios, scripts, and logs — see [scripting.md](scripting.md) — and a network can travel as a **link** (`#net=…`, the topology in the URL fragment; still no request — see [share-link.md](src/share-link.md)). The network on the canvas is also **autosaved** to the browser's `localStorage` and restored on the next visit (opt-out — storage, not network; see [autosave.md](src/autosave.md)). `rs-web.html` is committed (the portable deliverable lives in the repo).

## Serving

`test-server.ts` (Bun) serves the build output + the test/benchmark UIs + the test API:

```bash
bun test-server.ts          # default port 8767; / → rs-web.html
```

## Type-checking

esbuild does not type-check, so a type error can't break the build. Check explicitly:

```bash
bunx tsc --noEmit
```
