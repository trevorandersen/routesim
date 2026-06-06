# Build process

The toolchain is intentionally minimal: **`esbuild`** (bundler) and **`bun`** (runtime + inliner). There is **no** Node.js, npm, `package.json`, `node_modules`, or Python. This constraint is deliberate and must be preserved.

## Commands

```bash
bash build.sh            # dev build  → rs-main.html + rs-web.html
bash build.sh --minify   # minified build
```

## Pipeline

`build.sh` builds **two variants** from the same source, then cleans up:

```
for each variant:
  esbuild src/app.ts --bundle --format=iife --target=es2022 \
    --define:__BUILD_READONLY__=<flag> [--minify] --outfile=.bundle.js
  bun build-inline.ts <output.html> [--embed-config]
rm .bundle.js
```

1. **esbuild** bundles the entry point `src/app.ts` and all its imports into a single self-executing IIFE (`.bundle.js`). It injects the compile-time flag `__BUILD_READONLY__` via `--define` (read through `src/env.ts` — see [env.md](src/env.md)). esbuild strips TypeScript types but does **not** type-check (see Type-checking below).
2. **`build-inline.ts`** (a tiny Bun script) reads `template.html` and substitutes three placeholders: `{{STYLES}}` ← `styles.css`, `{{SCRIPT}}` ← the JS bundle, and (web variant only) `{{CONFIG}}` ← `config.json`. The result is one portable HTML file.

> **Gotcha:** `build-inline.ts` uses `String.replace` **replacer functions** (`.replace("{{SCRIPT}}", () => js)`), not string replacements. A string replacement would interpret `` $` ``/`$'`/`$&`/`$$` sequences in the bundle as special patterns and corrupt the output. This bit us once during the Python→Bun migration.

## Build variants

| Output | `__BUILD_READONLY__` | config.json | Use |
|--------|----------------------|-------------|-----|
| `rs-main.html` | `false` | fetched at runtime; read **and** write | Local use — full editor |
| `rs-web.html` | `true` | **embedded** at build time; read-only (Save hidden) | Self-contained web hosting |

- **`rs-main.html`** is for local use. On startup it fetches `./config.json`; the Save button writes back to it via the File System Access API (which requires `localhost` or HTTPS — see [config.md](src/config.md)).
- **`rs-web.html`** is for hosting. `config.json` is inlined into a `<script id="embeddedConfig" type="application/json">` block, so the page makes **zero** runtime requests and is a true single file. `READONLY` hides the Save button and no-ops `saveConfig()`.

Both `rs-main.html` and `rs-web.html` are committed (the portable deliverables live in the repo). Adding a third variant is one extra `build_variant <flag> <output> [args]` line in `build.sh`.

## Serving

`test-server.ts` (Bun) serves the build output, the test/benchmark UIs, and the test API:

```bash
bun test-server.ts          # default port 8767
bun test-server.ts 8765     # custom port
```

`/` redirects to `rs-main.html`. See [testing.md](testing.md) for the `/api/*` endpoints.

## Files involved

| File | Role |
|------|------|
| `build.sh` | Orchestrates the two-variant build |
| `build-inline.ts` | Inlines CSS/JS/config into `template.html` |
| `template.html` | HTML shell with `{{STYLES}}` / `{{SCRIPT}}` / `{{CONFIG}}` placeholders |
| `styles.css` | All CSS (dark/light theme via custom properties) |
| `src/env.ts` | Surfaces the `__BUILD_READONLY__` define as `READONLY` |
| `config.json` | Default topology store |

## Type-checking

esbuild does **not** type-check, so a type error cannot break the build — types are for editor safety and documentation. To check types explicitly:

```bash
bunx tsc --noEmit
```

`tsconfig.json` is `strict`, ES2022, `noEmit`, with DOM libs.
