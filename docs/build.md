# Build process

The toolchain is two binaries: **`esbuild`** (bundler) and **`bun`** (runtime + inliner). No Node.js, npm, `package.json`, `node_modules`, or Python.

## Commands

```bash
bash build.sh            # build → rs-web.html
bash build.sh --minify   # minified build
```

## Pipeline

```
esbuild src/app.ts --bundle --format=iife --target=es2022 [--minify] --outfile=.bundle.js
bun build-inline.ts rs-web.html
rm .bundle.js
```

1. **esbuild** bundles `src/app.ts` and all its imports into a single IIFE (`.bundle.js`); it strips TypeScript types but does **not** type-check (run `bunx tsc --noEmit` for that).
2. **`build-inline.ts`** reads `template.html` and substitutes `{{STYLES}}` ← `styles.css` and `{{SCRIPT}}` ← the JS bundle, producing the single portable **`rs-web.html`**.

> **Gotcha:** `build-inline.ts` uses `String.replace` **replacer functions** (`.replace("{{SCRIPT}}", () => js)`), not string replacements — a string replacement would interpret `` $` ``/`$'`/`$&`/`$$` in the bundle as special patterns and corrupt the output.

> **The inliner refuses a broken page.** `inlineTemplate(template, css, js)` (exported from `build-inline.ts`; the file I/O runs only as the entry point) throws — so `build.sh` fails and nothing is written — if `{{STYLES}}` or `{{SCRIPT}}` is missing from the template or appears more than once, if any other `{{NAME}}` placeholder remains, if the stylesheet or bundle is empty, or if either contains its own closing tag (`</style`, `</script`). It used to substitute and write whatever it was given: a renamed placeholder produced a page with no script and still printed "Built rs-web.html" (review R117). `tests/build-inline.test.ts` pins each guard.

## One self-contained file

There is a **single** build output, `rs-web.html` — a self-contained portable file with **no runtime requests**. The default topologies (`defaultConfig`/`vlanRoasConfig`/`routerMeshConfig` in `state.ts`) and scenarios (`SCENARIOS` in `scenarios.ts`) are compiled in; on startup the app loads the Basic Network directly. There is no `config.json`, no fetch, and no File System Access API.

Persistence is **JSON import/export** (download + file picker) for configs, scenarios, scripts, and logs — see [scripting.md](scripting.md). `rs-web.html` is committed (the portable deliverable lives in the repo).

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
