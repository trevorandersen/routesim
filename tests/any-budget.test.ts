/**
 * The `any` budget (review R107). The codebase's rule is "prefer concrete types
 * over `any`", but nothing enforced it and the count had grown to about 410
 * type-level uses. A type-checker-guarded sweep removed every one that could go
 * without a design change; what is left is counted here, and the count may only
 * go DOWN. When you remove some, lower BUDGET to the new count in the same
 * commit. If you must add one, say why next to it — and find one to remove.
 */
import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
export const BUDGET = 59;

// Type-level uses only: annotations, casts, array and generic arguments, unions.
// Comments and string/template/regex-ish literals are stripped first.
const TYPE_ANY = /(?::\s*any\b|\bas any\b|<any>|\bany\[\]|,\s*any>|<any,|\bany\s*\||\|\s*any\b|=>\s*any\b)/g;

function countAny(text: string): number {
  let count = 0, inBlock = false;
  for (let line of text.split("\n")) {
    if (inBlock) {
      if (!line.includes("*/")) continue;
      inBlock = false; line = line.slice(line.indexOf("*/") + 2);
    }
    const trimmed = line.trimStart();
    if (trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      if (line.includes("/*") && !line.includes("*/")) inBlock = true;
      continue;
    }
    const comment = line.indexOf("//");
    if (comment >= 0) line = line.slice(0, comment);
    line = line.replace(/"[^"\n]*"|`[^`\n]*`|'[^'\n]*'/g, '""');
    count += (line.match(TYPE_ANY) || []).length;
  }
  return count;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);
}

describe("the `any` budget only ratchets down (R107)", () => {
  it("counts type-level uses, not the word in comments or strings", () => {
    expect(countAny(`const a: any = 1; // any old comment\nconst b = x as any;\nconst s = "any";\n/* any */\nfunction f(xs: any[]): Record<string, any> { return {}; }`)).toBe(4);
  });

  it(`src/ holds no more than ${BUDGET} uses of \`any\``, () => {
    const perFile = sourceFiles(SRC).map(f => [f.slice(SRC.length + 1), countAny(readFileSync(f, "utf8"))] as const).filter(([, n]) => n > 0);
    const total = perFile.reduce((sum, [, n]) => sum + n, 0);
    // Over budget: the message lists where they are, largest first.
    const report = perFile.sort((a, b) => b[1] - a[1]).map(([f, n]) => `${n} ${f}`).join(", ");
    expect({ total: Math.max(total, BUDGET), report: total > BUDGET ? report : "" }).toEqual({ total: BUDGET, report: "" });
  });

  it("the budget is not slack: lower it when the count drops", () => {
    const total = sourceFiles(SRC).reduce((sum, f) => sum + countAny(readFileSync(f, "utf8")), 0);
    expect(BUDGET - total).toBeLessThanOrEqual(5);
  });
});
