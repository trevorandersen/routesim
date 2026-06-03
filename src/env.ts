// Build-time environment flags.
//
// __BUILD_READONLY__ is injected at build time via esbuild --define
// (see build.sh). It is absent in dev/test, where bun runs the TypeScript
// directly without esbuild — `typeof` on the runtime-undeclared identifier
// safely yields "undefined", so READONLY defaults to false.
declare const __BUILD_READONLY__: boolean | undefined;

export const READONLY: boolean =
  typeof __BUILD_READONLY__ !== "undefined" ? __BUILD_READONLY__ : false;
