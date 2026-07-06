// Ambient shims so `bunx tsc -p tsconfig.tests.json` can type-check the test
// suite WITHOUT pulling npm type packages — the project forbids node_modules,
// so `@types/bun` / `@types/node` aren't available. Bun provides all of these
// at runtime; here we declare just enough for tsc to resolve the imports. Kept
// deliberately loose: this check exists to catch import / fixture-shape /
// signature drift against the (strict) `src` types, not to police bun's own
// API internals.

declare module "bun:test" {
  type Hook = () => void | Promise<void>;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: Hook): void;
  export const test: typeof it;
  export function beforeAll(fn: Hook): void;
  export function beforeEach(fn: Hook): void;
  export function afterAll(fn: Hook): void;
  export function afterEach(fn: Hook): void;
  export function expect(value: any, message?: string): any;
  export const mock: any;
  export const spyOn: any;
}

declare module "fs" {
  export function readFileSync(path: string, encoding: string): string;
  export function readdirSync(path: string): string[];
  export function existsSync(path: string): boolean;
}
declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
  export function readdirSync(path: string): string[];
  export function existsSync(path: string): boolean;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function basename(p: string, ext?: string): string;
  export function dirname(p: string): string;
}

// Bun's `import.meta.dir` (the module's directory) — not in the standard lib.
interface ImportMeta {
  dir: string;
}
