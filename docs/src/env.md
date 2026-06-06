# `src/env.ts` — Build-time flags

Surfaces compile-time configuration to the rest of the app.

## Key export

- **`READONLY: boolean`** — `true` in the `rs-web.html` build, `false` in `rs-main.html` and in dev/test.

## How it works

esbuild injects the constant `__BUILD_READONLY__` via `--define` during the build (see [build.md](../build.md)). `env.ts` reads it defensively:

```ts
declare const __BUILD_READONLY__: boolean | undefined;
export const READONLY: boolean =
  typeof __BUILD_READONLY__ !== "undefined" ? __BUILD_READONLY__ : false;
```

The `typeof` guard is the one safe way to reference an identifier that may be undeclared at runtime: under `bun test` (no `--define`), it yields `"undefined"` and `READONLY` defaults to `false`. Under esbuild, the token is substituted (`typeof true` / `typeof false`) and folds to the build's value.

## How it fits

Two consumers gate read-only behaviour on `READONLY`:
- `config.ts` — `saveConfig()` no-ops when read-only.
- `ui.ts` — hides the Save button when read-only.

To add another build-time flag, define it in `build.sh` (`--define:`) and read it here with the same `typeof` pattern. See [build.md](../build.md).
